#!/usr/bin/env bash
# Removes the army from one or more harnesses. Only removes links that point into this repo and
# config entries the installer added. Run state is kept unless --purge is given.
# Usage: ./uninstall.sh [opencode] [claude] [copilot] [codex] [all] [--purge]   (default: all)
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
STATE="${ARMY_STATE_DIR:-$HOME/.local/share/agentic-army/state}"
LEGACY_STATE="$HOME/.local/share/opencode/army"

RUN="$REPO/bin/army-run"

purge=false
harnesses=()
for arg in "$@"; do
  if [ "$arg" = "--purge" ]; then purge=true; else harnesses+=("$arg"); fi
done

"$RUN" "$REPO/scripts/setup.ts" uninstall "${harnesses[@]+"${harnesses[@]}"}"

if $purge; then
  rm -rf "$STATE"
  echo "removed run state $STATE"
  if [ -z "${ARMY_STATE_DIR:-}" ] && [ -d "$LEGACY_STATE" ]; then rm -rf "$LEGACY_STATE"; echo "removed old run state $LEGACY_STATE"; fi
fi
echo "Done. Restart your agent harness(es)."
