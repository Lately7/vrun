"""Test helpers: a real worker subprocess driven over the NDJSON protocol."""

from __future__ import annotations

import itertools
import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Any

import pytest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAUNCHER = os.path.join(PY_DIR, "launcher.py")
sys.path.insert(0, PY_DIR)


def full_heap(result: dict[str, Any], k: int = -1) -> dict[str, Any]:
    """The complete heap at step k of a trace: steps carry heap deltas."""
    steps = result["steps"]
    k = k % len(steps)
    heap: dict[str, Any] = {}
    for step in steps[: k + 1]:
        heap.update(step["heap"])
        for key in step.get("gone", []):
            heap.pop(key, None)
    return heap


class KernelProc:
    def __init__(self, cwd: str | None = None, new_session: bool = False) -> None:
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", MPLBACKEND="Agg")
        # new_session: on POSIX the kernel kills its children only as a
        # process-group leader (as the extension starts it); the default keeps
        # exit code 0 for the shutdown tests.
        self.proc = subprocess.Popen(
            [sys.executable, "-u", LAUNCHER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=cwd or PY_DIR, env=env,
            start_new_session=new_session and os.name != "nt")
        self.ids = itertools.count(1)
        self.responses: dict[Any, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.cv = threading.Condition()
        self.stderr: list[bytes] = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()
        self.ready = self.wait_event("ready", 30)

    def _read(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            msg = json.loads(line)
            with self.cv:
                if msg.get("type") == "response":
                    self.responses[msg.get("id")] = msg
                else:
                    self.events.append(msg)
                self.cv.notify_all()

    def _read_err(self) -> None:
        assert self.proc.stderr
        for line in self.proc.stderr:
            self.stderr.append(line)

    def wait_event(self, name: str, timeout: float = 10) -> dict[str, Any]:
        deadline = time.time() + timeout
        with self.cv:
            while True:
                for e in self.events:
                    if e.get("event") == name:
                        return e
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"event {name} not received")
                self.cv.wait(left)

    def send(self, type_: str, **params: Any) -> Any:
        rid = next(self.ids)
        msg = {"id": rid, "type": type_, **params}
        assert self.proc.stdin
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        return rid

    def wait(self, rid: Any, timeout: float = 30) -> dict[str, Any]:
        deadline = time.time() + timeout
        with self.cv:
            while rid not in self.responses:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"no response for {rid}")
                self.cv.wait(left)
            return self.responses.pop(rid)

    def call(self, type_: str, timeout: float = 30, **params: Any) -> dict[str, Any]:
        return self.wait(self.send(type_, **params), timeout)

    def run(self, code: str, **params: Any) -> dict[str, Any]:
        resp = self.call("execute", code=code, **params)
        assert resp["ok"], resp
        return resp["result"]

    def stream_text(self, name: str = "stdout") -> str:
        with self.cv:
            return "".join(e["text"] for e in self.events if e.get("event") == "stream" and e["name"] == name)

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.send("shutdown")
                self.proc.wait(5)
            except Exception:  # noqa: BLE001
                self.proc.kill()
                self.proc.wait(5)


@pytest.fixture()
def kernel():
    k = KernelProc()
    yield k
    k.close()


@pytest.fixture(scope="module")
def shared_kernel():
    k = KernelProc()
    yield k
    k.close()
