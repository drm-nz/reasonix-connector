/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { readFile, writeFile, stat, readdir } from "node:fs/promises"

const STATE_DIR = "/tmp"
const STATE_PREFIX = ".reasonix-connector-state-"
const TUI_ACTIVE_FILE = `${STATE_DIR}/.reasonix-connector-tui-active`
const POLL_MS = 2000

interface StateSnapshot {
  interceptionCount: number
  lastInterception: number | null
  lastStatus: "success" | "fallback" | "running"
  lastModel: string | null
  lastCacheHit: number | null
  lastCacheMiss: number | null
}

let discoveredSessionID: string | null = null

const emptyState: StateSnapshot = {
  interceptionCount: 0,
  lastInterception: null,
  lastStatus: "success",
  lastModel: null,
  lastCacheHit: null,
  lastCacheMiss: null,
}

function statePath(sessionID: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `${STATE_DIR}/${STATE_PREFIX}${safe}.json`
}

async function readFileText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8") } catch { return null }
}

async function readSessionState(sidOverride?: string | null): Promise<StateSnapshot> {
  const sid = sidOverride
    ?? findSessionInArgv()
    ?? process.env.OPENCODE_SESSION_ID
    ?? discoveredSessionID
    ?? await scanLatestStateFile()

  if (sid) {
    const text = await readFileText(statePath(sid))
    if (text) {
      discoveredSessionID = sid
      return JSON.parse(text) as StateSnapshot
    }
  }
  return emptyState
}

function findSessionInArgv(): string | undefined {
  const a = process.argv
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] === "-s" || a[i] === "--session") return a[i + 1]
  }
}

async function scanLatestStateFile(): Promise<string | null | undefined> {
  try {
    const entries = await readdir(STATE_DIR)
    const stateFiles = entries
      .filter(f => f.startsWith(STATE_PREFIX) && f.endsWith(".json"))
      .map(f => `${STATE_DIR}/${f}`)
    if (stateFiles.length === 0) return undefined

    const times = await Promise.all(stateFiles.map(async (p) => {
      try { return { path: p, mtime: (await stat(p)).mtimeMs } } catch { return null }
    }))
    const latest = times.filter(Boolean).sort((a, b) => b!.mtime - a!.mtime)[0]
    if (!latest) return undefined

    const name = latest.path.slice(STATE_DIR.length + 1)
    const extracted = name.slice(STATE_PREFIX.length, -".json".length)
    discoveredSessionID = extracted
    return extracted
  } catch {
    return undefined
  }
}

async function findBinary(): Promise<string | undefined> {
  const candidates = [
    ...((process.env.PATH ?? "").split(":").map((d) => `${d}/reasonix`)),
    "/opt/homebrew/bin/reasonix",
    `${process.env.HOME}/.local/bin/reasonix`,
    `${process.env.HOME}/.bun/bin/reasonix`,
  ]
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c)) continue
    seen.add(c)
    try {
      const s = await stat(c)
      if (s.isFile() && s.size > 0) return c
    } catch {}
  }
}

function View(props: { api: TuiPluginApi; sessionID: string | null }) {
  const theme = () => props.api.theme.current
  const [snap, setSnap] = createSignal<StateSnapshot>(emptyState)
  const [binary, setBinary] = createSignal<string | undefined>()
  const [sid, setSid] = createSignal<string | null>(props.sessionID)

  createEffect(() => {
    if (props.sessionID) setSid(props.sessionID)
  })

  findBinary().then(setBinary)

  const timer = setInterval(async () => {
    setSnap(await readSessionState(sid()))
    setBinary(await findBinary())
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const hasDeepseek = createMemo(() =>
    props.api.state.provider.some((p) => p.id === "deepseek"),
  )

  const isDeepseekModel = createMemo(() => {
    const m = snap().lastModel
    return m != null && m.toLowerCase().includes("deepseek")
  })

  const modelColor = createMemo(() =>
    isDeepseekModel() ? theme().success : theme().textMuted,
  )

  const interceptedColor = createMemo(() =>
    snap().interceptionCount > 0 ? theme().success : theme().textMuted,
  )

  const cacheRate = createMemo(() => {
    const hit = snap().lastCacheHit
    const miss = snap().lastCacheMiss
    if (hit == null || miss == null) return null
    const t = hit + miss
    if (t === 0) return null
    return (hit / t * 100).toFixed(1)
  })

  const cacheDotColor = createMemo(() => {
    const r = cacheRate()
    if (r == null) return theme().textMuted
    return parseFloat(r) > 0 ? theme().success : theme().textMuted
  })

  const cacheTextColor = createMemo(() => {
    const r = cacheRate()
    if (r == null) return theme().textMuted
    const v = parseFloat(r)
    if (v >= 80) return theme().success
    if (v >= 50) return theme().warning
    return theme().error
  })

  const binaryColor = createMemo(() =>
    binary() ? theme().success : theme().error,
  )

  const statusColor = createMemo(() => {
    if (!snap().lastInterception) return theme().textMuted
    if (snap().lastStatus === "running") return theme().warning
    return snap().lastStatus === "success" ? theme().success : theme().textMuted
  })

  return (
    <box>
      <box flexDirection="row" gap={1}>
        <text fg={theme().text} bold>Reasonix</text>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={hasDeepseek() ? theme().success : theme().textMuted}>•</text>
        <text fg={theme().text}>Provider</text>
        <Show when={hasDeepseek()} fallback={<text fg={theme().textMuted}>—</text>}>
          <text fg={theme().textMuted}>deepseek</text>
        </Show>
      </box>
      <Show when={snap().lastModel}>
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} fg={modelColor()}>•</text>
          <text fg={theme().text}>Model</text>
          <text fg={theme().textMuted}>{snap().lastModel}</text>
        </box>
      </Show>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={binaryColor()}>•</text>
        <text fg={theme().text}>Binary</text>
        <Show when={binary()} fallback={<text fg={theme().error}>not found</text>}>
          <text fg={theme().textMuted}>{binary()}</text>
        </Show>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={interceptedColor()}>•</text>
        <text fg={theme().text}>Intercepted</text>
        <Show when={snap().interceptionCount > 0} fallback={<text fg={theme().textMuted}>No</text>}>
          <text fg={theme().textMuted}>{snap().interceptionCount}</text>
        </Show>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={snap().lastStatus === "running" ? theme().warning : cacheDotColor()}>•</text>
        <text fg={theme().text}>Cache Hit</text>
        <Show when={snap().lastStatus !== "running"} fallback={<text fg={theme().warning}>~</text>}>
          <Show when={cacheRate() !== null} fallback={
            snap().interceptionCount === 0
              ? <text fg={theme().textMuted}>~</text>
              : <text fg={theme().textMuted}>0%</text>
          }>
            <text fg={cacheTextColor()}>{cacheRate()}%</text>
          </Show>
        </Show>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={statusColor()}>•</text>
        <text fg={theme().text}>Status</text>
        <Show when={snap().lastInterception} fallback={<text fg={theme().textMuted}>waiting</text>}>
          <Show when={snap().lastStatus === "success"} fallback={
            <Show when={snap().lastStatus === "running"} fallback={<text fg={theme().textMuted}>waiting</text>}>
              <text fg={theme().warning}>running</text>
            </Show>
          }>
            <text fg={theme().success}>ok</text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  try { await writeFile(TUI_ACTIVE_FILE, "1") } catch {}

  api.lifecycle.onDispose(async () => {
    try { await writeFile(TUI_ACTIVE_FILE, "") } catch {}
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(props: { session_id: string }) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "reasonix-connector-tui",
  tui,
}

export default plugin
