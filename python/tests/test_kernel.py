"""End-to-end tests of the worker process over the real protocol."""

from __future__ import annotations

import time

import pytest


def test_ready_event(kernel):
    assert len(kernel.ready["session"]) == 16
    assert kernel.ready["pid"] > 0


def test_variables_persist_and_expression_value(kernel):
    r1 = kernel.run("x = 21\ny = [1, 2, 3]")
    assert r1["status"] == "ok" and r1["executionCount"] == 1
    r2 = kernel.run("x * 2")
    assert r2["value"]["repr"] == "42"
    assert r2["executionCount"] == 2
    r3 = kernel.run("_ + 1")  # last value is stored in `_`
    assert r3["value"]["repr"] == "43"


def test_stdout_and_stderr_are_captured(kernel):
    kernel.run("import sys\nprint('hello')\nprint('oops', file=sys.stderr)")
    assert "hello" in kernel.stream_text("stdout")
    assert "oops" in kernel.stream_text("stderr")


def test_native_stdout_does_not_corrupt_protocol(kernel):
    # os.write to fd 1 bypasses sys.stdout; it must go to stderr, not the protocol.
    r = kernel.run("import os\nos.write(1, b'native-bytes\\n')\n7")
    assert r["value"]["repr"] == "7"
    time.sleep(0.2)
    assert b"native-bytes" in b"".join(kernel.stderr)


def test_syntax_error_reports_line_with_offset(kernel):
    r = kernel.run("a = 1\nb = (\n", file="demo.py", lineOffset=10)
    assert r["status"] == "error"
    assert r["error"]["ename"] == "SyntaxError"
    assert r["error"]["userFrame"]["line"] >= 11


def test_runtime_error_traceback_points_to_user_line(kernel):
    code = "def f(v):\n    return 1 / v\n\nf(0)\n"
    r = kernel.run(code, file="algo.py", lineOffset=4)
    err = r["error"]
    assert err["ename"] == "ZeroDivisionError"
    assert err["userFrame"]["file"] == "algo.py"
    assert err["userFrame"]["line"] == 6  # line 2 of the cell + offset 4
    assert "pylive_kernel" not in err["traceback"]
    assert "return 1 / v" in err["traceback"]


def test_system_exit_does_not_kill_kernel(kernel):
    r = kernel.run("raise SystemExit(3)")
    assert r["error"]["ename"] == "SystemExit"
    assert kernel.run("1 + 1")["value"]["repr"] == "2"


def test_input_is_rejected(kernel):
    r = kernel.run("input('name?')")
    assert r["status"] == "error" and "not supported" in r["error"]["evalue"]


def test_interrupt_long_running_python_loop(kernel):
    rid = kernel.send("execute", code="n = 0\nwhile True:\n    n += 1\n", execId=1)
    time.sleep(0.5)
    ir = kernel.call("interrupt", target=rid)
    assert ir["result"]["interrupted"] is True
    resp = kernel.wait(rid, 10)
    assert resp["result"]["interrupted"] == "interrupted"
    # State before the interrupt is kept, and the kernel keeps working.
    assert int(kernel.run("n")["value"]["repr"]) > 0


def test_interrupt_drops_queued_executions(kernel):
    first = kernel.send("execute", code="while True:\n    pass\n")
    second = kernel.send("execute", code="queued_ran = True")
    time.sleep(0.3)
    kernel.call("interrupt", target=first)
    assert kernel.wait(first)["result"]["interrupted"]
    second_resp = kernel.wait(second)
    assert second_resp["ok"] is False and second_resp["error"]["code"] == "cancelled"
    assert kernel.run("'queued_ran' in globals()")["value"]["repr"] == "False"


def test_late_interrupt_does_not_hit_next_task(kernel):
    rid = kernel.send("execute", code="x = 1")
    kernel.wait(rid)
    ir = kernel.call("interrupt", target=rid)  # task already finished
    assert ir["result"]["interrupted"] is False
    assert kernel.run("sum(range(100000))")["status"] == "ok"


def test_live_mode_time_budget_interrupts(kernel):
    r = kernel.run("while 1 < 2:\n    pass\n", mode="live", timeoutMs=300)
    assert r["interrupted"] == "timeout"


def test_live_mode_blocks_training_code(kernel):
    r = kernel.run("model.fit(X, y)", mode="live")
    assert r["status"] == "blocked"
    assert r["analysis"]["findings"][0]["category"] == "training"


def test_manual_repeat_training_needs_confirmation(kernel):
    kernel.run("class M:\n    def fit(self, x):\n        self.coef_ = x\n        return self\nm = M()")
    first = kernel.run("m.fit(1)")
    assert first["status"] == "ok"
    second = kernel.run("m.fit(1)")
    assert second["status"] == "needs_confirmation"
    forced = kernel.run("m.fit(1)", force=True)
    assert forced["status"] == "ok"


def test_stale_session_handle_rejected(kernel):
    kernel.run("v = 1")
    r = kernel.call("variables.inspect", name="v", session="0000000000000000")
    assert r["ok"] is False and r["error"]["code"] == "stale_handle"


def test_stale_revision_rejected(kernel):
    kernel.run("v = [1]")
    lst = kernel.call("variables.list")["result"]
    kernel.run("v = [2]")
    r = kernel.call("variables.inspect", name="v", session=lst["session"], revision=lst["revision"])
    assert r["error"]["code"] == "stale_revision"


def test_unknown_request_and_bad_params(kernel):
    r = kernel.call("evil.request")
    assert r["error"]["code"] == "unknown_request"
    r = kernel.call("variables.inspect", name="__import__('os')")
    assert r["error"]["code"] == "bad_request"
    r = kernel.call("execute", code=123)
    assert r["error"]["code"] == "bad_request"


def test_cancel_queued_request(kernel):
    first = kernel.send("execute", code="import time\ntime.sleep(0.8)")
    second = kernel.send("variables.list")
    c = kernel.call("cancel", target=second)
    assert c["result"]["cancelled"] is True
    assert kernel.wait(second)["error"]["code"] == "cancelled"
    assert kernel.wait(first)["ok"]


def test_ping_while_busy(kernel):
    rid = kernel.send("execute", code="import time\ntime.sleep(1)")
    time.sleep(0.2)
    pong = kernel.call("ping", timeout=2)
    assert pong["result"]["busy"] is True
    kernel.wait(rid)


def test_output_is_bounded(kernel):
    r = kernel.run("for i in range(400000):\n    print('x' * 20)")
    assert r["outputTruncated"] is True
    total = len(kernel.stream_text("stdout"))
    assert total <= 2 * 1024 * 1024 + 200


def test_kernel_exits_on_stdin_eof():
    from conftest import KernelProc

    k = KernelProc()
    k.proc.stdin.close()
    assert k.proc.wait(10) == 0


def test_shutdown(kernel):
    r = kernel.call("shutdown")
    assert r["result"]["bye"]
    assert kernel.proc.wait(5) == 0


@pytest.mark.parametrize("code,expected", [
    ("import math\nmath.nan", "nan"),
    ("2**80", str(2**80)),
    ("None", None),
])
def test_expression_reprs(kernel, code, expected):
    r = kernel.run(code)
    if expected is None:
        assert "value" not in r
    else:
        assert r["value"]["repr"] == expected
