"""Execution of user code in the persistent namespace."""

from __future__ import annotations

import ast
import base64
import __future__
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
    hint = error_hint(type(exc).__name__, evalue, exc, folders)
    if hint:
        out["hint"] = hint
    return out


# Import names whose PyPI distribution is called something else.
PIP_NAMES = {"sklearn": "scikit-learn", "cv2": "opencv-python", "PIL": "pillow", "yaml": "pyyaml",
             "skimage": "scikit-image", "bs4": "beautifulsoup4", "dotenv": "python-dotenv",
             "Crypto": "pycryptodome", "docx": "python-docx", "pptx": "python-pptx"}


def _local_module_folder(name: str, folders: list[str]) -> str | None:
    """Folder holding the learner's own <name>.py / <name>/ package, if any.

    The kernel's sys.path[0] is the workspace, not the script's folder, so
    `import my_utils` next to week4/train.py fails; pip would install an
    unrelated PyPI package of that name.
    """
    seen: set[str] = set()
    for folder in [*folders, os.getcwd()]:
        key = os.path.normcase(os.path.abspath(folder))
        if key in seen:
            continue
        seen.add(key)
        if os.path.isfile(os.path.join(folder, name + ".py")) \
                or os.path.isfile(os.path.join(folder, name, "__init__.py")):
            return os.path.abspath(folder)
    return None


def error_hint(ename: str, evalue: str, exc: BaseException, folders: list[str] | None = None) -> str | None:
    """A next step for errors learners hit when practising ML."""
    if ename == "ModuleNotFoundError":
        name = getattr(exc, "name", None)
        if type(name) is str and name and "." not in name:
            local = _local_module_folder(name, folders or [])
            if local is not None:
                return (f"'{name}' is your own module in {local}, but that folder is not on sys.path "
                        "(the kernel starts in the workspace folder). Add it before the import: "
                        f"import sys; sys.path.insert(0, {local!r}) - or open that folder as the workspace.")
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
    return None


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
