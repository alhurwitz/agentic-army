#!/usr/bin/env bash
# Installs the army into one or more agent harnesses.
# Usage: ./install.sh [opencode] [claude] [copilot] [codex] [all]
# With no arguments, installs into every harness whose CLI is on PATH.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "error: $*" >&2; exit 1; }

RUN="$REPO/bin/army-run"
command -v git >/dev/null || fail "git not found"

harnesses=("$@")
if [ ${#harnesses[@]} -eq 0 ]; then
  for cli in opencode claude copilot codex; do
    command -v "$cli" >/dev/null && harnesses+=("$cli")
  done
  [ ${#harnesses[@]} -gt 0 ] || fail "no supported harness found on PATH (opencode, claude, copilot, codex); pass one explicitly"
fi

(cd "$REPO" && "$RUN" test tests >/dev/null 2>&1) || fail "tests failed; run 'bin/army-run test tests' in $REPO"

"$RUN" "$REPO/scripts/setup.ts" install "${harnesses[@]}"

BIN="${ARMY_BIN_DIR:-$HOME/.local/bin}"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: $BIN is not on PATH" ;; esac
for h in "${harnesses[@]}"; do
  if [ "$h" = codex ] || [ "$h" = all ]; then
    echo "note: Codex asks you to trust new hooks; open /hooks in Codex and trust the army hooks."
  fi
done
echo "Done. Restart your agent harness(es): ${harnesses[*]}"
