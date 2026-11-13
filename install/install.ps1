<#
.SYNOPSIS
  Installs the vrun VS Code extension on a Windows machine.

.DESCRIPTION
  1. Finds VS Code (offers to install it with winget when it is missing).
  2. Finds Python 3.12+ (offers to install Python 3.13 with winget when missing).
  3. Offers to install pandas, numpy, matplotlib, openpyxl, scikit-learn and
     tqdm into that Python.
  4. Removes the extension's old names (PyLive, Veil), installs the Python
     extension (interpreter picker) and the vrun VSIX next to this script.

  Double-click install.cmd, or run:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Yes] [-NoLibraries] [-Vsix <file>]

  The file is ASCII on purpose: Windows PowerShell 5.1 misreads UTF-8 scripts
  without a BOM.
#>
param(
  [string]$Vsix,
  # Answer "yes" to every question (unattended install).
  [switch]$Yes,
  # Do not offer to install pandas / numpy / matplotlib / openpyxl / scikit-learn / tqdm.
  [switch]$NoLibraries
)

# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native tool writing to
# stderr would otherwise abort the script. Exit codes are checked instead.
$ErrorActionPreference = 'Continue'
$MinPython = [version]'3.12'
# import name -> pip name (scikit-learn is imported as sklearn)
$Libraries = [ordered]@{ pandas = 'pandas'; numpy = 'numpy'; matplotlib = 'matplotlib'; openpyxl = 'openpyxl'; sklearn = 'scikit-learn'; tqdm = 'tqdm' }
$OldExtensions = @('pylive-local.pylive-inspector', 'veil-local.veil')
$script:problems = 0

function Say([string]$Message, [string]$Color = 'Gray') { Write-Host $Message -ForegroundColor $Color }
function Step([string]$Message) { Say ''; Say "== $Message" 'Cyan' }
function Ok([string]$Message) { Say "   [ok] $Message" 'Green' }
function Warn([string]$Message) { Say "   [!]  $Message" 'Yellow' }
function Fail([string]$Message) { Say "   [x]  $Message" 'Red'; $script:problems++ }

function Ask-YesNo([string]$Question) {
  if ($Yes) { return $true }
  $answer = Read-Host "   $Question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes|c|co)$')
}

function Update-SessionPath {
  # winget installers update the registry PATH, not this process.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail "winget is not available. Install $Name yourself, then run this installer again."
    return $false
  }
  $wingetArgs = @('install', '-e', '--id', $Id, '--scope', 'user')
  if ($Yes) { $wingetArgs += @('--accept-source-agreements', '--accept-package-agreements') }
  Say "   winget $($wingetArgs -join ' ')"
  & winget @wingetArgs
  Update-SessionPath
  return ($LASTEXITCODE -eq 0)
}

function Find-VSCode {
  $candidates = @()
  $onPath = Get-Command 'code.cmd', 'code' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($onPath) { $candidates += $onPath.Source }
  $candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd') }
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

function Get-PythonInfo([string]$Exe, [string[]]$PreArgs = @()) {
  $probe = "import sys; print('%d.%d.%d' % sys.version_info[:3]); print(sys.executable)"
  $out = & $Exe @PreArgs -c $probe 2>$null
  if ($LASTEXITCODE -ne 0 -or @($out).Count -lt 2) { return $null }
  try { $version = [version]@($out)[0] } catch { return $null }
  return [pscustomobject]@{ Version = $version; Exe = @($out)[1].Trim() }
}

function Find-Python {
  $found = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $info = Get-PythonInfo 'py' @('-3')
    if ($info) { $found += $info }
  }
  foreach ($name in 'python', 'python3') {
    # The Microsoft Store alias exits with an error when Python is not
    # installed; Get-PythonInfo then returns nothing.
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
      $info = Get-PythonInfo $cmd.Source
      if ($info) { $found += $info }
    }
  }
  return $found | Where-Object { $_.Version -ge $MinPython } | Sort-Object Version -Descending | Select-Object -First 1
}

function Find-Vsix {
  if ($Vsix) {
    if (Test-Path -LiteralPath $Vsix) { return (Resolve-Path -LiteralPath $Vsix).Path }
    return $null
  }
  # Next to this script (installer bundle), else the repository root.
  $dirs = @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent))
  foreach ($d in $dirs) {
    $files = Get-ChildItem -LiteralPath $d -Filter 'vrun-*.vsix' -File -ErrorAction SilentlyContinue
    $best = $files | Sort-Object {
      try { [version]($_.BaseName -replace '^vrun-', '') } catch { [version]'0.0' }
    } -Descending | Select-Object -First 1
    if ($best) { return $best.FullName }
  }
  return $null
}

Say 'vrun installer' 'White'

# --- 1. the extension file -------------------------------------------------
Step 'Extension package'
$vsixPath = Find-Vsix
if (-not $vsixPath) {
  Fail 'No vrun-*.vsix found next to this script. Put the .vsix file in the same folder (or pass -Vsix <file>).'
  exit 1
}
Ok $vsixPath

# --- 2. VS Code -------------------------------------------------------------
Step 'VS Code'
$code = Find-VSCode
if (-not $code) {
  Warn 'VS Code was not found.'
  if (Ask-YesNo 'Install VS Code now with winget?') {
    if (Install-WithWinget 'Microsoft.VisualStudioCode' 'VS Code') { $code = Find-VSCode }
  }
}
if (-not $code) {
  Fail 'VS Code is required: https://code.visualstudio.com/ (then run this installer again).'
  exit 1
}
$codeVersion = (& $code --version 2>$null | Select-Object -First 1)
Ok "$code ($codeVersion)"
try {
  if ([version]$codeVersion -lt [version]'1.90.0') { Fail "vrun needs VS Code 1.90 or newer (found $codeVersion). Update VS Code first." }
} catch { Warn "Could not read the VS Code version ('$codeVersion')." }

# --- 3. Python --------------------------------------------------------------
Step "Python $MinPython or newer"
$python = Find-Python
if (-not $python) {
  Warn "No Python $MinPython+ found (vrun runs your code with it)."
  if (Ask-YesNo 'Install Python 3.13 now with winget?') {
    if (Install-WithWinget 'Python.Python.3.13' 'Python 3.13') { $python = Find-Python }
  }
}
if ($python) {
  Ok "$($python.Exe) (Python $($python.Version))"
} else {
  Fail "Install Python $MinPython+ from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this installer again."
}

# --- 4. libraries for DataFrame work (optional) ------------------------------
if ($python -and -not $NoLibraries) {
  Step 'Python libraries (optional, for data science / ML practice)'
  $missing = @()
  foreach ($lib in $Libraries.Keys) {
    & $python.Exe -c "import $lib" 2>$null
    if ($LASTEXITCODE -ne 0) { $missing += $Libraries[$lib] }
  }
  if ($missing.Count -eq 0) {
    Ok (@($Libraries.Values) -join ', ')
  } elseif (Ask-YesNo "Install $($missing -join ', ') into $($python.Exe)?") {
    & $python.Exe -m pip install --disable-pip-version-check @missing
    if ($LASTEXITCODE -ne 0) {
      Warn 'Retrying for the current user only (--user).'
      & $python.Exe -m pip install --disable-pip-version-check --user @missing
    }
    if ($LASTEXITCODE -eq 0) { Ok "installed $($missing -join ', ')" } else { Fail "pip could not install $($missing -join ', ')." }
  } else {
    Warn "Skipped. Later: `"$($python.Exe)`" -m pip install $($missing -join ' ')"
  }
}

# --- 5. extensions ------------------------------------------------------------
Step 'VS Code extensions'
$installed = @(& $code --list-extensions 2>$null)
foreach ($old in $OldExtensions) {
  if ($installed -contains $old) {
    Say "   removing the old name $old"
    & $code --uninstall-extension $old 2>$null | Out-Null
  }
}
if ($installed -notcontains 'ms-python.python') {
  # vrun asks the Python extension which interpreter is selected.
  Say '   installing ms-python.python (interpreter picker)'
  & $code --install-extension ms-python.python 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok 'ms-python.python' } else { Warn 'Could not install ms-python.python; vrun will use python on PATH.' }
} else {
  Ok 'ms-python.python'
}
& $code --install-extension $vsixPath --force 2>$null | Out-Null
$vrun = @(& $code --list-extensions --show-versions 2>$null) | Where-Object { $_ -like 'vrun-local.vrun@*' }
if ($vrun) { Ok $vrun } else { Fail 'Installing the vrun extension failed. Try: code --install-extension <file>.vsix' }

# --- summary ------------------------------------------------------------------
Say ''
if ($script:problems -eq 0) {
  Say 'Done. Next steps:' 'Green'
} else {
  Say "Finished with $($script:problems) problem(s) shown above. Next steps once they are fixed:" 'Yellow'
}
Say '  1. Close and reopen VS Code (or run "Developer: Reload Window").'
Say '  2. Open a folder and choose "Trust" (vrun only runs in trusted folders).'
if ($python) { Say "  3. Ctrl+Shift+P > Python: Select Interpreter > $($python.Exe)" }
else { Say '  3. Ctrl+Shift+P > Python: Select Interpreter > your Python 3.12+' }
Say '  4. Open a .py file and press Ctrl+Alt+C (Run Cell). "vrun: Show Kernel Log" shows which Python started.'
exit $script:problems
