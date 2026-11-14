#!/usr/bin/env bash
# Removes the links install.sh created. Only removes symlinks that point into this repo.
# Run state in ~/.local/share/opencode/army is kept unless --purge is given.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${ARMY_BIN_DIR:-$HOME/.local/bin}"
STATE="${ARMY_STATE_DIR:-$HOME/.local/share/opencode/army}"

unlink_if_ours() {
  local dest="$1"
  if [ -L "$dest" ] && [[ "$(readlink "$dest")" == "$REPO"/* ]]; then
    rm "$dest"
    echo "removed $dest"
  elif [ -e "$dest" ]; then
    echo "skipped $dest (not a link into $REPO)"
  fi
}

unlink_if_ours "$CONFIG/plugins/army.ts"
unlink_if_ours "$CONFIG/plugins/army-tui"
unlink_if_ours "$CONFIG/agents/army-officer.md"
unlink_if_ours "$CONFIG/agents/army-soldier.md"
unlink_if_ours "$CONFIG/commands/alberts-army.md"
unlink_if_ours "$BIN/alberts-army-status"

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$STATE"
  echo "removed run state $STATE"
fi

echo "Done. Restart OpenCode."
