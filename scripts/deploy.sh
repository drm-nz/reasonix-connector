#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Reasonix Connector — Deploy / Install Script
#
# Usage:
#   ./scripts/deploy.sh install     # Install plugin files locally for OpenCode
#   ./scripts/deploy.sh publish     # Push + tag for a GitHub release
#   ./scripts/deploy.sh help        # Show this message
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="${OPENCODE_PLUGIN_DIR:-$HOME/.config/opencode/plugins}"
TUI_JSON="${OPENCODE_TUI_JSON:-$HOME/.config/opencode/tui.json}"

SERVER_PLUGIN="$REPO_ROOT/.opencode/plugins/reasonix-connector.ts"
TUI_PLUGIN="$REPO_ROOT/.opencode/plugins/reasonix-connector-tui.tsx"

install() {
  echo "==> Installing Reasonix Connector to $PLUGIN_DIR"

  mkdir -p "$PLUGIN_DIR"

  cp "$SERVER_PLUGIN" "$PLUGIN_DIR/"
  echo "    ✓ Server plugin copied"

  cp "$TUI_PLUGIN" "$PLUGIN_DIR/"
  echo "    ✓ TUI plugin copied"

  # Ensure the TUI plugin is registered in tui.json
  TUI_PLUGIN_PATH="$PLUGIN_DIR/reasonix-connector-tui.tsx"
  if [ -f "$TUI_JSON" ]; then
    # Check if already registered
    if grep -q "$TUI_PLUGIN_PATH" "$TUI_JSON" 2>/dev/null; then
      echo "    ✓ Already registered in $TUI_JSON"
    else
      # Append to existing plugin array, or create
      if grep -q '"plugin"' "$TUI_JSON" 2>/dev/null; then
        # Add to existing array (simple approach)
        cp "$TUI_JSON" "${TUI_JSON}.bak"
        # Use jq if available
        if command -v jq &>/dev/null; then
          jq --arg p "$TUI_PLUGIN_PATH" '.plugin += [$p]' "$TUI_JSON" > "${TUI_JSON}.tmp" && mv "${TUI_JSON}.tmp" "$TUI_JSON"
          echo "    ✓ Registered in $TUI_JSON"
        else
          echo "    ⚠ jq not found. Add this line to $TUI_JSON manually:"
          echo "       \"$TUI_PLUGIN_PATH\""
        fi
      else
        cat > "$TUI_JSON" <<-TUIEOF
{
  "plugin": ["$TUI_PLUGIN_PATH"]
}
TUIEOF
        echo "    ✓ Created $TUI_JSON"
      fi
    fi
  else
    cat > "$TUI_JSON" <<-TUIEOF
{
  "plugin": ["$TUI_PLUGIN_PATH"]
}
TUIEOF
    echo "    ✓ Created $TUI_JSON"
  fi

  echo ""
  echo "==> Done. Restart OpenCode to load the plugins."
}

publish() {
  echo "==> Publishing Reasonix Connector to GitHub"

  cd "$REPO_ROOT"

  # Ensure we're on main and clean
  if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
    echo "    ✗ Not on main branch. Switch to main first."
    exit 1
  fi

  if [ -n "$(git status --porcelain)" ]; then
    echo "    ✗ Working tree is not clean. Commit or stash changes first."
    exit 1
  fi

  # Determine next version (uses last tag, or 0.1.0)
  LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "0.0.0")
  MAJOR=$(echo "$LAST_TAG" | cut -d. -f1)
  MINOR=$(echo "$LAST_TAG" | cut -d. -f2)
  PATCH=$(echo "$LAST_TAG" | cut -d. -f3)
  NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))"

  echo "    Last tag: v$LAST_TAG"
  echo "    Next tag: v$NEXT"
  echo ""

  # Push to GitHub
  echo "==> Pushing to origin/main..."
  git push origin main
  echo "    ✓ Pushed"

  # Tag and push
  echo "==> Tagging v$NEXT..."
  git tag "v$NEXT"
  git push origin "v$NEXT"
  echo "    ✓ Tagged v$NEXT"

  echo ""
  echo "==> Done. GitHub Release will be created at:"
  echo "    https://github.com/drm-nz/reasonix-connector/releases/tag/v$NEXT"
  echo ""
  echo "    To finish, go to that URL and add release notes."
}

help() {
  cat <<-HELP
Usage: $0 <command>

Commands:
  install     Copy plugin files to ~/.config/opencode/plugins/ and
              register the TUI plugin in ~/.config/opencode/tui.json.
              Override dirs with OPENCODE_PLUGIN_DIR and OPENCODE_TUI_JSON.

  publish     Push the latest commit to GitHub and create a new tag,
              triggering a GitHub release.

  help        Show this message.

Examples:
  ./scripts/deploy.sh install
  OPENCODE_PLUGIN_DIR=.opencode/plugins ./scripts/deploy.sh install
  ./scripts/deploy.sh publish
HELP
}

case "${1:-help}" in
  install)  install ;;
  publish)  publish ;;
  help|--help|-h) help ;;
  *)        echo "Unknown command: $1"; help; exit 1 ;;
esac
