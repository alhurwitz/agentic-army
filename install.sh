#!/usr/bin/env bash
# Symlinks the army plugin, agents, command, and status CLI into the OpenCode config.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${ARMY_BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$CONFIG/plugins" "$CONFIG/agents" "$CONFIG/commands" "$BIN"

link() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    mv "$dest" "$dest.bak.$(date +%s)"
    echo "backed up $dest"
  fi
  ln -sfn "$src" "$dest"
  echo "linked $dest -> $src"
}

link "$REPO/plugin/army.ts" "$CONFIG/plugins/army.ts"
link "$REPO/plugin/army-tui" "$CONFIG/plugins/army-tui"
link "$REPO/agents/army-officer.md" "$CONFIG/agents/army-officer.md"
link "$REPO/agents/army-soldier.md" "$CONFIG/agents/army-soldier.md"
link "$REPO/commands/alberts-army.md" "$CONFIG/commands/alberts-army.md"
link "$REPO/bin/army-status.ts" "$BIN/alberts-army-status"

echo "Done. Restart OpenCode to load the plugin."
