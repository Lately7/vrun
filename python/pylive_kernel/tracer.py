"""Step-by-step tracing of algorithm code for the DSA visualizer.

The code runs in a *fresh* namespace (the persistent kernel namespace is not
touched) under ``sys.settrace``. For each executed line of the traced source
we record the call stack, the locals of each traced frame and a heap of the
objects they reference (see ``heap.HeapEncoder``).

Each step carries only the heap nodes that changed since they were last sent
(``heapDelta``); the webview rebuilds the full heap of a step. Every frame has
an id (``fid``) for the call tree, and its parameter names on its first step.

Limits (steps, bytes, wall time) are enforced by raising ``TraceLimit`` from
the trace callback. It derives from ``BaseException`` so ordinary
``except Exception`` blocks in user code do not swallow it; if user code
uses a bare ``except``, the callback keeps raising on every following line.
"""

from __future__ import annotations

import builtins
import io
import json
import sys
import threading
import time
import types
from typing import Any

from .executor import format_exception, format_syntax_error, register_source
from .heap import HeapEncoder
from .programinput import ProgramInput, StdinSwap

TRACE_FILE = "<pylive-trace>"
TRACE_MODULE = "__pylive_trace__"


class TraceLimit(BaseException):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class _BoundedOutput(io.TextIOBase):
    def __init__(self, limit: int) -> None:
        self.parts: list[str] = []
        self.size = 0
        self.limit = limit
        self.truncated = False

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
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


_CO_VARARGS = 0x04
_CO_VARKEYWORDS = 0x08
_CO_RESUMABLE = 0x20 | 0x80 | 0x100 | 0x200  # generator, coroutine, async generator


def _params(code: types.CodeType) -> list[str]:
    n = code.co_argcount + code.co_kwonlyargcount
    n += bool(code.co_flags & _CO_VARARGS) + bool(code.co_flags & _CO_VARKEYWORDS)
    return list(code.co_varnames[:n])


_HIDDEN_GLOBALS = {"__builtins__", "__name__", "__doc__", "__package__", "__loader__",
                   "__spec__", "__file__", "__annotations__", "__cached__"}


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
        # Frame ids for the call tree: assigned on "call", released on
        # "return" (a later frame at the same address is a new call).
        self.fids: dict[int, int] = {}
        self.announced: set[int] = set()
        self.next_fid = 1
        # JSON of every heap node as last sent, keyed by heap id.
        self.sent: dict[str, str] = {}
        # Encoded frame (without params) and its JSON size, by frame id.
        self.frames: dict[int, tuple[dict[str, Any], int]] = {}

    # sys.settrace entry point: only trace frames of the traced source.
    def global_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if frame.f_code.co_filename != TRACE_FILE:
            return None
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event == "call":
            self.calls += 1
            if id(frame) not in self.fids:  # a resumed generator keeps its id
                self.fids[id(frame)] = self.next_fid
                self.next_fid += 1
        return self.local_trace

    def local_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event in ("line", "return", "exception"):
            try:
                self._record(frame, event, arg)
            except RecursionError:
                # The program runs close to its recursion limit and encoding a
                # snapshot needs a few more frames. Raising here would make
                # CPython switch tracing off silently, so skip this snapshot.
                self.skipped_deep += 1
            if event == "return" and not frame.f_code.co_flags & _CO_RESUMABLE:
                fid = self.fids.pop(id(frame), None)
                if fid is not None:
                    self.frames.pop(fid, None)
        return self.local_trace

    def _stop(self, reason: str) -> None:
        self.stopped = reason
        raise TraceLimit(reason)

    def _record(self, frame: types.FrameType, event: str, arg: Any) -> None:
        if len(self.steps) >= self.max_steps:
            self._stop(f"step limit ({self.max_steps}) reached")
        if time.perf_counter() > self.deadline:
            self._stop("time limit reached")
        frames = []
        f: types.FrameType | None = frame
        while f is not None and f.f_code.co_filename == TRACE_FILE:
            frames.append(f)
            f = f.f_back
        frames.reverse()
        # Remember deep stacks: if CPython later switches tracing off, this
        # tells a recursion-limit stop apart from a program calling settrace.
        depth = len(frames)
        g = f
        while g is not None:
            depth += 1
            g = g.f_back
        if depth >= sys.getrecursionlimit() - 50:
            self.near_limit = True
        enc = HeapEncoder(max_nodes=self.max_nodes, max_items=self.max_items,
                          ids=self.ids, keepalive=self.keepalive)
        stack = []
        size = 0
        for fr in frames:
            fid = self.fids.get(id(fr))
            if fid is None:
                fid = self.fids[id(fr)] = self.next_fid
                self.next_fid += 1
            is_module = fr.f_code.co_name == "<module>"
            cached = self.frames.get(fid)
            # A suspended caller cannot change its own locals: only the top
            # frame runs, globals change from anywhere and closures through
            # cells. Its objects can change, but only through a frame that
            # reaches them, which is encoded. Re-encoding every frame made a
            # deep recursion quadratic.
            if cached is not None and fr is not frame and not is_module and not fr.f_code.co_cellvars:
                entry, entry_size = cached
            else:
                names = fr.f_globals if is_module else fr.f_locals
                local_vars = []
                for name, value in list(names.items()):
                    # type(), not isinstance(): a user class's __class__
                    # property would run; globals()[1] = ... gives int keys.
                    if type(name) is not str or name.startswith("__"):
                        continue
                    if is_module and (name in _HIDDEN_GLOBALS or type(value) is types.ModuleType):
                        continue
                    local_vars.append([name, enc.encode(value)])
                entry = {"func": fr.f_code.co_name, "line": fr.f_lineno, "locals": local_vars, "fid": fid}
                entry_size = len(json.dumps(entry, separators=(",", ":")))
                self.frames[fid] = (entry, entry_size)
            if fid not in self.announced:
                self.announced.add(fid)
                entry = {**entry, "params": _params(fr.f_code)}
                entry_size += 40
            stack.append(entry)
            size += entry_size
        ret = enc.encode(arg) if event == "return" else None
        # Only nodes that changed since they were last sent: a sort of 50
        # numbers repeated the whole list on every one of its 2000 steps.
        delta: dict[str, Any] = {}
        for key, node in enc.heap.items():
            js = json.dumps(node, separators=(",", ":"))
            if self.sent.get(key) != js:
                self.sent[key] = js
                delta[key] = node
                size += len(js) + len(key) + 4
        step: dict[str, Any] = {"line": frame.f_lineno, "event": event, "stack": stack,
                                "heap": delta, "out": self.out.size}
        gone = [str(oid) for oid in enc.missing if str(oid) in self.sent]
        if gone:
            step["gone"] = gone
            for key in gone:
                del self.sent[key]
        if event == "return":
            step["ret"] = ret
        elif event == "exception" and isinstance(arg, tuple) and arg:
            step["exc"] = getattr(arg[0], "__name__", "Exception")
        if enc.truncated:
            step["truncated"] = True
        size += 80 + len(json.dumps(step.get("ret"), separators=(",", ":"))) + sum(len(g) + 3 for g in gone)
        if self.bytes + size > self.max_bytes:
            self._stop(f"size limit ({self.max_bytes // 1024} KiB) reached")
        self.bytes += size
        self.steps.append(step)


def run_trace(code: str, max_steps: int = 1000, max_bytes: int = 6_000_000,
              max_seconds: float = 10.0, max_nodes: int = 150, max_items: int = 64,
              stdin: str | None = None) -> dict[str, Any]:
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
    error = None
    old_out, old_err = sys.stdout, sys.stderr
    tid = threading.get_ident()
    # Route only this thread's output into the trace; background threads of
    # persistent user code keep writing to the normal kernel streams.
    sys.stdout = _ThreadRouter(old_out, out, tid)  # type: ignore[assignment]
    sys.stderr = _ThreadRouter(old_err, out, tid)  # type: ignore[assignment]
    started = time.perf_counter()
    # A traced program that lowers the recursion limit must not leave the
    # kernel at that limit.
    recursion_limit = sys.getrecursionlimit()
    swap = StdinSwap(program_input)
    swap.__enter__()
    sys.settrace(rec.global_trace)
    try:
        exec(code_obj, ns)
    except TraceLimit as lim:
        rec.stopped = rec.stopped or lim.reason
    except KeyboardInterrupt:
        sys.settrace(None)
        raise
    except BaseException as exc:  # noqa: BLE001 - user errors are part of the trace
        error = format_exception(exc, {TRACE_FILE})
    finally:
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
    elapsed = time.perf_counter() - started
    return {
        "steps": rec.steps,
        "heapDelta": True,
        "stopped": rec.stopped,
        "error": error,
        # Make truncation visible in the text itself, not only as a flag.
        "stdout": out.getvalue() + ("\n… output truncated (200 000 characters shown)\n" if out.truncated else ""),
        "stdoutTruncated": out.truncated,
        "skippedSteps": rec.skipped_deep,
        "elapsedMs": round(elapsed * 1000, 1),
        "source": code,
    }
