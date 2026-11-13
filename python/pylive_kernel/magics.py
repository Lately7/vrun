"""Notebook habits in plain Python files.

Learners come from Jupyter / Colab tutorials: ``%matplotlib inline`` at the
top, ``%timeit`` to compare loops with NumPy, ``!pip install xgboost``,
``display(df)``. They were SyntaxErrors that stopped the whole cell. Only when
the code does not parse as Python, lines that start with ``%`` or ``!`` are
rewritten in place (same line count, so tracebacks keep their lines):

* setup magics that notebooks need and vrun does not are ignored, with a note;
* ``%time`` / ``%timeit`` run the statement (timeit measures it);
* ``%%writefile [-a] path`` writes the rest of the cell to the file;
* shell commands and package installs are an error that says what to run in a
  terminal instead.

Only lines outside strings and brackets count: a docstring line that starts
with ``%`` or ``!`` is text, not a magic.
"""

from __future__ import annotations

import ast
import builtins
import math
import os
import re
import sys
from typing import Any

IGNORED = {
    "matplotlib": "figures are shown automatically",
    "load_ext": "extensions are not needed",
    "reload_ext": "extensions are not needed",
    "autoreload": "re-run the cell that imports your module after editing it",
    "config": "notebook configuration does not apply",
    "precision": "use np.set_printoptions / pd.set_option instead",
    "pylab": "import numpy and matplotlib.pyplot yourself",
    "notebook": "notebook settings do not apply",
    "env": "use os.environ instead",
}
TIMEIT_NAME = "_vrun_timeit"


class MagicError(Exception):
    def __init__(self, line: int, message: str) -> None:
        super().__init__(message)
        self.line = line


# Cell magics whose body is Python: it runs, the magic line becomes `pass`.
RUN_BODY_CELL_MAGICS = ("time", "timeit", "capture")
WRITEFILE_CELL_MAGICS = ("writefile", "file")
SHELL_CELL_MAGICS = ("bash", "sh", "script", "cmd", "powershell", "pwsh", "system", "perl", "ruby")
DISPLAY_CELL_MAGICS = ("html", "javascript", "js", "latex", "markdown", "svg")
# The host's cell marker (src/exec/cells.ts).
_CELL_MARKER = re.compile(r"^\s*#\s*%%")


def rewrite(code: str) -> tuple[str, list[str]]:
    """Code with notebook lines rewritten, and notes for the Output tab.

    Valid Python is returned unchanged. Raises MagicError for commands that
    cannot run here. Line count is kept, so tracebacks keep their lines.
    """
    try:
        ast.parse(code)
        return code, []
    except SyntaxError as exc:
        error_line = exc.lineno
    lines = code.split("\n")  # a CRLF line keeps its "\r", put back on rewrite
    notes: list[str] = []
    changed: set[int] = set()
    quote: str | None = None  # delimiter of a string still open at the line end
    depth = 0  # brackets open outside strings
    joined = False  # the previous line ended with a backslash
    cell_has_code = False
    i = 0
    while i < len(lines):
        eol = "\r" if lines[i].endswith("\r") else ""
        text = lines[i][: len(lines[i]) - len(eol)]
        stripped = text.lstrip()
        indent = text[: len(text) - len(stripped)]
        top = quote is None and depth == 0 and not joined
        if top and _CELL_MARKER.match(text):
            cell_has_code = False
        elif top and stripped.startswith("%%") and stripped[2:].strip():
            name, args = _split_magic(stripped[2:])
            if cell_has_code:
                raise MagicError(i + 1, f"'%%{name}' is a notebook cell magic: it only works as the first "
                                        "line of a cell (right after '# %%').")
            if name in WRITEFILE_CELL_MAGICS:
                path, append = _writefile_args(args, i + 1)
                end = next((j for j in range(i + 1, len(lines)) if _CELL_MARKER.match(lines[j])), len(lines))
                body = [ln[:-1] if ln.endswith("\r") else ln for ln in lines[i + 1:end]]
                while body and not body[-1].strip():
                    body.pop()
                content = "\n".join(body) + "\n" if body else ""
                lines[i] = (f"{indent}__import__({__name__!r}, fromlist=['writefile'])"
                            f".writefile({path!r}, {content!r}, {append!r}){eol}")
                for j in range(i, end):
                    if j > i:
                        lines[j] = ""
                    changed.add(j)
                i = end
                continue
            if name not in RUN_BODY_CELL_MAGICS:
                raise MagicError(i + 1, _cell_magic_message(name))
            notes.append(f"line {i + 1}: '%%{name}' is a notebook cell magic and was ignored"
                         + (" (the run time is shown next to the output)" if name in ("time", "timeit") else ""))
            lines[i] = indent + "pass" + eol
            changed.add(i)
            cell_has_code = True
        elif top and stripped.startswith(("%", "!")) and not stripped.startswith("%%"):
            # Not scanned for quotes: shell text may hold an unbalanced one.
            lines[i] = indent + _line_magic(stripped, i + 1, notes) + eol
            changed.add(i)
            cell_has_code = True
        else:
            if stripped and not (top and stripped.startswith("#")):
                cell_has_code = True
            quote, depth, joined = _scan(text, quote, depth)
        i += 1
    if not changed:
        return code, notes
    new_code = "\n".join(lines)
    try:
        ast.parse(new_code)
    except SyntaxError:
        # The code has another error: report the parser's own message for it,
        # unless that message pointed at a magic line we just made valid.
        if error_line is None or error_line - 1 not in changed:
            return code, []
    return new_code, notes


def _scan(text: str, quote: str | None, depth: int) -> tuple[str | None, int, bool]:
    """String and bracket state after one line of Python source."""
    j, n = 0, len(text)
    while j < n:
        ch = text[j]
        if quote is not None:
            if ch == "\\":
                j += 2
            elif text.startswith(quote, j):
                j += len(quote)
                quote = None
            else:
                j += 1
            continue
        if ch == "#":
            return None, depth, False
        if ch in "\"'":
            quote = ch * 3 if text.startswith(ch * 3, j) else ch
            j += len(quote)
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        j += 1
    if quote is not None and len(quote) == 1 and j <= n:
        quote = None  # unterminated one-line string: the parser reports it
    return quote, depth, quote is None and text.endswith("\\")


def _split_magic(body: str) -> tuple[str, str]:
    parts = body.split(maxsplit=1)
    return (parts[0] if parts else ""), (parts[1].strip() if len(parts) > 1 else "")


def _line_magic(stripped: str, line: int, notes: list[str]) -> str:
    """Python for one '%name ...' line; MagicError for '!cmd' and the rest."""
    if stripped.startswith("!"):
        raise MagicError(line, _shell_message(stripped[1:].strip()))
    name, rest = _split_magic(stripped[1:])
    if name in IGNORED:
        notes.append(f"line {line}: '%{name}' ignored: {IGNORED[name]}")
        return "pass"
    if name == "time" and rest:
        return rest
    if name == "timeit" and rest:
        return f"{TIMEIT_NAME}({_strip_timeit_options(rest)!r}, globals())"
    if name in ("pip", "conda"):
        raise MagicError(line, _shell_message(f"{name} {rest}"))
    raise MagicError(line, f"'%{name}' is an IPython magic: vrun runs plain Python files, "
                           "so write it as Python code instead.")


def _writefile_args(args: str, line: int) -> tuple[str, bool]:
    append = False
    rest = args
    while rest.startswith("-"):
        opt, rest = _split_magic(rest)
        if opt not in ("-a", "--append"):
            raise MagicError(line, f"'%%writefile {opt}': unknown option; write %%writefile [-a] <file name>")
        append = True
    if len(rest) >= 2 and rest[0] == rest[-1] and rest[0] in "'\"":
        rest = rest[1:-1]
    if not rest:
        raise MagicError(line, "'%%writefile' needs a file name, for example: %%writefile train.py")
    return rest, append


def _cell_magic_message(name: str) -> str:
    if name in SHELL_CELL_MAGICS:
        return (f"'%%{name}' runs the cell as a shell script; vrun runs plain Python and did not run it. "
                "Run these commands in a terminal, or use subprocess.run([...]) in code.")
    if name in DISPLAY_CELL_MAGICS:
        return (f"'%%{name}' displays the cell in a notebook; vrun runs plain Python and did not run it. "
                "Save it in its own file and open that instead.")
    return (f"'%%{name}' is an IPython cell magic: vrun runs plain Python files, so write the cell "
            "as Python code instead.")


def _strip_timeit_options(rest: str) -> str:
    parts = rest.split()
    while parts and parts[0].startswith("-"):
        opt = parts.pop(0)
        if opt in ("-n", "-r") and parts:
            parts.pop(0)
    return " ".join(parts) if parts else rest


def _shell_message(command: str) -> str:
    py = sys.executable
    words = command.split()
    if len(words) >= 2 and words[0] in ("pip", "pip3", "conda") or command.startswith(("python -m pip", "python3 -m pip")):
        pkgs = " ".join(w for w in words[2:] if not w.startswith("-")) if words[0] in ("pip", "pip3", "conda") else ""
        return (f"'!{command}' is a notebook shell command; vrun runs plain Python. Install packages in a terminal "
                f"with the kernel's Python: \"{py}\" -m pip install {pkgs or '<package>'} - then restart the kernel.")
    return (f"'!{command}' is a notebook shell command; vrun runs plain Python. Run it in a terminal, "
            "or use subprocess.run([...]) in code.")


# -- runtime helpers ---------------------------------------------------------
def timeit(stmt: str, ns: dict[str, Any]) -> None:
    """%timeit: auto-ranged loops, best of up to 7 repeats within ~2 s."""
    import timeit as _timeit

    timer = _timeit.Timer(stmt, globals=ns)
    number, first = timer.autorange()
    repeats = max(1, min(7, int(2.0 / max(first, 1e-9))))
    runs = [first] + timer.repeat(repeat=repeats - 1, number=number) if repeats > 1 else [first]
    values = [r / number for r in runs]
    mean = sum(values) / len(values)
    std = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)) if len(values) > 1 else 0.0
    print(f"{_fmt(mean)} ± {_fmt(std)} per loop (mean ± std. dev. of {len(values)} runs, "
          f"{number:,} loop{'s' if number != 1 else ''} each)")


def writefile(path: str, content: str, append: bool) -> None:
    """%%writefile: as IPython does, relative to the working directory."""
    target = os.path.expanduser(path)
    if os.path.exists(target):
        print(("Appending to " if append else "Overwriting ") + target)
    else:
        print("Writing " + target)
    with open(target, "a" if append else "w", encoding="utf-8") as fh:
        fh.write(content)


def _fmt(seconds: float) -> str:
    for unit, scale in (("s", 1.0), ("ms", 1e-3), ("µs", 1e-6), ("ns", 1e-9)):
        if seconds >= scale or unit == "ns":
            return f"{seconds / scale:.3g} {unit}"
    return f"{seconds} s"


def install_display(show_figure: Any, describe: Any) -> None:
    """display(obj) as in notebooks; never replaces a user-defined display."""
    if hasattr(builtins, "display"):
        return

    def display(*objs: Any, **_: Any) -> None:
        for obj in objs:
            if show_figure(obj):
                continue
            print(describe(obj))

    builtins.display = display  # type: ignore[attr-defined]


__all__ = ["MagicError", "TIMEIT_NAME", "install_display", "rewrite", "timeit", "writefile"]
