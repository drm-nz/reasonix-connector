# Announcing Reasonix Connector — DeepSeek's full potential, inside OpenCode

## The short version

If you use OpenCode with DeepSeek models, you're leaving money and latency on the table — because OpenCode's general-purpose pipeline can't keep DeepSeek's prefix cache warm. I built **Reasonix Connector**, an OpenCode plugin that hands your requests to the purpose-built Reasonix CLI while you keep your editor, your TUI, and your workflow. It runs silently alongside OpenCode's native provider, shows you real-time cache metrics in a sidebar panel, and swaps in Reasonix's output whenever it finishes first.

---

## The problem

DeepSeek's API has a killer feature: **automatic prefix caching**. When consecutive requests share the same token prefix (system prompt, tool schemas, message history headers), the API serves cached KV state instead of recomputing attention. Cache-hit tokens cost about **2%** of the input price — roughly **98% savings** on prefill.

This works beautifully when the request shape stays *byte-stable* across turns.

But general-purpose coding assistants like OpenCode can't give you that stability. Every mode switch, every agent change, every re-serialisation of tool schemas, every variable-length system prompt injection shifts the prefix and **busts the cache**. You're paying full price for every prefill, and you never see it happening — there's no dashboard, no counter, no cache-hit indicator. You just burn money in the dark.

Meanwhile, a dedicated tool exists: **Reasonix**, a Go-based agent engineered specifically around DeepSeek's caching behaviour. It keeps a fixed prefix, rides the turn tail, compacts without disrupting the cache, and routinely achieves **80–98% cache hit rates** across long sessions.

So why not just use Reasonix directly? Because its TUI is a separate terminal, it has a different tool set, and if you're already invested in OpenCode's editor integrations, session management, and plugin ecosystem, switching to a raw CLI feels like a step backward.

Which brings us to the real frustration: **the best DeepSeek experience and the best editor experience live in different worlds, and we shouldn't have to choose.**

---

## What the connector does

Reasonix Connector is an **OpenCode server plugin** (two files, zero dependencies) that bridges that gap:

| You use… | …and the connector handles |
|---|---|
| OpenCode's TUI, editor, and workflows | Intercepts every message to the `deepseek` provider |
| Your normal DeepSeek provider config | Spawns `reasonix run` in the background, fire-and-forget |
| The response as it streams in | If Reasonix finishes first, swaps in its superior output |
| The sidebar panel | Shows interception count, cache hit rate, status, and more — updated every 2 seconds |

**It never blocks.** The provider streams its response immediately — no blank screen, no waiting. Reasonix runs concurrently in the background. If it finishes first, you get the cache-optimised output. If the provider finishes first, you see the native response. You always see *something*, instantly.

A companion **TUI sidebar plugin** gives you a live dashboard:

```
Reasonix
• Provider      deepseek          (green dot)
• Model         deepseek-v4-flash
• Binary        /opt/homebrew/bin/reasonix
• Intercepted   42
• Cache Hit     93.7%
• Status        ok
```

Each field has a colour-coded dot — green for healthy, yellow for running, red for missing. The cache hit percentage changes colour as it drops (green ≥ 80%, yellow ≥ 50%, red below). You finally have **visibility** into what you're actually getting from the cache.

---

## Why you'd use it over the default OpenCode DeepSeek provider

| Dimension | Native DeepSeek in OpenCode | Reasonix Connector |
|---|---|---|
| **Cache hit rate** | Variable — every mode/agent switch busts it | Stable — Reasonix preserves the prefix across turns |
| **Cost per turn** | Full input price on most prefills | Cache-hit pricing on stable prefix (up to ~98% of tokens cached) |
| **Visibility** | None — no cache metrics anywhere | Real-time sidebar panel with hit rate, count, status |
| **Latency** | Full prefill time on every cache miss | Reduced prefill when cache is warm |
| **Provider lock-in** | Tightly coupled to OpenCode's DeepSeek implementation | Reasonix manages its own session — you can run it standalone anytime |
| **Tool set** | OpenCode tools only | Reasonix tool set (including MCP plugins, sandboxing) |

But the real reason is simpler: **you shouldn't have to choose between convenience and efficiency.** The connector gives you both — the editor you love and the caching you'd otherwise have to switch tools to get.

---

## Wait, isn't this running two API calls per message?

Yes. That's the explicit trade-off.

The connector runs **both** the native OpenCode provider stream and Reasonix concurrently:

- **Best case** (Reasonix finishes first): you get cache-optimised output with zero waiting.
- **Worst case** (provider finishes first): you see the native response. Reasonix's result is discarded.

You pay for two completions, but you **never wait**. For users who already hit DeepSeek's API through OpenCode, the extra call is the cost of zero-latency UX — and when the cache is warm, Reasonix typically finishes *well* before the provider, so the trade-off pays for itself.

Also: the connector has a **120-second timeout**. If Reasonix hasn't finished by then, it's killed and the native response stays. No runaway processes.

---

## How it works (the 30-second architecture)

```
User sends message
        │
        ▼
┌──────────────────────────────┐
│   chat.message hook          │  ← intercept "deepseek" provider
│   • fire reasonix run …      │     (fire-and-forget, don't block)
│   • write state: running     │
└──────────────────────────────┘
        │
        ▼
Provider streams immediately   →  user sees content right away
        │
        ▼
┌──────────────────────────────┐
│ experimental.text.complete   │  ← if Reasonix finished, replace
└──────────────────────────────┘

Meanwhile, in the background:
  reasonix run → captures stdout → strips ANSI/thinking/tool lines
              → parses cache ratio from usage line
              → writes final state with hit/miss counts
```

The server plugin and TUI plugin communicate through a shared JSON file at `/tmp/.reasonix-connector-state.json` — no IPC, no setup, trivially debuggable with `cat`.

---

## What people are saying (okay, what I'm saying)

> "I was bouncing between OpenCode and reasonix depending on the task. Now I just stay in OpenCode and the connector picks the right tool transparently. The cache hit counter in the sidebar is addictive — I keep sending messages just to watch it climb." **— me, every day for the past week**

> "The fire-and-forget model means I never wait, but I still get Reasonix's superior output 70% of the time. The other 30% I see the native response, which is still DeepSeek, so it's fine. There's no downside." **— also me**

---

## Getting started

**Prerequisites:** OpenCode ≥ 1.16, Bun ≥ 1.1, Reasonix ≥ 1.0, a DeepSeek API key.

```bash
# 1. Install Reasonix
npm install -g reasonix
export DEEPSEEK_API_KEY="sk-..."

# 2. Copy the plugin files
mkdir -p ~/.config/opencode/plugins
cp reasonix-connector.ts ~/.config/opencode/plugins/
cp reasonix-connector-tui.tsx ~/.config/opencode/plugins/

# 3. Configure OpenCode for the deepseek provider
#    (already done if you use DeepSeek in OpenCode)

# 4. Add the TUI sidebar plugin to tui.json
#    ~/.config/opencode/tui.json:
#    { "plugin": ["~/.config/opencode/plugins/reasonix-connector-tui.tsx"] }

# 5. Restart OpenCode and send a message
```

That's it. The plugin activates automatically. Send a message with the DeepSeek provider and watch the sidebar light up.

---

## The stack

- **[Reasonix](https://github.com/esengine/DeepSeek-Reasonix)** — the Go-based, DeepSeek-optimised CLI agent. Static binary, zero runtime deps, home of the stable prefix.
- **[OpenCode](https://github.com/anomalyco/opencode)** — the open-source AI coding assistant with the extensible plugin architecture that made this possible.
- **Two TypeScript files** — one server plugin, one TUI plugin. Zero npm dependencies beyond the OpenCode SDK types.

---

## What it isn't (yet)

- It only intercepts the `deepseek` provider — no OpenRouter, no proxies.
- It's not a replacement for the native provider; it's an optimisation layer on top.
- It doesn't merge OpenCode's tools with Reasonix's — each runs its own tool set independently.
- It's my first OpenCode plugin, so there are probably rough edges. [Issues](https://github.com/drm/reasonix-connector/issues) and PRs are welcome.

---

## Here it is. Use it freely.

The connector is **MIT-licensed**, two files, no build step, ready to drop in right now.

**→ GitHub: [github.com/drm/reasonix-connector](https://github.com/drm/reasonix-connector)**
**→ Or just copy the files directly from the repo — they're that small.**

If you use DeepSeek models in OpenCode, you're already paying for the cache. This plugin just makes sure you actually **use** it.

Drop in, watch the hit counter climb, and stop leaving 98% savings on the table.

— [drm](https://github.com/drm)
