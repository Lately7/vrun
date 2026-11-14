"""Execution of user code in the persistent namespace."""

from __future__ import annotations

import ast
import base64
import __future__
import functools
import io
import linecache
import os
import re
import sys
import tempfile
import traceback
import types
import warnings
from dataclasses import dataclass
from typing import Any

from .serialize import friendly_repr, safe_repr, short_type_name, type_module, type_name, type_qualname

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_FIGURES = 8
MAX_FIGURE_BYTES = 2 * 1024 * 1024
MAX_FIGURE_PIXELS = 4096
# Leaves headroom under the worker's 8 MiB message limit for the rest of the result.
MAX_FIGURES_TOTAL_B64 = 5 * 1024 * 1024


@dataclass(frozen=True)
class CompiledStatement:
    node: ast.stmt
    code: Any
    is_expression: bool
    line: int
    source: str


def make_user_module() -> types.ModuleType:
    """Fresh ``__main__`` module, as IPython does, so pickling/`if __name__` work."""
    mod = types.ModuleType("__main__", "vrun user namespace")
    mod.__dict__["__builtins__"] = __builtins__
    sys.modules["__main__"] = mod
    return mod


def register_source(filename: str, code: str, line_offset: int) -> None:
    """Make tracebacks show the executed (possibly unsaved) source lines."""
    lines = ["\n"] * line_offset + [ln + "\n" for ln in code.splitlines()]
    # mtime None marks the entry as non-file so checkcache() keeps it.
    linecache.cache[filename] = (len(code), None, lines, filename)


def compile_cell(code: str, filename: str, line_offset: int) -> tuple[Any, Any]:
    """Parse and split into (exec_part, eval_part_or_None). Raises SyntaxError."""
    try:
        tree = ast.parse(code, filename, "exec")
    except SyntaxError as exc:
        if line_offset and exc.lineno:
            exc.lineno += line_offset
            if getattr(exc, "end_lineno", None):
                exc.end_lineno += line_offset  # type: ignore[operator]
        raise
    if line_offset:
        ast.increment_lineno(tree, line_offset)
    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = ast.Expression(tree.body.pop().value)  # type: ignore[attr-defined]
    exec_code = compile(tree, filename, "exec")
    eval_code = compile(last_expr, filename, "eval") if last_expr is not None else None
    return tree, (exec_code, eval_code)


def compile_statements(code: str, filename: str, line_offset: int) -> list[CompiledStatement]:
    """Compile top-level statements separately without changing source locations."""
    try:
        tree = ast.parse(code, filename, "exec")
    except SyntaxError as exc:
        if line_offset and exc.lineno:
            exc.lineno += line_offset
            if getattr(exc, "end_lineno", None):
                exc.end_lineno += line_offset  # type: ignore[operator]
        raise

    sources = [ast.get_source_segment(code, statement) or "" for statement in tree.body]
    original_lines = [statement.lineno for statement in tree.body]
    if line_offset:
        ast.increment_lineno(tree, line_offset)

    # Compiling once validates constraints that are cell-wide, such as the
    # placement of future imports, before any statement can mutate state.
    whole = compile(tree, filename, "exec")
    future_mask = 0
    for feature_name in __future__.all_feature_names:
        future_mask |= getattr(__future__, feature_name).compiler_flag
    flags = whole.co_flags & future_mask

    result: list[CompiledStatement] = []
    last_index = len(tree.body) - 1
    for index, statement in enumerate(tree.body):
        is_expression = index == last_index and isinstance(statement, ast.Expr)
        unit: ast.AST
        mode: str
        if is_expression:
            unit = ast.Expression(statement.value)
            mode = "eval"
        else:
            unit = ast.Module(body=[statement], type_ignores=[])
            mode = "exec"
        compiled = compile(unit, filename, mode, flags=flags, dont_inherit=True)
        result.append(CompiledStatement(
            node=statement,
            code=compiled,
            is_expression=is_expression,
            line=original_lines[index] + line_offset,
            source=sources[index],
        ))
    return result


def format_syntax_error(exc: SyntaxError) -> dict[str, Any]:
    return {
        "ename": "SyntaxError" if type(exc) is SyntaxError else type(exc).__name__,
        "evalue": exc.msg or str(exc),
        "traceback": "".join(traceback.format_exception_only(type(exc), exc)),
        "frames": [],
        "userFrame": {
            "file": exc.filename or "",
            "line": exc.lineno or 0,
            "col": exc.offset or 0,
            "endLine": getattr(exc, "end_lineno", None) or exc.lineno or 0,
            "endCol": getattr(exc, "end_offset", None) or 0,
            "name": "<module>",
        },
    }


_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text) if "\x1b" in text else text


def _editor_col(filename: str, lineno: int, byte_col: int) -> int:
    """co_positions() counts UTF-8 bytes; the editor and the webview count
    UTF-16 units, so a Vietnamese string before the error moved the squiggle."""
    if byte_col <= 0 or lineno <= 0:
        return byte_col
    line = linecache.getline(filename, lineno)
    if not line or line.isascii():
        return byte_col
    head = line.encode("utf-8", "surrogatepass")[:byte_col].decode("utf-8", "ignore")
    return len(head.encode("utf-16-le", "surrogatepass")) // 2


def _with_suggestion(te: traceback.TracebackException | None, exc: BaseException, evalue: str) -> str:
    """str(exc) plus what Python adds only when it prints the error.

    "name 'pirnt' is not defined" becomes "...not defined. Did you mean:
    'print'?": the suggestion is computed by TracebackException (from the
    frame's names, dir() of the object, the module's names), never by
    str(exc). Only the first chunk of format_exception_only() is the message
    line; __notes__ follow as separate chunks and must not be glued on.
    """
    etype = type(exc)
    if te is None or issubclass(etype, SyntaxError):
        return evalue  # its first chunks are the file/caret lines
    try:
        first = next(iter(te.format_exception_only()), "")
    except Exception:  # noqa: BLE001
        return evalue
    marker = ": " + evalue
    at = first.find(marker)
    if not evalue or at < 0 or "\n" in first[:at]:
        return evalue
    extra = first[at + len(marker):].removesuffix("\n")
    if etype is ImportError and type(exc.name) is str and "." in exc.name:  # type: ignore[attr-defined]
        # Python 3.12 looks the name up in __import__(exc.name), the top-level
        # package: none for sklearn.model_selection's train_test_spilt, and
        # 'deque' (from collections) for collections.abc's dequ.
        if extra.startswith(". Did you mean: "):
            extra = ""
        if not extra:
            own = _import_suggestion(exc)  # type: ignore[arg-type]
            extra = f". Did you mean: '{own}'?" if own else ""
    return evalue + extra if extra and "\n" not in extra else evalue


def _import_suggestion(exc: ImportError) -> str | None:
    """A close name in the module `from <exc.name> import <name_from>` read."""
    import difflib

    wrong = getattr(exc, "name_from", None)  # exact ImportError: a plain member
    mod = sys.modules.get(exc.name or "")
    if type(wrong) is not str or not wrong or type(mod) is not types.ModuleType:
        return None
    names = _MODULE_DICT.__get__(mod, types.ModuleType)  # no module __getattr__ / __dir__ runs
    if type(names) is not dict or len(names) > 5000:
        return None
    keys = [k for k in names if type(k) is str and k != wrong and (wrong[:1] == "_" or k[:1] != "_")]
    match = difflib.get_close_matches(wrong, keys, n=1, cutoff=0.6)
    return match[0] if match else None


def format_exception(exc: BaseException, user_files: set[str]) -> dict[str, Any]:
    """Structured traceback with the worker's own frames removed."""
    tb = exc.__traceback__
    while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename).startswith(_PKG_DIR):
        tb = tb.tb_next
    exc = exc.with_traceback(tb)
    te: traceback.TracebackException | None = None
    try:
        # One TracebackException for both the text and the message: it is
        # what traceback.format_exception builds internally.
        te = traceback.TracebackException(type(exc), exc, tb, compact=True)
        text = "".join(te.format())
    except Exception:  # noqa: BLE001
        text = f"{type(exc).__name__} (traceback formatting failed)"
    frames = []
    user_frame = None
    for fs in traceback.extract_tb(tb, limit=64):
        line = fs.lineno or 0
        end_line = getattr(fs, "end_lineno", None) or line
        col = getattr(fs, "colno", None)
        end_col = getattr(fs, "end_colno", None)
        frame = {"file": fs.filename, "line": line, "name": fs.name,
                 "col": _editor_col(fs.filename, line, col) + 1 if col is not None else 0,
                 "endCol": _editor_col(fs.filename, end_line, end_col) + 1 if end_col is not None else 0,
                 "endLine": end_line}
        frames.append(frame)
        if fs.filename in user_files:
            user_frame = frame
    try:
        evalue = str(exc)
    except Exception:  # noqa: BLE001
        evalue = "<unprintable exception>"
    evalue = _with_suggestion(te, exc, evalue)
    # Keras/TF colour their messages: escape codes would show as junk in the
    # inline note and the Problems panel.
    out = {
        "ename": type(exc).__name__,
        "evalue": strip_ansi(evalue)[:2000],
        "traceback": strip_ansi(text)[-20000:],
        "frames": frames[-20:],
        "userFrame": user_frame,
    }
    folders = [os.path.dirname(f) for f in user_files if os.path.isabs(f)]
    try:
        hint = error_hint(type(exc).__name__, evalue, exc, folders, user_files)
    except Exception:  # noqa: BLE001 - a hint must never hide the error itself
        hint = None
    if hint:
        out["hint"] = hint
    return out


# Import names whose PyPI distribution is called something else.
PIP_NAMES = {"sklearn": "scikit-learn", "cv2": "opencv-python", "PIL": "pillow", "yaml": "pyyaml",
             "skimage": "scikit-image", "bs4": "beautifulsoup4", "dotenv": "python-dotenv",
             "Crypto": "pycryptodome", "docx": "python-docx", "pptx": "python-pptx"}


def _module_entry(folder: str, name: str) -> tuple[str, str] | None:
    """(module name as spelled on disk, entry) for <name>.py or a <name>/
    package in folder, matched without case: Windows' isfile() finds
    hinh_hoc.py for Hinh_hoc.py, but import compares names exactly."""
    low = name.lower()
    other: tuple[str, str] | None = None
    try:
        with os.scandir(folder) as it:
            for count, entry in enumerate(it):
                if count > 50_000:
                    break
                is_file = entry.name.endswith(".py")
                stem = entry.name[:-3] if is_file else entry.name
                if stem.lower() != low:
                    continue
                if not (entry.is_file() if is_file else
                        os.path.isfile(os.path.join(folder, entry.name, "__init__.py"))):
                    continue
                if stem == name:
                    return stem, entry.name
                other = other or (stem, entry.name)
    except OSError:
        return None
    return other


def _local_module_folder(name: str, folders: list[str]) -> tuple[str, str, str] | None:
    """(folder, spelling, entry) of the learner's own <name>.py / <name>/
    package, an exact spelling first, else one that differs only in case.

    sys.path[0] is the folder the kernel started in (or the one vrun moved
    to), not necessarily this script's folder, so `import my_utils` next to
    week4/train.py can fail; pip would install an unrelated PyPI package.
    """
    seen: set[str] = set()
    other: tuple[str, str, str] | None = None
    for folder in [*folders, os.getcwd()]:
        key = os.path.normcase(os.path.abspath(folder))
        if key in seen:
            continue
        seen.add(key)
        found = _module_entry(folder, name)
        if found is None:
            continue
        if found[0] == name:
            return os.path.abspath(folder), *found
        other = other or (os.path.abspath(folder), *found)
    return other


def _on_sys_path(folder: str) -> bool:
    key = os.path.normcase(os.path.abspath(folder))
    return any(type(p) is str and os.path.normcase(os.path.abspath(p or os.curdir)) == key for p in sys.path)


def error_hint(ename: str, evalue: str, exc: BaseException, folders: list[str] | None = None,
               user_files: set[str] | None = None) -> str | None:
    """A next step for errors learners hit when practising ML and DSA.

    user_files: files of the learner's code; the innermost frame in one of
    them is where the failing expression is read (None: the innermost frame).
    """
    folders = folders or []
    etype = type(exc)
    if ename == "ModuleNotFoundError":
        name = getattr(exc, "name", None)
        if type(name) is str and name and "." not in name:
            found = _local_module_folder(name, folders)
            local = found[0] if found is not None else None
            if found is not None and found[1] != name:
                missing = "" if _on_sys_path(found[0]) else (
                    f" That folder is not on sys.path either: import sys; sys.path.insert(0, {found[0]!r})")
                entry = found[2] if found[2].endswith(".py") else f"the package {found[2]}"
                return (f"There is no module '{name}', but {found[0]} has {entry}: spell it {found[1]} in the "
                        f"import (module names are case-sensitive, even on Windows).{missing}")
            if local is not None and _on_sys_path(local):
                # A folder on sys.path whose new file the import system has
                # not seen yet (its directory listing is cached).
                return (f"'{name}' is in {local}, which is on sys.path, but Python's import cache has not "
                        "seen the file yet. Run: import importlib; importlib.invalidate_caches() - then "
                        "import it again.")
            if local is not None:
                return (f"'{name}' is your own module in {local}, but that folder is not on sys.path, "
                        "so import cannot find it. Add it before the import: "
                        f"import sys; sys.path.insert(0, {local!r})")
            pip = PIP_NAMES.get(name)
            if pip is not None:
                return (f"'{name}' is not installed in the kernel's Python ({sys.executable}). Install it "
                        f"in a terminal with: \"{sys.executable}\" -m pip install {pip} - then restart the kernel.")
            return (f"'{name}' is not installed in the kernel's Python ({sys.executable}). If it is a "
                    f"package from PyPI, install it in a terminal with: \"{sys.executable}\" -m pip install "
                    f"{name} - then restart the kernel. If it is your own module, check the file name and "
                    "that its folder is on sys.path.")
    if ename == "ImportError" and "initialized once" in evalue:
        return ("This library was interrupted while it was being imported and cannot be loaded again in "
                "this process. Restart the kernel (vrun: Restart Kernel).")
    worker_died = "DataLoader worker" in evalue and "exited unexpectedly" in evalue
    main_lookup = "on <module '__main__'" in evalue or ("PicklingError" in ename and "__main__" in evalue)
    if worker_died or main_lookup:
        return ("Worker processes (DataLoader num_workers > 0, multiprocessing) are new Python processes on "
                "Windows: they import your saved script and cannot see classes, functions or lambdas that "
                "exist only in this kernel. Use num_workers=0 while practising, or put the Dataset / "
                "collate_fn in a .py module and import it, and keep the training code under "
                "if __name__ == \"__main__\":. The worker's own error is in the vrun output channel "
                "(vrun: Show Kernel Log).")
    if issubclass(etype, OSError):
        return _path_hint(exc, folders)  # type: ignore[arg-type]
    if etype is UnicodeDecodeError or etype is UnicodeEncodeError:
        return _encoding_hint(exc)  # type: ignore[arg-type]
    if etype is AttributeError:
        return _stale_module_hint(_ATTR_OBJ.__get__(exc, AttributeError), _ATTR_NAME.__get__(exc, AttributeError),
                                  evalue)
    if etype is ImportError:
        # `from hinh_hoc import duong_cheo` after adding duong_cheo: the same
        # stale module as hinh_hoc.duong_cheo (exact ImportError: plain members).
        modname = exc.name  # type: ignore[attr-defined]
        mod = sys.modules.get(modname) if type(modname) is str else None
        return _stale_module_hint(mod, getattr(exc, "name_from", None), evalue)
    if issubclass(etype, (IndexError, TypeError)):
        site = _failing_site(exc, user_files)
        if site is None:
            return None
        if issubclass(etype, IndexError):
            return _index_hint(site, evalue)
        return _shadowed_builtin_hint(site, evalue)
    return None


# -- hints that read the learner's files and frames ----------------------------
# None of these call repr()/str() or any method on objects of unknown types:
# values are read with exact type() checks, attributes through the built-in
# member descriptors (a user subclass's property cannot run).
_OSERROR_FILENAME = OSError.__dict__["filename"]
_ATTR_NAME = AttributeError.__dict__["name"]
_ATTR_OBJ = AttributeError.__dict__["obj"]
_MODULE_DICT = types.ModuleType.__dict__["__dict__"]
_LISTING_LIMIT = 2000  # names read from one folder for "did you mean"


def _plain_path(value: object) -> str | None:
    if type(value) is str:
        return value  # type: ignore[return-value]
    import pathlib

    if type(value) in (pathlib.Path, pathlib.PurePath, pathlib.WindowsPath, pathlib.PosixPath,
                       pathlib.PureWindowsPath, pathlib.PurePosixPath):
        return os.fspath(value)  # type: ignore[arg-type]
    return None


def _same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _listing(folder: str) -> list[str]:
    try:
        with os.scandir(folder) as it:
            names = []
            for entry in it:
                names.append(entry.name)
                if len(names) > _LISTING_LIMIT:
                    return []  # a huge folder: no guessing
            return names
    except OSError:
        return []


def _path_hint(exc: OSError, folders: list[str]) -> str | None:
    """FileNotFoundError and friends: where Python looked, and what is there."""
    path = _plain_path(_OSERROR_FILENAME.__get__(exc, OSError))
    if not path:
        return None
    controls = {"\n": "\\n", "\t": "\\t", "\r": "\\r", "\f": "\\f", "\v": "\\v", "\a": "\\a", "\b": "\\b"}
    found = [esc for ch, esc in controls.items() if ch in path]
    if found:
        # "C:\new\data.csv": \n became a newline (Errno 22, or not found).
        # Show the learner's own path back as it was typed, when it can be.
        typed = "".join(controls.get(ch, ch) for ch in path)
        if not typed.isprintable() or "'" in typed or typed.endswith("\\"):
            typed = "C:\\new\\data.csv"
        return (f"The path contains {', '.join(found)}: in a normal string a backslash starts an escape "
                f"(\\n is a new line, \\t a tab). Write Windows paths as raw strings, r'{typed}', "
                f"or with forward slashes, '{typed.replace(chr(92), '/')}'.")
    if not issubclass(type(exc), FileNotFoundError):
        return None
    cwd = os.getcwd()
    if os.path.isabs(path):
        folder, base = os.path.split(path)
        near = _close_names(base, [folder]) if os.path.isdir(folder) else []
        if near:
            return f"There is no {base!r} in {folder}. Did you mean {_or_list(near)}?"
        return None
    if os.path.exists(path):
        return None  # created after the error: nothing to explain
    scripts = []
    for f in folders:
        if os.path.isdir(f) and not any(_same_folder(f, s) for s in scripts):
            scripts.append(f)
    for folder in scripts:
        if not _same_folder(folder, cwd) and os.path.exists(os.path.join(folder, path)):
            # No os.chdir advice: after the learner's own chdir vrun stops
            # moving to the running file's folder (workdir.py).
            return (f"{path!r} is in {folder}, next to your script, but the kernel's working folder is {cwd}, "
                    "and relative paths start there. Build the path from the script's folder: "
                    f"from pathlib import Path; Path(__file__).parent / {path!r}")
    near = _close_names(path, [cwd, *scripts])
    here = "the working folder " + cwd
    if scripts and _same_folder(scripts[0], cwd):
        here += " (your script's folder)"
    if near:
        return f"There is no {path!r} in {here}. Did you mean {_or_list(near)}?"
    tip = ""
    if scripts and not _same_folder(scripts[0], cwd):
        tip = f" Your script is in {scripts[0]}."
    return (f"Relative paths start in the kernel's working folder, {cwd}, and there is no {path!r} there.{tip} "
            "Check the name in the Explorer (Windows can hide extensions: data.csv may really be data.csv.txt).")


def _close_names(path: str, roots: list[str]) -> list[str]:
    """Names like `path` ('dta.csv' -> 'data.csv') in each root; a root other
    than the first is named, since the learner has to say where it is."""
    import difflib

    sub, base = os.path.split(path)
    if not base:
        return []
    # The separator the learner typed: 'data/dta.csv' -> 'data/data.csv', not 'data\\data.csv'.
    sep = path[len(sub)] if sub and path[len(sub):len(sub) + 1] in ("/", "\\") else os.sep
    if sub.endswith(("/", "\\")):
        sep = ""
    out: list[str] = []
    for i, root in enumerate(roots):
        lowered: dict[str, str] = {}
        for name in _listing(os.path.join(root, sub)):
            lowered.setdefault(name.lower(), name)
        for match in difflib.get_close_matches(base.lower(), list(lowered), n=3, cutoff=0.6):
            shown = repr(sub + sep + lowered[match] if sub else lowered[match])
            label = shown if i == 0 or _same_folder(root, roots[0]) else f"{shown} (in {root})"
            if label not in out:
                out.append(label)
    return out[:3]


def _or_list(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " or " + items[-1]


# cp1258 (Vietnamese Windows) has no precomposed toned letters for most
# syllables: Excel writes "ễ" as ê + a combining tilde. A tone mark right
# after a vowel is the evidence; the letters ă đ ơ ư alone are not, since
# cp1252's ã õ ð ý (São, Goiânia) are the same bytes.
_VI_TONES = frozenset("\u0300\u0301\u0303\u0309\u0323")
_VI_VOWELS = frozenset("aeiouyâêôăơưAEIOUYÂÊÔĂƠƯ")


def _looks_vietnamese(data: bytes) -> bool:
    text = data.decode("cp1258", "ignore")
    return any(ch in _VI_TONES and text[i - 1] in _VI_VOWELS for i, ch in enumerate(text) if i)


def _decodes_as_utf8(data: bytes) -> bool:
    """Valid UTF-8 (its first 64 KB), allowing a character cut at the end of
    a read chunk."""
    head = data[:65536]
    try:
        head.decode("utf-8")
    except UnicodeDecodeError as err:
        return err.start >= len(head) - 3 and err.reason == "unexpected end of data"
    return True


def _ansi_encoding() -> str:
    try:
        import locale

        return locale.getencoding()  # the Windows code page, even in UTF-8 mode
    except Exception:  # noqa: BLE001
        return "cp1252"


def _encoding_hint(exc: UnicodeError) -> str | None:
    """'charmap' codec errors: a UTF-8 file read or written with the Windows
    code page, and the reverse once UTF-8 is the default (an Excel CSV)."""
    enc_raw = exc.encoding  # type: ignore[attr-defined] - exact UnicodeDecode/EncodeError only
    if type(enc_raw) is not str:
        return None
    enc = enc_raw.lower().replace("_", "-")
    windows = enc == "charmap" or enc == "mbcs" or re.fullmatch(r"cp\d+", enc) is not None
    # 'charmap' is how Python names every single-byte code page in these
    # errors, so which one is unknown; in UTF-8 mode it is one the code
    # passed as encoding=, not necessarily the machine's ANSI code page.
    label = "a Windows code page ('charmap': cp1252, cp1258, ...)" if enc == "charmap" \
        else f"the Windows encoding {enc_raw}"
    data = exc.object  # type: ignore[attr-defined]
    if type(exc) is UnicodeEncodeError:
        if not windows:
            return None
        start = exc.start  # type: ignore[attr-defined]
        letter = f"'{data[start]}'" if type(data) is str and type(start) is int and 0 <= start < len(data) \
            else "letters like 'Đ'"
        return (f"Python is writing this text with {label}, which has no {letter}. "
                "Open the file with encoding='utf-8': open(path, 'w', encoding='utf-8') "
                "(VS Code reads files as UTF-8).")
    if type(data) is not bytes:
        return None
    if windows:
        what = "the file is UTF-8" if _decodes_as_utf8(data) else "the file is most likely UTF-8"
        return (f"Python read this file with {label}, but {what} "
                "(VS Code saves files as UTF-8). Open it with encoding='utf-8': open(path, encoding='utf-8'), "
                "Path(path).read_text(encoding='utf-8').")
    if enc not in ("utf-8", "utf8"):
        return None
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return ("This file is UTF-16 (Notepad's 'Unicode', or PowerShell's > redirection). Open it with "
                "encoding='utf-16', or save it again as UTF-8.")
    if data.startswith(b"PK\x03\x04"):
        return ("This is a zip file, most likely an Excel .xlsx workbook, not text: read it with "
                "pd.read_excel(path) instead of read_csv / open().")
    if data.startswith((b"\x89PNG", b"\xff\xd8\xff", b"%PDF", b"GIF8")) or b"\x00" in data[:1024]:
        return "This is a binary file (an image, PDF or similar), not text: open it with open(path, 'rb')."
    # Not UTF-8: usually a CSV saved by Excel or Notepad in the Windows (ANSI)
    # encoding. Vietnamese Windows uses cp1258; suggest it when the bytes read
    # as Vietnamese letters with it. The bytes around the failure count most:
    # a long CSV can be plain ASCII (numbers, codes) for many KB before a name.
    start = exc.start  # type: ignore[attr-defined]
    at = start if type(start) is int and 0 <= start <= len(data) else 0
    sample = data[:4096] + b"\n" + data[max(0, at - 2048):at + 2048]
    if _looks_vietnamese(sample):
        # Python's cp1258 decoder keeps tone marks as separate combining
        # characters: df['ten'] == 'Nguyễn' (typed, composed) is then False.
        return ("This file is not UTF-8: it was probably saved by Excel ('CSV (Comma delimited)') in the "
                "Vietnamese Windows encoding, cp1258. Best: save it again in Excel as 'CSV UTF-8'. Or read it "
                "with encoding='cp1258' (pd.read_csv(path, encoding='cp1258')); the tone marks then come as "
                "separate characters, so compare text after unicodedata.normalize('NFC', text).")
    # No Vietnamese tone marks: most likely Western European (cp1252) text,
    # also on a machine whose ANSI code page is cp1258.
    ansi = _ansi_encoding()
    order = ["cp1252", "cp1258"] if ansi.lower() == "cp1258" else [ansi, "cp1252", "cp1258"]
    choices = [c for c in dict.fromkeys(order) if c and c.lower() not in ("utf-8", "utf8", "cp65001")]
    options = " or ".join(f"encoding={c!r}" for c in choices)
    return ("This file is not UTF-8: it was probably saved by Excel ('CSV (Comma delimited)') or another "
            f"Windows program in the Windows encoding. Read it with {options} - for example "
            f"pd.read_csv(path, encoding={choices[0]!r}) - or save it again as 'CSV UTF-8'.")


def _is_learner_file(path: str) -> bool:
    """A .py file of the learner's: not stdlib, site-packages or vrun itself."""
    import sysconfig

    p = os.path.normcase(os.path.abspath(path))
    parts = p.split(os.sep)
    if "site-packages" in parts or "dist-packages" in parts:
        return False
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, os.path.dirname(_PKG_DIR)}
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        try:
            roots.add(sysconfig.get_path(key))
        except Exception:  # noqa: BLE001
            pass
    for root in roots:
        if type(root) is str and root and p.startswith(os.path.normcase(os.path.abspath(root)) + os.sep):
            return False
    return True


def _is_main_guard(statement: ast.stmt) -> bool:
    """`if __name__ == "__main__":` (either order). A copy of reloader.py's
    check, so a change there cannot silently switch these hints off."""
    if not isinstance(statement, ast.If) or not isinstance(statement.test, ast.Compare):
        return False
    test = statement.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left, test.comparators[0]]
    return any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides) \
        and any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)


def _top_level_bindings(tree: ast.Module, name: str, imported: bool = False) -> list[tuple[ast.stmt, bool]]:
    """Module-level statements that bind `name` (also inside top-level
    if/for/while/try/with bodies, not inside functions), each with whether it
    always runs (directly in the module body).

    imported: the module was imported, so `if __name__ == "__main__":` bodies
    never ran (in a cell run as __main__ they did).
    """
    found: list[tuple[ast.stmt, bool]] = []
    todo: list[tuple[ast.stmt, bool]] = [(st, True) for st in tree.body]
    while todo:
        st, always = todo.pop()
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if st.name == name:
                found.append((st, always))
            continue
        if isinstance(st, (ast.Import, ast.ImportFrom)):
            if any((alias.asname or alias.name.split(".")[0]) == name for alias in st.names):
                found.append((st, always))
            continue
        if imported and _is_main_guard(st):
            continue
        targets: list[ast.expr] = []
        if isinstance(st, ast.Assign):
            targets = list(st.targets)
        elif isinstance(st, (ast.AnnAssign, ast.AugAssign)):
            targets = [st.target]
        elif isinstance(st, (ast.For, ast.AsyncFor)):
            targets = [st.target]
        elif isinstance(st, (ast.With, ast.AsyncWith)):
            targets = [item.optional_vars for item in st.items if item.optional_vars is not None]
        # Store only: `a[max] = 1` reads max, it does not bind it.
        if any(isinstance(node, ast.Name) and node.id == name and isinstance(node.ctx, ast.Store)
               for target in targets for node in ast.walk(target)):
            # A for target is bound only if the loop ran at least once.
            found.append((st, always and not isinstance(st, (ast.For, ast.AsyncFor))))
            continue
        for field in ("body", "orelse", "finalbody", "handlers"):
            for child in getattr(st, field, []) or []:
                if isinstance(child, ast.ExceptHandler):
                    todo.extend((c, False) for c in child.body)
                elif isinstance(child, ast.stmt):
                    todo.append((child, False))
    return found


def _top_level_binding(tree: ast.Module, name: str) -> ast.stmt | None:
    """The first module-level statement that binds `name`."""
    found = _top_level_bindings(tree, name)
    return min((st for st, _ in found), key=lambda st: st.lineno) if found else None


def _edited_since_import(mdict: dict[str, Any], path: str) -> bool | None:
    """Has the source changed since the module was imported (or reloaded)?

    The import validated or wrote the .pyc, whose header holds the source's
    mtime and size at that moment. None: no timestamp .pyc to tell (a
    read-only folder, hash-based .pyc), or one the import may have left
    stale because it could not write (PYTHONDONTWRITEBYTECODE).
    """
    import importlib.util

    cached = mdict.get("__cached__")
    if type(cached) is not str:
        return None
    try:
        st = os.stat(path)
        with open(cached, "rb") as fh:
            head = fh.read(16)
    except OSError:
        return None
    if len(head) != 16 or head[:4] != importlib.util.MAGIC_NUMBER or int.from_bytes(head[4:8], "little") != 0:
        return None
    compiled = (int.from_bytes(head[8:12], "little"), int.from_bytes(head[12:16], "little"))
    if compiled == (int(st.st_mtime) & 0xFFFFFFFF, st.st_size & 0xFFFFFFFF):
        return False
    return None if sys.dont_write_bytecode else True


def _stale_module_hint(mod: object, name: object, evalue: str) -> str | None:
    """`module 'hinh_hoc' has no attribute 'duong_cheo'` (or `cannot import
    name 'duong_cheo' from 'hinh_hoc'`) after the learner added duong_cheo to
    hinh_hoc.py: the kernel still has the old module.

    Said only when the file changed since the import (its .pyc says so), or,
    without a .pyc to tell, when the name is bound by a statement that always
    runs on import: then the name is missing only because the module that ran
    was older. A name under `if __name__ == "__main__":` or in a failed
    `try: import ...` was never bound: reloading would not help.
    """
    if type(name) is not str or type(mod) is not types.ModuleType or "partially initialized" in evalue:
        return None  # a circular import: the module is still running its top level
    mdict = _MODULE_DICT.__get__(mod, types.ModuleType)
    if type(mdict) is not dict or name in mdict:
        return None
    path, modname = mdict.get("__file__"), mdict.get("__name__")
    if type(path) is not str or type(modname) is not str or not path.endswith(".py"):
        return None
    if not os.path.isfile(path) or not _is_learner_file(path):
        return None
    try:
        if os.path.getsize(path) > 1_000_000:
            return None
        import importlib.util

        with open(path, "rb") as fh:
            tree = ast.parse(importlib.util.decode_source(fh.read()), path)
    except (OSError, SyntaxError, ValueError, UnicodeDecodeError):
        return None
    found = _top_level_bindings(tree, name, imported=True)
    if not found:
        return None
    edited = _edited_since_import(mdict, path)
    deleted = any(isinstance(st, ast.Delete) and any(isinstance(t, ast.Name) and t.id == name for t in st.targets)
                  for st in tree.body)
    if edited is False or (edited is None and (deleted or not any(always for _, always in found))):
        return None
    base = os.path.basename(path)
    # The worker reloads edited modules before manual runs and traces
    # (reloader.py) but not in Live Mode, and not a module whose import does
    # something a reload must not repeat (it says so in the run's notes).
    return (f"{base} now defines '{name}', but the kernel still has the copy of '{modname}' it imported "
            "before that change (Python imports a module once and keeps it). Run Cell and Visualize "
            "usually reload edited modules (Live Mode does not, and the run's notes say when vrun did not); "
            f"to reload it yourself: import importlib, {modname}; importlib.reload({modname}) - then run your "
            f"'from {modname} import ...' lines again.")


# -- the failing expression in the learner's frame -----------------------------
class _Unsafe(Exception):
    """The expression cannot be evaluated without running user code."""


_COMPS = (ast.ListComp, ast.SetComp, ast.DictComp)


@dataclass(frozen=True)
class _Site:
    frame: types.FrameType
    node: ast.expr  # the expression whose instruction raised
    line: int  # its first line in the file
    last: bool  # raised by this frame itself (no deeper Python frame)
    module_source: str | None  # the file's executed source, padded to file line numbers
    in_cell: bool  # the frame runs the code that was executed (not an imported module of the learner)
    span: tuple[int, int, int, int]  # (line, col, end_line, end_col), UTF-8 byte columns as in the AST

    @functools.cached_property
    def tree(self) -> ast.Module | None:
        if self.module_source is None:
            return None
        try:
            return ast.parse(self.module_source)
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            return None

    def encloses(self, node: ast.AST) -> bool:
        start = (getattr(node, "lineno", 0), getattr(node, "col_offset", 0))
        end = (getattr(node, "end_lineno", 0) or 0, getattr(node, "end_col_offset", 0) or 0)
        line, col, end_line, end_col = self.span
        return start <= (line, col) and (end_line, end_col) <= end

    @functools.cached_property
    def comprehensions(self) -> list[ast.ListComp | ast.SetComp | ast.DictComp]:
        """List/set/dict comprehensions around the failure that run inside
        this frame, innermost first.

        Python 3.12 inlines them (PEP 709): when the exception leaves one,
        its loop variables are put back to their values from before it
        (or removed), so the frame no longer shows the i that failed.
        """
        if self.tree is None:
            return []
        # Only expressions can hold a comprehension; of those, a lambda and a
        # generator expression run in frames of their own.
        around = [n for n in ast.walk(self.tree)
                  if isinstance(n, (*_COMPS, ast.GeneratorExp, ast.Lambda)) and self.encloses(n)]
        around.sort(key=lambda n: (n.lineno, n.col_offset, -(n.end_lineno or 0), -(n.end_col_offset or 0)))
        out: list[ast.ListComp | ast.SetComp | ast.DictComp] = []
        for n in around:  # outermost first
            if isinstance(n, ast.Lambda):
                if self.encloses(n.body):
                    out = []
            elif self.encloses(n.generators[0].iter):
                pass  # the first iterable is evaluated outside the comprehension
            elif isinstance(n, ast.GeneratorExp):
                out = []  # comprehensions outside it are not in this frame
            else:
                out.append(n)
        return out[::-1]

    @functools.cached_property
    def comp_names(self) -> frozenset[str]:
        """Names whose value in the frame is not the one the failing code saw."""
        return frozenset(n.id for comp in self.comprehensions for gen in comp.generators
                         for n in ast.walk(gen.target) if isinstance(n, ast.Name))


def _failing_site(exc: BaseException, user_files: set[str] | None) -> _Site | None:
    """The learner's innermost frame and the AST of the expression that failed.

    The expression is cut from the source by the instruction's column range
    (co_positions), as the traceback's ^^^ markers are, and parsed on its own.
    """
    import itertools

    tb = exc.__traceback__
    user_tb = None
    learner: dict[str, bool] = {}
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename
        if user_files is None or filename in user_files:
            user_tb = tb
        else:
            # The learner's own module (sapxep.py imported by the cell): its
            # frames are theirs too, so the subscript inside it is explained.
            if filename not in learner:
                learner[filename] = os.path.isabs(filename) and filename.endswith(".py") \
                    and os.path.isfile(filename) and _is_learner_file(filename)
            if learner[filename]:
                user_tb = tb
        tb = tb.tb_next
    if user_tb is None or user_tb.tb_lasti < 0:
        return None
    code = user_tb.tb_frame.f_code
    pos = next(itertools.islice(code.co_positions(), user_tb.tb_lasti // 2, None), None)
    if pos is None or None in pos:
        return None
    line, end_line, col, end_col = pos  # type: ignore[misc]
    if not (0 < line <= end_line <= line + 20):
        return None
    filename = code.co_filename
    lines = [linecache.getline(filename, n) for n in range(line, end_line + 1)]
    if not all(ln.strip() for ln in (lines[0], lines[-1])):
        return None
    if code.co_name != "<module>" and not _source_matches(code):
        return None
    raw = [ln.encode("utf-8", "surrogatepass") for ln in lines]
    try:
        if len(raw) == 1:
            text = raw[0][col:end_col].decode("utf-8")
        else:
            text = raw[0][col:].decode("utf-8") + b"".join(raw[1:-1]).decode("utf-8") \
                + raw[-1][:end_col].decode("utf-8")
        node = ast.parse("(" + text + "\n)", mode="eval").body
    except (SyntaxError, ValueError, UnicodeDecodeError):
        return None
    entry = linecache.getlines(filename)
    module_source = "".join(entry) if entry and len(entry) < 50_000 else None
    in_cell = user_files is None or filename in user_files
    return _Site(user_tb.tb_frame, node, line, user_tb.tb_next is None, module_source, in_cell,
                 (line, col, end_line, end_col))


def _source_matches(code: types.CodeType) -> bool:
    """Does linecache still hold this function's source?

    linecache keeps only the latest cell of a file, so a function defined in
    an earlier cell may point at unrelated lines of the current one.
    """
    first = linecache.getline(code.co_filename, code.co_firstlineno)
    if code.co_name == "<lambda>":
        return "lambda" in first
    if code.co_name.startswith("<"):
        return " for " in first  # generator expressions and comprehensions
    if first.lstrip().startswith("@"):
        return True  # co_firstlineno is the first decorator's line
    return re.search(r"\b(?:def|class)\s+" + re.escape(code.co_name) + r"\b", first) is not None


_SEQ_TYPES: tuple[type, ...] = (list, tuple, str)
_INT_LIMIT = 10 ** 15
_INT_OPS: dict[type, Any] = {ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
                             ast.Mult: lambda a, b: a * b, ast.FloorDiv: lambda a, b: a // b,
                             ast.Mod: lambda a, b: a % b}


def _lookup(frame: types.FrameType, name: str) -> object:
    local = frame.f_locals
    if name in local:
        return local[name]
    if name in frame.f_globals:
        return frame.f_globals[name]
    raise _Unsafe


def _is_seq(value: object) -> bool:
    import collections

    return type(value) in _SEQ_TYPES or type(value) is collections.deque


def _peek_seq(node: ast.expr, frame: types.FrameType, depth: int = 0) -> Any:
    """A list / tuple / str / deque named by a small expression (nums, grid[i], self.data)."""
    if depth > 6:
        raise _Unsafe
    if isinstance(node, ast.Name):
        value = _lookup(frame, node.id)
    elif isinstance(node, ast.Attribute):
        value = _peek_attr(node, frame, depth)
    elif isinstance(node, ast.Subscript) and not isinstance(node.slice, (ast.Slice, ast.Tuple)):
        outer = _peek_seq(node.value, frame, depth + 1)
        index = _peek_int(node.slice, frame, depth + 1)
        if not -len(outer) <= index < len(outer):
            raise _Unsafe
        value = outer[index]
    else:
        raise _Unsafe
    if not _is_seq(value):
        raise _Unsafe
    return value


def _peek_attr(node: ast.Attribute, frame: types.FrameType, depth: int) -> object:
    from .heap import instance_dict

    if not isinstance(node.value, ast.Name):
        raise _Unsafe
    owner = _lookup(frame, node.value.id)
    fields = instance_dict(owner)  # never runs a property or __getattr__
    if fields is None or node.attr not in fields:
        raise _Unsafe
    return fields[node.attr]


def _builtin_len(frame: types.FrameType) -> bool:
    import builtins

    return "len" not in frame.f_locals and "len" not in frame.f_globals \
        and frame.f_builtins.get("len") is builtins.len


def _peek_int(node: ast.expr, frame: types.FrameType, depth: int = 0) -> int:
    """An exact int from Name / Constant / + - * // % / len(seq) / seq[i]."""
    if depth > 8:
        raise _Unsafe
    value: object
    if isinstance(node, ast.Constant):
        value = node.value
    elif isinstance(node, ast.Name):
        value = _lookup(frame, node.id)
    elif isinstance(node, ast.Attribute):
        value = _peek_attr(node, frame, depth)
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        inner = _peek_int(node.operand, frame, depth + 1)
        value = -inner if isinstance(node.op, ast.USub) else inner
    elif isinstance(node, ast.BinOp) and type(node.op) in _INT_OPS:
        a = _peek_int(node.left, frame, depth + 1)
        b = _peek_int(node.right, frame, depth + 1)
        if b == 0 and type(node.op) in (ast.FloorDiv, ast.Mod):
            raise _Unsafe
        value = _INT_OPS[type(node.op)](a, b)
    elif _is_len_call(node, frame):
        value = _peek_len(node.args[0], frame, depth + 1)  # type: ignore[attr-defined]
    elif isinstance(node, ast.Subscript) and not isinstance(node.slice, (ast.Slice, ast.Tuple)):
        seq = _peek_seq(node.value, frame, depth + 1)
        index = _peek_int(node.slice, frame, depth + 1)
        if not -len(seq) <= index < len(seq):
            raise _Unsafe
        value = seq[index]
    else:
        raise _Unsafe
    if type(value) is not int or abs(value) > _INT_LIMIT:  # type: ignore[arg-type]
        raise _Unsafe
    return value  # type: ignore[return-value]


def _names_in(node: ast.expr) -> list[str]:
    seen: list[str] = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id not in seen and sub.id != "len":
            seen.append(sub.id)
    return seen


def _index_hint(site: _Site, evalue: str) -> str | None:
    """nums[j + 1]: j + 1 = 4 (j = 3), but len(nums) = 4 (valid indexes 0..3)."""
    if not site.last:
        return None  # raised deeper (a library's __getitem__): not this subscript
    node, frame = site.node, site.frame
    if site.comp_names.intersection(_names_in(node)):
        return _comprehension_index_hint(site, node)
    try:
        if isinstance(node, ast.Subscript) and not isinstance(node.slice, (ast.Slice, ast.Tuple)):
            seq = _peek_seq(node.value, frame)
            index = _peek_int(node.slice, frame)
        elif isinstance(node, ast.Call):
            return _pop_hint(node, frame)
        else:
            return None
    except _Unsafe:
        return None
    n = len(seq)
    if -n <= index < n:
        return None  # our reading disagrees with what failed: say nothing
    seq_text, index_text = ast.unparse(node.value), ast.unparse(node.slice)
    head = f"{seq_text}[{index_text}]: "
    literal = isinstance(node.slice, ast.Constant) or (
        isinstance(node.slice, ast.UnaryOp) and isinstance(node.slice.operand, ast.Constant))
    valid = "only index 0 is valid" if n == 1 else f"valid indexes 0..{n - 1}"
    if index_text == f"len({seq_text})":
        return (f"{head}{index_text} = {index} is one past the last index ({valid}). The last item is "
                f"{seq_text}[len({seq_text}) - 1], or {seq_text}[-1].") if n else \
            f"{head}{seq_text} is empty, so it has no index 0."
    if not literal:
        head += f"{index_text} = {index}"
        parts = []
        for name in _names_in(node.slice):
            if name == index_text:
                continue
            try:
                parts.append(f"{name} = {_peek_int(ast.Name(id=name), frame)}")
            except _Unsafe:
                pass
        if parts:
            head += f" ({', '.join(parts)})"
        head += ", but "
    if n == 0:
        msg = head + f"{seq_text} is empty, so it has no index {index}."
    else:
        msg = head + f"len({seq_text}) = {n} ({valid}" \
            + (f", or -{n}..-1 from the end" if index < 0 else "") + ")."
    grow = (f" A list does not grow when you assign past its end: use {seq_text}.append(value), "
            f"or create it with the right size first ({seq_text} = [0] * size).")
    # `del a[9]` fails with the same "assignment index" message as a store.
    deleting = site.tree is not None and any(
        isinstance(st, ast.Delete) and site.encloses(st) for st in ast.walk(site.tree))
    store = "assignment" in evalue and index >= n and not deleting
    if store and n == 0:
        return msg + grow
    if index < 0:
        return msg + (f" Negative indexes count from the end, so {index} is before the start." if n else "")
    advice = _loop_advice(site, node.slice, index, n)
    if advice:
        return msg + " " + advice
    if store:
        return msg + grow
    if index == n:
        var = _var_step(node.slice)
        if _calls_itself(frame) and (var is None or _enclosing_loop(site, var[0]) is None):
            # f(a, i) -> a[i] + f(a, i + 1): no loop, the recursion went one call too deep.
            example = f" (e.g. if {index_text} == len({seq_text}): return ...)" \
                if isinstance(node.slice, ast.Name) else ""
            return msg + (f" {frame.f_code.co_name}() calls itself, and this call got an index one past the end: "
                          f"the base case that stops the recursion is missing or comes too late. Check it before "
                          f"using the index{example}.")
        return msg + (f" {index} is one past the last index ({n - 1}): a loop that goes one step too far "
                      "(range(n + 1), or <= where < was meant) is the usual cause.")
    return msg


def _calls_itself(frame: types.FrameType) -> bool:
    """Is this frame's function also further up the stack (recursion)?"""
    code, back = frame.f_code, frame.f_back
    for _ in range(10_000):
        if back is None:
            return False
        if back.f_code is code:
            return True
        back = back.f_back
    return False


def _var_step(index_node: ast.expr) -> tuple[str, int] | None:
    """`i` -> ('i', 0), `i + 2` -> ('i', 2)."""
    if isinstance(index_node, ast.Name):
        return index_node.id, 0
    if isinstance(index_node, ast.BinOp) and isinstance(index_node.op, ast.Add) \
            and isinstance(index_node.left, ast.Name) and isinstance(index_node.right, ast.Constant) \
            and type(index_node.right.value) is int and index_node.right.value >= 0:
        return index_node.left.id, index_node.right.value
    return None


def _is_range(it: ast.expr) -> bool:
    return isinstance(it, ast.Call) and isinstance(it.func, ast.Name) and it.func.id == "range" \
        and 1 <= len(it.args) <= 2 and not it.keywords and not any(isinstance(a, ast.Starred) for a in it.args)


def _stored_before(loop: ast.stmt, var: str, site: _Site) -> bool:
    """Is `var` assigned in the loop body before the failing expression? Then
    its value at the failure is not the one the loop gave it."""
    return any(isinstance(n, ast.Name) and n.id == var and isinstance(n.ctx, ast.Store)
               and (n.lineno, n.col_offset) < site.span[:2]
               for st in loop.body for n in ast.walk(st))  # type: ignore[attr-defined]


def _enclosing_loop(site: _Site, var: str) -> ast.For | ast.While | None:
    """The innermost `for var in ...` or `while var <op> ...` around the failure."""
    loop: ast.For | ast.While | None = None
    for node in ast.walk(site.tree) if site.tree is not None else ():
        if isinstance(node, (ast.For, ast.While)) and node.lineno <= site.line <= (node.end_lineno or 0):
            if (isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == var) or (
                    isinstance(node, ast.While) and isinstance(node.test, ast.Compare)
                    and isinstance(node.test.left, ast.Name) and node.test.left.id == var):
                if loop is None or node.lineno >= loop.lineno:
                    loop = node
    return loop


def _loop_advice(site: _Site, index_node: ast.expr, index: int, n: int) -> str | None:
    """Which loop let the index run past the end, and its fixed bound."""
    var_step = _var_step(index_node)
    if var_step is None or not isinstance(site.node, ast.Subscript):
        return None
    var, step = var_step
    loop = _enclosing_loop(site, var)
    if loop is None or _stored_before(loop, var, site):
        return None
    seq_node = site.node.value
    try:
        current = _peek_int(ast.Name(id=var), site.frame)
        if isinstance(loop, ast.While):
            test = loop.test
            if not (len(test.ops) == 1 and isinstance(test.ops[0], ast.LtE) and index - (n - 1) == 1):  # type: ignore[attr-defined]
                return None
            # i == bound: with < the last round is i = bound - 1, whose index is the last valid one.
            if _peek_int(test.comparators[0], site.frame) != current:  # type: ignore[attr-defined]
                return None
            return (f"The loop 'while {ast.unparse(test)}' lets {var} reach "
                    f"{ast.unparse(test.comparators[0])}: use < instead of <=.")  # type: ignore[attr-defined]
        it = loop.iter
        if not _is_range(it):
            return None
        stop_value = _peek_int(it.args[-1], site.frame)  # type: ignore[attr-defined]
        start = _peek_int(it.args[0], site.frame) if len(it.args) == 2 else 0  # type: ignore[attr-defined]
    except _Unsafe:
        return None
    if not isinstance(it, ast.Call):
        return None
    stop, last = it.args[-1], stop_value - 1
    seq_text = ast.unparse(seq_node)
    if current > last and f"len({seq_text})" in ast.unparse(stop):
        # range() took len() once, when the loop started: the list got shorter since.
        return (f"'for {var} in {ast.unparse(it)}' computed its end once, when the loop started, and "
                f"{seq_text} has become shorter since (an item deleted, popped or removed inside the loop), so "
                f"{var} went past its end. Build a new list instead, e.g. {seq_text} = [x for x in {seq_text} "
                f"if ...], or loop over a copy: for x in {seq_text}[:].")
    if current > last:
        return None  # var was changed by other code: not the bound
    fix = _range_fix(site, it, seq_node, n, step, stop_value, start)
    if fix is None:
        return None
    action, text, note = fix
    reach = f"{var} = {last}" + (f", so {var} + {step} = {last + step}" if step else "")
    head = f"'for {var} in {ast.unparse(it)}' runs up to {reach}{note}"
    return f"{head}: use {text}." if action == "use" else f"{head}. {text}"


def _range_text(it: ast.Call, stop: ast.expr) -> str:
    return ast.unparse(ast.Call(func=it.func, args=[*it.args[:-1], stop], keywords=[]))


def _len_of(seq_node: ast.expr, step: int) -> ast.expr:
    """`len(seq) - step`: the stop that makes seq[var + step] end at the last item."""
    length = ast.Call(func=ast.Name(id="len"), args=[seq_node], keywords=[])
    return _minus(length, step) if step else length


def _range_fix(site: _Site, it: ast.Call, seq_node: ast.expr, n: int, step: int,
               stop_value: int, start: int) -> tuple[str, str, str] | None:
    """How the range should end so that seq[var + step] stops at the last item:
    ("use", the fixed range, a note after "runs up to i = 3") or ("explain", why).

    The stop measures this sequence (len(nums), or n set to it): the stop
    minus its overshoot, range(n - i) -> range(n - i - 1). The length of
    another sequence: shortening the range would silently skip that one's
    last items, so the hint says the two lengths differ. A literal, or a
    name holding some other number: range(len(seq)).
    """
    stop = it.args[-1]
    owner = _stop_owner(site, stop, seq_node, n)
    if owner is not None and owner[0] == "seq":
        over = stop_value - (n - step)
        return ("use", _range_text(it, _minus(stop, over)), "") if over > 0 else None
    if owner is not None and owner[0] == "other":
        _, other, other_len, via = owner
        if other is None:
            return None
        note = f" ({via} = len({ast.unparse(other)}))" if via else ""
        return "explain", _mismatch(other, other_len, seq_node, n, it, step), note
    if owner is not None:  # "changed": n = len(a), then a got shorter
        _, _, size, via = owner
        seq_text = ast.unparse(seq_node)
        return "explain", (f"{via} = {size} was len({seq_text}) when it was set, but {seq_text} has "
                           f"{_count(n, 'item')} now: it changed length after that line."), ""
    if isinstance(stop, (ast.Constant, ast.Name)):
        if start + step > n - 1:
            return None  # range(5, 10) over 3 items: even the first round fails, so not the stop
        note = f" ({stop.id} = {stop_value})" if isinstance(stop, ast.Name) else ""
        return "use", _range_text(it, _len_of(seq_node, step)), note
    return None  # an expression with no sequence behind it: the right bound is unknown


def _is_len_call(node: ast.AST, frame: types.FrameType) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len" \
        and len(node.args) == 1 and not isinstance(node.args[0], ast.Starred) and not node.keywords \
        and _builtin_len(frame)


def _peek_len(node: ast.expr, frame: types.FrameType, depth: int = 0) -> int:
    """len() of an exact list / tuple / str / deque / dict / set named by a small expression."""
    if isinstance(node, (ast.Name, ast.Attribute)):
        value = _lookup(frame, node.id) if isinstance(node, ast.Name) else _peek_attr(node, frame, depth)
        if type(value) in (dict, set, frozenset):
            return len(value)  # type: ignore[arg-type]
    return len(_peek_seq(node, frame, depth))


def _len_source(tree: ast.Module, name: str) -> ast.expr | None:
    """Y when the code's only binding of `name` is `name = len(Y)`."""
    source: ast.expr | None = None
    bindings = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id == name and not isinstance(node.ctx, ast.Load):
            bindings += 1
        elif isinstance(node, ast.arg) and node.arg == name:
            return None
        elif isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id == name and isinstance(node.value, ast.Call) \
                and isinstance(node.value.func, ast.Name) and node.value.func.id == "len" \
                and len(node.value.args) == 1 and not node.value.keywords:
            source = node.value.args[0]
    return source if bindings == 1 else None


_Owner = tuple[str, ast.expr | None, int, str | None]


def _stop_owner(site: _Site, stop: ast.expr, seq_node: ast.expr, n: int) -> _Owner | None:
    """Which sequence a range's stop counts, as (kind, sequence, its length,
    the name holding that length): "seq" the one indexed (or one of the same
    length), "other" another one, "changed" a name set to len(seq) before
    seq changed length. None: no sequence (a literal, a name holding some
    other number)."""
    frame = site.frame
    seq_text = ast.unparse(seq_node)

    def terms(node: ast.AST) -> list[ast.expr]:  # len(...) calls and names, not the names inside len()
        if _is_len_call(node, frame) or isinstance(node, ast.Name):
            return [node]  # type: ignore[list-item]
        return [t for child in ast.iter_child_nodes(node) for t in terms(child)]

    other: _Owner | None = None
    for term in terms(stop):
        via: str | None = None
        try:
            if isinstance(term, ast.Call):
                measured: ast.expr | None = term.args[0]
                size = _peek_len(term.args[0], frame)
            elif isinstance(term, ast.Name) and term.id != "len":
                size = _peek_int(term, frame)
                measured = _len_source(site.tree, term.id) if site.tree is not None else None
                if measured is None:
                    if size == n:
                        return "seq", None, n, None  # a name holding the length (a parameter, an earlier cell's n)
                    continue
                if _peek_len(measured, frame) != size:
                    if ast.unparse(measured) == seq_text:
                        return "changed", measured, size, term.id
                    continue
                via = term.id
            else:
                continue
        except _Unsafe:
            continue
        if ast.unparse(measured) == seq_text or size == n:  # type: ignore[arg-type]
            return "seq", measured, size, via  # an off-by-one either way
        other = other or ("other", measured, size, via)
    return other


def _count(k: int, word: str) -> str:
    return f"{k} {word}" + ("" if k == 1 else "s")


def _mismatch(other: ast.expr, other_len: int, seq_node: ast.expr, n: int, it: ast.Call, step: int) -> str:
    """The range counts the items of another sequence than the one indexed."""
    other_text, seq_text = ast.unparse(other), ast.unparse(seq_node)
    fixed = _range_text(it, _len_of(seq_node, step))
    if isinstance(other, ast.Subscript) and ast.unparse(other.value) == seq_text:
        return (f"len({other_text}) = {other_len} is the length of a row of {seq_text}, but {seq_text} has "
                f"{_count(n, 'row')}: to go over the rows use {fixed}.")
    if isinstance(seq_node, ast.Subscript) and ast.unparse(seq_node.value) == other_text:
        return (f"len({other_text}) = {other_len} counts the rows of {other_text}, but the row {seq_text} has "
                f"{_count(n, 'item')}: to go along a row use {fixed}.")
    msg = (f"{other_text} and {seq_text} have different lengths ({other_len} and {n}), so a range over "
           f"{other_text} runs past the end of {seq_text}.")
    if isinstance(other, ast.Name) and isinstance(seq_node, ast.Name):
        msg += (f" If they should match, check the data; zip({other_text}, {seq_text}) pairs their items and "
                "stops at the shorter one.")
    return msg


def _comprehension_index_hint(site: _Site, node: ast.expr) -> str | None:
    """a[i + 1] in [... for i in range(len(a))]. The frame no longer holds the
    i that failed (see _Site.comprehensions), but a comprehension without an
    `if` always runs its range to the end, so the bound alone tells."""
    var_step = _var_step(node.slice) if isinstance(node, ast.Subscript) else None
    if var_step is None:
        return None
    var, step = var_step
    gen = comp = None
    for c in site.comprehensions:  # innermost first: it binds var last
        for g in reversed(c.generators):
            if any(isinstance(t, ast.Name) and t.id == var for t in ast.walk(g.target)):
                gen, comp = g, c
                break
        if gen is not None:
            break
    if gen is None or comp is None or not isinstance(gen.target, ast.Name) or gen.ifs or gen.is_async \
            or not _is_range(gen.iter) or any(isinstance(n, ast.NamedExpr) for n in ast.walk(comp)):
        return None
    it = gen.iter
    if not isinstance(it, ast.Call) or not isinstance(node, ast.Subscript):
        return None
    if site.comp_names.intersection([*_names_in(node.value), *(n for a in it.args for n in _names_in(a))]):
        return None  # the list or the bound depends on another loop variable of the comprehension
    try:
        start = _peek_int(it.args[0], site.frame) if len(it.args) == 2 else 0
        last = _peek_int(it.args[-1], site.frame) - 1
        n = len(_peek_seq(node.value, site.frame))
    except _Unsafe:
        return None
    if last + step - (n - 1) <= 0:
        return None  # the range does not overshoot: something else failed
    fix = _range_fix(site, it, node.value, n, step, last + 1, start)
    if fix is None:
        return None
    action, text, note = fix
    seq_text, index_text = ast.unparse(node.value), ast.unparse(node.slice)
    valid = "only index 0 is valid" if n == 1 else f"valid indexes 0..{n - 1}"
    kind = "list" if isinstance(comp, ast.ListComp) else "set" if isinstance(comp, ast.SetComp) else "dict"
    reach = f"{var} = {last}" + (f", so {index_text} reaches {last + step}" if step else "")
    head = (f"{seq_text}[{index_text}] in this {kind} comprehension: 'for {var} in {ast.unparse(it)}' runs up to "
            f"{reach}{note}, but len({seq_text}) = {n} ({valid})")
    return f"{head}: use {text}." if action == "use" else f"{head}. {text}"


def _minus(node: ast.expr, k: int) -> ast.expr:
    """`node - k`, folded: range(n + 1) -> range(n), range(4) -> range(3)."""
    if isinstance(node, ast.Constant) and type(node.value) is int:
        return ast.Constant(node.value - k)
    if isinstance(node, ast.BinOp) and isinstance(node.right, ast.Constant) and type(node.right.value) is int:
        c = node.right.value
        if isinstance(node.op, ast.Add):
            if c == k:
                return node.left
            return ast.BinOp(node.left, ast.Add(), ast.Constant(c - k)) if c > k \
                else ast.BinOp(node.left, ast.Sub(), ast.Constant(k - c))
        if isinstance(node.op, ast.Sub):
            return ast.BinOp(node.left, ast.Sub(), ast.Constant(c + k))
    return ast.BinOp(node, ast.Sub(), ast.Constant(k))


def _pop_hint(node: ast.Call, frame: types.FrameType) -> str | None:
    """stack.pop() / q.popleft() / heappop(h) on an empty container."""
    func = node.func
    if isinstance(func, ast.Attribute) and func.attr in ("pop", "popleft") and len(node.args) <= 1 \
            and not node.keywords:
        target = func.value
        call = ast.unparse(node)
        seq = _peek_seq(target, frame)
        if type(seq) is str or type(seq) is tuple:
            return None
        if len(seq) == 0:
            name = ast.unparse(target)
            return (f"{call}: {name} is empty here. Check before taking an item: "
                    f"'if {name}:' or 'while {name}:'.")
        if node.args:
            index = _peek_int(node.args[0], frame)
            n = len(seq)
            if not -n <= index < n:
                return f"{call}: index {index}, but len({ast.unparse(target)}) = {n} (valid indexes 0..{n - 1})."
        return None
    is_heappop = (isinstance(func, ast.Attribute) and func.attr == "heappop") or \
        (isinstance(func, ast.Name) and func.id == "heappop")
    if is_heappop and len(node.args) == 1 and not node.keywords:
        heap = _peek_seq(node.args[0], frame)
        if type(heap) is list and len(heap) == 0:
            name = ast.unparse(node.args[0])
            return f"{ast.unparse(node)}: the heap {name} is empty here. Check 'if {name}:' before popping."
    return None


def _describe(value: object) -> str:
    """A few words about a value, from its exact type only."""
    t = type(value)
    if t in (int, float, bool, type(None)):
        return repr(value)
    if t is str:
        if len(value) <= 36:  # type: ignore[arg-type]
            return repr(value)
        text = repr(value[:36])  # type: ignore[index] - not the whole of open(f).read()
        return text[:min(len(text) - 1, 36)] + "..." + text[0]  # keep repr's own quote
    if t in (list, tuple, dict, set):
        size = len(value)  # type: ignore[arg-type]
        return f"a {t.__name__} of {size} item{'' if size == 1 else 's'}"
    if t is types.MethodType or t is types.BuiltinFunctionType:
        # Member/getset descriptors of the method types: no user code runs.
        self_obj = value.__self__  # type: ignore[attr-defined]
        func = value.__func__ if t is types.MethodType else value  # type: ignore[attr-defined]
        name = func.__name__ if type(func) in (types.FunctionType, types.BuiltinFunctionType) else "method"
        if self_obj is sys.stdin:
            return f"sys.stdin.{name}"
        if type(self_obj) is types.ModuleType:
            modname = _MODULE_DICT.__get__(self_obj, types.ModuleType).get("__name__")
            # max = min: a plain built-in; from math import pow: math.pow
            return f"{name}()" if modname == "builtins" or type(modname) is not str else f"{modname}.{name}()"
        if self_obj is None:
            return f"{name}()"
        return f"a method {name}()"
    if t is types.FunctionType:
        return f"a function {value.__name__}()"  # type: ignore[attr-defined]
    from .serialize import type_qualname

    return f"a {type_qualname(t)} object"


def _shadowed_builtin_hint(site: _Site, evalue: str) -> str | None:
    """max(a) after `max = 0`: the call reached the learner's value, not the built-in."""
    node, frame = site.node, site.frame
    if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
        return None
    name = node.func.id
    builtins_ns = frame.f_builtins
    original = builtins_ns.get(name) if type(builtins_ns) is dict else None
    if original is None or name.startswith("_") or name in site.comp_names:
        return None
    try:
        value = _lookup(frame, name)
    except _Unsafe:
        return None
    if value is original:
        return None
    t = type(value)
    not_callable = "object is not callable" in evalue
    # A stand-in that is not the learner's own function (input =
    # sys.stdin.readline): its TypeError is about the stand-in's arguments.
    stand_in = t is types.BuiltinFunctionType or (
        t is types.MethodType and type(value.__func__) is types.FunctionType  # type: ignore[attr-defined]
        and not _is_learner_file(value.__func__.__code__.co_filename))  # type: ignore[attr-defined]
    if not (not_callable and site.last) and not stand_in:
        return None
    desc = _describe(value)
    kind = "type" if type(original) is type else "function"
    is_local = frame.f_code.co_name != "<module>" and name in frame.f_locals \
        and frame.f_locals is not frame.f_globals
    fix = f"Rename your variable (e.g. {name}_value)"
    if is_local:
        origin = f"inside {frame.f_code.co_name}()"
    else:
        origin = "by code you ran earlier (maybe in another file: all files share one kernel)"
        bound = _top_level_binding(site.tree, name) if site.tree is not None else None
        if bound is not None:
            src = linecache.getline(frame.f_code.co_filename, bound.lineno).strip()
            where = "" if site.in_cell else f" of {os.path.basename(frame.f_code.co_filename)}"
            origin = f"on line {bound.lineno}{where} ({src[:60]})"
            alias = next((a for a in bound.names if (a.asname or a.name) == name), None) \
                if isinstance(bound, ast.ImportFrom) and bound.module and not bound.level else None
            if alias is not None and t in (types.BuiltinFunctionType, types.FunctionType):
                # from os import open: the module's function, which is not a variable to rename.
                desc = f"{bound.module}.{alias.name}()"  # type: ignore[union-attr]
                fix = f"Import the module instead (import {bound.module}, then call {desc[:-2]}(...))"  # type: ignore[union-attr]
    msg = (f"{name} is a built-in {kind}, but here {name} holds {desc}, set {origin}, so {name}(...) "
           f"calls that instead. {fix}")
    msg += "." if is_local else f", or run del {name} to get the built-in back."
    if name == "input" and desc.startswith("sys.stdin."):
        msg += " sys.stdin.readline() takes no prompt and keeps the '\\n' at the end of the line."
    return msg


def describe_result(value: object) -> dict[str, Any]:
    from .heap import viz_hint

    t = type(value)
    name = type_qualname(t)
    is_frame = type_module(t).startswith("pandas") and name in ("DataFrame", "Series")
    # describe() / corr() of a 30-column frame is ~30 lines of 500 chars:
    # pandas' own max_rows / max_columns bound it, 4000 chars cut it mid-row.
    info: dict[str, Any] = {
        "type": type_name(value),
        "shortType": short_type_name(value),
        "repr": friendly_repr(value, 400_000 if is_frame else 4000),
    }
    if t is str and value.count("\n") >= 2 and len(value) <= 200_000:  # type: ignore[attr-defined]
        # classification_report(...) as the last line: show the table, not
        # a quoted string full of \n. One-line strings keep their repr.
        info["repr"] = value
        info["text"] = True
    if is_frame:
        info["shape"] = list(getattr(value, "shape", ()))
        info["dataframe"] = name == "DataFrame"
    elif type_module(t).startswith("torch") and name in ("Tensor", "Parameter"):
        try:
            v: Any = value
            info["shape"] = [int(x) for x in v.shape]
            info["shortType"] = f"Tensor {str(v.dtype).removeprefix('torch.')} {v.device}"
        except Exception:  # noqa: BLE001
            pass
    else:
        try:
            info["viz"] = viz_hint(value)
        except Exception:  # noqa: BLE001
            pass
    return info


class _Figures:
    """Figures of the current run: shown ones (plt.show) first, then the rest."""

    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.budget = MAX_FIGURES_TOTAL_B64  # all figures share one response message
        self.dropped = 0
        # plt.pause() / show(block=False) figures: a live-update loop keeps
        # drawing on them, so they are rendered later, in their final state.
        self.held: list[Any] = []
        # ids of figures already counted in `dropped`, so a figure that every
        # pause() of a loop sees again is counted once.
        self.dropped_ids: set[int] = set()

    def shown(self) -> int:
        return len([f for f in self.items if "png" in f or "html" in f])

    def add_png(self, render: Any, label: str) -> None:
        if self.shown() >= MAX_FIGURES:
            self.dropped += 1
            return
        try:
            data = render()
        except Exception as exc:  # noqa: BLE001
            self.items.append({"error": f"{label}: {type(exc).__name__}: {exc}"})
            return
        encoded_len = (len(data) + 2) // 3 * 4
        if len(data) > MAX_FIGURE_BYTES or encoded_len > self.budget:
            self.items.append({"error": f"{label} too large to display ({len(data)} bytes)"})
        else:
            self.budget -= encoded_len
            self.items.append({"png": base64.b64encode(data).decode("ascii")})


_current = _Figures()


def reset_figures() -> None:
    """Start of a run: figures of an interrupted run must not leak into it."""
    global _current
    _current = _Figures()
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        try:
            plt.close("all")
        except Exception:  # noqa: BLE001
            pass


def _png_of(fig: Any) -> bytes:
    w, h = fig.get_size_inches()
    dpi = min(100.0, MAX_FIGURE_PIXELS / max(w, h, 1e-6))
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    return buf.getvalue()


def _open_figures() -> list[tuple[int, Any]]:
    """(number, figure) of every open pyplot figure, without changing the
    current figure: plt.figure(num) would redirect the user's next plt.plot."""
    plt = sys.modules.get("matplotlib.pyplot")
    helpers = sys.modules.get("matplotlib._pylab_helpers")
    if plt is None:
        return []
    try:
        nums = sorted(plt.get_fignums())
        managers = helpers.Gcf.figs if helpers is not None else {}
    except Exception:  # noqa: BLE001
        return []
    out = []
    for num in nums:
        try:
            manager = managers.get(num)
            out.append((num, manager.canvas.figure if manager is not None else plt.figure(num)))
        except Exception:  # noqa: BLE001
            continue
    return out


def show_figures() -> None:
    """plt.show(): render held and open figures now, in order, and close them."""
    plt = sys.modules.get("matplotlib.pyplot")
    held, _current.held = _current.held, []
    figures = [(0, fig) for fig in held]
    figures += [(num, fig) for num, fig in _open_figures() if not any(fig is h for h in held)]
    for num, fig in figures:
        if id(fig) not in _current.dropped_ids:
            _current.add_png(lambda fig=fig: _png_of(fig), f"figure {num}" if num else "figure")
        try:
            if plt is not None:
                plt.close(fig)
        except Exception:  # noqa: BLE001
            pass


def hold_figures() -> None:
    """plt.pause() / plt.show(block=False): keep the open figures open.

    Rendering and closing them here (as a blocking show does) kept only the
    first, empty frame of a live-update loop, and the loop then drew on a
    closed figure. They are rendered by the next blocking show or at the end
    of the run instead.
    """
    for _num, fig in _open_figures():
        if any(fig is h for h in _current.held) or id(fig) in _current.dropped_ids:
            continue
        if _current.shown() + len(_current.held) >= MAX_FIGURES:
            _current.dropped += 1
            _current.dropped_ids.add(id(fig))
            continue
        _current.held.append(fig)


def _unhold(fig: object) -> None:
    _current.held = [h for h in _current.held if h is not fig]


def show_value_figure(value: object) -> bool:
    """A matplotlib Figure as the last expression is drawn, like a notebook."""
    t = type(value)
    if not (type_module(t).startswith("matplotlib") and type_qualname(t) in ("Figure", "SubFigure")):
        return False
    fig: Any = value
    try:
        # A SubFigure cannot be saved on its own: draw the figure it is part of.
        for _ in range(100):
            if type_qualname(type(fig)) != "SubFigure":
                break
            fig = fig.figure
    except Exception:  # noqa: BLE001
        return True
    _unhold(fig)
    _current.add_png(lambda: _png_of(fig), "figure")
    plt = sys.modules.get("matplotlib.pyplot")
    try:
        if plt is not None:
            plt.close(fig)  # drawn once, not again by capture_figures
    except Exception:  # noqa: BLE001
        pass
    return True


def add_interactive_figure(path: str, title: str) -> None:
    if _current.shown() >= MAX_FIGURES:
        _current.dropped += 1
        return
    _current.items.append({"html": path, "title": title[:200]})


def capture_figures() -> list[dict[str, Any]]:
    """End of a run: the shown figures plus every figure still open."""
    global _current
    show_figures()
    figures = list(_current.items)
    if _current.dropped:
        # A plot per epoch in a loop: say so instead of dropping them quietly.
        figures.append({"error": f"{_current.dropped} more figures not shown (at most {MAX_FIGURES} per run): "
                                 "draw them as subplots of one figure, or plot once after the loop"})
    _current = _Figures()
    return figures


_TYPE_MRO = type.__dict__["__mro__"]
# Results of plotting calls, already drawn in the captured figure. Matched by
# exact base class so values such as rcParams or a Colormap stay visible.
_PLOT_BASES = {("matplotlib.artist", "Artist"), ("matplotlib.container", "Container"),
               ("matplotlib.colorbar", "Colorbar")}


def _is_plot_type(t: type) -> bool:
    try:
        mro = _TYPE_MRO.__get__(t, type)
    except Exception:  # noqa: BLE001
        return False
    return any((type_module(base), type_qualname(base)) in _PLOT_BASES for base in mro)


def is_plot_artist(value: object) -> bool:
    """plt.plot(...) / sns.histplot(...) results: noise above the figure."""
    if "matplotlib" not in sys.modules:
        return False
    t = type(value)
    if t in (list, tuple):
        seq: Any = value
        return bool(seq) and all(_is_plot_type(type(x)) for x in seq[:20])
    if type_module(t).startswith("matplotlib") and type_qualname(t) in ("Figure", "SubFigure"):
        return False
    return _is_plot_type(t)


_pandas_display_done = False


def apply_pandas_display() -> None:
    """Show every column of a DataFrame instead of ``...``.

    pandas assumes an 80-character terminal (``display.width``) and drops
    middle columns to fit; the Output panel is not one. Applied once, when
    the user has imported pandas, and only to options still at pandas'
    defaults, so an explicit ``pd.set_option`` by the user wins.
    """
    global _pandas_display_done
    if _pandas_display_done:
        return
    pd = sys.modules.get("pandas")
    if pd is None or not hasattr(pd, "get_option"):
        return
    _pandas_display_done = True
    try:
        if pd.get_option("display.width") == 80:
            pd.set_option("display.width", 100_000)
        if pd.get_option("display.max_columns") in (0, 20):
            pd.set_option("display.max_columns", 100)
    except Exception:  # noqa: BLE001 - display tweaks must never break a run
        pass


_plotly_ready = False
_plotly_dir = ""
# The host remembers the figures of its last 30 runs; older files are only
# disk use (each Live re-run of fig.show() writes one).
MAX_PLOTLY_FILES = 30
_plotly_files: list[str] = []
_plotly_bundles: dict[str, str] = {}  # folder -> plotly.js file name written there


def _private_dir(temp_dir: str) -> None:
    os.makedirs(temp_dir, mode=0o700, exist_ok=True)
    getuid = getattr(os, "getuid", None)
    # In a shared /tmp another user could own the folder and swap our files.
    if getuid is not None and os.stat(temp_dir).st_uid != getuid():
        raise PermissionError(f"{temp_dir} belongs to another user")


def _write_new(path_dir: str, prefix: str, suffix: str, data: bytes) -> str:
    """A new file with a random name: O_EXCL, so a planted symlink is never followed."""
    fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=path_dir)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except BaseException:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    return path


def _plotly_bundle(temp_dir: str, get_js: Any, version: str) -> str:
    """plotly.js once per folder, next to the figures that load it, instead
    of 4.8 MB inside every figure file."""
    name = _plotly_bundles.get(temp_dir)
    if name is not None and os.path.isfile(os.path.join(temp_dir, name)):
        return name
    name = "plotly-" + (re.sub(r"[^0-9A-Za-z.]", "_", version)[:40] or "x") + ".min.js"
    js = get_js().encode("utf-8")
    final = os.path.join(temp_dir, name)
    try:
        with open(final, "rb") as fh:
            current: bytes | None = fh.read(len(js) + 1)
    except OSError:
        current = None
    if current != js:
        # Replace rather than write in place: the name may be a planted link.
        tmp = _write_new(temp_dir, "plotly-", ".tmp", js)
        try:
            os.replace(tmp, final)
        except OSError:
            os.remove(tmp)
            raise
    _plotly_bundles[temp_dir] = name
    return name


def _remember_plotly_file(path: str) -> None:
    _plotly_files.append(path)
    while len(_plotly_files) > MAX_PLOTLY_FILES:
        try:
            os.remove(_plotly_files.pop(0))
        except OSError:
            pass


def prepare_plotly(temp_dir: str) -> None:
    """fig.show() must not open a browser tab (on every Live re-run).

    Once plotly is imported, a "vrun" renderer becomes the default: it
    writes the interactive figure to an HTML file and the Output tab offers
    a button to open it. Cheap until plotly is loaded: called before every
    run and after every import.
    """
    global _plotly_ready, _plotly_dir
    if "plotly" not in sys.modules:
        return
    _plotly_dir = temp_dir  # the latest: the worker replaces a folder that vanished
    if _plotly_ready:
        return
    _plotly_ready = True
    try:
        # `import plotly.graph_objects` does not load plotly.io; fig.show()
        # would, and pick the browser renderer before we could replace it.
        import plotly.io as pio

        renderers = pio.renderers
        if str(renderers.default) in ("png", "jpeg", "jpg", "svg", "pdf", "json"):
            return  # the learner chose a static renderer
        try:
            from plotly.io._base_renderers import ExternalRenderer
        except ImportError:
            from plotly.io.base_renderers import ExternalRenderer  # type: ignore[no-redef]

        class VrunRenderer(ExternalRenderer):  # type: ignore[misc, valid-type]
            def render(self, fig_dict: Any) -> None:
                if _current.shown() >= MAX_FIGURES:
                    _current.dropped += 1  # no file nobody can open
                    return
                try:
                    path = self._write(fig_dict)
                except Exception as exc:  # noqa: BLE001
                    _current.items.append({"error": f"plotly figure: {type(exc).__name__}: {exc}"})
                    return
                title = ""
                try:
                    layout_title = fig_dict.get("layout", {}).get("title")
                    title = layout_title.get("text", "") if type(layout_title) is dict else str(layout_title or "")
                except Exception:  # noqa: BLE001
                    pass
                kinds = sorted({str(tr.get("type", "scatter")) for tr in fig_dict.get("data", []) if type(tr) is dict})
                add_interactive_figure(path, title or "plotly figure: " + ", ".join(kinds))

            def _write(self, fig_dict: Any) -> str:
                folder = _plotly_dir
                _private_dir(folder)
                include: Any = True
                try:
                    from plotly.offline import get_plotlyjs, get_plotlyjs_version

                    include = _plotly_bundle(folder, get_plotlyjs, str(get_plotlyjs_version()))
                except Exception:  # noqa: BLE001 - a self-contained file still works
                    pass
                html = pio.to_html(fig_dict, include_plotlyjs=include, full_html=True)
                path = _write_new(folder, f"figure-{os.getpid()}-", ".html", html.encode("utf-8"))
                _remember_plotly_file(path)
                return path

        renderers["vrun"] = VrunRenderer()
        renderers.default = "vrun"
    except Exception:  # noqa: BLE001 - never break a run over a renderer
        pass


def silence_agg_show_warning() -> None:
    warnings.filterwarnings(
        "ignore", message=".*non-interactive.*cannot be shown", category=UserWarning)
    warnings.filterwarnings("ignore", message=".*FigureCanvasAgg is non-interactive.*")
