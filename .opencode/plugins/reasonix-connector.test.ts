/**
 * Unit tests for Reasonix Connector server plugin.
 *
 * Run with:  cd .opencode && bun test
 *
 * These tests exercise the pure-logic functions and state I/O without
 * requiring the OpenCode host app or the `reasonix` binary.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { unlinkSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  isDeepseekProvider,
  parseCacheRatio,
  readAll,
  writeRunningState,
  writeDoneState,
} from "./reasonix-connector"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A tiny ReadableStream helper that yields Uint8Array chunks. */
function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

// ---------------------------------------------------------------------------
// isDeepseekProvider
// ---------------------------------------------------------------------------
describe("isDeepseekProvider", () => {
  test("returns true for 'deepseek'", () => {
    expect(isDeepseekProvider("deepseek")).toBe(true)
  })

  test("returns true for 'DEEPSEEK'", () => {
    expect(isDeepseekProvider("DEEPSEEK")).toBe(true)
  })

  test("returns true for 'DeepSeek'", () => {
    expect(isDeepseekProvider("DeepSeek")).toBe(true)
  })

  test("returns false for 'openai'", () => {
    expect(isDeepseekProvider("openai")).toBe(false)
  })

  test("returns false for undefined", () => {
    expect(isDeepseekProvider(undefined)).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isDeepseekProvider("")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseCacheRatio  — the most valuable tests
// ---------------------------------------------------------------------------
describe("parseCacheRatio", () => {
  // ---- Happy paths -------------------------------------------------------

  test("extracts text and cache numbers from typical output", () => {
    const output = [
      "  ▎ thinking The user wants to refactor the function…",
      "  ▎ thinking This is a straightforward change…",
      "",
      "Here is the refactored function:",
      "```go",
      "func foo() { return 42 }",
      "```",
      "  · 150 tok · in 3 (120 cached / 30 new)",
    ].join("\n")

    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(120)
    expect(result.cacheMiss).toBe(30)
    expect(result.text).toContain("Here is the refactored function:")
    expect(result.text).toContain("func foo()")
    expect(result.text).not.toContain("▎ thinking")
    expect(result.text).not.toContain("· 150 tok")
  })

  test("handles output with no usage line", () => {
    const output = "Simple response without stats."
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(0)
    expect(result.cacheMiss).toBe(0)
    expect(result.text).toBe("Simple response without stats.")
  })

  test("handles empty output", () => {
    const result = parseCacheRatio("")
    expect(result.cacheHit).toBe(0)
    expect(result.cacheMiss).toBe(0)
    expect(result.text).toBe("")
  })

  test("handles output with only a usage line", () => {
    const output = "  · 42 tok · in 1 (40 cached / 2 new)"
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(40)
    expect(result.cacheMiss).toBe(2)
    // The usage line itself is filtered out
    expect(result.text).toBe("")
  })

  test("extracts last segment after multiple thinking blocks", () => {
    const output = [
      "  ▎ thinking First reasoning block",
      "  ▎ thinking Second reasoning block",
      "",
      "Final answer after reasoning.",
      "  · 200 tok · in 4 (180 cached / 20 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.text).toBe("Final answer after reasoning.")
    expect(result.cacheHit).toBe(180)
    expect(result.cacheMiss).toBe(20)
  })

  // ---- Stripping / filtering --------------------------------------------

  test("strips ANSI escape sequences before parsing", () => {
    const output = [
      "\x1b[32m  ▎ thinking\x1b[0m Some reasoning",
      "\x1b[34mFinal answer\x1b[0m",
      "  \x1b[90m· 100 tok · in 2 (90 cached / 10 new)\x1b[0m",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(90)
    expect(result.cacheMiss).toBe(10)
    expect(result.text).toBe("Final answer")
  })

  test("filters out tool-call lines (-> prefix)", () => {
    const output = [
      "  ▎ thinking I should call a tool",
      "  -> getWeather(location=NYC)",
      "  ⊘ Tool completed: getWeather",
      "The weather is sunny.",
      "  · 50 tok · in 1 (40 cached / 10 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.text).not.toContain("-> getWeather")
    expect(result.text).not.toContain("⊘ Tool completed")
    expect(result.text).toBe("The weather is sunny.")
  })

  test("filters out empty lines after trimming", () => {
    const output = [
      "  ▎ thinking Hmm…",
      "",
      "  ",
      "\t",
      "Result line.",
      "  · 30 tok · in 1 (20 cached / 10 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.text).toBe("Result line.")
  })

  // ---- Edge cases --------------------------------------------------------

  test("handles zero cache numbers", () => {
    const output = [
      "No cache available.",
      "  · 10 tok · in 1 (0 cached / 10 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(0)
    expect(result.cacheMiss).toBe(10)
    expect(result.text).toBe("No cache available.")
  })

  test("handles large cache numbers", () => {
    const output = [
      "Big output.",
      "  · 999999 tok · in 42 (888888 cached / 111111 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(888888)
    expect(result.cacheMiss).toBe(111111)
    expect(result.text).toBe("Big output.")
  })

  test("handles malformed usage line gracefully (falls back to 0/0)", () => {
    const output = [
      "Some text.",
      "  · abc tok · in def (xyz cached / wut new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    expect(result.cacheHit).toBe(0)
    expect(result.cacheMiss).toBe(0)
    expect(result.text).toBe("Some text.")
  })

  test("handles output with many newlines and whitespace", () => {
    const output =
      "\n\n  \n  ▎ thinking Thinking\n\n\nFinal\n\n  · 10 tok · in 1 (5 cached / 5 new)\n\n"
    const result = parseCacheRatio(output)
    expect(result.text).toBe("Final")
    expect(result.cacheHit).toBe(5)
    expect(result.cacheMiss).toBe(5)
  })

  test("prose containing numbers that look like cache stats is not parsed", () => {
    const output = [
      "The function processed 200 items with 150 cache hits.",
      "  · 300 tok · in 5 (250 cached / 50 new)",
    ].join("\n")
    const result = parseCacheRatio(output)
    // The usage-line regex anchors on "· N tok · in N" so it won't match prose
    expect(result.cacheHit).toBe(250)
    expect(result.cacheMiss).toBe(50)
    expect(result.text).toContain("The function processed 200 items")
  })
})

// ---------------------------------------------------------------------------
// readAll  (stream utility)
// ---------------------------------------------------------------------------
describe("readAll", () => {
  test("reads a single chunk", async () => {
    const s = streamFrom([new TextEncoder().encode("hello")])
    expect(await readAll(s)).toBe("hello")
  })

  test("reads multiple chunks", async () => {
    const s = streamFrom([
      new TextEncoder().encode("He"),
      new TextEncoder().encode("llo "),
      new TextEncoder().encode("World"),
    ])
    expect(await readAll(s)).toBe("Hello World")
  })

  test("returns empty string for empty stream", async () => {
    const s = streamFrom([])
    expect(await readAll(s)).toBe("")
  })

  test("handles chunks of varying sizes including empty chunks", async () => {
    const s = streamFrom([
      new TextEncoder().encode("a"),
      new TextEncoder().encode(""),
      new TextEncoder().encode("bc"),
      new TextEncoder().encode(""),
      new TextEncoder().encode("defghij"),
    ])
    expect(await readAll(s)).toBe("abcdefghij")
  })

  test("handles unicode characters spanning chunk boundaries", async () => {
    // 3-byte UTF-8 sequence split across chunks
    const s = streamFrom([
      new Uint8Array([0xE2, 0x82]), // first 2 bytes of € (U+20AC)
      new Uint8Array([0xAC]),        // last byte
      new TextEncoder().encode(" cost 5€"),
    ])
    expect(await readAll(s)).toBe("€ cost 5€")
  })
})

// ---------------------------------------------------------------------------
// State I/O integration tests  (write / read JSON state files)
// ---------------------------------------------------------------------------
describe("State file I/O", () => {
  // Use a temp directory so tests don't clobber the real state file.
  const testDir = join(tmpdir(), "reasonix-connector-test")
  const testPath = join(testDir, "state.json")

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    try { unlinkSync(testPath) } catch {}
  })

  afterEach(() => {
    try { unlinkSync(testPath) } catch {}
  })

  test("writeRunningState creates file with correct fields", async () => {
    await writeRunningState(testPath, 5, "deepseek-r1")
    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.interceptionCount).toBe(5)
    expect(raw.lastStatus).toBe("running")
    expect(raw.lastModel).toBe("deepseek-r1")
    expect(raw.lastCacheHit).toBeNull()
    expect(raw.lastInterception).toBeGreaterThan(0)
  })

  test("writeRunningState writes to a custom path", async () => {
    // Verify the function accepts a path argument (it delegates to Bun.write)
    await writeRunningState(testPath, 3, null)
    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.interceptionCount).toBe(3)
    expect(raw.lastModel).toBeNull()
  })

  test("writeDoneState preserves interceptionCount from existing file", async () => {
    // First write a "running" state
    await writeRunningState(testPath, 7, "deepseek-r1")
    // Then write a done state — it should read interceptionCount from the file
    await writeDoneState(testPath, "success", "deepseek-r1", 90, 10)

    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.interceptionCount).toBe(7) // preserved from previous write
    expect(raw.lastStatus).toBe("success")
    expect(raw.lastCacheHit).toBe(90)
    expect(raw.lastCacheMiss).toBe(10)
  })

  test("writeDoneState coerces zero cache values to null", async () => {
    await writeRunningState(testPath, 1, "deepseek-r1")
    await writeDoneState(testPath, "success", "deepseek-r1", 0, 0)

    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.lastCacheHit).toBeNull()
    expect(raw.lastCacheMiss).toBeNull()
  })

  test("writeDoneState with fallback status", async () => {
    await writeRunningState(testPath, 2, "deepseek-r1")
    await writeDoneState(testPath, "fallback", "deepseek-r1", 0, 0)

    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.lastStatus).toBe("fallback")
  })

  test("writeDoneState handles missing file gracefully (no previous state)", async () => {
    await writeDoneState(testPath, "success", "deepseek-r1", 10, 5)

    const raw = JSON.parse(await Bun.file(testPath).text())
    expect(raw.interceptionCount).toBe(0) // defaults to 0
    expect(raw.lastStatus).toBe("success")
  })
})
