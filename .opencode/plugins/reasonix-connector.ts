import type { PluginInput, Plugin, Hooks } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"

const STATE_PATH = "/tmp/.reasonix-connector-state.json"
const TUI_ACTIVE_FILE = "/tmp/.reasonix-connector-tui-active"
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
let interceptorCount = 0

async function writeEmptyState(): Promise<void> {
  try {
    await Bun.write(STATE_PATH, JSON.stringify({
      interceptionCount: 0,
      lastInterception: null,
      lastStatus: "success",
      lastModel: null,
      lastCacheHit: null,
      lastCacheMiss: null,
    } as StateSnapshot))
  } catch {}
}

async function writeRunningState(model: string | null): Promise<void> {
  try {
    await Bun.write(STATE_PATH, JSON.stringify({
      interceptionCount: interceptorCount,
      lastInterception: Date.now(),
      lastStatus: "running",
      lastModel: model,
      lastCacheHit: null,
      lastCacheMiss: null,
    } as StateSnapshot))
  } catch {}
}

async function writeDoneState(
  status: "success" | "fallback",
  model: string | null,
  cacheHit: number,
  cacheMiss: number,
): Promise<void> {
  try {
    const prev = JSON.parse(await Bun.file(STATE_PATH).text().catch(() => "{}"))
    await Bun.write(STATE_PATH, JSON.stringify({
      interceptionCount: prev.interceptionCount ?? 0,
      lastInterception: Date.now(),
      lastStatus: status,
      lastModel: model,
      lastCacheHit: cacheHit || null,
      lastCacheMiss: cacheMiss || null,
    } as StateSnapshot))
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

async function toast(
  client: PluginInput["client"],
  variant: "info" | "success" | "warning" | "error",
  title: string,
  message: string,
  duration?: number,
) {
  if (variant === "info" || variant === "success") {
    try {
      const f = Bun.file(TUI_ACTIVE_FILE)
      if (await f.text().then(t => t.length > 0).catch(() => false)) return
    } catch {}
  }
  try {
    await client.tui.showToast({ body: { variant, title, message, duration: duration ?? 3000 } })
  } catch {}
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
      const cur = JSON.parse(Bun.file(STATE_PATH).textSync())
      return (cur.interceptionCount ?? 0) <= spawnedAt
    } catch { return true }
  }

  try {
    proc = Bun.spawn([binary, "run", "--dir", worktree, prompt], { cwd: dir, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] })
    timeout = setTimeout(() => { try { proc.kill() } catch {} }, 120_000)

    // Read stdout/stderr concurrently while the process runs so the
    // streams are consumed in real-time. After exit, the remaining data
    // is already buffered and reads complete near-instantly.
    const stdoutRead = proc.stdout ? readAll(proc.stdout) : Promise.resolve("")
    const stderrRead = proc.stderr ? readAll(proc.stderr) : Promise.resolve("")

    let code = 0

    try {
      code = await proc.exited
    } catch {
      code = -1
    }
    clearTimeout(timeout)

    // Write success/fallback immediately so the TUI panel updates
    // without waiting for the (now nearly-complete) stream reads.
    if (code === 0 && stillCurrent()) {
      await writeDoneState("success", modelID ?? null, 0, 0)
    } else if (stillCurrent()) {
      await writeDoneState("fallback", modelID ?? null, 0, 0)
    }

    try {
      const stdout = await stdoutRead
      const stderr = await stderrRead

      if (code === 0 && stillCurrent()) {
        const p = parseCacheRatio(stdout)
        if (p.text) cache.set(sid, p.text)
        if (p.cacheHit > 0) await writeDoneState("success", modelID ?? null, p.cacheHit, p.cacheMiss)
        await toast(client, "success", "Reasonix", "Refined.", 1500)
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
      const cur = JSON.parse(await Bun.file(STATE_PATH).text())
      if ((cur.interceptionCount ?? 0) <= spawnedAt) {
        await writeDoneState("fallback", modelID ?? null, 0, 0)
      }
    } catch {}
  }
}

export const server: Plugin = (ctx: PluginInput): Hooks => {
  const binary = findReasonix()

  return {
    dispose: async () => { cache.clear() },

    "chat.message": async (input, output) => {
      try {
        if (!input.model || !isDeepseekProvider(input.model.providerID)) {
          await writeEmptyState()
          return
        }
        if (!binary) { await toast(ctx.client, "error", "Reasonix", "binary not found.", 8000); return }

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
        await writeRunningState(input.model.modelID)
        await toast(ctx.client, "info", "Reasonix", "Refining concurrently...", 3000)

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