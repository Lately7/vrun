"""Execution of user code in the persistent namespace."""

from __future__ import annotations

import ast
import base64
import io
import linecache
import os
import sys
import traceback
import types
import warnings
from typing import Any

from .serialize import safe_repr, short_type_name, type_name

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
MAX_FIGURES = 8
MAX_FIGURE_BYTES = 2 * 1024 * 1024
MAX_FIGURE_PIXELS = 4096
# Leaves headroom under the worker's 8 MiB message limit for the rest of the result.
MAX_FIGURES_TOTAL_B64 = 5 * 1024 * 1024


def make_user_module() -> types.ModuleType:
    """Fresh ``__main__`` module, as IPython does, so pickling/`if __name__` work."""
    mod = types.ModuleType("__main__", "PyLive Inspector user namespace")
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


def format_exception(exc: BaseException, user_files: set[str]) -> dict[str, Any]:
    """Structured traceback with the worker's own frames removed."""
    tb = exc.__traceback__
    while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename).startswith(_PKG_DIR):
        tb = tb.tb_next
    exc = exc.with_traceback(tb)
    try:
        text = "".join(traceback.format_exception(type(exc), exc, tb))
    except Exception:  # noqa: BLE001
        text = f"{type(exc).__name__} (traceback formatting failed)"
    frames = []
    user_frame = None
    for fs in traceback.extract_tb(tb, limit=64):
        frame = {"file": fs.filename, "line": fs.lineno or 0, "name": fs.name,
                 "col": (fs.colno or 0) + 1 if getattr(fs, "colno", None) is not None else 0,
                 "endCol": (fs.end_colno or 0) + 1 if getattr(fs, "end_colno", None) is not None else 0,
                 "endLine": getattr(fs, "end_lineno", None) or fs.lineno or 0}
        frames.append(frame)
        if fs.filename in user_files:
            user_frame = frame
    try:
        evalue = str(exc)
    except Exception:  # noqa: BLE001
        evalue = "<unprintable exception>"
    return {
        "ename": type(exc).__name__,
        "evalue": evalue[:2000],
        "traceback": text[-20000:],
        "frames": frames[-20:],
        "userFrame": user_frame,
    }


def describe_result(value: object) -> dict[str, Any]:
    from .heap import viz_hint

    info: dict[str, Any] = {
        "type": type_name(value),
        "shortType": short_type_name(value),
        "repr": safe_repr(value, 4000),
    }
    t = type(value)
    if t.__module__.startswith("pandas") and t.__name__ in ("DataFrame", "Series"):
        info["shape"] = list(getattr(value, "shape", ()))
        info["dataframe"] = t.__name__ == "DataFrame"
    else:
        try:
            info["viz"] = viz_hint(value)
        except Exception:  # noqa: BLE001
            pass
    return info


def capture_figures() -> list[dict[str, Any]]:
    """Render and close open pyplot figures (only if the user imported pyplot)."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    figures: list[dict[str, Any]] = []
    try:
        nums = list(plt.get_fignums())
    except Exception:  # noqa: BLE001
        return []
    budget = MAX_FIGURES_TOTAL_B64  # all figures share one response message
    for num in nums[:MAX_FIGURES]:
        try:
            fig = plt.figure(num)
            w, h = fig.get_size_inches()
            dpi = min(100.0, MAX_FIGURE_PIXELS / max(w, h, 1e-6))
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
            data = buf.getvalue()
            encoded_len = (len(data) + 2) // 3 * 4
            if len(data) > MAX_FIGURE_BYTES or encoded_len > budget:
                figures.append({"error": f"figure {num} too large to display ({len(data)} bytes)"})
            else:
                budget -= encoded_len
                figures.append({"png": base64.b64encode(data).decode("ascii")})
        except Exception as exc:  # noqa: BLE001
            figures.append({"error": f"figure {num}: {type(exc).__name__}: {exc}"})
    try:
        plt.close("all")
    except Exception:  # noqa: BLE001
        pass
    return figures


def silence_agg_show_warning() -> None:
    warnings.filterwarnings(
        "ignore", message=".*non-interactive.*cannot be shown", category=UserWarning)
    warnings.filterwarnings("ignore", message=".*FigureCanvasAgg is non-interactive.*")
