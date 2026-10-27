"""Regression tests for findings of the Codex reviews (docs/reviews/)."""

from __future__ import annotations

import json
import time

import pytest


def _stream(kernel, exec_id):
    return "".join(e["text"] for e in kernel.events if e.get("event") == "stream" and e.get("execId") == exec_id)


def test_user_stdout_replacement_follows_python_semantics(kernel):
    # Python semantics: after `sys.stdout = StringIO()` prints go to the StringIO.
    kernel.run("import io, sys\nbuf = io.StringIO()\nsys.stdout = buf")
    kernel.run("print('into buffer')", execId="a")
    assert "into buffer" not in _stream(kernel, "a")
    assert kernel.run("buf.getvalue()")["value"]["repr"] == "'into buffer\\n'"
    # ...and the usual restore idiom brings capture back.
    kernel.run("sys.stdout = sys.__stdout__")
    kernel.run("print('captured again')", execId="b")
    time.sleep(0.1)
    assert "captured again" in _stream(kernel, "b")


def test_output_budget_counts_utf8_bytes(kernel):
    r = kernel.run("print('😀' * 1_000_000)")  # 4 MB of UTF-8 in one write
    assert r["outputTruncated"] is True
    sizes = [len(json.dumps(e, ensure_ascii=False).encode()) for e in kernel.events if e.get("event") == "stream"]
    assert sizes and max(sizes) < 2 * 1024 * 1024
    total = sum(len(e["text"].encode("utf-8", "replace")) for e in kernel.events if e.get("event") == "stream")
    assert total <= 2 * 1024 * 1024 + 100


def test_lone_surrogate_output_is_delivered(kernel):
    kernel.run("print('a\\udcff b')", execId="s")
    time.sleep(0.1)
    assert "a" in _stream(kernel, "s") and "b" in _stream(kernel, "s")


def test_integer_filter_is_exact_above_2_53(kernel):
    pytest.importorskip("pandas")
    kernel.run("import pandas as pd\nbig = pd.DataFrame({'v': [2**53, 2**53 + 1]})")
    p = kernel.call("dataframe.page", name="big", offset=0, limit=5,
                    filter={"column": 0, "op": "eq", "value": str(2**53 + 1)})["result"]
    assert p["total"] == 1


def test_variables_list_never_calls_user_sizeof(kernel):
    kernel.run("calls = []\nclass S:\n    def __sizeof__(self):\n        calls.append(1)\n        return 1\ns = S()")
    kernel.call("variables.list")
    assert kernel.run("len(calls)")["value"]["repr"] == "0"


def test_trace_does_not_capture_background_thread_output(kernel):
    kernel.run(
        "import threading, time, sys\n"
        "def bg():\n"
        "    time.sleep(0.3)\n"
        "    print('from-background')\n"
        "threading.Thread(target=bg, daemon=True).start()",
        execId="bg-start",
    )
    res = kernel.call("trace", code="import time\nfor i in range(3):\n    time.sleep(0.2)\nprint('traced')")["result"]
    assert "from-background" not in res["stdout"]
    assert "traced" in res["stdout"]
    time.sleep(0.2)
    # A newer request (the trace) started meanwhile, so the kernel cannot be
    # sure which run the text belongs to: it is reported as background (None),
    # never as the trace's output.
    assert "from-background" in _stream(kernel, None)
    # The persistent __main__ is untouched by tracing.
    assert kernel.run("import sys\nsys.modules['__main__'].__dict__ is globals()")["value"]["repr"] == "True"


def test_background_output_while_its_run_is_latest_keeps_exec_id(kernel):
    kernel.run(
        "import threading, time\n"
        "threading.Thread(target=lambda: (time.sleep(0.2), print('mine')), daemon=True).start()",
        execId="owner",
    )
    time.sleep(0.5)  # no newer execution started
    assert "mine" in _stream(kernel, "owner")


def test_zero_dim_and_structured_arrays(kernel):
    pytest.importorskip("numpy")
    kernel.run("import numpy as np\nz = np.array(7)\nrec = np.array([(1, 2.5)], dtype=[('a', 'i4'), ('b', 'f8')])")
    z = kernel.call("variables.inspect", name="z")["result"]
    assert z["heap"][str(z["root"]["ref"])]["value"] == 7
    rec = kernel.call("variables.inspect", name="rec")["result"]
    assert rec["heap"][str(rec["root"]["ref"])]["items"][0] == {"$t": "record", "v": "(1, 2.5)"}
