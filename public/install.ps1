# codehost installer — https://codehost.dev
#
#   powershell -c "irm codehost.dev/install.ps1 | iex"
#
# Ensures Bun is installed, installs the `codehost` CLI globally (which fetches
# the native WebRTC binary via Bun's lifecycle scripts), then runs `codehost
# setup` to pick a token, install VS Code, and start a server daemon.
#
# Env override: $env:CODEHOST_NO_SETUP = "1"  -> install only, skip setup.

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "[codehost] $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "[codehost] $m" -ForegroundColor Red; exit 1 }

# Bun installs its global bin under %USERPROFILE%\.bun\bin by default.
$bunBin = Join-Path $env:USERPROFILE ".bun\bin"
if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Info "Bun not found - installing from bun.sh..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Fail "Bun install did not land on PATH. Open a new terminal and re-run."
}

Info "installing the codehost CLI (bun add -g codehost)..."
bun add -g codehost

if (-not (Get-Command codehost -ErrorAction SilentlyContinue)) {
  Fail "codehost installed but not on PATH. Add $bunBin to PATH and run: codehost setup"
}

if ($env:CODEHOST_NO_SETUP -eq "1") {
  Info "installed. Run ``codehost setup`` in the directory you want to serve."
  exit 0
}

Info "running ``codehost setup``..."
codehost setup
