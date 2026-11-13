<#
.SYNOPSIS
  Prepares a development checkout of vrun on Windows.

.DESCRIPTION
  * checks Node.js 20+ and installs the npm dependencies (npm ci)
  * creates .venv with Python 3.12+ and the test libraries
    (python/requirements-dev.txt); a broken .venv, e.g. one copied from
    another machine whose interpreter no longer exists, is rebuilt
  * builds and runs the type check and the Node unit tests

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1 [-Python <python.exe>] [-SkipChecks]

  ASCII only: Windows PowerShell 5.1 misreads UTF-8 scripts without a BOM.
#>
param(
  # Interpreter for .venv. Default: the newest Python 3.12+ from `py` or PATH.
  [string]$Python,
  # Skip the build / type check / unit tests at the end.
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Continue'
$MinPython = [version]'3.12'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root

function Say([string]$Message, [string]$Color = 'Gray') { Write-Host $Message -ForegroundColor $Color }
function Die([string]$Message) { Say "[x] $Message" 'Red'; exit 1 }

function Get-PythonInfo([string]$Exe, [string[]]$PreArgs = @()) {
  $probe = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)"
  $out = & $Exe @PreArgs -c $probe 2>$null
  if ($LASTEXITCODE -ne 0 -or @($out).Count -lt 2) { return $null }
  try { $version = [version]@($out)[0] } catch { return $null }
  return [pscustomobject]@{ Version = $version; Exe = @($out)[1].Trim() }
}

# --- Node.js ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die 'Node.js 20+ is required: winget install -e --id OpenJS.NodeJS.LTS (or https://nodejs.org), then open a new terminal.'
}
$nodeVersion = (& node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { Die "Node.js 20+ is required (found $nodeVersion)." }
Say "[ok] Node.js $nodeVersion ($($node.Source))" 'Green'

Say '== npm ci' 'Cyan'
& npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }

# --- Python .venv -------------------------------------------------------------
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$venvOk = $false
if (Test-Path -LiteralPath $venvPython) {
  $info = Get-PythonInfo $venvPython
  if ($info -and $info.Version -ge $MinPython) {
    $venvOk = $true
    Say "[ok] existing .venv (Python $($info.Version))" 'Green'
  } else {
    Say '[!]  .venv does not start (copied from another machine?) or is older than 3.12; rebuilding it.' 'Yellow'
  }
}

if (-not $venvOk) {
  $base = $null
  if ($Python) {
    $base = Get-PythonInfo $Python
    if (-not $base) { Die "Cannot run $Python" }
  } else {
    $found = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $i = Get-PythonInfo 'py' @('-3'); if ($i) { $found += $i } }
    foreach ($n in 'python', 'python3') {
      $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($c) { $i = Get-PythonInfo $c.Source; if ($i) { $found += $i } }
    }
    $base = $found | Where-Object { $_.Version -ge $MinPython } | Sort-Object Version -Descending | Select-Object -First 1
  }
  if (-not $base -or $base.Version -lt $MinPython) {
    Die "Python $MinPython+ is required: winget install -e --id Python.Python.3.13 (or pass -Python <python.exe>)."
  }
  Say "== creating .venv with $($base.Exe) (Python $($base.Version))" 'Cyan'
  # --clear replaces a broken venv in place.
  & $base.Exe -m venv --clear (Join-Path $root '.venv')
  if ($LASTEXITCODE -ne 0) { Die 'python -m venv failed.' }
}

Say '== installing test libraries (python/requirements-dev.txt)' 'Cyan'
# pip (not uv) on purpose: it pre-compiles bytecode, so a fresh kernel imports
# pandas in about a second instead of several (Live Mode has a 5 s budget).
& $venvPython -m pip install --disable-pip-version-check --upgrade pip | Out-Null
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $root 'python\requirements-dev.txt')
if ($LASTEXITCODE -ne 0) { Die 'pip install failed.' }

# --- checks -----------------------------------------------------------------------
if (-not $SkipChecks) {
  Say '== npm run typecheck' 'Cyan'
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { Die 'typecheck failed.' }
  Say '== npm test' 'Cyan'
  & npm test
  if ($LASTEXITCODE -ne 0) { Die 'unit tests failed.' }
}

Say ''
Say 'Ready. The test scripts use .venv automatically (set PYLIVE_PYTHON to override):' 'Green'
Say '  npm run test:py       pytest'
Say '  npm run test:vscode   integration tests in an Extension Development Host'
Say '  npm run dist          VSIX + installer bundle in dist/'
