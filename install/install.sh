#!/usr/bin/env sh
# Installs the vrun VS Code extension on macOS / Linux.
#   sh install.sh [path/to/vrun-x.y.z.vsix]
# Needs VS Code 1.90+ with the `code` command, and Python 3.12+ to run code.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
say() { printf '%s\n' "$*"; }

vsix=${1:-}
if [ -z "$vsix" ]; then
  # Next to this script (installer bundle), else the repository root.
  vsix=$(ls "$here"/vrun-*.vsix "$here"/../vrun-*.vsix 2>/dev/null | tail -n 1 || true)
fi
if [ -z "$vsix" ] || [ ! -f "$vsix" ]; then
  say "[x] No vrun-*.vsix found next to this script (or pass its path as the first argument)."
  exit 1
fi
say "[ok] package: $vsix"

code=$(command -v code || true)
mac_code="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
if [ -z "$code" ] && [ -x "$mac_code" ]; then code=$mac_code; fi
if [ -z "$code" ]; then
  say "[x] The VS Code command 'code' was not found. Install VS Code 1.90+ (https://code.visualstudio.com/);"
  say "    on macOS run 'Shell Command: Install code command in PATH' from the Command Palette."
  exit 1
fi
say "[ok] VS Code: $("$code" --version | head -n 1)"

python=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null; then
    python=$(command -v "$candidate")
    break
  fi
done
if [ -n "$python" ]; then
  say "[ok] Python: $python ($("$python" -c 'import sys; print(sys.version.split()[0])'))"
  if ! "$python" -c 'import pandas' 2>/dev/null; then
    say "[!]  pandas is not installed in $python (only needed for DataFrame scripts):"
    say "     $python -m pip install pandas numpy matplotlib openpyxl scikit-learn tqdm"
  fi
else
  say "[!]  Python 3.12+ was not found. Install it (https://www.python.org/downloads/) before running code with vrun."
fi

installed=$("$code" --list-extensions 2>/dev/null || true)
for old in pylive-local.pylive-inspector veil-local.veil; do
  if printf '%s\n' "$installed" | grep -qx "$old"; then
    say "     removing the old name $old"
    "$code" --uninstall-extension "$old" >/dev/null 2>&1 || true
  fi
done
if ! printf '%s\n' "$installed" | grep -qx ms-python.python; then
  # vrun asks the Python extension which interpreter is selected.
  "$code" --install-extension ms-python.python >/dev/null 2>&1 || say "[!]  Could not install ms-python.python; vrun will use python3 on PATH."
fi
"$code" --install-extension "$vsix" --force >/dev/null
if "$code" --list-extensions --show-versions | grep -q '^vrun-local\.vrun@'; then
  say "[ok] $("$code" --list-extensions --show-versions | grep '^vrun-local\.vrun@')"
else
  say "[x] Installing the vrun extension failed."
  exit 1
fi

say ""
say "Done. Reload VS Code, open a folder and trust it, pick your Python with"
say "'Python: Select Interpreter', then open a .py file and press Ctrl+Alt+C (Cmd+Alt+C on macOS)."
