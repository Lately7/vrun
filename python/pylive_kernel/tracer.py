"""Step-by-step tracing of algorithm code for the DSA visualizer.

The code runs in a *fresh* namespace (the persistent kernel namespace is not
touched) under ``sys.settrace``. For each executed line of the traced source
we record the call stack, the locals of each traced frame and a heap of the
objects they reference (see ``heap.HeapEncoder``).

Each step carries only the heap nodes that changed since they were last sent
(``heapDelta``), and in ``stack`` a number n for a run of n frames unchanged
since the previous step (``stackRuns``); the webview rebuilds both.
Every frame has an id (``fid``) for the call tree, and on its first step its
parameter names and code id. A frame's "return" step says how it ended:
``ret`` (returned), ``ret`` with ``yield`` (a generator suspended), or
``raised`` (an exception left the frame).

Limits (steps, bytes, wall time) are enforced by raising ``TraceLimit`` from
the trace callback. It derives from ``BaseException`` so ordinary
``except Exception`` blocks in user code do not swallow it; if user code
uses a bare ``except``, ``_Stopper`` raises it again on every following line.
A trace stopped at a limit while the program repeats a state exactly says
so (``loop``: a likely endless loop, see ``Recorder._watch_loop``).

With a ``prelude`` (the text above a traced cell), the definitions the cell
needs from it run first, untraced (see ``prelude.py``); ``notes`` say which.
The cell's calls of functions from it are not traced either, but are held
to the time limit (``Recorder.prelude_trace``).
"""

from __future__ import annotations

import ast
import builtins
import dis
import io
import json
import marshal
import random
import sys
import threading
import time
import types
from typing import Any

from . import prelude as prelude_mod
from .executor import format_exception, format_syntax_error, register_source
from .heap import HeapEncoder, HeapMemo, is_class, shown_as_tag
from .programinput import ProgramInput, StdinSwap
from .serialize import type_module

TRACE_FILE = "<pylive-trace>"
TRACE_MODULE = "__pylive_trace__"
# Bound now: the traced code shares the random module and may rebind these.
_random_state = random.getstate
_random_restore = random.setstate
# Caps of what one step shows. They were 64 items and 150 nodes, which cut a
# BFS's visited set of a 10x10 grid, a sort of 200 numbers and a memo of 71
# keys without saying so. Tuples of plain values ((r, c) cells, (dist, node)
# heap entries) cost a node only on the step they first appear (see
# heap.HeapMemo), so the node cap bounds lists, dicts and objects. 2-D
# arrays keep 64 x 64.
MAX_ITEMS = 512
MAX_NODES = 1000
MAX_MATRIX = 64


class TraceLimit(BaseException):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _code_objects(code: types.CodeType) -> list[types.CodeType]:
    """A code object and every function, class body and comprehension in it."""
    out = [code]
    for c in out:
        out.extend(k for k in c.co_consts if type(k) is types.CodeType)
    return out


class _Stopper:
    """After a limit, raises stop() on every line of the given code.

    CPython stops calling a trace function in a frame once it raised, so a
    bare ``except:`` around the line that hit the limit swallowed the stop:
    an endless loop then ran on untraced and the trace never returned.
    sys.monitoring keeps calling its callback in that frame. Only the traced
    code's own code objects are armed; library code runs at full speed.
    (The cells above, prelude.py, use it for their time budget too.)
    """

    _TOOLS = (4, 3)  # ids no standard tool claims (debuggers use 0, coverage 1)

    def __init__(self, roots: list[types.CodeType], stop: Any) -> None:
        self.tool: int | None = None
        self.codes = [c for root in roots for c in _code_objects(root)]
        mon = getattr(sys, "monitoring", None)
        if mon is None:
            return
        for tool in self._TOOLS:
            if mon.get_tool(tool) is None:
                try:
                    mon.use_tool_id(tool, "vrun trace stop")
                except ValueError:
                    continue
                self.tool = tool
                break
        if self.tool is None:
            return  # no free id: the limit still holds without a bare except

        def line(code: types.CodeType, lineno: int) -> None:
            raise stop()

        mon.register_callback(self.tool, mon.events.LINE, line)
        for c in self.codes:
            mon.set_local_events(self.tool, c, mon.events.LINE)

    def close(self) -> None:
        if self.tool is None:
            return
        mon = sys.monitoring
        for c in self.codes:
            mon.set_local_events(self.tool, c, 0)
        mon.register_callback(self.tool, mon.events.LINE, None)
        mon.free_tool_id(self.tool)
        self.tool = None


class _BoundedOutput(io.TextIOBase):
    def __init__(self, limit: int) -> None:
        self.parts: list[str] = []
        self.size = 0
        self.limit = limit
        self.truncated = False
        self.writes = 0  # output goes on even when no more of it is kept

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        self.writes += 1
        if self.size < self.limit:
            take = s[: self.limit - self.size]
            self.parts.append(take)
            self.size += len(take)
            if len(take) < len(s):
                self.truncated = True
        else:
            self.truncated = True
        return len(s)

    def getvalue(self) -> str:
        return "".join(self.parts)


class _ThreadRouter:
    """sys.stdout stand-in: the traced thread writes to the trace buffer."""

    def __init__(self, fallback: Any, trace_out: _BoundedOutput, tid: int) -> None:
        self._fallback = fallback
        self._trace_out = trace_out
        self._tid = tid

    def _target(self) -> Any:
        return self._trace_out if threading.get_ident() == self._tid else self._fallback

    def write(self, s: str) -> int:
        return self._target().write(s)

    def flush(self) -> None:
        target = self._target()
        if hasattr(target, "flush"):
            target.flush()

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)


_CO_OPTIMIZED = 0x01  # set for functions, not for module or class bodies
_CO_VARARGS = 0x04
_CO_VARKEYWORDS = 0x08
_CO_RESUMABLE = 0x20 | 0x80 | 0x100 | 0x200  # generator, coroutine, async generator


def _params(code: types.CodeType) -> list[str]:
    n = code.co_argcount + code.co_kwonlyargcount
    n += bool(code.co_flags & _CO_VARARGS) + bool(code.co_flags & _CO_VARKEYWORDS)
    # ".0" is the iterator a generator expression gets, not a user name.
    return [v for v in code.co_varnames[:n] if not v.startswith(".")]


def _ops(*names: str) -> frozenset[int]:
    return frozenset(dis.opmap[n] for n in names if n in dis.opmap)


# Opcodes at f_lasti when a frame's "return" event fires. Bytecode differs
# between versions (RETURN_CONST is 3.12-3.13 only), hence the name lookup.
_RETURN_OPS = _ops("RETURN_VALUE", "RETURN_CONST")
_YIELD_OPS = _ops("YIELD_VALUE")
_SEND_OPS = _ops("SEND", "END_SEND", "CLEANUP_THROW")
_TYPE_NAME = type.__dict__["__name__"]
_Cached = tuple[dict[str, Any], str]  # an encoded frame and its JSON
_dumps = json.JSONEncoder(separators=(",", ":")).encode


def _exc_name(exc: object) -> str:
    # The type's own descriptor: a metaclass could override __getattribute__.
    try:
        return _TYPE_NAME.__get__(exc)  # type: ignore[no-any-return]
    except TypeError:
        return "Exception"


_HIDDEN_GLOBALS = {"__builtins__", "__name__", "__doc__", "__package__", "__loader__",
                   "__spec__", "__file__", "__annotations__", "__cached__"}

# -- endless loops -------------------------------------------------------------
# A line step whose frames encode exactly as at an earlier step, with no heap
# change, output or input in between, repeats a program state: a
# deterministic program then loops forever. That holds only for state the
# trace shows. Lines that may change state it does not show end the stretch
# in which states are compared: a for loop's iterator, generators, random
# numbers, the clock, input, and code that is not traced.
_ITER_OPS = _ops("FOR_ITER", "SEND", "GET_ANEXT", "END_ASYNC_FOR", "YIELD_VALUE")
# `nonlocal n; n += 1` in a closure: the cell belongs to a frame that may
# be gone or suspended (and is not re-encoded), so the change is unseen.
_DEREF_STORE_OPS = _ops("STORE_DEREF", "DELETE_DEREF")
_GLOBAL_OPS = _ops("LOAD_GLOBAL", "LOAD_NAME", "LOAD_FROM_DICT_OR_GLOBALS")
_LOCAL_OPS = _ops("LOAD_FAST", "LOAD_FAST_CHECK", "LOAD_FAST_AND_CLEAR", "LOAD_DEREF",
                  "LOAD_FROM_DICT_OR_DEREF")
_ATTR_OPS = _ops("LOAD_ATTR", "LOAD_METHOD", "LOAD_SUPER_ATTR", "IMPORT_NAME", "IMPORT_FROM")
# Built-ins that read or change state no frame shows.
_HIDDEN_BUILTINS = frozenset({"next", "iter", "aiter", "anext", "input", "open", "exec", "eval",
                              "globals", "locals", "vars", "getattr", "setattr", "delattr",
                              "__import__", "breakpoint"})
# Methods of library objects with such state (random generators, clocks,
# files, queues). Not `.next` (a linked list's field) and not `.get`.
_HIDDEN_ATTRS = frozenset({
    "__next__", "send", "throw", "random", "randint", "randrange", "choice", "choices", "shuffle",
    "sample", "uniform", "gauss", "normalvariate", "getrandbits", "seed", "rand", "randn", "integers",
    "normal", "permutation", "urandom", "uuid1", "uuid4", "token_hex", "token_bytes", "time",
    "time_ns", "perf_counter", "perf_counter_ns", "monotonic", "monotonic_ns", "process_time",
    "sleep", "now", "today", "utcnow", "stdin", "read", "readline", "readlines", "recv",
    "get_nowait", "empty", "qsize", "full", "is_alive", "poll", "wait", "acquire", "locked",
})
_HIDDEN_MODULES = ("random", "time", "datetime", "secrets", "uuid", "sys", "os", "threading", "queue",
                   "socket", "select", "io", "fileinput", "itertools")
_LOOP_STATES_MAX = 20_000  # a longer stretch without any change is not compared further
_LOOP_MAX_DEPTH = 100  # deeper stacks are not compared (see Recorder._record)
_MISSING = object()

# Per line: always volatile (an iterator, a closure's cell, a hidden
# method), and the global, local and attribute names it loads.
_LineInfo = tuple[bool, set[str], set[str], set[str]]
# Per line of the traced source: names whose attributes or items it sets
# (`C.n += 1`), (name, attribute) of method calls on a name (`helpers.bump(c)`,
# `C.items.append(1)`), and whether it sets them on something unnamed.
_LineRoots = tuple[frozenset[str], frozenset[tuple[str, str]], bool]


def _line_names(code: types.CodeType) -> dict[int, _LineInfo]:
    """Per line of a code object: whether it always changes state the trace
    does not show, and the global, local and attribute names it loads."""
    out: dict[int, _LineInfo] = {}
    free = code.co_freevars
    for ins in dis.get_instructions(code):
        pos = ins.positions
        line = pos.lineno if pos is not None else None
        if line is None:
            continue
        entry = out.get(line)
        if entry is None:
            entry = out[line] = (False, set(), set(), set())
        if ins.opcode in _ITER_OPS or (ins.opcode in _DEREF_STORE_OPS and ins.argval in free):
            out[line] = entry = (True, entry[1], entry[2], entry[3])
        elif type(ins.argval) is str:
            if ins.opcode in _GLOBAL_OPS:
                entry[1].add(ins.argval)
            elif ins.opcode in _LOCAL_OPS:
                entry[2].add(ins.argval)
            elif ins.opcode in _ATTR_OPS:
                entry[3].add(ins.argval)
                if ins.argval in _HIDDEN_ATTRS:
                    out[line] = entry = (True, entry[1], entry[2], entry[3])
    return out


def _chain(node: ast.expr) -> tuple[ast.expr, str | None, bool]:
    """Root of `a.b[i].c`, the attribute right after it (b), and whether the
    chain goes through __class__ (`self.__class__.count += 1`)."""
    first: str | None = None
    via_class = False
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Starred)):
        if isinstance(node, ast.Attribute):
            first = node.attr
            via_class = via_class or node.attr == "__class__"
        node = node.value
    return node, first, via_class


def _line_roots(tree: ast.AST) -> dict[int, _LineRoots]:
    """See _LineRoots. From the source rather than the bytecode: which
    object a STORE_ATTR sets is not in the instruction."""
    stores: dict[int, set[str]] = {}
    calls: dict[int, set[tuple[str, str]]] = {}
    always: set[int] = set()

    def lines(node: ast.AST) -> range:
        return range(node.lineno, (node.end_lineno or node.lineno) + 1)  # type: ignore[attr-defined]

    def target(t: ast.expr) -> None:
        if isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                target(e)
            return
        if isinstance(t, ast.Starred):
            target(t.value)
            return
        if not isinstance(t, (ast.Attribute, ast.Subscript)):
            return
        root, _attr, via_class = _chain(t)
        if isinstance(root, ast.Name) and not via_class:
            for ln in lines(t):
                stores.setdefault(ln, set()).add(root.id)
        elif not isinstance(root, (ast.List, ast.Tuple, ast.Dict, ast.Set, ast.Constant)):
            always.update(lines(t))  # type(self).count += 1, get().x = 1

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                target(t)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor, ast.comprehension)):
            target(node.target)
        elif isinstance(node, ast.Delete):
            for t in node.targets:
                target(t)
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            target(node.optional_vars)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            root, attr, via_class = _chain(node.func)
            if isinstance(root, ast.Name) and attr is not None and not via_class:
                for ln in lines(node):
                    calls.setdefault(ln, set()).add((root.id, attr))
            elif via_class or (isinstance(root, ast.Call) and isinstance(root.func, ast.Name)
                               and root.func.id == "type"):
                always.update(lines(node))  # type(self).registry.append(x)
    out: dict[int, _LineRoots] = {}
    for ln in set(stores) | set(calls) | always:
        out[ln] = (frozenset(stores.get(ln, ())), frozenset(calls.get(ln, ())), ln in always)
    return out


_MODULE_DICT = types.ModuleType.__dict__["__dict__"]


def _module_attr(m: types.ModuleType, name: str) -> Any:
    d = _MODULE_DICT.__get__(m, types.ModuleType)
    return d.get(name, _MISSING) if type(d) is dict else _MISSING


def _builtin_class(v: object) -> bool:
    # A class's own module through type's descriptor (heap.type_module).
    return is_class(v) and type_module(v) == "builtins"  # type: ignore[arg-type]


def _hidden_value(v: object) -> bool:
    """Calling or using v may change state that no traced frame shows."""
    t = type(v)
    if t is types.FunctionType:
        return v.__code__.co_filename != TRACE_FILE  # type: ignore[attr-defined]  # not traced
    if t is types.MethodType:
        return _hidden_value(v.__func__)  # type: ignore[attr-defined]
    if t is types.BuiltinFunctionType:
        return v.__name__ in _HIDDEN_BUILTINS or v.__name__ in _HIDDEN_ATTRS  # type: ignore[attr-defined]
    if t is types.ModuleType:
        return any(v is sys.modules.get(m) for m in _HIDDEN_MODULES)
    return False


def _scalar_text(v: Any) -> str | None:
    """`lo = 4`: how an encoded plain value reads in the loop message."""
    if v is None or type(v) is bool:
        return str(v)
    if type(v) is int or type(v) is float:
        return repr(v)
    if type(v) is str:
        return repr(v if len(v) <= 20 else v[:20] + "…")
    return None


class Recorder:
    def __init__(self, max_steps: int, max_bytes: int, max_seconds: float,
                 max_nodes: int, max_items: int, out: _BoundedOutput) -> None:
        self.steps: list[dict[str, Any]] = []
        self.max_steps = max_steps
        self.max_bytes = max_bytes
        self.deadline = time.perf_counter() + max_seconds
        self.max_nodes = max_nodes
        self.max_items = max_items
        self.bytes = 0
        self.stopped: str | None = None
        self.out = out
        self.ids: dict[int, int] = {}
        self.keepalive: list[object] = []
        self.calls = 0
        self.skipped_deep = 0  # snapshots skipped near the recursion limit
        self.near_limit = False  # the stack came close to sys.getrecursionlimit()
        # Frame ids for the call tree: assigned on "call", released when the
        # call ends (a later frame at the same address is a new call). A
        # generator keeps its id while it is only suspended at a yield.
        self.fids: dict[int, int] = {}
        self.announced: set[int] = set()
        self.next_fid = 1
        # Fingerprint (marshal) of every heap node as last sent, by heap id.
        self.sent: dict[str, bytes] = {}
        # Encoded frame (without first-step fields) and its JSON, by frame id.
        self.frames: dict[int, _Cached] = {}
        # Frames whose cached entry is out of date: a caller whose line has
        # not finished when it calls (comprehension variables, walrus).
        self.stale: set[int] = set()
        # The stack as sent with the previous step: unchanged frames are not
        # sent again.
        self.prev_stack: list[dict[str, Any]] = []
        # Exception type raised in a frame since its last line event, and the
        # last one raised in it at all, by id(frame).
        self.pending_exc: dict[int, object] = {}
        self.last_exc: dict[int, object] = {}
        # Per code object: its bytecode and a small id (recursion is a call
        # of the same code, not of another lambda or __init__).
        self.code_info: dict[int, tuple[types.CodeType, bytes, int]] = {}
        # Unchanged containers and tuples are not encoded again (heap.HeapMemo);
        # by heap id, the node object last sent: the same object is unchanged.
        self.memo = HeapMemo()
        self.sent_nodes: dict[str, Any] = {}
        self.max_matrix = MAX_MATRIX
        # Endless loops: program states since the last change the frames do
        # not show (heap, input, a volatile line), state -> (step, output
        # writes so far). A state is the frames' JSON plus fingerprints of
        # what the encoding leaves out (HeapEncoder.hidden).
        self.states: dict[tuple[Any, ...], tuple[int, int]] = {}
        self.loop: tuple[int, int] | None = None  # (first, repeat) in this stretch
        self.loop_code: types.CodeType | None = None
        self.loop_prints = False  # output was written between first and repeat
        self.last_repeat = -1
        self.flush_states = False
        self.limit_hit = False
        self.last_input = 0
        self.input_pos: Any = None  # a callable: how much program input was read
        self.line_info: dict[int, dict[int, _LineInfo]] = {}
        self.line_roots: dict[int, _LineRoots] = {}  # of the traced source (_line_roots)
        self.root_code: types.CodeType | None = None  # the traced code, for _Stopper
        # Code of the cells above (prelude.py): untraced, but stopped too.
        self.extra_codes: list[types.CodeType] = []
        self.stopper: _Stopper | None = None

    def _code(self, code: types.CodeType) -> tuple[types.CodeType, bytes, int]:
        info = self.code_info.get(id(code))
        if info is None:
            info = self.code_info[id(code)] = (code, code.co_code, len(self.code_info) + 1)
        return info

    def _opcode(self, frame: types.FrameType) -> int:
        co = self._code(frame.f_code)[1]
        i = frame.f_lasti
        return co[i] if 0 <= i < len(co) else -1

    def _end_kind(self, frame: types.FrameType) -> str:
        """How a frame's 'return' event ends it: return, yield, or raise."""
        op = self._opcode(frame)
        if frame.f_code.co_flags & _CO_RESUMABLE and op in _YIELD_OPS:
            pending = self.pending_exc.get(id(frame))
            # close() and garbage collection throw GeneratorExit in at the
            # yield; the frame then unwinds from that yield.
            if pending is None or pending is StopIteration or pending is StopAsyncIteration:
                return "yield"
        # While unwinding, the frame stops at the instruction that raised.
        return "return" if op in _RETURN_OPS else "raise"

    # sys.settrace entry point: only trace frames of the traced source.
    def global_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if frame.f_code.co_filename != TRACE_FILE:
            # A function from the cells above is not traced, but it is held
            # to the time limit: one with an endless loop ran forever.
            return self.prelude_trace if frame.f_code.co_filename == prelude_mod.PRELUDE_FILE else None
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event == "call":
            self.calls += 1
            if id(frame) not in self.fids:  # a resumed generator keeps its id
                self.fids[id(frame)] = self.next_fid
                self.next_fid += 1
            # The caller's snapshot is from the start of its line; the call
            # comes in the middle of it (`[f(c) for c in kids]`, `f(i := i + 1)`).
            self._caller_stale(frame)
        return self.local_trace

    def prelude_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        """Lines of a function from the cells above: no steps, only the clock."""
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event == "line" and time.perf_counter() > self.deadline:
            self._stop(f"time limit reached in {frame.f_code.co_name}() from the cells above")
        return self.prelude_trace

    def _caller_stale(self, frame: types.FrameType) -> None:
        b = frame.f_back
        while b is not None and b.f_code.co_filename != TRACE_FILE:
            b = b.f_back
        if b is not None:
            bf = self.fids.get(id(b))
            if bf is not None:
                self.stale.add(bf)

    def local_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event == "line":
            self.pending_exc.pop(id(frame), None)
        elif event == "exception":
            exc = arg[0] if isinstance(arg, tuple) and arg else None
            # `yield from` and `await` end a finished sub-generator with a
            # StopIteration of their own; it is not an error in the program.
            # (A user's own `next(it)` raises at a CALL and is kept.)
            op = self._opcode(frame)
            if (exc is StopIteration or exc is StopAsyncIteration) and op in _SEND_OPS:
                return self.local_trace
            self.pending_exc[id(frame)] = exc
            self.last_exc[id(frame)] = exc
            # close() (also by any(), or when the generator is collected)
            # throws GeneratorExit in at the yield: the end step says "closed".
            if exc is GeneratorExit and op in _YIELD_OPS:
                return self.local_trace
        elif event != "return":
            return self.local_trace
        end = None
        if event == "return":
            end = self._end_kind(frame)
            # The callee may have changed the caller's objects through a path
            # the caller's cached snapshot does not show (`Log.entries`).
            self._caller_stale(frame)
        try:
            self._record(frame, event, arg, end)
        except RecursionError:
            # The program runs close to its recursion limit and encoding a
            # snapshot needs a few more frames. Raising here would make
            # CPython switch tracing off silently, so skip this snapshot.
            self.skipped_deep += 1
        if end is not None and end != "yield":
            key = id(frame)
            fid = self.fids.pop(key, None)
            if fid is not None:
                self.frames.pop(fid, None)
                self.stale.discard(fid)
            self.pending_exc.pop(key, None)
            self.last_exc.pop(key, None)
        return self.local_trace

    def _stop(self, reason: str) -> None:
        self.stopped = reason
        self.limit_hit = True
        if self.stopper is None and self.root_code is not None:
            self.stopper = _Stopper([self.root_code, *self.extra_codes], lambda: TraceLimit(reason))
        raise TraceLimit(reason)

    # -- endless loops --------------------------------------------------------
    def _volatile(self, frame: types.FrameType) -> bool:
        """The line may change state the trace does not show (see _ITER_OPS)."""
        code = frame.f_code
        line = frame.f_lineno
        info = self.line_info.get(id(code))
        if info is None:
            self._code(code)  # keeps the code alive, so its id stays its own
            info = self.line_info[id(code)] = _line_names(code)
        entry = info.get(line)
        roots = self.line_roots.get(line)
        if entry is None and roots is None:
            return False
        g, b = frame.f_globals, frame.f_builtins
        # What a name holds when the line runs, not its spelling (a local
        # `next` is a list node, a global `next` the built-in) and not what
        # it held the first time (a parameter `fn` may be random.random later).
        if entry is not None:
            always, globs, locs, _attrs = entry
            if always or any(_hidden_value(g.get(n, b.get(n))) for n in globs):
                return True
            if locs:
                fl = frame.f_locals
                if any(_hidden_value(fl.get(n)) for n in locs):
                    return True
        if roots is None:
            return False
        stores, calls, always = roots
        if always:
            return True
        fl = frame.f_locals

        def value(n: str) -> Any:
            return fl[n] if n in fl else g.get(n, b.get(n, _MISSING))

        for n in stores:
            # C.n += 1, linked.k = 0, f.calls += 1, obj.x = 1 for an object
            # shown as a tag: nothing the trace shows changes.
            v = value(n)
            if v is not _MISSING and shown_as_tag(v) and not _builtin_class(v):
                return True
        for n, attr in calls:
            v = value(n)
            if v is _MISSING or _builtin_class(v):
                continue
            if type(v) is types.ModuleType:
                if _hidden_value(_module_attr(v, attr)):  # helpers.bump(c): not traced
                    return True
            elif shown_as_tag(v):
                return True  # C.items.append(1), counter.incr(): state no frame shows
        return False

    def _watch_loop(self, frame: types.FrameType, event: str, state: tuple[Any, ...] | None,
                    changed: bool) -> None:
        index = len(self.steps) - 1
        pos = self.input_pos() if self.input_pos is not None else 0
        # Output is no reason to start over: what a program prints does not
        # change what it does next, and a frozen loop that prints (a debug
        # print(lo, hi)) prints the same text on every pass.
        if changed or self.flush_states or state is None or pos != self.last_input:
            # The program moved on: no earlier state can come back unchanged.
            self.states.clear()
            self.loop = None
            self.flush_states = False
            self.last_input = pos
        if event != "line" or state is None:
            return
        writes = self.out.writes
        seen = self.states.get(state)
        if seen is None:
            if len(self.states) >= _LOOP_STATES_MAX:
                self.states.clear()
                self.loop = None
            self.states[state] = (index, writes)
        else:
            if self.loop is None:
                self.loop = (seen[0], index)
                self.loop_code = frame.f_code
                self.loop_prints = writes != seen[1]
            self.last_repeat = index
        if self._volatile(frame):
            # The state above is from before the line runs; what the line
            # changes unseen is only in the next steps' states.
            self.flush_states = True

    def loop_report(self) -> dict[str, Any] | None:
        """C5 `loop`, when the trace stopped at a limit inside a repeating state."""
        if not self.limit_hit or self.loop is None:
            return None
        first, repeat = self.loop
        period = repeat - first
        # Safety net: a deterministic program in that cycle repeats states
        # in every period until the end.
        if len(self.steps) - 1 - self.last_repeat > period:
            return None
        step = self.steps[repeat]
        top = step["stack"][-1]
        on_lines = {s["line"] for s in self.steps[first:repeat + 1]}
        names: set[str] = set()
        if self.loop_code is not None:
            info = self.line_info.get(id(self.loop_code)) or _line_names(self.loop_code)
            for line in on_lines:
                entry = info.get(line)
                if entry is not None:
                    names |= entry[1] | entry[2]
        names |= {n for line in on_lines for n in self._stored_on(line)}
        values = [[n, v] for n, v in top["locals"] if n in names][:8]
        text = ", ".join(f"{n} = {t}" for n, v in values if (t := _scalar_text(v)) is not None)
        report: dict[str, Any] = {"first": first, "repeat": repeat, "line": step["line"], "values": values,
                                  "text": text}
        if self.loop_prints:
            report["prints"] = True  # it writes the same output on every pass
        return report

    def _stored_on(self, line: int) -> set[str]:
        code = self.loop_code
        if code is None:
            return set()
        return {ins.argval for ins in dis.get_instructions(code)
                if ins.positions is not None and ins.positions.lineno == line
                and ins.opname.startswith("STORE_") and type(ins.argval) is str}

    def _encode_frame(self, fr: types.FrameType, fid: int, is_module: bool, top: bool,
                      enc: HeapEncoder) -> _Cached:
        names = fr.f_globals if is_module else fr.f_locals
        # A closure's free variables live in cells that other frames rebind
        # (`nonlocal best`). They are shown where they change: in the running
        # frame and in the frame that owns the cell. In every suspended dfs()
        # they would be stale, or make each step resend the whole stack.
        hidden = () if top else fr.f_code.co_freevars
        local_vars = []
        for name, value in list(names.items()):
            # type(), not isinstance(): a user class's __class__
            # property would run; globals()[1] = ... gives int keys.
            if type(name) is not str or name.startswith("__") or name in hidden:
                continue
            if is_module and (name in _HIDDEN_GLOBALS or type(value) is types.ModuleType):
                continue
            local_vars.append([name, enc.encode(value)])
        entry = {"func": fr.f_code.co_name, "line": fr.f_lineno, "locals": local_vars, "fid": fid}
        return entry, _dumps(entry)

    def _record(self, frame: types.FrameType, event: str, arg: Any, end: str | None) -> None:
        if len(self.steps) >= self.max_steps:
            self._stop(f"step limit ({self.max_steps}) reached")
        if time.perf_counter() > self.deadline:
            self._stop("time limit reached")
        # Library frames between traced ones (heapq.nsmallest calling a key
        # lambda, Counter consuming a genexpr) are skipped, not the end.
        frames = []
        depth = 0
        f: types.FrameType | None = frame
        while f is not None:
            if f.f_code.co_filename == TRACE_FILE:
                frames.append(f)
            depth += 1
            f = f.f_back
        frames.reverse()
        # Remember deep stacks: if CPython later switches tracing off, this
        # tells a recursion-limit stop apart from a program calling settrace.
        if depth >= sys.getrecursionlimit() - 50:
            self.near_limit = True
        # (hidden always: a node reused later replays what it added here)
        hidden: list[Any] = []
        enc = HeapEncoder(max_nodes=self.max_nodes, max_items=self.max_items,
                          ids=self.ids, keepalive=self.keepalive, memo=self.memo,
                          max_matrix=self.max_matrix, hidden=hidden)
        stack = []
        sizes = []
        announce = []
        # The frames' JSON: the program state, for _watch_loop. Not for deep
        # recursion: keying every frame on every step cost 15 % at depth 5000.
        keys: list[str] | None = [] if len(frames) <= _LOOP_MAX_DEPTH else None
        for fr in frames:
            fid = self.fids.get(id(fr))
            if fid is None:
                fid = self.fids[id(fr)] = self.next_fid
                self.next_fid += 1
            code = fr.f_code
            is_module = code.co_name == "<module>"
            cached = self.frames.get(fid)
            # A suspended caller cannot change its own locals: only the top
            # frame runs, globals change from anywhere and cells from the
            # frames that share them. Its objects can change, but only
            # through a frame that reaches them, which is encoded. (A caller
            # is re-encoded once when it calls and when the callee returns.)
            # Re-encoding every frame made a deep recursion quadratic.
            if (cached is not None and fr is not frame and not is_module
                    and not code.co_cellvars and fid not in self.stale):
                entry, js = cached
            else:
                entry, js = self._encode_frame(fr, fid, is_module, fr is frame, enc)
                if cached is not None and cached[1] == js:
                    entry = cached[0]  # unchanged: the same object is not sent again
                self.frames[fid] = (entry, js)
                self.stale.discard(fid)
            if keys is not None:
                keys.append(js)
            size = len(js)
            if fid not in self.announced:
                announce.append(fid)
                first: dict[str, Any] = {"params": _params(code), "code": self._code(code)[2]}
                # The qualified name tells Trie.__init__ from TrieNode.__init__;
                # a class body runs like a call but is none.
                qual = getattr(code, "co_qualname", code.co_name)
                if qual != code.co_name:
                    first["qual"] = qual
                if not is_module and not code.co_flags & _CO_OPTIMIZED:
                    first["body"] = True
                entry = {**entry, **first}
                size += 60 + len(qual)
            stack.append(entry)
            sizes.append(size)
        # The program state for _watch_loop. Frames from the cache add no
        # fingerprints: what they reach can only change through a frame
        # that is encoded (see above), so theirs would be the same.
        state = None if keys is None or enc.blind else (*keys, *hidden)
        # A deep recursion repeats the same suspended frames on every step:
        # a run of n frames that are the ones sent at the same positions with
        # the previous step is sent as the number n. The top is always sent.
        prev = self.prev_stack
        wire: list[Any] = []
        size = 0
        run = 0
        last = len(stack) - 1
        for i, entry in enumerate(stack):
            if i < last and i < len(prev) and prev[i] is entry:
                run += 1
                continue
            if run:
                wire.append(run)
                size += 6
                run = 0
            wire.append(entry)
            size += sizes[i]
        ret = enc.encode(arg) if end is not None and end != "raise" else None
        # Only nodes that changed since they were last sent: a sort of 50
        # numbers repeated the whole list on every one of its 2000 steps.
        # marshal is several times faster than json.dumps for the check;
        # version 2 has no object sharing, so equal nodes marshal the same.
        delta: dict[str, Any] = {}
        prints: list[tuple[str, bytes]] = []
        fresh: list[tuple[str, Any]] = []
        sent_nodes = self.sent_nodes
        for key, node in enc.heap.items():
            if sent_nodes.get(key) is node:
                continue  # a reused node (HeapMemo): what was sent last
            fresh.append((key, node))
            fp = marshal.dumps(node, 2)
            if self.sent.get(key) != fp:
                prints.append((key, fp))
                delta[key] = node
                size += len(_dumps(node)) + len(key) + 4
        step: dict[str, Any] = {"line": frame.f_lineno, "event": event, "stack": wire,
                                "heap": delta, "out": self.out.size}
        gone = [str(oid) for oid in enc.missing if str(oid) in self.sent]
        if gone:
            step["gone"] = gone
        if end == "raise":
            step["raised"] = _exc_name(self.last_exc.get(id(frame)))
        elif end is not None:
            step["ret"] = ret
            if end == "yield":
                step["yield"] = True
        elif event == "exception" and isinstance(arg, tuple) and arg:
            step["exc"] = _exc_name(arg[0])
        if enc.truncated:
            step["truncated"] = True
        size += 80 + len(_dumps(ret)) + sum(len(g) + 3 for g in gone)
        if self.bytes + size > self.max_bytes:
            self._stop(f"size limit ({self.max_bytes // 1024} KiB) reached")
        # Commit only now: a snapshot skipped by a RecursionError above must
        # not count as sent.
        self.bytes += size
        self.steps.append(step)
        self.prev_stack = stack
        self.announced.update(announce)
        for key, fp in prints:
            self.sent[key] = fp
        for key, node in fresh:
            sent_nodes[key] = node
        for key in gone:
            del self.sent[key]
            sent_nodes.pop(key, None)
            self.memo.frozen.discard(int(key))
        frozen = self.memo.frozen
        for oid in enc.new_frozen:
            if str(oid) in self.sent:
                frozen.add(oid)  # the webview has it; a tuple never changes
        # A cut container is no change: its unshown items are in the state.
        self._watch_loop(frame, event, state, bool(delta or gone))


def _run_prelude(prelude: str, code: str, ns: dict[str, Any], seconds: float) -> prelude_mod.Result:
    """The cells above the traced one (see prelude.py); never fails the trace."""
    register_source(prelude_mod.PRELUDE_FILE, prelude, 0)
    try:
        tree = ast.parse(code)
        return prelude_mod.run(prelude, code, tree, ns, seconds * prelude_mod.PRELUDE_SHARE, _Stopper)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 - a bug here must not cost the trace
        return prelude_mod.Result(notes=[f"the cells above could not be used ({type(exc).__name__})"])


def _loop_stop(rec: Recorder) -> dict[str, Any] | None:
    report = rec.loop_report()
    if report is None:
        return None
    text = report.pop("text")
    where = f"line {report['line']}: {text}" if text else f"line {report['line']}"
    prints = ", printing the same output each time" if report.get("prints") else ""
    # Keep "looks like": only state the trace shows is compared.
    rec.stopped = (f"looks like an endless loop: step {report['repeat'] + 1} repeats step "
                   f"{report['first'] + 1} exactly ({where}){prints}; {rec.stopped}")
    return report


def run_trace(code: str, max_steps: int = 1000, max_bytes: int = 6_000_000,
              max_seconds: float = 10.0, max_nodes: int = MAX_NODES, max_items: int = MAX_ITEMS,
              stdin: str | None = None, prelude: str | None = None) -> dict[str, Any]:
    """Trace code; prelude is the text above the traced cell (C3), whose
    definitions the code may use."""
    register_source(TRACE_FILE, code, 0)
    try:
        code_obj = compile(code, TRACE_FILE, "exec")
    except SyntaxError as exc:
        return {"steps": [], "error": format_syntax_error(exc), "stdout": "", "stopped": None}

    module = types.ModuleType(TRACE_MODULE)
    ns = module.__dict__
    # Classes defined by the traced code get __module__ == "__main__" via
    # __name__, so HeapEncoder recognises them as user types. sys.modules is
    # deliberately left alone: kernel threads must keep seeing the real
    # persistent __main__ while a trace runs.
    ns["__name__"] = "__main__"
    # input() reads the program input (<script>.in) instead of the real stdin,
    # which in the kernel is not a terminal (and in-process would block).
    # A private builtins mapping keeps input() out of the traced variables.
    program_input = ProgramInput(stdin)
    trace_builtins = dict(vars(builtins))
    trace_builtins["input"] = program_input.input
    ns["__builtins__"] = trace_builtins
    out = _BoundedOutput(200_000)
    rec = Recorder(max_steps, max_bytes, max_seconds, max_nodes, max_items, out)
    rec.input_pos = program_input.stream.tell
    rec.root_code = code_obj
    try:
        rec.line_roots = _line_roots(ast.parse(code))
    except (SyntaxError, ValueError, RecursionError):  # compiled above, so not expected
        pass
    error = None
    notes: list[str] = []
    old_out, old_err = sys.stdout, sys.stderr
    tid = threading.get_ident()
    started = time.perf_counter()
    # A traced program that lowers the recursion limit must not leave the
    # kernel at that limit.
    recursion_limit = sys.getrecursionlimit()
    # Nor reseed the kernel's random numbers (`random.seed(1)` in the cell
    # or above it, Live Mode on every edit): Run Cell continues as if no
    # Visualize had happened.
    random_state = _random_state()
    swap = StdinSwap(program_input)
    swap.__enter__()
    try:
        if prelude is not None and prelude.strip():
            # Untraced, output discarded, inside the trace's time budget
            # (rec's deadline is already running).
            discard = _BoundedOutput(0)
            sys.stdout = _ThreadRouter(old_out, discard, tid)  # type: ignore[assignment]
            sys.stderr = _ThreadRouter(old_err, discard, tid)  # type: ignore[assignment]
            above = _run_prelude(prelude, code, ns, max_seconds)
            notes = above.notes
            rec.extra_codes = above.codes
            if program_input.stream.tell():
                program_input.stream.seek(0)  # the cell reads its input from the start
        # Route only this thread's output into the trace; background threads of
        # persistent user code keep writing to the normal kernel streams.
        sys.stdout = _ThreadRouter(old_out, out, tid)  # type: ignore[assignment]
        sys.stderr = _ThreadRouter(old_err, out, tid)  # type: ignore[assignment]
        sys.settrace(rec.global_trace)
        exec(code_obj, ns)
    except TraceLimit as lim:
        rec.stopped = rec.stopped or lim.reason
    except KeyboardInterrupt:
        sys.settrace(None)
        raise
    except BaseException as exc:  # noqa: BLE001 - user errors are part of the trace
        error = format_exception(exc, {TRACE_FILE})
    finally:
        if rec.stopper is not None:
            rec.stopper.close()
        # At the recursion limit CPython cannot even call the trace function
        # and switches tracing off by itself (hooks need frames too, so it
        # cannot be turned back on reliably). Say so instead of silently
        # showing a trace that ends early.
        if sys.gettrace() is None and not rec.stopped and error is None:
            rec.stopped = (
                "tracing stopped at the recursion limit; later steps are not shown"
                if rec.near_limit else
                "the program switched tracing off (sys.settrace); later steps are not shown")
        sys.settrace(None)
        sys.stdout, sys.stderr = old_out, old_err
        swap.__exit__()
        if sys.getrecursionlimit() != recursion_limit:
            sys.setrecursionlimit(recursion_limit)
        try:
            _random_restore(random_state)
        except Exception:  # noqa: BLE001 - never worth failing the trace
            pass
    elapsed = time.perf_counter() - started
    loop = _loop_stop(rec)
    result: dict[str, Any] = {
        "steps": rec.steps,
        "heapDelta": True,
        "stackRuns": True,
        "stopped": rec.stopped,
        "error": error,
        # Make truncation visible in the text itself, not only as a flag.
        "stdout": out.getvalue() + ("\n… output truncated (200 000 characters shown)\n" if out.truncated else ""),
        "stdoutTruncated": out.truncated,
        "skippedSteps": rec.skipped_deep,
        "elapsedMs": round(elapsed * 1000, 1),
        "source": code,
    }
    if loop is not None:
        result["loop"] = loop
    if notes:
        result["notes"] = notes
    return result
