#!/usr/bin/env bash
# codehost provisioning hook. Runs on every open of a repo deep link
# BEFORE the editor opens CODEHOST_WS. Keep it idempotent: clone/worktree if
# missing, fast-skip if present. Edit freely (install deps, pull/rebase policy…).
#
# Env in:  CODEHOST_OWNER  CODEHOST_REPO  CODEHOST_BRANCH  CODEHOST_HOST
#          CODEHOST_HOME (this dir)       CODEHOST_WS (the path the editor opens)
#          CODEHOST_TARGET_KIND (repo | folder)  CODEHOST_REPO_KEY (host/owner/repo)
#
# Optional: echo ::codehost:ready={"path":"..."} once the workspace is usable
# to have the editor open early — before this script finishes (e.g. before a
# slow "bun install" below). Without it, the editor opens after this script
# exits, at the path resolved from config.yaml's workspace layout.
set -euo pipefail

ws="$CODEHOST_WS"
if [ -e "$ws/.git" ]; then
  echo "[setup] $ws already provisioned"
  exit 0
fi

# Primary clone = the workspace path minus the /tree/<branch> tail (layout-agnostic).
repo="${ws%/tree/$CODEHOST_BRANCH}"
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
git -C "$repo" worktree add "$ws" "$CODEHOST_BRANCH" \
  || git -C "$repo" worktree add -b "$CODEHOST_BRANCH" "$ws" "origin/$CODEHOST_BRANCH"

# Example: install deps for this worktree (uncomment / edit).
# ( cd "$ws" && bun install )

echo "[setup] ready: $ws"
