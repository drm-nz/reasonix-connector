# Plan: feature/tui-session-id-resolution

## Status

Current phase: cleaned_up

Last updated: 2026-06-07 12:15 NZST

## Branch

- Branch name: `feature/tui-session-id-resolution`
- Dev folder name: `feature_tui-session-id-resolution`

## Goal

Fix the TUI plugin's session-ID resolution so it can display the correct state even when OpenCode starts without `-s`/`--session` flags or `OPENCODE_SESSION_ID` env var.

## Summary of Agreed Approach

Add a multi-source session ID resolution chain to `readSessionState()` in the TUI plugin, with priority:

1. Slot prop `session_id` from `sidebar_content` (most authoritative — OpenCode tells us directly)
2. CLI `-s`/`--session` (explicit user intent)
3. `process.env.OPENCODE_SESSION_ID` (set by opencode spawning the plugin)
4. One-time mtime scan of `/tmp/.reasonix-connector-state-*.json` (last resort, cached forever)
5. Fallthrough to `emptyState`

## High-Level Implementation Plan

### 1. Wire slot prop session_id to View component

Status: completed

Summary: Capture `session_id` from `sidebar_content` slot props and pass it through to the View component so the polling timer can use it.

### 2. Reorder session ID resolution in readSessionState

Status: completed

Summary: Refactor `readSessionState()` to accept an optional session ID argument and use the correct priority chain. Add `discoveredSessionID` module-level cache.

### 3. Add one-time mtime scan fallback

Status: completed

Summary: When no session ID is available from any explicit source, scan `/tmp/` for `.reasonix-connector-state-*.json` files and pick the newest by mtime. Cache the result. This runs at most once.

## Key Decisions

- Slot prop `session_id` is the most authoritative source because OpenCode passes it directly
- CLI args take precedence over env var (explicit user intent > inherited environment)
- mtime scan is a one-time fallback, not polled — avoids race conditions and is only used at startup
- `discoveredSessionID` cache prevents re-scanning on every poll cycle

## Assumptions

- `sidebar_content` slot props include `session_id` (confirmed from @opencode-ai/plugin type definitions)
- The TUI plugin process always has access to `process.argv` and `process.env`

## Out of Scope

- Server plugin changes (not needed for this fix)
- Removing CLI arg / env var lookups (they remain as fallbacks)
- Changing the TUI polling interval or mechanism

## Risks

- If `sidebar_content` slot never renders (e.g., sidebar is hidden), the slot prop is unavailable. Fallback chain covers this.
- mtime scan might pick the wrong file if multiple sessions exist simultaneously. This is mitigated by making it the last resort.

## Resume Notes

Implementation complete. Awaiting user review and approval.
