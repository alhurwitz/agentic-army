#!/usr/bin/env bash
# Installs the army into one or more agent harnesses, installing anything missing first:
# git, a runtime (Bun or Node 22.18+; Node is installed when neither is found), and the CLI
# of each harness you name.
# Usage: ./install.sh [opencode] [claude] [copilot] [codex] [all]
# With no arguments, installs into every harness whose CLI is already on PATH.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
RUN="$REPO/bin/army-run"
BIN="${ARMY_BIN_DIR:-$HOME/.local/bin}"
NODE_DIR="${ARMY_NODE_DIR:-$HOME/.local/share/agentic-army/node}"
NODE_MAJOR="${ARMY_NODE_MAJOR:-24}"

fail() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

sudo_if_needed() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# Installs a system package with whatever package manager this machine has.
pkg_install() {
  if have brew; then brew install "$@"
  elif have apt-get; then sudo_if_needed apt-get update -y && sudo_if_needed apt-get install -y "$@"
  elif have dnf; then sudo_if_needed dnf install -y "$@"
  elif have pacman; then sudo_if_needed pacman -S --noconfirm "$@"
  elif have apk; then sudo_if_needed apk add "$@"
  else return 1
  fi
}

ensure_git() {
  have git && return
  say "installing git"
  if [ "$(uname -s)" = Darwin ] && ! have brew; then
    xcode-select --install || true
    fail "finish the Xcode Command Line Tools install that just opened, then re-run ./install.sh"
  fi
  pkg_install git || fail "could not install git; install it and re-run"
}

# True when bin/army-run finds Bun or a new enough Node.
runtime_ok() { "$RUN" -e '' >/dev/null 2>&1; }

sha256() { if have shasum; then shasum -a 256 "$1"; else sha256sum "$1"; fi | cut -d' ' -f1; }

# Downloads the official Node build into $NODE_DIR (no sudo) and links node/npm/npx into $BIN.
install_node_tarball() {
  local os arch base name tmp sum
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "unsupported OS $(uname -s); install Node $NODE_MAJOR yourself" ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64 | amd64) arch=x64 ;; *) fail "unsupported CPU $(uname -m); install Node $NODE_MAJOR yourself" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  name="$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$name" ] || fail "no Node build for $os-$arch at $base"
  curl -fsSL "$base/$name" -o "$tmp/$name"
  sum="$(grep " $name\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  [ "$(sha256 "$tmp/$name")" = "$sum" ] || fail "checksum mismatch for $name"
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR" "$BIN"
  tar -xzf "$tmp/$name" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  for t in node npm npx; do ln -sf "$NODE_DIR/bin/$t" "$BIN/$t"; done
  export PATH="$NODE_DIR/bin:$PATH"
}

# With no usable runtime, installs Node into $NODE_DIR, a fixed place bin/army-run checks even
# when PATH lacks it (harnesses start hooks with their own PATH).
ensure_runtime() {
  runtime_ok && return
  say "installing Node $NODE_MAJOR into $NODE_DIR"
  have curl || pkg_install curl || fail "curl is needed to download Node"
  install_node_tarball
  runtime_ok || fail "Node install did not work; install Bun or Node 22.18+ yourself and re-run"
}

npm_package() {
  case "$1" in
    opencode) echo opencode-ai ;;
    claude) echo @anthropic-ai/claude-code ;;
    copilot) echo @github/copilot ;;
    codex) echo @openai/codex ;;
  esac
}

# Installs a harness CLI with npm: into npm's global folder when it is writable and on PATH,
# otherwise next to $BIN (e.g. ~/.local/bin). Uses Bun's global install when there is no npm.
ensure_cli() {
  have "$1" && return
  local pkg prefix bun_bin
  pkg="$(npm_package "$1")"
  say "installing $1 ($pkg)"
  [ -x "$NODE_DIR/bin/npm" ] && export PATH="$PATH:$NODE_DIR/bin"
  if ! have npm; then
    bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
    have bun || export PATH="$bun_bin:$PATH"
    have bun || fail "need npm or bun to install $1"
    bun install -g "$pkg"
    export PATH="$bun_bin:$PATH"
    hash -r
    have "$1" || fail "installed $pkg but '$1' was not found"
    return
  fi
  prefix="$(npm prefix -g)"
  if [ -w "$prefix" ] && case ":$PATH:" in *":$prefix/bin:"*) true ;; *) false ;; esac; then
    npm install -g "$pkg"
  else
    mkdir -p "$BIN"
    npm install -g --prefix "$(dirname "$BIN")" "$pkg"
    export PATH="$BIN:$PATH"
  fi
  hash -r
  have "$1" || fail "installed $pkg but '$1' was not found"
}

ensure_git
ensure_runtime

harnesses=("$@")
if [ ${#harnesses[@]} -eq 0 ]; then
  for cli in opencode claude copilot codex; do
    have "$cli" && harnesses+=("$cli")
  done
  [ ${#harnesses[@]} -gt 0 ] || fail "no harness CLI found on PATH. Name one to install it too, e.g. ./install.sh claude (or: opencode, copilot, codex, all)"
fi

targets=()
for h in "${harnesses[@]}"; do
  case "$h" in
    all) targets+=(opencode claude copilot codex) ;;
    opencode | claude | copilot | codex) targets+=("$h") ;;
    *) fail "unknown harness \"$h\" (use opencode, claude, copilot, codex, all)" ;;
  esac
done
for h in "${targets[@]}"; do ensure_cli "$h"; done

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if ! (cd "$REPO" && "$RUN" test >"$log" 2>&1); then
  tail -n 40 "$log" >&2
  fail "tests failed (output above); run 'bin/army-run test' in $REPO"
fi

"$RUN" "$REPO/scripts/setup.ts" install "${harnesses[@]}"

case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: add $BIN to your PATH (e.g. in ~/.zshrc: export PATH=\"$BIN:\$PATH\")" ;; esac
for h in "${targets[@]}"; do
  if [ "$h" = codex ]; then
    echo "note: Codex asks you to trust new hooks; open /hooks in Codex and trust the army hooks."
  fi
done
echo "Done. Restart your agent harness(es): ${targets[*]}"
