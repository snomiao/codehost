# codehost provisioning hook (Windows). See setup.sh for the full contract
# (env vars in, optional ::codehost:ready early-open sentinel).
$ErrorActionPreference = "Stop"
$ws = $env:CODEHOST_WS
if (Test-Path (Join-Path $ws ".git")) { Write-Host "[setup] $ws already provisioned"; exit 0 }

$repo = $ws -replace "[\\/]tree[\\/]$([regex]::Escape($env:CODEHOST_BRANCH))$", ""
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
