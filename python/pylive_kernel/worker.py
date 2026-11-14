"""Worker process: protocol I/O, task queue, interrupts.

Threads:
* main thread   — runs tasks one at a time (user code, inspection).
* reader thread — parses requests; handles interrupt/cancel/shutdown at once.
* writer thread — the *only* writer of protocol output (whole NDJSON lines),
  so a KeyboardInterrupt in the main thread can never cut a message in half.
"""

from __future__ import annotations

import _thread
import ast
import builtins
import codecs
import collections
import copy
import hashlib
import io
import json
import os
import pathlib
import queue
import secrets
import tempfile
import signal
import sys
import threading
import time
import types
import weakref
from dataclasses import dataclass
from typing import Any, BinaryIO, Callable

from . import (children, dataframe, executor, heap, images, inspector, livestate, magics, outbuf, reloader, safety,
               series, shadows, tracer, warnfold, workdir)
from .livestate import first_state_reset as _first_state_reset, target_names as _target_names
from .programinput import NO_INPUT_HINT, ProgramInput
from .serialize import type_module, type_name, type_qualname

MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 4 * 1024 * 1024
# A first `import torch` / `import tensorflow` takes 3-15 s; later imports are
# free (sys.modules). Imports therefore get their own bound in Live Mode
# instead of eating the per-run budget meant for the user's code.
LIVE_IMPORT_SECONDS = 60.0
# Interrupting these half-way leaves them unimportable for the life of the
# process ("torch can only be initialized once"): an interrupt that arrives
# during their first import waits until the import statement has finished.
UNTEARABLE_IMPORTS = {
    "torch", "torchvision", "torchaudio", "tensorflow", "keras", "jax", "transformers",
    "numpy", "pandas", "scipy", "sklearn", "matplotlib", "seaborn", "xgboost", "lightgbm",
    "catboost", "cv2", "polars", "statsmodels", "plotly", "tensorflow_datasets", "datasets",
    "timm", "lightning", "pytorch_lightning", "tf_keras",
}
CONTROL_TYPES = {"interrupt", "cancel", "shutdown", "ping"}
TASK_TYPES = {
    "execute", "trace", "analyze", "variables.list", "variables.inspect", "variables.image",
    "variables.series",
    "dataframe.metadata", "dataframe.page", "dataframe.summary", "dataframe.column",
}
_NO_VALUE = object()
_UNCACHEABLE = object()


class RequestError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------
# Output


class Writer:
    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._queue: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._thread = threading.Thread(target=self._run, name="pylive-writer", daemon=True)
        self._thread.start()

    def send(self, msg: dict[str, Any]) -> None:
        try:
            # "replace": lone surrogates (e.g. from os.fsdecode) must not make
            # a whole message unsendable.
            data = json.dumps(msg, separators=(",", ":"), ensure_ascii=False,
                              allow_nan=False, default=_json_default).encode("utf-8", "replace")
        except (TypeError, ValueError) as exc:
            data = json.dumps({"type": "response", "id": msg.get("id"), "ok": False,
                               "error": {"code": "serialization_error", "message": str(exc)[:500]}}
                              ).encode("utf-8")
        if len(data) > MAX_MESSAGE_BYTES:
            data = json.dumps({"type": "response", "id": msg.get("id"), "ok": False,
                               "error": {"code": "message_too_large",
                                         "message": f"result is {len(data)} bytes (limit {MAX_MESSAGE_BYTES})"}}
                              ).encode("utf-8")
        self._queue.put(data + b"\n")

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            try:
                self._stream.write(item)
                self._stream.flush()
            except OSError:
                children.exit_process(0)  # host went away

    def close(self, timeout: float = 2.0) -> None:
        self._queue.put(None)
        self._thread.join(timeout)


def _json_default(o: Any) -> Any:
    return {"$t": "obj", "type": type_name(o)}


class CaptureStream:
    """Replacement for sys.stdout/sys.stderr that emits batched stream events.

    Both streams share one ordered buffer (outbuf.OutputBuffer): ordering,
    the per-run budget and progress-bar compaction live there.
    """

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, worker: Worker, name: str) -> None:
        self._worker = worker
        self.name = name
        self._binary = _BinaryWriter(self)

    def write(self, s: str) -> int:
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self._worker.outbuf.write(self.name, self._worker.exec_id_for_current_thread(), s)
        return len(s)

    def flush(self) -> None:
        self._worker.outbuf.soft_flush()

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False

    def isatty(self) -> bool:
        # The Output tab is a terminal (webview/terminal.ts): Keras, tqdm and
        # rich then redraw progress in place instead of writing a new line
        # per update. fileno() still raises, so widths fall back to 80.
        return True

    # -- TextIOWrapper compatibility: these streams also serve as
    # sys.__stdout__/__stderr__, which libraries treat as real text files.
    closed = False
    line_buffering = True
    newlines = None

    @property
    def buffer(self) -> _BinaryWriter:
        return self._binary

    def reconfigure(self, **_: Any) -> None:
        """Accepted and ignored: the stream is always UTF-8 and line-flushed."""

    def fileno(self) -> int:
        # UnsupportedOperation (an OSError and ValueError) is what io raises
        # for streams without a descriptor; faulthandler and subprocess
        # handle it.
        raise io.UnsupportedOperation("vrun capture stream has no file descriptor")

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)


class _BinaryWriter:
    """`.buffer` of a CaptureStream: UTF-8 bytes are decoded into the text stream."""

    def __init__(self, text: CaptureStream) -> None:
        self._text = text
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self._lock = threading.Lock()

    def write(self, data: Any) -> int:
        b = bytes(memoryview(data))
        with self._lock:
            s = self._decoder.decode(b)
        if s:
            self._text.write(s)
        return len(b)

    def flush(self) -> None:
        self._text.flush()

    closed = False

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise io.UnsupportedOperation("vrun capture stream has no file descriptor")


class _StdinProxy:
    """sys.stdin of the kernel: reads the current run's program input."""

    def __init__(self, worker: Worker) -> None:
        self._worker = worker

    def _stream(self) -> io.StringIO:
        pi = self._worker.program_input
        if not pi.provided:
            raise EOFError(NO_INPUT_HINT)
        return pi.stream

    def readline(self, *args: Any) -> str:
        return self._stream().readline(*args)

    def read(self, *args: Any) -> str:
        return self._stream().read(*args)

    def readlines(self, *args: Any) -> list[str]:
        return self._stream().readlines(*args)

    @property
    def buffer(self) -> Any:
        return self._stream().buffer

    def __iter__(self) -> Any:
        return iter(self._stream())

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise io.UnsupportedOperation("vrun program input has no file descriptor")

    closed = False


# --------------------------------------------------------------------------
# Worker


class Task:
    __slots__ = ("msg", "id", "type")

    def __init__(self, msg: dict[str, Any]) -> None:
        self.msg = msg
        self.id = msg["id"]
        self.type = msg["type"]


@dataclass(frozen=True)
class LoadSnapshot:
    key: str
    bindings: tuple[tuple[str, object], ...]
    has_value: bool
    value: object


class Worker:
    def __init__(self, proto_in: BinaryIO, proto_out: BinaryIO) -> None:
        self.proto_in = proto_in
        self.writer = Writer(proto_out)
        self.outbuf = outbuf.OutputBuffer(self.writer.send)
        self.session = secrets.token_hex(8)
        self.queue: collections.deque[Task] = collections.deque()
        self.cond = threading.Condition()
        self.cur_lock = threading.Lock()
        self.current: Task | None = None
        self.interrupt_reason: str | None = None
        self.current_exec_id: Any = None
        self.exec_seq = 0  # bumped by every execute/trace; see exec_id_for_current_thread
        # thread -> (exec_seq at start, owning exec id)
        self.thread_owners: weakref.WeakKeyDictionary[threading.Thread, tuple[int, Any]] = \
            weakref.WeakKeyDictionary()
        self.execution_count = 0
        self.user = executor.make_user_module()
        self.ns: dict[str, Any] = self.user.__dict__
        self.page_cache = dataframe.PageCache()
        # code hash -> seconds its last successful training run took
        self.ml_hashes: dict[str, float] = {}
        self.defer_interrupt = False
        self.deferred_interrupt = False
        self._risk_cache: dict[int, tuple[object, tuple[str, str] | None]] = {}
        self.program_input = ProgramInput(None)
        # A slot excludes the free-name fingerprint, so changing an input
        # replaces (and releases) the prior snapshot instead of accumulating
        # one full dataset per path value.
        self.load_cache: dict[str, LoadSnapshot] = {}
        self.current_skipped_loads: list[dict[str, Any]] = []
        self.current_loaded_now: list[dict[str, Any]] = []
        self.timeout_generation = 0
        self.shutting_down = False
        # Created before any user code runs: the startup folder and its
        # sys.path entry are still the ones launcher.py set.
        self.workdir = workdir.WorkingFolder()
        self.modules = reloader.ModuleReloader()
        self.modules.add_folder(self.workdir.chosen)
        self.trained = livestate.TrainedNames()
        self.leftovers = shadows.BuiltinLeftovers()
        # Notes of a run that stopped before running (Live blocked it, or it
        # asks to confirm training): the host shows no notes for those, and
        # the folder change or reload they report already happened.
        self.carried_notes: list[str] = []

    # -- setup -------------------------------------------------------------
    def install_streams(self) -> None:
        self.capture_out = CaptureStream(self, "stdout")
        self.capture_err = CaptureStream(self, "stderr")
        sys.stdout = self.capture_out  # type: ignore[assignment]
        sys.stderr = self.capture_err  # type: ignore[assignment]
        # The common restore idiom `sys.stdout = sys.__stdout__` must bring
        # capture back; the real fd 1 now points at the kernel log.
        sys.__stdout__ = self.capture_out  # type: ignore[misc]
        sys.__stderr__ = self.capture_err  # type: ignore[misc]
        # Output from threads is attributed to the execution that started them.
        original_start = threading.Thread.start
        worker = self

        def start(thread: threading.Thread) -> None:
            # Inherit the *starting thread's* owner: a stale background thread
            # that spawns a child must not hand it the newest execution's id.
            # Ownership lives outside the Thread object (no attribute clashes
            # with subclasses) and is only recorded for a first, successful
            # start: a second start() raises and must not re-label the thread.
            first = thread.ident is None and thread not in worker.thread_owners
            if first:
                worker.thread_owners[thread] = (worker.exec_seq, worker.exec_id_for_current_thread())
            try:
                original_start(thread)
            except BaseException:
                if first:
                    worker.thread_owners.pop(thread, None)
                raise

        threading.Thread.start = start  # type: ignore[method-assign]
        sys.stdin = _StdinProxy(self)  # type: ignore[assignment]
        warnfold.install()
        magics.install_display(executor.show_value_figure, lambda obj: executor.describe_result(obj)["repr"])
        self.ns[magics.TIMEIT_NAME] = magics.timeit
        import builtins
        # input() reads the program input (<script>.in sent by the host).
        builtins.input = lambda prompt="": self.program_input.input(prompt)  # type: ignore[assignment]
        signal.signal(signal.SIGINT, signal.default_int_handler)
        executor.silence_agg_show_warning()

    def exec_id_for_current_thread(self) -> Any:
        """Execution that output of the calling thread belongs to.

        Invariant: never a wrong execution. A background thread is attributed
        to the execution that started it only until a newer execution starts
        (a reused pool thread may run jobs of later executions); after that,
        and for threads created without Thread.start, the answer is None
        ("background output").
        """
        t = threading.current_thread()
        if t is threading.main_thread():
            return self.current_exec_id
        origin = self.thread_owners.get(t)
        if origin is not None and origin[0] == self.exec_seq:
            return origin[1]
        return None

    # -- reader thread -----------------------------------------------------
    def reader(self) -> None:
        for raw in self.proto_in:
            if len(raw) > MAX_REQUEST_BYTES:
                self.writer.send({"type": "response", "id": None, "ok": False,
                                  "error": {"code": "bad_request", "message": "request too large"}})
                continue
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict) or not isinstance(msg.get("type"), str) \
                        or not isinstance(msg.get("id"), (int, str)):
                    raise ValueError("request must be an object with 'id' and 'type'")
            except ValueError as exc:
                self.writer.send({"type": "response", "id": None, "ok": False,
                                  "error": {"code": "bad_request", "message": str(exc)[:300]}})
                continue
            mtype = msg["type"]
            if mtype in CONTROL_TYPES:
                self.control(msg)
            elif mtype in TASK_TYPES:
                with self.cond:
                    self.queue.append(Task(msg))
                    self.cond.notify()
            else:
                self.respond_error(msg["id"], "unknown_request", f"unknown request type {mtype!r}")
        # stdin EOF: the host is gone. Exit without running user atexit hooks
        # that could block forever.
        self.writer.close(0.5)
        children.exit_process(0)

    def control(self, msg: dict[str, Any]) -> None:
        mtype = msg["type"]
        if mtype == "ping":
            self.respond(msg["id"], {"pong": True, "busy": self.current is not None,
                                     "queued": len(self.queue)})
        elif mtype == "interrupt":
            target = msg.get("target")  # request id, or None for "whatever runs now"
            dropped = 0
            if msg.get("clearQueue", True):
                with self.cond:
                    keep = collections.deque(t for t in self.queue if t.type != "execute" and t.type != "trace")
                    dropped_tasks = [t for t in self.queue if t.type in ("execute", "trace")]
                    self.queue = keep
                for t in dropped_tasks:
                    self.respond_error(t.id, "cancelled", "cancelled by interrupt")
                dropped = len(dropped_tasks)
            hit = self.interrupt_current(target, "user")
            self.respond(msg["id"], {"interrupted": hit, "droppedQueued": dropped})
        elif mtype == "cancel":
            target = msg.get("target")
            removed = False
            with self.cond:
                for t in list(self.queue):
                    if t.id == target:
                        self.queue.remove(t)
                        removed = True
            if removed:
                self.respond_error(target, "cancelled", "cancelled before start")
            self.respond(msg["id"], {"cancelled": removed})
        elif mtype == "shutdown":
            self.shutting_down = True
            self.respond(msg["id"], {"bye": True})
            self.writer.close(1.0)
            children.exit_process(0)

    def interrupt_current(self, target: Any, reason: str) -> bool:
        with self.cur_lock:
            cur = self.current
            if cur is None or (target is not None and cur.id != target):
                return False
            if self.interrupt_reason is None:
                self.interrupt_reason = reason
                if self.defer_interrupt:
                    self.deferred_interrupt = True  # raised after the import
                else:
                    _thread.interrupt_main()
            return True

    # -- main thread -------------------------------------------------------
    def _flush_loop(self) -> None:
        # Writes are batched; without this, text printed by a background
        # thread after its execution ended would wait for the next execution.
        while True:
            time.sleep(outbuf.FLUSH_SECONDS)
            self.outbuf.soft_flush()

    def serve_forever(self) -> None:
        threading.Thread(target=self.reader, name="pylive-reader", daemon=True).start()
        threading.Thread(target=self._flush_loop, name="pylive-flush", daemon=True).start()
        self.writer.send({"type": "event", "event": "ready", "session": self.session,
                          "pid": os.getpid(), "python": inspector.python_info(),
                          "cwd": os.getcwd()})
        while True:
            try:
                task = self._next_task()
                self._run_task(task)
            except KeyboardInterrupt:
                # An interrupt that arrived after its task finished. Ignore it.
                continue

    def _next_task(self) -> Task:
        with self.cond:
            while not self.queue:
                self.cond.wait(1.0)
            return self.queue.popleft()

    def _run_task(self, task: Task) -> None:
        with self.cur_lock:
            self.current = task
            self.interrupt_reason = None
            self.defer_interrupt = False
            self.deferred_interrupt = False
            self.timeout_generation += 1
        timer: threading.Timer | None = None
        budget = self._deadline_for(task)
        if budget is not None:
            timer = threading.Timer(budget, self.interrupt_current, args=(task.id, "timeout"))
            timer.daemon = True
            timer.start()
        # interrupt_current() fires at most once per task (interrupt_reason is
        # set under cur_lock), so at most one KeyboardInterrupt can arrive while
        # this task is current: either inside dispatch, inside the bookkeeping
        # below (outer handler), or as a pending signal surfaced by the drain.
        reply: dict[str, Any] | None = None
        try:
            try:
                result = self.dispatch(task)
                reply = {"type": "response", "id": task.id, "ok": True, "result": result}
            except KeyboardInterrupt:
                reply = self._interrupted_reply(task)
            except RequestError as exc:
                reply = _error(task.id, exc.code, str(exc))
            except dataframe.BadRequest as exc:
                reply = _error(task.id, "bad_request", str(exc))
            except Exception as exc:  # noqa: BLE001 - inspection bug must not kill the worker
                reply = _error(task.id, "internal_error", f"{type(exc).__name__}: {exc}"[:1000])
            except (SystemExit, GeneratorExit) as exc:
                # Raised by user code that inspection reached (a property);
                # ending the process here would lose the whole namespace.
                reply = _error(task.id, "internal_error", type(exc).__name__)
            self._finish_task(timer)
            _drain_pending_interrupt()
        except KeyboardInterrupt:
            if reply is None:
                reply = self._interrupted_reply(task)
            self._finish_task(timer)
        self._flush_streams()
        self.writer.send(reply)

    def _finish_task(self, timer: threading.Timer | None) -> None:
        if timer is not None:
            timer.cancel()
        with self.cur_lock:
            self.timeout_generation += 1
            self.current = None

    def _interrupted_reply(self, task: Task) -> dict[str, Any]:
        code = "timeout" if self.interrupt_reason == "timeout" else "interrupted"
        msg = "execution interrupted" if code == "interrupted" else "time budget exceeded; interrupted"
        reply = _error(task.id, code, msg)
        if task.type == "execute":
            # Executions report a normal result so the UI can show where it stopped.
            reply = {"type": "response", "id": task.id, "ok": True, "result": {
                "status": "error", "executionCount": self.execution_count,
                "error": {"ename": "KeyboardInterrupt", "evalue": msg, "traceback": f"KeyboardInterrupt: {msg}\n",
                          "frames": [], "userFrame": None}, "figures": _figures_after_interrupt(),
                "skippedLoads": list(self.current_skipped_loads),
                "loadedNow": list(self.current_loaded_now),
                "loadCache": len(self.load_cache),
                "interrupted": code}}
        return reply

    def _deadline_for(self, task: Task) -> float | None:
        p = task.msg
        if task.type == "execute":
            # Live execute arms the budget only around non-load statements.
            # A first-time load remains manually interruptible but has no
            # automatic deadline.
            return None
        if task.type == "trace":
            return _num(p.get("timeoutMs"), 15000, 100, 600_000) / 1000
        if task.type in ("analyze", "variables.list"):
            return 10.0
        return _num(p.get("timeoutMs"), 20000, 100, 600_000) / 1000

    def _flush_streams(self) -> None:
        # Flush our own buffer even if user code replaced sys.stdout; the end
        # of a run that went over budget is sent now.
        try:
            self.outbuf.finish()
        except KeyboardInterrupt:
            pass

    def _arm_live_timeout(self, seconds: float) -> threading.Timer:
        with self.cur_lock:
            self.timeout_generation += 1
            generation = self.timeout_generation
            target = self.current.id if self.current is not None else None

        def fire() -> None:
            with self.cur_lock:
                current = self.current
                if generation != self.timeout_generation or current is None \
                        or current.id != target or self.interrupt_reason is not None:
                    return
                self.interrupt_reason = "timeout"
                if self.defer_interrupt:
                    self.deferred_interrupt = True  # raised after the import
                else:
                    _thread.interrupt_main()

        timer = threading.Timer(seconds, fire)
        timer.daemon = True
        timer.start()
        return timer

    def _disarm_live_timeout(self, timer: threading.Timer) -> None:
        with self.cur_lock:
            self.timeout_generation += 1
        timer.cancel()

    # -- dispatch ----------------------------------------------------------
    def dispatch(self, task: Task) -> Any:
        p = task.msg
        handler: Callable[[dict[str, Any]], Any] = getattr(self, "h_" + task.type.replace(".", "_"))
        if task.type not in ("execute", "trace", "analyze"):
            self._check_handle(p)
        return handler(p)

    def _check_handle(self, p: dict[str, Any]) -> None:
        session = p.get("session")
        if session is not None and session != self.session:
            raise RequestError("stale_handle", "variable handle belongs to a previous kernel session")
        rev = p.get("revision")
        if rev is not None and rev != self.execution_count:
            raise RequestError("stale_revision", "variables changed since this view was loaded")

    def _lookup(self, p: dict[str, Any]) -> Any:
        name = p.get("name")
        if not isinstance(name, str) or not name.isidentifier() or len(name) > 200:
            raise RequestError("bad_request", "invalid variable name")
        if name not in self.ns:
            raise RequestError("not_found", f"variable {name!r} is not defined")
        return self.ns[name]

    def h_execute(self, p: dict[str, Any]) -> dict[str, Any]:
        code = _str(p.get("code"), "code", 2_000_000)
        filename = _str(p.get("file") or "<pylive-cell>", "file", 1000)
        line_offset = int(_num(p.get("lineOffset"), 0, 0, 10_000_000))
        mode = p.get("mode", "manual")
        if mode not in ("manual", "live"):
            raise RequestError("bad_request", "mode must be 'manual' or 'live'")
        folder = self._folder_param(p)
        self.current_exec_id = p.get("execId")
        self.exec_seq += 1
        stdin = self._stdin_param(p)
        self.program_input = ProgramInput(stdin)
        self.outbuf.flush()  # earlier background output keeps its own budget
        self.outbuf.reset()
        warnfold.start_run(self.ns)
        executor.reset_figures()
        self._prepare_plotly()
        self.current_skipped_loads = []
        self.current_loaded_now = []

        live_budget = None
        if mode == "live":
            live_budget = _num(p.get("timeoutMs"), 5000, 100, 600_000) / 1000

        # Before the analysis: it must see the module code that will run (a
        # helper edited to train asks for confirmation on the first run).
        notes = self.carried_notes + self._prepare_run(mode, filename, folder)
        self.carried_notes = []
        source_code = code
        try:
            code, magic_notes = magics.rewrite(code)
        except magics.MagicError as exc:
            err = SyntaxError(str(exc), (filename, exc.line + line_offset, 1, None))
            return _with_notes({"status": "error", "error": executor.format_syntax_error(err),
                                "executionCount": self.execution_count, "figures": [],
                                "skippedLoads": [], "loadedNow": [], "loadCache": len(self.load_cache)}, notes)
        analysis = safety.analyze_source(code, self._cheap_preprocessors(), self._risky_calls(),
                                         self._torch_modules())
        _add_file_lines(analysis, line_offset)
        statement_analysis = analysis.get("statements", [])
        live_ok = analysis["liveSafe"] or (stdin is not None and analysis.get("liveSafeWithInput"))
        stop_index: int | None = None
        stopped_at = None
        whole = False
        if mode == "live" and not live_ok:
            # Run the safe beginning of the cell (load, preprocess, explore)
            # and stop before the first statement that trains or writes:
            # blocking the whole cell made Live useless on ML files.
            allowed = safety.LIVE_OK_WITH_INPUT if stdin is not None else safety.LIVE_OK
            whole = analysis.get("syntaxError") or any(f["category"] == "marker" for f in analysis["findings"])
            stop_index = None if whole else _first_unsafe(statement_analysis, allowed)
            if stop_index is not None:
                stopped_at = _stop_info(statement_analysis[stop_index], allowed)
                reset = _first_state_reset(ast.parse(code).body, stop_index, self.ns)
                if reset is not None:
                    stop_index, name = reset
                    stopped_at = {
                        "line": int(statement_analysis[stop_index]["line"]) + line_offset,
                        "category": stopped_at["category"],
                        "message": f"re-running this would reset '{name}', which line "
                                   f"{stopped_at['line']} uses ({stopped_at['message']})",
                    }
        if mode == "live" and not whole:
            # A cell with no training of its own (`model = MLP()`, `history =
            # {...}`) must not replace what an earlier Run Cell trained either.
            guard = self.trained.first_replacement(ast.parse(code).body, stop_index, self.ns, filename)
            if guard is not None and (stop_index is None or guard[0] < stop_index):
                stop_index, message = guard
                stopped_at = {"line": int(statement_analysis[stop_index]["line"]) + line_offset,
                              "category": "trained", "message": message}
        if mode == "live" and (whole or stop_index == 0 or (not live_ok and stop_index is None)):
            blocked = {"status": "blocked", "analysis": analysis,
                       "executionCount": self.execution_count,
                       "skippedLoads": [], "loadedNow": [],
                       "loadCache": len(self.load_cache)}
            if stopped_at is not None:
                blocked["stoppedAt"] = stopped_at
            self._carry(notes)
            return blocked
        code_hash = hashlib.sha256(code.encode("utf-8", "surrogatepass")).hexdigest()
        # Ask before repeating training only when the last run took long
        # enough to matter (instant fits asked every time).
        confirm_after = _num(p.get("confirmAfterMs"), 0, 0, 86_400_000) / 1000
        last = self.ml_hashes.get(code_hash)
        if mode == "manual" and analysis.get("training") and last is not None \
                and last >= confirm_after and not p.get("force"):
            self._carry(notes)
            return {"status": "needs_confirmation", "analysis": analysis,
                    "executionCount": self.execution_count,
                    "lastElapsedMs": round(last * 1000, 2),
                    "skippedLoads": [], "loadedNow": [],
                    "loadCache": len(self.load_cache)}
        self._set_script_file(filename)

        executor.register_source(filename, source_code, line_offset)
        try:
            statements = executor.compile_statements(code, filename, line_offset)
        except SyntaxError as exc:
            return _with_notes({"status": "error", "error": executor.format_syntax_error(exc),
                                "executionCount": self.execution_count, "figures": [],
                                "skippedLoads": [], "loadedNow": [],
                                "loadCache": len(self.load_cache)}, notes)

        if len(statement_analysis) != len(statements):
            raise RuntimeError("safety and compiler statement counts differ")
        nodes = [s.node for s in statements]
        notes += self._remove_leftovers(filename, nodes)
        if stop_index is not None:
            statements = statements[:stop_index]
            statement_analysis = statement_analysis[:stop_index]

        self.execution_count += 1
        self.page_cache.clear()
        started = time.perf_counter()
        value: Any = None
        error = None
        remaining = live_budget
        import_seconds = 0.0  # imports do not make training "slow"
        ran: list[tuple[executor.CompiledStatement, dict[str, Any]]] = []
        sizes: dict[int, dict[str, tuple[int, int]]] = {}  # index in ran -> TrainedNames.sizes
        builtins_before = self.leftovers.snapshot(self.ns)
        started_wall = time.time()  # file mtimes are wall-clock
        try:
            for statement, statement_info in zip(statements, statement_analysis):
                is_load = bool(statement_info["load"])  # type: ignore[index]
                bound_names = _bound_names(statement.node) if is_load else set()
                load_summary = {"line": statement.line, "code": statement.source[:80]}
                load_slot = None
                load_key = None
                if is_load:
                    load_slot, load_key = _load_identity(filename, statement.node, self.ns)

                can_skip = bool(bound_names) or statement.is_expression
                if mode == "live" and can_skip \
                        and load_slot is not None and load_key is not None:
                    snapshot = self.load_cache.get(load_slot)
                    if snapshot is not None and snapshot.key == load_key:
                        restored, restored_value = _restore_load_snapshot(snapshot, self.ns)
                        if restored:
                            if statement.is_expression:
                                value = restored_value
                            self.current_skipped_loads.append(load_summary)
                            continue
                        self.load_cache.pop(load_slot, None)

                if load_slot is not None:
                    # A failed refresh must not leave an older successful key
                    # eligible for skipping, and a new fingerprint replaces
                    # the prior dataset for this statement slot.
                    self.load_cache.pop(load_slot, None)

                timer = None
                statement_started = time.perf_counter()
                is_import = isinstance(statement.node, (ast.Import, ast.ImportFrom))
                untearable = is_import and _imports_untearable(statement.node)
                if mode == "live" and not is_load and is_import:
                    assert remaining is not None
                    timer = self._arm_live_timeout(max(remaining, LIVE_IMPORT_SECONDS))
                elif mode == "live" and not is_load:
                    assert remaining is not None
                    if remaining <= 0:
                        with self.cur_lock:
                            if self.interrupt_reason is None:
                                self.interrupt_reason = "timeout"
                        raise KeyboardInterrupt
                    timer = self._arm_live_timeout(remaining)
                # Checked per statement: pandas is usually imported by the
                # first statement and printed by a later one in the same run.
                executor.apply_pandas_display()
                if mode == "manual" and livestate.trains(statement_info["findings"]):  # type: ignore[arg-type]
                    # A helper may fill a history out of sight
                    # (train_epoch(model, opt, losses)): sizes before, for after.
                    sizes[len(ran)] = self.trained.sizes(statement.node, self.ns)
                ran.append((statement, statement_info))
                try:
                    if untearable:
                        with self.cur_lock:
                            self.defer_interrupt = True
                    if statement.is_expression:
                        value = eval(statement.code, self.ns)
                    else:
                        exec(statement.code, self.ns)
                    if untearable:
                        self._end_untearable()
                    if is_import:
                        self._prepare_plotly()
                except BaseException:
                    if untearable:
                        with self.cur_lock:
                            self.defer_interrupt = False
                            self.deferred_interrupt = False
                    if load_slot is not None:
                        self.load_cache.pop(load_slot, None)
                    raise
                else:
                    if load_slot is not None and load_key is not None:
                        self.current_loaded_now.append(load_summary)
                        snapshot = _capture_load_snapshot(
                            load_key, bound_names, self.ns,
                            statement.is_expression, value,
                        )
                        if snapshot is not None:
                            self.load_cache[load_slot] = snapshot
                        # A no-binding, non-final expression may have visible
                        # side effects, so it deliberately remains uncached.
                finally:
                    if is_import:
                        import_seconds += time.perf_counter() - statement_started
                    if timer is not None:
                        self._disarm_live_timeout(timer)
                        assert remaining is not None
                        if not is_import:
                            remaining -= time.perf_counter() - statement_started
        except KeyboardInterrupt:
            raise
        except SystemExit as exc:
            error = {"ename": "SystemExit", "evalue": str(exc.code), "traceback":
                     f"SystemExit({exc.code!r}) ignored: the kernel keeps running\n",
                     "frames": [], "userFrame": None}
        except BaseException as exc:  # noqa: BLE001
            error = executor.format_exception(exc, {filename})
        finally:
            # Also after an error or an interrupt: training stopped after 5
            # epochs still trained the model.
            self._after_run(mode, filename, nodes, ran, builtins_before, started_wall, sizes)
        elapsed = time.perf_counter() - started
        if value is not None and error is None:
            # A Figure is drawn, plt.plot(...)'s Line2D list is noise, and a
            # trailing ';' hides the value, as in notebooks.
            if executor.show_value_figure(value) or executor.is_plot_artist(value) \
                    or (statements and _ends_with_semicolon(code, statements[-1], line_offset)):
                value = None
        folded = warnfold.summary()
        if folded:
            self.capture_err.write(folded)
        self.outbuf.flush()
        result: dict[str, Any] = {
            "status": "error" if error else "ok",
            "executionCount": self.execution_count,
            "elapsedMs": round(elapsed * 1000, 2),
            "figures": executor.capture_figures(),
            "outputTruncated": self.outbuf.truncated,
            "skippedLoads": list(self.current_skipped_loads),
            "loadedNow": list(self.current_loaded_now),
            "loadCache": len(self.load_cache),
        }
        if error:
            result["error"] = error
        elif value is not None:
            self.ns["_"] = value
            result["value"] = executor.describe_result(value)
        if analysis.get("training") and not error and mode == "manual":
            self.ml_hashes[code_hash] = max(0.0, elapsed - import_seconds)
        if stopped_at is not None:
            result["stoppedAt"] = stopped_at
        if notes or magic_notes:
            result["notes"] = notes + magic_notes
        if analysis["findings"]:
            result["analysis"] = analysis
        return result

    def _prepare_run(self, mode: str, filename: str, folder: str | None) -> list[str]:
        """Working folder and edited modules, before a run is analysed.
        Returns notes. Each step on its own: a failing os.chdir must not
        also skip the reload."""
        notes: list[str] = []
        moved = False
        try:
            moved, note = self.workdir.apply(folder, filename)
            if note:
                notes.append(note)
        except Exception as exc:  # noqa: BLE001 - a helper's bug must not block every run
            _log(f"working folder change failed: {type(exc).__name__}: {exc}")
        try:
            self.modules.add_folder(folder)
            if os.path.isabs(filename):
                self.modules.add_folder(os.path.dirname(filename))
            if moved and folder is not None:
                notes += self.modules.follow_folder(folder, self.ns)
        except Exception as exc:  # noqa: BLE001
            _log(f"module folder update failed: {type(exc).__name__}: {exc}")
        try:
            # Reloading runs the module's code: never on Live's keystrokes.
            notes += self.modules.reload_changed(self.ns) if mode == "manual" else self.modules.changed_notes()
        except Exception as exc:  # noqa: BLE001
            _log(f"module reload failed: {type(exc).__name__}: {exc}")
        return notes

    def _remove_leftovers(self, filename: str, nodes: list[ast.stmt]) -> list[str]:
        """Built-in names another file left, just before user code runs."""
        try:
            return self.leftovers.remove(self.ns, filename, nodes)
        except Exception as exc:  # noqa: BLE001
            _log(f"leftover removal failed: {type(exc).__name__}: {exc}")
            return []

    def _carry(self, notes: list[str]) -> None:
        for n in notes:
            if n not in self.carried_notes and len(self.carried_notes) < 20:
                self.carried_notes.append(n)

    def _after_run(self, mode: str, filename: str, nodes: list[ast.stmt],
                   ran: list[tuple[executor.CompiledStatement, dict[str, Any]]],
                   builtins_before: dict[str, object], started_wall: float,
                   sizes: dict[int, dict[str, tuple[int, int]]]) -> None:
        try:
            self.workdir.ran(filename)
            self.leftovers.remember(self.ns, filename, nodes, builtins_before)
            self.modules.scan(started_wall)  # import-time stamps of modules this run imported
            self.trained.prune(self.ns)
            if mode != "manual":
                return
            training = [(i, s) for i, (s, info) in enumerate(ran) if livestate.trains(info["findings"])]
            if training:
                risky = self._risky_calls()
                for i, s in training:
                    self.trained.record(s.node, s.line, filename, self.ns, risky, sizes.get(i))
        except Exception as exc:  # noqa: BLE001 - bookkeeping must not fail a finished run
            _log(f"run bookkeeping failed: {type(exc).__name__}: {exc}")

    def _end_untearable(self) -> None:
        with self.cur_lock:
            self.defer_interrupt = False
            pending = self.deferred_interrupt
            self.deferred_interrupt = False
        if pending:
            raise KeyboardInterrupt

    def _set_script_file(self, filename: str) -> None:
        """__file__ of a saved script, as `python script.py` has it.

        Windows starts DataLoader / multiprocessing workers by re-importing
        the main script from __main__.__file__; without it a Dataset class
        could not be found in the worker. `Path(__file__).parent` works too.
        """
        if filename.endswith(".py") and os.path.isabs(filename) and os.path.isfile(filename):
            self.ns["__file__"] = filename
        else:
            cur = self.ns.get("__file__")
            if type(cur) is str and not os.path.isfile(cur):
                self.ns.pop("__file__", None)

    def _risky_calls(self) -> dict[str, tuple[str, str]]:
        """Helpers and classes defined in earlier runs whose call trains or writes.

        Read from code objects only (safety.code_risk), nothing is called:
        user functions, also wrapped ones (@tf.function, functools.wraps),
        user classes ("Trainer" when __init__ trains, "Trainer.run") and
        their instances ("trainer.run"). A helper that calls a risky helper
        is risky too.
        """
        out: dict[str, tuple[str, str]] = {}
        plain: dict[str, list[Any]] = {}  # user functions without a risk of their own
        if len(self._risk_cache) > 4096:
            self._risk_cache.clear()
        for count, (name, value) in enumerate(list(self.ns.items())):
            if count > 5000:
                break
            if type(name) is not str or name.startswith("__"):
                continue
            t = type(value)
            codes = _function_codes(value)
            if codes:
                risk = next((r for r in map(self._code_risk, codes) if r is not None), None)
                if risk is not None:
                    out[name] = risk
                elif _is_user_code(codes[0]):
                    plain[name] = codes
            elif heap.is_class(value):
                if type_module(value) in heap.USER_MODULES:
                    self._member_risks(name, value, out, "__init__")
            elif type_module(t) in heap.USER_MODULES:
                self._member_risks(name, t, out, "__call__")
        for _ in range(4):
            grew = False
            for name, codes in list(plain.items()):
                used: set[str] = set()
                for c in codes:
                    used |= safety.code_names(c)
                called = sorted(used & out.keys())
                if called:
                    out[name] = (out[called[0]][0], f"inside, '{called[0]}()': {out[called[0]][1]}")
                    del plain[name]
                    grew = True
            if not grew:
                break
        return out

    def _member_risks(self, name: str, klass: type, out: dict[str, tuple[str, str]], call: str) -> None:
        """Risky methods of a user class as "name.method"; `call` is the
        method that calling `name` itself runs (__init__ for a class)."""
        seen: set[str] = set()
        for k in heap.class_mro(klass):
            if type_module(k) not in heap.USER_MODULES:
                continue
            for attr, fn in list(heap.class_ns(k).items()):
                if type(attr) is not str or attr in seen:
                    continue
                seen.add(attr)  # the most derived definition wins
                if type(fn) in (staticmethod, classmethod):
                    fn = fn.__func__
                if type(fn) is types.FunctionType:
                    risk = self._code_risk(fn.__code__)
                    if risk is not None:
                        out[f"{name}.{attr}"] = risk
        if f"{name}.{call}" in out:
            out[name] = out[f"{name}.{call}"]

    def _torch_modules(self) -> frozenset[str]:
        """Names bound to a torch.nn.Module: their .train() trains nothing."""
        if "torch" not in sys.modules:
            return frozenset()
        out = set()
        for count, (name, value) in enumerate(list(self.ns.items())):
            if count > 5000:
                break
            if type(name) is not str:
                continue
            for k in heap.class_mro(type(value)):
                if type_qualname(k) == "Module" and type_module(k) == "torch.nn.modules.module":
                    out.add(name)
                    break
        return frozenset(out)

    def _prepare_plotly(self) -> None:
        if "plotly" in sys.modules:
            executor.prepare_plotly(_plotly_dir())

    def _code_risk(self, code: Any) -> tuple[str, str] | None:
        hit = self._risk_cache.get(id(code))
        if hit is not None and hit[0] is code:
            return hit[1]
        risk = safety.code_risk(code) if _is_user_code(code) else None
        self._risk_cache[id(code)] = (code, risk)
        return risk

    def _cheap_preprocessors(self) -> frozenset[str]:
        """Names bound to scikit-learn scalers/encoders (exact library types)."""
        out = set()
        for name, value in list(self.ns.items()):
            if type(name) is str and safety_type_is_cheap(type(value)):
                out.add(name)
        return frozenset(out)

    def h_trace(self, p: dict[str, Any]) -> dict[str, Any]:
        code = _str(p.get("code"), "code", 200_000)
        folder = self._folder_param(p)
        prelude = p.get("prelude")
        prelude = None if prelude is None else _str(prelude, "prelude", 2_000_000)
        self.current_exec_id = p.get("execId")
        self.exec_seq += 1
        stdin = self._stdin_param(p)
        live = p.get("mode") == "live"
        if live:
            analysis = safety.analyze_source(code)
            # A trace starts from a fresh namespace, so loads would re-read on
            # every keystroke: only program input is allowed in live traces.
            only_input = all(f["category"] == "input" for f in analysis["findings"])  # type: ignore[union-attr, index]
            if not analysis["safe"] and not (stdin is not None and only_input):
                return {"status": "blocked", "analysis": analysis}
        # Same working-folder policy as execute, and the learner's edited
        # modules: `from hinh_hoc import f` in the traced code finds the
        # module in sys.modules, so a stale one would be traced.
        notes = self._prepare_run("live" if live else "manual", "<trace>", folder)
        extra: dict[str, Any] = {}
        if prelude is not None:
            extra["prelude"] = prelude  # C3: safe definitions from the cells above
        started_wall = time.time()
        try:
            result = tracer.run_trace(
                code,
                max_steps=int(_num(p.get("maxSteps"), 5000, 10, 50000)),
                max_bytes=int(_num(p.get("maxBytes"), 6_000_000, 10_000, 7_000_000)),
                max_seconds=_num(p.get("timeoutMs"), 15000, 100, 600_000) / 1000,
                stdin=stdin,
                **extra,
            )
        finally:
            try:
                self.workdir.ran("<trace>")
                self.modules.scan(started_wall)  # modules the traced code imported
            except Exception as exc:  # noqa: BLE001
                _log(f"module scan failed: {type(exc).__name__}: {exc}")
        if notes:
            result["notes"] = notes + [n for n in result.get("notes") or [] if type(n) is str]
        result["status"] = "ok"
        return result

    @staticmethod
    def _stdin_param(p: dict[str, Any]) -> str | None:
        stdin = p.get("stdin")
        return None if stdin is None else _str(stdin, "stdin", 1_100_000)

    @staticmethod
    def _folder_param(p: dict[str, Any]) -> str | None:
        """C1: the folder of the saved document being run (absent for untitled)."""
        folder = p.get("cwd")
        return None if folder is None else _str(folder, "cwd", 4096)

    def h_analyze(self, p: dict[str, Any]) -> dict[str, Any]:
        return safety.analyze_source(_str(p.get("code"), "code", 2_000_000), self._cheap_preprocessors(),
                                     self._risky_calls(), self._torch_modules())

    def h_variables_list(self, p: dict[str, Any]) -> dict[str, Any]:
        out = inspector.list_variables(self.ns)
        out["session"] = self.session
        out["revision"] = self.execution_count
        return out

    def h_variables_inspect(self, p: dict[str, Any]) -> dict[str, Any]:
        self._lookup(p)
        out = inspector.inspect_variable(
            self.ns, p["name"],
            max_nodes=int(_num(p.get("maxNodes"), 200, 1, 1000)),
            max_items=int(_num(p.get("maxItems"), 100, 1, 1000)))
        out["session"] = self.session
        out["revision"] = self.execution_count
        return out

    def h_variables_image(self, p: dict[str, Any]) -> dict[str, Any]:
        value = self._lookup(p)
        try:
            out = images.preview(value, start=int(_num(p.get("start"), 0, 0, 10**12)),
                                 max_images=int(_num(p.get("count"), 16, 1, images.MAX_IMAGES)))
        except images.NotAnImage as exc:
            raise RequestError("not_an_image", str(exc)) from None
        out.update(name=p["name"], session=self.session, revision=self.execution_count)
        return out

    def h_variables_series(self, p: dict[str, Any]) -> dict[str, Any]:
        value = self._lookup(p)
        try:
            out = series.chart(value, int(_num(p.get("maxPoints"), series.DEFAULT_POINTS, 20, 5000)))
        except series.NotASeries as exc:
            raise RequestError("not_a_series", str(exc)) from None
        out.update(name=p["name"], session=self.session, revision=self.execution_count)
        return out

    def h_dataframe_metadata(self, p: dict[str, Any]) -> dict[str, Any]:
        out = dataframe.metadata(self._lookup(p))
        out.update(name=p["name"], session=self.session, revision=self.execution_count)
        return out

    def h_dataframe_page(self, p: dict[str, Any]) -> dict[str, Any]:
        value = self._lookup(p)
        sort = p.get("sort")
        flt = p.get("filter")
        if sort is not None and not isinstance(sort, dict):
            raise RequestError("bad_request", "sort must be an object")
        if flt is not None and not isinstance(flt, dict):
            raise RequestError("bad_request", "filter must be an object")
        out = dataframe.page(
            value,
            offset=int(_num(p.get("offset"), 0, 0, 10**12)),
            limit=int(_num(p.get("limit"), 50, 1, dataframe.MAX_PAGE_ROWS)),
            col_offset=int(_num(p.get("colOffset"), 0, 0, 10**9)),
            col_limit=int(_num(p.get("colLimit"), 50, 1, dataframe.MAX_PAGE_COLS)),
            sort=sort, flt=flt, cache=self.page_cache,
            cache_key=(p["name"], id(value), self.execution_count))
        out.update(name=p["name"], revision=self.execution_count)
        return out

    def h_dataframe_summary(self, p: dict[str, Any]) -> dict[str, Any]:
        out = dataframe.summary(self._lookup(p))
        out.update(name=p["name"], revision=self.execution_count)
        return out

    def h_dataframe_column(self, p: dict[str, Any]) -> dict[str, Any]:
        out = dataframe.column_detail(self._lookup(p), p.get("column"))  # type: ignore[arg-type]
        # "name" is the column's label; the frame goes under its own key.
        out.update(frame=p["name"], revision=self.execution_count)
        return out

    # -- responses ---------------------------------------------------------
    def respond(self, req_id: Any, result: Any) -> None:
        self.writer.send({"type": "response", "id": req_id, "ok": True, "result": result})

    def respond_error(self, req_id: Any, code: str, message: str) -> None:
        self.writer.send(_error(req_id, code, message))


_PLOTLY_DIR: str | None = None
_PLOTLY_PREFIX = "vrun-figures-"
_STALE_FIGURE_SECONDS = 2 * 86400


def _plotly_dir() -> str:
    """This kernel's own figure folder (mkdtemp: unique, 0700 on POSIX).

    A shared, predictable folder let another user plant files or symlinks.
    """
    global _PLOTLY_DIR
    if _PLOTLY_DIR is None or not os.path.isdir(_PLOTLY_DIR):
        _PLOTLY_DIR = tempfile.mkdtemp(prefix=_PLOTLY_PREFIX)
    return _PLOTLY_DIR


def _remove_stale_figure_dirs() -> None:
    """Folders of kernels that ended days ago (a killed kernel cannot clean up)."""
    import shutil
    import stat
    root = tempfile.gettempdir()
    now = time.time()
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for entry in entries[:10000]:
        if not entry.name.startswith(_PLOTLY_PREFIX):
            continue
        try:
            st = entry.stat(follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode) or now - st.st_mtime < _STALE_FIGURE_SECONDS:
                continue
            if hasattr(os, "getuid") and st.st_uid != os.getuid():
                continue
            shutil.rmtree(entry.path, ignore_errors=True)
        except OSError:
            continue


def _figures_after_interrupt() -> list[dict[str, Any]]:
    # Plots drawn before the interrupt belong to this run (not the next one).
    try:
        return executor.capture_figures()
    except BaseException:  # noqa: BLE001 - a second interrupt or a drawing error
        return []


def _ends_with_semicolon(code: str, statement: Any, line_offset: int) -> bool:
    node = statement.node
    if not statement.is_expression or getattr(node, "end_lineno", None) is None:
        return False
    lines = code.splitlines()
    i = node.end_lineno - line_offset - 1
    if not 0 <= i < len(lines):
        return False
    rest = lines[i].encode("utf-8", "surrogatepass")[node.end_col_offset or 0:].decode("utf-8", "ignore")
    return rest.lstrip().startswith(";")


_LIBRARY_DIRS = tuple(os.path.normcase(os.path.abspath(d)) for d in {sys.prefix, sys.base_prefix, sys.exec_prefix})


def _is_user_code(code: Any) -> bool:
    path = getattr(code, "co_filename", "")
    if type(path) is not str or not path or path.startswith("<frozen"):
        return False
    if path.startswith("<"):
        return True  # cells ("<pylive-cell>", untitled documents)
    norm = os.path.normcase(os.path.abspath(path))
    return "site-packages" not in norm and not norm.startswith(_LIBRARY_DIRS)


def _imports_untearable(node: ast.stmt) -> bool:
    if isinstance(node, ast.Import):
        roots = {a.name.split(".")[0] for a in node.names}
    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
        roots = {node.module.split(".")[0]}
    else:
        return False
    return any(r in UNTEARABLE_IMPORTS and r not in sys.modules for r in roots)


def _add_file_lines(analysis: dict[str, Any], line_offset: int) -> None:
    """Findings carry the document line too (cells start at line_offset)."""
    for f in analysis.get("findings", []):
        f["fileLine"] = int(f.get("line") or 0) + line_offset
    for st in analysis.get("statements", []):
        for f in st.get("findings", []):
            f["fileLine"] = int(f.get("line") or 0) + line_offset


def _with_notes(result: dict[str, Any], notes: list[str]) -> dict[str, Any]:
    if notes:
        result["notes"] = notes
    return result


def _first_unsafe(statements: list[dict[str, Any]], allowed: tuple[str, ...]) -> int | None:
    for i, st in enumerate(statements):
        if any(f["category"] not in allowed for f in st["findings"]):
            return i
    return None


def _stop_info(statement: dict[str, Any], allowed: tuple[str, ...]) -> dict[str, Any]:
    f = next(f for f in statement["findings"] if f["category"] not in allowed)
    return {"line": f["fileLine"], "category": f["category"], "message": f["message"]}


def _function_codes(value: object) -> list[Any]:
    """Code of a plain function and of the function it wraps.

    functools.wraps keeps the original in the wrapper's __dict__, tf.function
    in its instance dict; both are read without calling anything.
    """
    if type(value) is types.FunctionType:
        codes = [value.__code__]
        wrapped = value.__dict__.get("__wrapped__")
    else:
        d = heap.instance_dict(value)
        if d is None:
            return []
        codes = []
        wrapped = d.get("__wrapped__")
    if type(wrapped) is types.FunctionType:
        codes.append(wrapped.__code__)
    return codes


def safety_type_is_cheap(t: type) -> bool:
    return livestate.is_cheap_preprocessor(t)


def _bound_names(statement: ast.stmt) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(statement):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                names.update(_target_names(target))
        elif isinstance(node, ast.AnnAssign):
            names.update(_target_names(node.target))
    return names


def _is_exact_immutable(value: object) -> bool:
    if value is None or type(value) in (str, bytes, int, float, bool):
        return True
    return type(value) is tuple and all(_is_exact_immutable(item) for item in value)


def _copy_for_load_cache(value: object) -> object:
    """Return an isolated copy, or _UNCACHEABLE for unsupported objects."""
    if _is_exact_immutable(value):
        return value

    pandas_module = sys.modules.get("pandas")
    if pandas_module is not None:
        pandas_types = tuple(
            candidate for candidate in (
                getattr(pandas_module, "DataFrame", None),
                getattr(pandas_module, "Series", None),
                getattr(pandas_module, "Index", None),
            )
            if isinstance(candidate, type)
        )
        if pandas_types and isinstance(value, pandas_types):
            try:
                copy_on_write = bool(pandas_module.options.mode.copy_on_write)
            except Exception:  # noqa: BLE001 - older pandas has no COW option
                copy_on_write = False
            try:
                return value.copy(deep=not copy_on_write)
            except Exception:  # noqa: BLE001 - caching must not break execution
                return _UNCACHEABLE

    numpy_module = sys.modules.get("numpy")
    if numpy_module is not None:
        ndarray = getattr(numpy_module, "ndarray", None)
        if isinstance(ndarray, type) and isinstance(value, ndarray):
            try:
                return value.copy()
            except Exception:  # noqa: BLE001
                return _UNCACHEABLE

    if type(value) in (dict, list, set):
        try:
            return copy.deepcopy(value)
        except Exception:  # noqa: BLE001
            return _UNCACHEABLE
    return _UNCACHEABLE


def _capture_load_snapshot(
    key: str,
    bound_names: set[str],
    namespace: dict[str, Any],
    is_expression: bool,
    value: object,
) -> LoadSnapshot | None:
    bindings: list[tuple[str, object]] = []
    if bound_names:
        for name in sorted(bound_names):
            if name not in namespace:
                return None
            copied = _copy_for_load_cache(namespace[name])
            if copied is _UNCACHEABLE:
                return None
            bindings.append((name, copied))
        return LoadSnapshot(key, tuple(bindings), False, _NO_VALUE)
    if is_expression:
        copied = _copy_for_load_cache(value)
        if copied is not _UNCACHEABLE:
            return LoadSnapshot(key, (), True, copied)
    return None


def _restore_load_snapshot(
    snapshot: LoadSnapshot, namespace: dict[str, Any]
) -> tuple[bool, object]:
    bindings: list[tuple[str, object]] = []
    for name, cached in snapshot.bindings:
        copied = _copy_for_load_cache(cached)
        if copied is _UNCACHEABLE:
            return False, _NO_VALUE
        bindings.append((name, copied))

    restored_value: object = _NO_VALUE
    if snapshot.has_value:
        restored_value = _copy_for_load_cache(snapshot.value)
        if restored_value is _UNCACHEABLE:
            return False, _NO_VALUE

    # Do not partially rebind the namespace if copying one value failed.
    for name, copied in bindings:
        namespace[name] = copied
    return True, restored_value


def _hash_part(hasher: Any, value: bytes) -> None:
    hasher.update(len(value).to_bytes(8, "big"))
    hasher.update(value)


def _fingerprint_value(value: object) -> tuple[bytes, bytes]:
    value_type = type(value)
    if value is None:
        return b"none", b""
    if value_type is str:
        return b"str", value.encode("utf-8", "surrogatepass")  # type: ignore[union-attr]
    if value_type is bytes:
        return b"bytes", value  # type: ignore[return-value]
    if value_type is bool:
        return b"bool", b"1" if value else b"0"
    if value_type is int:
        return b"int", int.__str__(value).encode("ascii")  # type: ignore[arg-type]
    if value_type is float:
        return b"float", float.hex(value).encode("ascii")  # type: ignore[arg-type]
    if isinstance(value, pathlib.PurePath):
        path_value = os.fspath(value)
        if type(path_value) is bytes:
            return b"path-bytes", path_value
        return b"path-str", path_value.encode("utf-8", "surrogatepass")
    return b"object", f"{type_name(value)}:{id(value)}".encode("utf-8")


def _load_identity(
    filename: str, statement: ast.stmt, namespace: dict[str, Any]
) -> tuple[str, str]:
    bound = _bound_names(statement)
    free_names = sorted({
        node.id for node in ast.walk(statement)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
        and node.id not in bound and node.id not in vars(builtins)
    })
    filename_bytes = filename.encode("utf-8", "surrogatepass")
    statement_bytes = ast.dump(statement, include_attributes=False).encode("utf-8")
    slot_hasher = hashlib.sha256()
    _hash_part(slot_hasher, filename_bytes)
    _hash_part(slot_hasher, statement_bytes)
    key_hasher = hashlib.sha256()
    _hash_part(key_hasher, filename_bytes)
    _hash_part(key_hasher, statement_bytes)
    missing = object()
    for name in free_names:
        _hash_part(key_hasher, name.encode("utf-8"))
        value = namespace.get(name, missing)
        if value is missing:
            tag, encoded = b"missing", b""
        else:
            tag, encoded = _fingerprint_value(value)
        _hash_part(key_hasher, tag)
        _hash_part(key_hasher, encoded)
    return slot_hasher.hexdigest(), key_hasher.hexdigest()


def _error(req_id: Any, code: str, message: str) -> dict[str, Any]:
    return {"type": "response", "id": req_id, "ok": False, "error": {"code": code, "message": message}}


def _str(v: Any, field: str, max_len: int) -> str:
    if not isinstance(v, str):
        raise RequestError("bad_request", f"'{field}' must be a string")
    if len(v) > max_len:
        raise RequestError("bad_request", f"'{field}' is too long")
    return v


def _num(v: Any, default: float, lo: float, hi: float) -> float:
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise RequestError("bad_request", "numeric parameter expected")
    if not (lo <= v <= hi):
        raise RequestError("bad_request", f"parameter out of range [{lo}, {hi}]")
    return float(v)


def _noop() -> None:
    pass


def _log(text: str) -> None:
    """A line in the kernel log (vrun: Show Kernel Log): fd 2 is the real
    stderr, while sys.stderr shows in the learner's Output."""
    try:
        os.write(2, f"[vrun] {text}\n".encode("utf-8", "replace"))
    except OSError:
        pass


def _drain_pending_interrupt() -> None:
    """Deliver an interrupt that was requested just before its task ended.

    The eval loop checks for pending signals on function entry, so calling a
    trivial function a few times surfaces it here, where it is harmless.
    """
    for _ in range(3):
        try:
            _noop()
            _noop()
        except KeyboardInterrupt:
            pass


def _open_protocol_streams() -> tuple[BinaryIO, BinaryIO]:
    """Duplicate fd 0/1 for the protocol; re-point fd 0/1 away from it."""
    in_fd = os.dup(0)
    out_fd = os.dup(1)
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(in_fd, os.O_BINARY)
        msvcrt.setmode(out_fd, os.O_BINARY)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    os.dup2(2, 1)  # native writes to stdout now land in stderr (the kernel log)
    return os.fdopen(in_fd, "rb"), os.fdopen(out_fd, "wb", buffering=0)


_VRUN_BACKEND = "module://pylive_kernel.mpl_backend"


class _MatplotlibBackendHook:
    """Points matplotlib at the vrun backend when this process imports it.

    MPLBACKEND itself stays "Agg": subprocesses and multiprocessing workers
    inherit the environment and cannot import pylive_kernel, so a module://
    value there made every plot in a child crash.
    """

    def find_spec(self, name: str, path: Any = None, target: Any = None) -> Any:
        if name != "matplotlib":
            return None
        spec = None
        for finder in list(sys.meta_path):
            find = getattr(finder, "find_spec", None) if finder is not self else None
            if find is None:
                continue
            spec = find(name, path, target)
            if spec is not None:
                break
        loader = getattr(spec, "loader", None)
        exec_module = getattr(loader, "exec_module", None)
        if exec_module is None:
            return spec

        def exec_and_point(module: Any) -> None:
            exec_module(module)
            try:
                rc = module.rcParams
                current = dict.get(rc, "backend")  # no backend resolution
                if type(current) is str and current.lower() == "agg":
                    rc["backend"] = _VRUN_BACKEND
            except Exception:  # noqa: BLE001 - plots then use plain Agg
                pass

        loader.exec_module = exec_and_point  # type: ignore[union-attr]
        return spec


def main() -> None:
    children.contain_children()
    if os.environ.get("MPLBACKEND", "Agg").lower() in ("agg", ""):
        os.environ["MPLBACKEND"] = "Agg"
        sys.meta_path.insert(0, _MatplotlibBackendHook())
    _remove_stale_figure_dirs()
    proto_in, proto_out = _open_protocol_streams()
    worker = Worker(proto_in, proto_out)
    worker.install_streams()
    worker.serve_forever()
