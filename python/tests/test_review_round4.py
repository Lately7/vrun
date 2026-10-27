"""Regression tests for the Codex round-4 regression review."""

from __future__ import annotations

import time

import pytest


def _stream(kernel, exec_id):
    return "".join(e["text"] for e in kernel.events if e.get("event") == "stream" and e.get("execId") == exec_id)


def test_huge_exponent_filter_answers_fast(kernel):
    pytest.importorskip("pandas")
    kernel.run("import pandas as pd\nints = pd.DataFrame({'v': pd.array([1, None, 3], dtype='Int64')})")
    for op, expected in (("eq", 0), ("ne", 2), ("lt", 2), ("gt", 0)):
        t0 = time.time()
        r = kernel.call("dataframe.page", name="ints", offset=0, limit=5,
                        filter={"column": 0, "op": op, "value": "1e999999999"}, timeout=10)
        assert time.time() - t0 < 5
        assert r["result"]["total"] == expected, (op, r)
    r = kernel.call("dataframe.page", name="ints", offset=0, limit=5,
                    filter={"column": 0, "op": "gt", "value": "-1e999999999"})
    assert r["result"]["total"] == 2


def test_stdout_buffer_and_dunder_streams_are_usable(kernel):
    kernel.run(
        "import sys\n"
        "sys.stdout.buffer.write('héllo\\n'.encode())\n"
        "sys.__stdout__.buffer.write(b'raw bytes\\n')\n"
        "sys.stdout.reconfigure(line_buffering=True)\n"
        "assert sys.__stderr__.closed is False",
        execId="buf",
    )
    time.sleep(0.2)
    out = _stream(kernel, "buf")
    assert "héllo" in out and "raw bytes" in out
    r = kernel.run("import io, sys\ntry:\n    sys.stdout.fileno()\nexcept io.UnsupportedOperation:\n    ok = True\nok")
    assert r["value"]["repr"] == "True"


def test_hostile_str_subclass_module_is_not_called(kernel):
    kernel.run(
        "calls = []\n"
        "class Evil(str):\n"
        "    def startswith(self, *a):\n"
        "        calls.append('startswith'); return False\n"
        "    def __eq__(self, o):\n"
        "        calls.append('eq'); return False\n"
        "    __hash__ = str.__hash__\n"
        "    def __format__(self, spec):\n"
        "        calls.append('format'); return 'x'\n"
        "class Thing: pass\n"
        "Thing.__module__ = Evil('evilmod')\n"
        "thing = Thing()"
    )
    kernel.call("variables.list")
    kernel.call("variables.inspect", name="thing")
    kernel.run("thing")
    assert kernel.run("calls")["value"]["repr"] == "[]"


def test_second_start_does_not_relabel_thread(kernel):
    kernel.run(
        "import threading, time\n"
        "ev = threading.Event()\n"
        "def body():\n"
        "    ev.wait(2)\n"
        "    print('from-first-owner')\n"
        "t = threading.Thread(target=body, daemon=True)\n"
        "t.start()",
        execId="first",
    )
    r = kernel.run("try:\n    t.start()\nexcept RuntimeError:\n    pass\nev.set()\ntime.sleep(0.3)", execId="second")
    assert r["status"] == "ok"
    time.sleep(0.2)
    # Started by "first" but printing while "second" is the latest run: unknown, never "second".
    assert "from-first-owner" not in _stream(kernel, "second")
