import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Scaffolds a home's `.codehost/` config dir: an editable, idempotent setup hook
// (run on every repo open) plus a config.yaml. Provisioning is opt-in by these
// files existing — `codehost init` is how you opt in.

const CONFIG_YAML = `# codehost workspace config — see docs/provisioning.md

# Where /gh/<owner>/<repo>/tree/<branch> lands, relative to this served root
# (serve a dedicated workspace dir like ~/ws — never \$HOME itself).
workspace: "{owner}/{repo}/tree/{branch}"

# Optional: only these repos may auto-provision (a trailing /* is an owner
# wildcard). Empty/absent = allow all. The room token already grants access, so
# this is extra hardening, not the primary gate.
# allowlist:
#   - github.com/snomiao/*
`;

const SETUP_SH = `#!/usr/bin/env bash
# codehost provisioning hook. Runs on every open of /gh/<owner>/<repo>/tree/<branch>
# BEFORE the editor opens CODEHOST_WS. Keep it idempotent: clone/worktree if
# missing, fast-skip if present. Edit freely (install deps, pull/rebase policy…).
#
# Env in:  CODEHOST_OWNER  CODEHOST_REPO  CODEHOST_BRANCH  CODEHOST_HOST
#          CODEHOST_HOME (this dir)       CODEHOST_WS (the path the editor opens)
set -euo pipefail

ws="$CODEHOST_WS"
if [ -e "$ws/.git" ]; then
  echo "[setup] $ws already provisioned"
  exit 0
fi

# Primary clone = the workspace path minus the /tree/<branch> tail (layout-agnostic).
repo="\${ws%/tree/$CODEHOST_BRANCH}"
url="https://$CODEHOST_HOST/$CODEHOST_OWNER/$CODEHOST_REPO.git"

if [ ! -e "$repo/.git" ]; then
  echo "[setup] cloning $url"
  mkdir -p "$(dirname "$repo")"
  git clone "$url" "$repo"
  # Detach the fresh primary clone so EVERY branch (incl. the default one it
  # just checked out) can be worktree-added under tree/<branch>. Skipped for
  # pre-existing clones — they may be someone's live working copy.
  git -C "$repo" switch --detach
fi

echo "[setup] adding worktree $ws @ $CODEHOST_BRANCH"
mkdir -p "$(dirname "$ws")"
git -C "$repo" fetch --quiet origin "$CODEHOST_BRANCH" || true
git -C "$repo" worktree add "$ws" "$CODEHOST_BRANCH" \\
  || git -C "$repo" worktree add -b "$CODEHOST_BRANCH" "$ws" "origin/$CODEHOST_BRANCH"

# Example: install deps for this worktree (uncomment / edit).
# ( cd "$ws" && bun install )

echo "[setup] ready: $ws"
`;

const SETUP_PS1 = `# codehost provisioning hook (Windows). See setup.sh for the contract.
$ErrorActionPreference = "Stop"
$ws = $env:CODEHOST_WS
if (Test-Path (Join-Path $ws ".git")) { Write-Host "[setup] $ws already provisioned"; exit 0 }

$repo = $ws -replace "[\\\\/]tree[\\\\/]$([regex]::Escape($env:CODEHOST_BRANCH))$", ""
$url = "https://$($env:CODEHOST_HOST)/$($env:CODEHOST_OWNER)/$($env:CODEHOST_REPO).git"

if (-not (Test-Path (Join-Path $repo ".git"))) {
  Write-Host "[setup] cloning $url"
  New-Item -ItemType Directory -Force -Path (Split-Path $repo) | Out-Null
  git clone $url $repo
  # Detach so every branch (incl. the default) can be worktree-added.
  git -C $repo switch --detach
}
Write-Host "[setup] adding worktree $ws @ $($env:CODEHOST_BRANCH)"
New-Item -ItemType Directory -Force -Path (Split-Path $ws) | Out-Null
git -C $repo worktree add $ws $env:CODEHOST_BRANCH
Write-Host "[setup] ready: $ws"
`;

const FILES: Array<{ rel: string; body: string; exec?: boolean }> = [
  { rel: "config.yaml", body: CONFIG_YAML },
  { rel: "setup.sh", body: SETUP_SH, exec: true },
  { rel: "setup.ps1", body: SETUP_PS1 },
];

/** Write `<homeDir>/.codehost/{config.yaml,setup.sh,setup.ps1}`. Existing files
 *  are kept unless `force`. Returns the list of files actually written. */
export function scaffoldCodehost(homeDir: string, force = false): string[] {
  const dir = join(homeDir, ".codehost");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const f of FILES) {
    const path = join(dir, f.rel);
    if (existsSync(path) && !force) continue;
    writeFileSync(path, f.body);
    if (f.exec) {
      try {
        chmodSync(path, 0o755);
      } catch {
        // non-POSIX fs — ignore
      }
    }
    written.push(path);
  }
  return written;
}
