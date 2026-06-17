import type { PluginInput, Plugin, Hooks } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"

const STATE_DIR = "/tmp"
const STATE_PREFIX = ".reasonix-connector-state-"
const USAGE_RE = /^  · \d+ tok · in \d+ \((\d+) cached \/ (\d+) new\)/

interface StateSnapshot {
  interceptionCount: number
  lastInterception: number | null
  lastStatus: "success" | "fallback" | "running"
  lastModel: string | null
  lastCacheHit: number | null
  lastCacheMiss: number | null
}

const cache = new Map<string, string>()
const rootSessionCache = new Map<string, string>()
let interceptorCount = 0

async function findRootSession(
  client: PluginInput["client"],
  sid: string,
): Promise<string> {
  if (rootSessionCache.has(sid)) return rootSessionCache.get(sid)!

  try {
    const result = await client.session.get({ path: { id: sid } })
    const parentID = (result.data as any)?.parentID as string | undefined

    if (!parentID) {
      rootSessionCache.set(sid, sid)
      return sid
    }

    const root = await findRootSession(client, parentID)
    rootSessionCache.set(sid, root)
    return root
  } catch {
    rootSessionCache.set(sid, sid)
    return sid
  }
}

function statePath(sessionID: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `${STATE_DIR}/${STATE_PREFIX}${safe}.json`
}

// Track sessions we've written to, so dispose can clean up our own files only.
const writtenSessions = new Set<string>()

async function writeEmptyState(sessionID: string): Promise<void> {
  try {
    writtenSessions.add(sessionID)
    await Bun.write(statePath(sessionID), JSON.stringify({
      interceptionCount: 0,
      lastInterception: null,
      lastStatus: "success",
      lastModel: null,
      lastCacheHit: null,
      lastCacheMiss: null,
    } as StateSnapshot))
  } catch {}
}

async function writeRunningState(model: string | null, sessionID: string, client: PluginInput["client"]): Promise<void> {
  try {
    const rootSid = await findRootSession(client, sessionID)
    const sids = new Set([sessionID])
    if (rootSid !== sessionID) sids.add(rootSid)

    for (const sid of sids) {
      writtenSessions.add(sid)
      await Bun.write(statePath(sid), JSON.stringify({
        interceptionCount: interceptorCount,
        lastInterception: Date.now(),
        lastStatus: "running",
        lastModel: model,
        lastCacheHit: null,
        lastCacheMiss: null,
      } as StateSnapshot))
    }
  } catch {}
}

function statusPriority(s: string): number {
  if (s === "success") return 3
  if (s === "running") return 2
  return 1
}

async function writeDoneState(
  status: "success" | "fallback",
  model: string | null,
  cacheHit: number,
  cacheMiss: number,
  sessionID: string,
  client: PluginInput["client"],
): Promise<void> {
  try {
    const rootSid = await findRootSession(client, sessionID)
    const sids = new Set([sessionID])
    if (rootSid !== sessionID) sids.add(rootSid)

    for (const sid of sids) {
      writtenSessions.add(sid)
      const path = statePath(sid)
      const prev = JSON.parse(await Bun.file(path).text().catch(() => "{}"))
      const prevHit = prev.lastCacheHit ?? 0
      const prevMiss = prev.lastCacheMiss ?? 0
      const effectiveStatus = (sid === rootSid && prev.lastStatus && statusPriority(prev.lastStatus) > statusPriority(status))
        ? prev.lastStatus
        : status
      await Bun.write(path, JSON.stringify({
        interceptionCount: sid === rootSid ? interceptorCount : (prev.interceptionCount ?? 0),
        lastInterception: Date.now(),
        lastStatus: effectiveStatus,
        lastModel: model,
        lastCacheHit: (sid === rootSid ? prevHit : 0) + cacheHit,
        lastCacheMiss: (sid === rootSid ? prevMiss : 0) + cacheMiss,
      } as StateSnapshot))
    }
  } catch {}
}

function isDeepseekProvider(providerID?: string): boolean {
  return providerID?.toLowerCase() === "deepseek"
}

function findReasonix(): string | undefined {
  if (typeof Bun === "undefined") return
  const p = Bun.which("reasonix")
  if (p) return p
  for (const c of ["/opt/homebrew/bin/reasonix", `${process.env.HOME}/.local/bin/reasonix`, `${process.env.HOME}/.bun/bin/reasonix`]) {
    try { if (Bun.file(c).size > 0) return c } catch {}
  }
}

function parseCacheRatio(stdout: string): { text: string; cacheHit: number; cacheMiss: number } {
  const stripped = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim()
  const m = stripped.split("\n").pop()?.match(USAGE_RE)
  let hit = 0, miss = 0
  if (m) { hit = parseInt(m[1], 10); miss = parseInt(m[2], 10) }

  const segments = stripped.split(/^[ ]*▎ thinking/m)
  const finalTurn = segments[segments.length - 1]

  const textLines = finalTurn.split("\n").filter(l => {
    const t = l.trim()
    if (!t) return false
    if (/(?:^| )[ ]*▎ thinking/.test(t)) return false
    if (/^[ ]*-> \S+/.test(t)) return false
    if (/^[ ]*⊘ /.test(t)) return false
    if (/^[ ]*· /.test(t)) return false
    return true
  })

  return { text: textLines.join("\n").trim(), cacheHit: hit, cacheMiss: miss }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  if (chunks.length === 0) return ""
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.length }
  return new TextDecoder().decode(buf)
}

async function runReasonix(binary: string, sid: string, worktree: string, dir: string, prompt: string, client: PluginInput["client"], modelID: string | undefined) {
  let proc: any
  let timeout: ReturnType<typeof setTimeout> | undefined
  const spawnedAt = interceptorCount

  const stillCurrent = () => {
    try {
      const cur = JSON.parse(Bun.file(statePath(sid)).textSync())
      return (cur.interceptionCount ?? 0) <= spawnedAt
    } catch { return true }
  }

  try {
    proc = Bun.spawn([binary, "run", "--dir", worktree, prompt], { cwd: dir, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] })
    timeout = setTimeout(() => { try { proc.kill() } catch {} }, 900_000)

    const stdoutRead = proc.stdout ? readAll(proc.stdout) : Promise.resolve("")
    const stderrRead = proc.stderr ? readAll(proc.stderr) : Promise.resolve("")

    let code = 0

    try {
      code = await proc.exited
    } catch {
      code = -1
    }
    clearTimeout(timeout)

    if (code === 0 && stillCurrent()) {
      await writeDoneState("success", modelID ?? null, 0, 0, sid, client)
    } else if (stillCurrent()) {
      await writeDoneState("fallback", modelID ?? null, 0, 0, sid, client)
    }

    try {
      const stdout = await stdoutRead
      const stderr = await stderrRead

      if (code === 0 && stillCurrent()) {
        const p = parseCacheRatio(stdout)
        if (p.text) cache.set(sid, p.text)
        if (p.cacheHit > 0) await writeDoneState("success", modelID ?? null, p.cacheHit, p.cacheMiss, sid, client)
      } else if (code === 0) {
        const p = parseCacheRatio(stdout)
        if (p.text) cache.set(sid, p.text)
      } else if (stderr) {
        try { await Bun.write(`${dir}/.reasonix-err-${Date.now()}.log`, stderr) } catch {}
      }
    } catch {}
  } catch {
    if (timeout !== undefined) clearTimeout(timeout)
    if (proc !== undefined) try { proc.kill() } catch {}
    try {
      const cur = JSON.parse(await Bun.file(statePath(sid)).text())
      if ((cur.interceptionCount ?? 0) <= spawnedAt) {
        await writeDoneState("fallback", modelID ?? null, 0, 0, sid, client)
      }
    } catch {}
  }
}

export const server: Plugin = (ctx: PluginInput): Hooks => {
  const binary = findReasonix()

  return {
    dispose: async () => {
      cache.clear()
      rootSessionCache.clear()
      await Promise.all([...writtenSessions].map(sid =>
        Bun.file(statePath(sid)).unlink().catch(() => {}),
      ))
      writtenSessions.clear()
    },

    "chat.message": async (input, output) => {
      try {
        if (!input.model || !isDeepseekProvider(input.model.providerID)) {
          await writeEmptyState(input.sessionID)
          return
        }
        if (!binary) { return }

        const { text, files } = await (async () => {
          const t: string[] = []
          const f: string[] = []
          for (const p of output.parts) {
            if (p.type === "text" && (p as any).text) t.push((p as any).text)
            if (p.type === "file" && (p as Part & { url?: string }).url) {
              try { f.push(`File: ${(p as any).filename ?? (p as any).url}\n\`\`\`\n${await Bun.file(((p as any).url).replace(/^file:\/\//, "")).text()}\n\`\`\``) } catch { f.push(`[unreadable: ${(p as any).filename}]`) }
            }
          }
          return { text: t.join("\n").trim(), files: f.join("\n\n").trim() }
        })()

        const prompt = [text, files].filter(Boolean).join("\n\n")
        if (!prompt) return

        interceptorCount++
        await writeRunningState(input.model.modelID, input.sessionID, ctx.client)

        runReasonix(binary, input.sessionID, ctx.worktree, ctx.directory, prompt, ctx.client, input.model.modelID)
      } catch {}
    },

    "experimental.text.complete": async (input, output) => {
      try {
        const cached = cache.get(input.sessionID)
        if (!cached) return
        output.text = cached
        cache.delete(input.sessionID)
      } catch {}
    },
  }
}

export default { id: "reasonix-connector", server }