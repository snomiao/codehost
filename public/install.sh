#!/bin/sh
# codehost installer / updater — https://codehost.dev
#
#   curl -fsSL https://codehost.dev/install.sh | sh
#   curl -fsSL https://codehost.dev/setup.sh   | sh   # same script, friendlier name
#
# Ensures Bun is installed, installs/UPGRADES the `codehost` CLI globally to the
# latest release (which fetches the native WebRTC binary via Bun's lifecycle
# scripts), then runs `codehost setup` to pick a token, install VS Code, and
# start a server daemon. Safe to re-run any time — it always lands you on the
# newest codehost.
#
# Bun is the runtime (the CLI is TypeScript run by Bun + a native addon), so it
# can't be skipped — but we bootstrap it and then invoke everything by absolute
# path, so a not-yet-reloaded shell PATH never makes the install "fail" after
# Bun is actually present.
#
# Env overrides:
#   CODEHOST_NO_SETUP=1   install/update only; don't run `codehost setup`
set -eu

info() { printf '\033[1;36m[codehost]\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m[codehost]\033[0m %s\n' "$1" >&2; }

# Bun installs its global bin here by default; make sure it's on PATH for both
# the bun we may install and the `codehost` we're about to install.
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

# Resolve a usable bun binary: one already on PATH, or the managed install.
# Echoes the absolute path (empty if none) so callers can invoke it directly.
bun_bin() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
  elif [ -x "$BUN_INSTALL/bin/bun" ]; then
    printf '%s\n' "$BUN_INSTALL/bin/bun"
  fi
}

BUN="$(bun_bin)"
if [ -z "$BUN" ]; then
  info "Bun not found — installing from bun.sh…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bun.sh/install | bash
  else
    err "need curl or wget to install Bun. Install one and re-run."
    exit 1
  fi
  BUN="$(bun_bin)"
fi

if [ -z "$BUN" ]; then
  err "Bun was installed but its binary isn't at $BUN_INSTALL/bin/bun. Set BUN_INSTALL to its location and re-run."
  exit 1
fi

# `@latest` makes every re-run an upgrade, so users always end up on the newest
# codehost instead of a stale globally-pinned copy.
info "installing the latest codehost CLI ($BUN add -g codehost@latest)…"
"$BUN" add -g codehost@latest

CODEHOST="$BUN_INSTALL/bin/codehost"
if [ ! -x "$CODEHOST" ]; then
  CODEHOST="$(command -v codehost || true)"
fi
if [ -z "$CODEHOST" ] || [ ! -x "$CODEHOST" ]; then
  err "codehost installed but not found under $BUN_INSTALL/bin. Add it to PATH and run: codehost setup"
  exit 1
fi

if [ "${CODEHOST_NO_SETUP:-}" = "1" ]; then
  info "installed/updated. Run \`codehost setup\` in the directory you want to serve."
  exit 0
fi

info "running \`codehost setup\`…"
exec "$CODEHOST" setup
