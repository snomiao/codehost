#!/bin/sh
# codehost installer — https://codehost.dev
#
#   curl -fsSL https://codehost.dev/install.sh | sh
#
# Ensures Bun is installed, installs the `codehost` CLI globally (which fetches
# the native WebRTC binary via Bun's lifecycle scripts), then runs `codehost
# setup` to pick a token, install VS Code, and start a server daemon.
#
# Env overrides:
#   CODEHOST_NO_SETUP=1   install only; don't run `codehost setup`
set -eu

info() { printf '\033[1;36m[codehost]\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m[codehost]\033[0m %s\n' "$1" >&2; }

# Bun installs its global bin here by default; make sure it's on PATH for both
# the bun we may install and the `codehost` we're about to install.
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  info "Bun not found — installing from bun.sh…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bun.sh/install | bash
  else
    err "need curl or wget to install Bun. Install one and re-run."
    exit 1
  fi
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  err "Bun install did not land on PATH. Open a new shell or add $BUN_INSTALL/bin to PATH, then re-run."
  exit 1
fi

info "installing the codehost CLI (bun add -g codehost)…"
bun add -g codehost

if ! command -v codehost >/dev/null 2>&1; then
  err "codehost installed but not on PATH. Add $BUN_INSTALL/bin to your PATH and run: codehost setup"
  exit 1
fi

if [ "${CODEHOST_NO_SETUP:-}" = "1" ]; then
  info "installed. Run \`codehost setup\` in the directory you want to serve."
  exit 0
fi

info "running \`codehost setup\`…"
exec codehost setup
