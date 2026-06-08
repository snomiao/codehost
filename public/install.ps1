# codehost installer / updater — https://codehost.dev
#
#   powershell -c "irm codehost.dev/install.ps1 | iex"
#   powershell -c "irm codehost.dev/setup.ps1   | iex"   # same script, friendlier name
#
# Ensures Bun is installed, installs/UPGRADES the `codehost` CLI globally to the
# latest release (which fetches the native WebRTC binary via Bun's lifecycle
# scripts), then runs `codehost setup` to pick a token, install VS Code, and
# start a server daemon. Safe to re-run any time — it always lands you on the
# newest codehost.
#
# Bun is the runtime and can't be skipped — we bootstrap it and then invoke
# everything by absolute path, so a not-yet-reloaded shell PATH never makes the
# install "fail" after Bun is actually present.
#
# Env override: $env:CODEHOST_NO_SETUP = "1"  -> install/update only, skip setup.

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "[codehost] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[codehost] $m" -ForegroundColor Red; exit 1 }

# Bun installs its global bin under %USERPROFILE%\.bun\bin by default.
$bunBin = Join-Path $env:USERPROFILE ".bun\bin"
$bunExe = Join-Path $bunBin "bun.exe"
if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }

if (-not (Test-Path $bunExe)) {
  Info "Bun not found - installing from bun.sh..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }
}

# Prefer the absolute path; fall back to a PATH lookup in case Bun honored a
# custom install dir. Either way we never bail just because PATH wasn't reloaded.
if (-not (Test-Path $bunExe)) {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if ($cmd) { $bunExe = $cmd.Source }
  else { Fail "Bun was installed but bun.exe wasn't found at $bunBin. Open a new terminal and re-run." }
}

# `@latest` makes every re-run an upgrade, so users always end up on the newest
# codehost instead of a stale globally-pinned copy.
Info "installing the latest codehost CLI (bun add -g codehost@latest)..."
& $bunExe add -g codehost@latest

# Resolve the codehost shim Bun just wrote (extension varies on Windows).
$codehostCmd = Get-Command codehost -ErrorAction SilentlyContinue
if ($codehostCmd) { $codehostExe = $codehostCmd.Source }
elseif (Test-Path (Join-Path $bunBin "codehost.exe")) { $codehostExe = Join-Path $bunBin "codehost.exe" }
else { Fail "codehost installed but not found in $bunBin. Add it to PATH and run: codehost setup" }

if ($env:CODEHOST_NO_SETUP -eq "1") {
  Info "installed/updated. Run ``codehost setup`` in the directory you want to serve."
  exit 0
}

Info "running ``codehost setup``..."
& $codehostExe setup
