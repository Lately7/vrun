"""Worker process: protocol I/O, task queue, interrupts.

Threads:
* main thread   — runs tasks one at a time (user code, inspection).
* reader thread — parses requests; handles interrupt/cancel/shutdown at once.
* writer thread — the *only* writer of protocol output (whole NDJSON lines),
  so a KeyboardInterrupt in the main thread can never cut a message in half.
"""

from __future__ import annotations

import _thread
import collections
import hashlib
import json
import os
import queue
import secrets
import signal
import sys
import threading
import time
from typing import Any, BinaryIO, Callable

from . import dataframe, executor, inspector, safety, tracer
from .serialize import type_name

MAX_MESSAGE_BYTES = 8 * 1024 * 1024
MAX_REQUEST_BYTES = 4 * 1024 * 1024
STREAM_FLUSH_BYTES = 8192
STREAM_FLUSH_SECONDS = 0.05
MAX_OUTPUT_PER_EXEC = 2 * 1024 * 1024  # UTF-8 bytes
STREAM_CHUNK_CHARS = 256 * 1024
CONTROL_TYPES = {"interrupt", "cancel", "shutdown", "ping"}
TASK_TYPES = {
    "execute", "trace", "analyze", "variables.list", "variables.inspect",
    "dataframe.metadata", "dataframe.page", "dataframe.summary", "dataframe.column",
}


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
                os._exit(0)  # host went away

    def close(self, timeout: float = 2.0) -> None:
        self._queue.put(None)
        self._thread.join(timeout)


def _json_default(o: Any) -> Any:
    return {"$t": "obj", "type": type_name(o)}


class CaptureStream:
    """Replacement for sys.stdout/sys.stderr that emits batched stream events."""

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, worker: Worker, name: str) -> None:
        self._worker = worker
        self.name = name
        self._buf: list[str] = []
        self._size = 0
        self._last = time.monotonic()
        self._lock = threading.Lock()
        self._exec_id: Any = None

    def write(self, s: str) -> int:
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        exec_id = self._worker.exec_id_for_current_thread()
        with self._lock:
            if exec_id != self._exec_id:
                # Never merge text of two executions into one event.
                self._flush_locked()
                self._exec_id = exec_id
            w = self._worker
            room = MAX_OUTPUT_PER_EXEC - w.output_bytes
            if room <= 0:
                self._mark_truncated()
                return len(s)
            # Budget in UTF-8 bytes: the protocol limit is in bytes, and one
            # character can take up to 4.
            encoded = s.encode("utf-8", "surrogatepass")
            if len(encoded) > room:
                chunk = encoded[:room].decode("utf-8", "ignore")
                w.output_bytes = MAX_OUTPUT_PER_EXEC
                self._buf.append(chunk)
                self._size += len(chunk)
                self._mark_truncated()
            else:
                chunk = s
                w.output_bytes += len(encoded)
                self._buf.append(chunk)
                self._size += len(chunk)
            now = time.monotonic()
            if self._size >= STREAM_FLUSH_BYTES or now - self._last >= STREAM_FLUSH_SECONDS:
                self._flush_locked()
        return len(s)

    def _mark_truncated(self) -> None:
        w = self._worker
        if not w.output_truncated:
            w.output_truncated = True
            self._buf.append("\n[PyLive: output truncated]\n")

    def _flush_locked(self) -> None:
        if self._buf:
            text = "".join(self._buf)
            self._buf.clear()
            self._size = 0
            # Chunks of <= STREAM_CHUNK_CHARS keep every event far below the
            # message size limit (at most 4 bytes per character).
            for start in range(0, len(text), STREAM_CHUNK_CHARS):
                self._worker.writer.send({"type": "event", "event": "stream", "name": self.name,
                                          "text": text[start:start + STREAM_CHUNK_CHARS],
                                          "execId": self._exec_id})
        self._last = time.monotonic()

    def flush(self) -> None:
        with self._lock:
            self._flush_locked()

    def writable(self) -> bool:
        return True

    def readable(self) -> bool:
        return False

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        raise OSError("PyLive capture stream has no file descriptor")

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)


class _NoInput:
    def readline(self, *_: Any) -> str:
        raise RuntimeError("input() is not supported in PyLive Inspector; set the value in code")

    read = readline

    def isatty(self) -> bool:
        return False


def _no_input(prompt: object = "") -> str:
    raise RuntimeError("input() is not supported in PyLive Inspector; set the value in code")


# --------------------------------------------------------------------------
# Worker


class Task:
    __slots__ = ("msg", "id", "type")

    def __init__(self, msg: dict[str, Any]) -> None:
        self.msg = msg
        self.id = msg["id"]
        self.type = msg["type"]


class Worker:
    def __init__(self, proto_in: BinaryIO, proto_out: BinaryIO) -> None:
        self.proto_in = proto_in
        self.writer = Writer(proto_out)
        self.session = secrets.token_hex(8)
        self.queue: collections.deque[Task] = collections.deque()
        self.cond = threading.Condition()
        self.cur_lock = threading.Lock()
        self.current: Task | None = None
        self.interrupt_reason: str | None = None
        self.current_exec_id: Any = None
        self.execution_count = 0
        self.output_bytes = 0
        self.output_truncated = False
        self.user = executor.make_user_module()
        self.ns: dict[str, Any] = self.user.__dict__
        self.page_cache = dataframe.PageCache()
        self.ml_hashes: set[str] = set()
        self.shutting_down = False

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
            thread._pylive_exec_id = worker.current_exec_id  # type: ignore[attr-defined]
            original_start(thread)

        threading.Thread.start = start  # type: ignore[method-assign]
        sys.stdin = _NoInput()  # type: ignore[assignment]
        import builtins
        builtins.input = _no_input  # type: ignore[assignment]
        signal.signal(signal.SIGINT, signal.default_int_handler)
        executor.silence_agg_show_warning()

    def exec_id_for_current_thread(self) -> Any:
        t = threading.current_thread()
        if t is threading.main_thread():
            return self.current_exec_id
        return getattr(t, "_pylive_exec_id", None)

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
        os._exit(0)

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
            os._exit(0)

    def interrupt_current(self, target: Any, reason: str) -> bool:
        with self.cur_lock:
            cur = self.current
            if cur is None or (target is not None and cur.id != target):
                return False
            if self.interrupt_reason is None:
                self.interrupt_reason = reason
                _thread.interrupt_main()
            return True

    # -- main thread -------------------------------------------------------
    def serve_forever(self) -> None:
        threading.Thread(target=self.reader, name="pylive-reader", daemon=True).start()
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
                          "frames": [], "userFrame": None}, "figures": [],
                "interrupted": code}}
        return reply

    def _deadline_for(self, task: Task) -> float | None:
        p = task.msg
        if task.type == "execute":
            if p.get("mode") == "live":
                return _num(p.get("timeoutMs"), 5000, 100, 600_000) / 1000
            return None
        if task.type == "trace":
            return _num(p.get("timeoutMs"), 15000, 100, 600_000) / 1000
        if task.type in ("analyze", "variables.list"):
            return 10.0
        return _num(p.get("timeoutMs"), 20000, 100, 600_000) / 1000

    def _flush_streams(self) -> None:
        # Flush our own streams even if user code replaced sys.stdout.
        for s in (self.capture_out, self.capture_err):
            try:
                s.flush()
            except KeyboardInterrupt:
                pass

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
        self.current_exec_id = p.get("execId")
        self.output_bytes = 0
        self.output_truncated = False

        analysis = safety.analyze_source(code)
        if mode == "live" and not analysis["safe"]:
            return {"status": "blocked", "analysis": analysis, "executionCount": self.execution_count}
        code_hash = hashlib.sha256(code.encode("utf-8", "surrogatepass")).hexdigest()
        if mode == "manual" and analysis.get("training") and code_hash in self.ml_hashes \
                and not p.get("force"):
            return {"status": "needs_confirmation", "analysis": analysis,
                    "executionCount": self.execution_count}

        executor.register_source(filename, code, line_offset)
        try:
            _, (exec_code, eval_code) = executor.compile_cell(code, filename, line_offset)
        except SyntaxError as exc:
            return {"status": "error", "error": executor.format_syntax_error(exc),
                    "executionCount": self.execution_count, "figures": []}

        self.execution_count += 1
        self.page_cache.clear()
        started = time.perf_counter()
        value: Any = None
        error = None
        try:
            exec(exec_code, self.ns)
            if eval_code is not None:
                value = eval(eval_code, self.ns)
        except KeyboardInterrupt:
            raise
        except SystemExit as exc:
            error = {"ename": "SystemExit", "evalue": str(exc.code), "traceback":
                     f"SystemExit({exc.code!r}) ignored: the kernel keeps running\n",
                     "frames": [], "userFrame": None}
        except BaseException as exc:  # noqa: BLE001
            error = executor.format_exception(exc, {filename})
        elapsed = time.perf_counter() - started
        result: dict[str, Any] = {
            "status": "error" if error else "ok",
            "executionCount": self.execution_count,
            "elapsedMs": round(elapsed * 1000, 2),
            "figures": executor.capture_figures(),
            "outputTruncated": self.output_truncated,
        }
        if error:
            result["error"] = error
        elif value is not None:
            self.ns["_"] = value
            result["value"] = executor.describe_result(value)
        if analysis.get("training") and not error:
            self.ml_hashes.add(code_hash)
        if analysis["findings"]:
            result["analysis"] = analysis
        return result

    def h_trace(self, p: dict[str, Any]) -> dict[str, Any]:
        code = _str(p.get("code"), "code", 200_000)
        self.current_exec_id = p.get("execId")
        if p.get("mode") == "live":
            analysis = safety.analyze_source(code)
            if not analysis["safe"]:
                return {"status": "blocked", "analysis": analysis}
        result = tracer.run_trace(
            code,
            max_steps=int(_num(p.get("maxSteps"), 1000, 10, 20000)),
            max_bytes=int(_num(p.get("maxBytes"), 6_000_000, 10_000, 7_000_000)),
            max_seconds=_num(p.get("timeoutMs"), 15000, 100, 600_000) / 1000,
        )
        result["status"] = "ok"
        return result

    def h_analyze(self, p: dict[str, Any]) -> dict[str, Any]:
        return safety.analyze_source(_str(p.get("code"), "code", 2_000_000))

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
        out.update(name=p["name"], revision=self.execution_count)
        return out

    # -- responses ---------------------------------------------------------
    def respond(self, req_id: Any, result: Any) -> None:
        self.writer.send({"type": "response", "id": req_id, "ok": True, "result": result})

    def respond_error(self, req_id: Any, code: str, message: str) -> None:
        self.writer.send(_error(req_id, code, message))


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


def main() -> None:
    proto_in, proto_out = _open_protocol_streams()
    worker = Worker(proto_in, proto_out)
    worker.install_streams()
    worker.serve_forever()
