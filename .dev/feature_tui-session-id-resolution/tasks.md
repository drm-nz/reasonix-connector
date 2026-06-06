# Tasks: feature/tui-session-id-resolution

## Status

Last updated: 2026-06-07 12:15 NZST

## Task Groups

### 1. Wire slot prop session_id to View component

Related plan section: `1. Wire slot prop session_id to View component`

- [x] Import `readdir` from `node:fs/promises`
- [x] Add `discoveredSessionID` module-level cache variable
- [x] Modify `sidebar_content` slot registration to capture `props.session_id`
- [x] Pass `session_id` through to View component
- [x] Add `createEffect` in View to update signal when slot re-renders

### 2. Reorder session ID resolution in readSessionState

Related plan section: `2. Reorder session ID resolution in readSessionState`

- [x] Refactor `readSessionState` to accept optional `sidOverride` parameter
- [x] Restructure priority: slot→CLI args→env var→mtime scan→emptyState
- [x] Cache discovered session ID on successful lookup

### 3. Add one-time mtime scan fallback

Related plan section: `3. Add one-time mtime scan fallback`

- [x] Implement mtime scan of state files in /tmp/
- [x] Sort by mtime descending, pick latest
- [x] Extract session ID from filename
- [x] Cache in `discoveredSessionID` to prevent re-scanning

## Blockers

- None

## Skipped Tasks

- None

## Completed Tasks

- All implementation tasks complete

## Waiting For

- User review and approval
