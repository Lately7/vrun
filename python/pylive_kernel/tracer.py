"""Step-by-step tracing of algorithm code for the DSA visualizer.

The code runs in a *fresh* namespace (the persistent kernel namespace is not
touched) under ``sys.settrace``. For each executed line of the traced source
we record the call stack, the locals of each traced frame and a heap of the
objects they reference (see ``heap.HeapEncoder``).

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

    # sys.settrace entry point: only trace frames of the traced source.
    def global_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if frame.f_code.co_filename != TRACE_FILE:
            return None
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event == "call":
            self.calls += 1
        return self.local_trace

    def local_trace(self, frame: types.FrameType, event: str, arg: Any) -> Any:
        if self.stopped:
            raise TraceLimit(self.stopped)
        if event in ("line", "return", "exception"):
            self._record(frame, event, arg)
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
        enc = HeapEncoder(max_nodes=self.max_nodes, max_items=self.max_items,
                          ids=self.ids, keepalive=self.keepalive)
        stack = []
        for fr in frames:
            is_module = fr.f_code.co_name == "<module>"
            names = fr.f_globals if is_module else fr.f_locals
            local_vars = []
            for name, value in list(names.items()):
                if is_module and (name in _HIDDEN_GLOBALS or isinstance(value, types.ModuleType)):
                    continue
                if name.startswith("__"):
                    continue
                local_vars.append([name, enc.encode(value)])
            stack.append({"func": fr.f_code.co_name, "line": fr.f_lineno, "locals": local_vars})
        step: dict[str, Any] = {"line": frame.f_lineno, "event": event, "stack": stack,
                                "heap": enc.heap, "out": self.out.size}
        if event == "return":
            step["ret"] = enc.encode(arg)
        elif event == "exception" and isinstance(arg, tuple) and arg:
            step["exc"] = getattr(arg[0], "__name__", "Exception")
        if enc.truncated:
            step["truncated"] = True
        size = len(json.dumps(step, separators=(",", ":")))
        if self.bytes + size > self.max_bytes:
            self._stop(f"size limit ({self.max_bytes // 1024} KiB) reached")
        self.bytes += size
        self.steps.append(step)


def run_trace(code: str, max_steps: int = 1000, max_bytes: int = 6_000_000,
              max_seconds: float = 10.0, max_nodes: int = 150, max_items: int = 64) -> dict[str, Any]:
    register_source(TRACE_FILE, code, 0)
    try:
        code_obj = compile(code, TRACE_FILE, "exec")
    except SyntaxError as exc:
        return {"steps": [], "error": format_syntax_error(exc), "stdout": "", "stopped": None}

    module = types.ModuleType(TRACE_MODULE)
    ns = module.__dict__
    ns["__builtins__"] = builtins
    # Classes defined by the traced code get __module__ == "__main__" via
    # __name__, so HeapEncoder recognises them as user types. sys.modules is
    # deliberately left alone: kernel threads must keep seeing the real
    # persistent __main__ while a trace runs.
    ns["__name__"] = "__main__"
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
        sys.settrace(None)
        sys.stdout, sys.stderr = old_out, old_err
    elapsed = time.perf_counter() - started
    return {
        "steps": rec.steps,
        "stopped": rec.stopped,
        "error": error,
        "stdout": out.getvalue(),
        "stdoutTruncated": out.truncated,
        "elapsedMs": round(elapsed * 1000, 1),
        "source": code,
    }
