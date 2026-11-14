#!/usr/bin/env bash
# Symlinks the army plugin, agents, command, and status CLI into the OpenCode config.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
BIN="${ARMY_BIN_DIR:-$HOME/.local/bin}"

fail() { echo "error: $*" >&2; exit 1; }

command -v bun >/dev/null || fail "bun not found; install it from https://bun.sh"
command -v opencode >/dev/null || fail "opencode not found; install it from https://opencode.ai"
command -v git >/dev/null || fail "git not found"
[ -d "$CONFIG" ] || fail "OpenCode config dir $CONFIG not found; run opencode once or set OPENCODE_CONFIG_DIR"
(cd "$REPO" && bun test tests >/dev/null 2>&1) || fail "tests failed; run 'bun test tests' in $REPO"

mkdir -p "$CONFIG/plugins" "$CONFIG/agents" "$CONFIG/commands" "$BIN"

link() {
  local src="$1" dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    local backup="$CONFIG/.army-backup/$(date +%Y%m%d%H%M%S)"
    mkdir -p "$backup"
    mv "$dest" "$backup/"
    echo "backed up $dest to $backup/"
  fi
  ln -sfn "$src" "$dest"
  echo "linked $dest -> $src"
}

# Remove links from the old command name (alberts-army) if they point into this repo.
for old in "$CONFIG/commands/alberts-army.md" "$BIN/alberts-army-status"; do
  if [ -L "$old" ] && [[ "$(readlink "$old")" == "$REPO"/* ]]; then rm "$old"; echo "removed old link $old"; fi
done

link "$REPO/plugin/army.ts" "$CONFIG/plugins/army.ts"
link "$REPO/plugin/army-tui" "$CONFIG/plugins/army-tui"
link "$REPO/agents/army-officer.md" "$CONFIG/agents/army-officer.md"
link "$REPO/agents/army-soldier.md" "$CONFIG/agents/army-soldier.md"
link "$REPO/commands/army.md" "$CONFIG/commands/army.md"
link "$REPO/bin/army-status.ts" "$BIN/army-status"

case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: $BIN is not on PATH" ;; esac

# Register the TUI plugin in cli.json (backed up first; no-op if already present).
CLI_JSON="$CONFIG/cli.json" TUI_PATH="$CONFIG/plugins/army-tui" bun -e '
  const fs = require("node:fs")
  const file = process.env.CLI_JSON, pkg = process.env.TUI_PATH
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
  data.plugins ??= []
  if (data.plugins.some((p) => p.package === pkg)) process.exit(0)
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-army`)
  data.plugins.push({ package: pkg })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  console.log(`registered TUI plugin in ${file}`)
'

echo "Done. Restart OpenCode to load the plugin."
