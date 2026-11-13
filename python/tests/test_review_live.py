"""Regression tests for review findings on Live Mode and Safe ML."""
from __future__ import annotations

import os
import sys
import tempfile
import time

from conftest import KernelProc

from pylive_kernel import safety, worker


def _names(kernel: KernelProc) -> list[str]:
    return kernel.run("sorted(globals())")["value"]["repr"].split("'")[1::2]


# -- the Live prefix keeps trained state ------------------------------------------
def test_live_does_not_recreate_a_trained_model(kernel):
    code = ("from sklearn.linear_model import LogisticRegression\n"
            "X = [[0.0], [1.0], [2.0], [3.0]]\n"
            "y = [0, 0, 1, 1]\n"
            "model = LogisticRegression()\n"
            "model.fit(X, y)\n"
            "print(model.predict([[3.0]]))")
    assert kernel.run(code)["status"] == "ok"
    r = kernel.call("execute", code=code, mode="live", timeoutMs=5000, lineOffset=10)["result"]
    assert r["status"] == "ok", r
    assert r["stoppedAt"]["line"] == 14 and "'model'" in r["stoppedAt"]["message"]
    assert kernel.run("hasattr(model, 'coef_')")["value"]["repr"] == "True"


def test_live_keeps_a_network_and_its_loss_history(kernel):
    code = ("class Net:\n"
            "    def __init__(self):\n"
            "        self.w = 0\n"
            "class Loss:\n"
            "    def __init__(self, net):\n"
            "        self.net = net\n"
            "    def backward(self):\n"
            "        self.net.w += 1\n"
            "net = Net()\n"
            "losses = []\n"
            "for _ in range(5):\n"
            "    Loss(net).backward()\n"
            "    losses.append(net.w)")
    assert kernel.run(code)["status"] == "ok"
    r = kernel.call("execute", code=code, mode="live", timeoutMs=5000)["result"]
    assert r["stoppedAt"]["line"] == 9, r  # net = Net(), not the loop
    assert kernel.run("(net.w, len(losses))")["value"]["repr"] == "(5, 5)"


def test_live_still_runs_data_preparation_before_the_model(kernel):
    code = ("data = [1, 2, 3]\n"
            "X = tuple(data)\n"
            "from sklearn.svm import SVC\n"
            "m = SVC()\n"
            "m.fit([[0], [1]], [0, 1])")
    kernel.run(code)
    r = kernel.call("execute", code=code.replace("[1, 2, 3]", "[4, 5, 6]"), mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and r["stoppedAt"]["line"] == 4, r
    assert kernel.run("X")["value"]["repr"] == "(4, 5, 6)"
    assert kernel.run("hasattr(m, 'support_')")["value"]["repr"] == "True"


# -- classes, callbacks and wrapped helpers ------------------------------------------
def test_training_in_methods_and_callbacks_is_seen():
    for code in (
        "class Loop:\n    def run(self):\n        model.fit(X, y)\nLoop().run()",
        "class Loop:\n    def run(self):\n        model.fit(X, y)\nt = Loop()\nt.run()",
        "class T:\n    def _step(self):\n        loss.backward()\n    def run(self):\n        self._step()\nT().run()",
        "class T:\n    def __init__(self):\n        m.fit(X, y)\nt = T()",
        "class A:\n    def run(self):\n        m.fit(X, y)\nclass B(A):\n    pass\nB().run()",
        "def train_fold(f):\n    model.fit(f)\nmodels = list(map(train_fold, folds))",
        "import threading\ndef train():\n    model.fit(X, y)\nthreading.Thread(target=train).start()",
    ):
        assert safety.analyze_source(code)["training"], code
    for code in (
        "class T:\n    def run(self):\n        m.fit(X, y)",  # defining is safe
        "class A:\n    def run(self):\n        m.fit(X, y)\nclass B(A):\n    def run(self):\n        return 1\nB().run()",
    ):
        assert safety.analyze_source(code)["liveSafe"], code


def test_kernel_knows_classes_wrapped_and_nested_helpers(kernel):
    kernel.run("calls = 0\n"
               "class Loop:\n"
               "    def run(self):\n"
               "        global calls\n"
               "        calls += 1\n"
               "        model.fit(1)\n"
               "t = Loop()\n"
               "def train_epoch():\n"
               "    loss.backward()\n"
               "def fit_all():\n"
               "    train_epoch()\n"
               "import functools\n"
               "def deco(f):\n"
               "    @functools.wraps(f)\n"
               "    def inner(*a):\n"
               "        return f(*a)\n"
               "    return inner\n"
               "@deco\n"
               "def step():\n"
               "    opt.apply_gradients(g)")
    for code in ("Loop().run()", "t.run()", "fit_all()", "step()", "list(map(fit_all, [1]))"):
        r = kernel.call("execute", code=code, mode="live", timeoutMs=5000)["result"]
        assert r["status"] == "blocked", (code, r)
    assert kernel.run("calls")["value"]["repr"] == "0"


def test_hugging_face_style_train_is_training():
    assert safety.analyze_source("trainer.train()")["training"]
    assert safety.analyze_source("model.train()", torch_modules=frozenset({"model"}))["safe"]


# -- kernel robustness ---------------------------------------------------------------
def test_odd_globals_and_file_values_do_not_break_later_runs(kernel):
    assert kernel.run("globals()[1] = 'one'")["status"] == "ok"
    assert kernel.run("x = 1")["status"] == "ok"
    kernel.run("del globals()[1]")
    kernel.run("class P:\n    def __str__(self):\n        raise ValueError('user str ran')\n__file__ = P()")
    r = kernel.run("y = 2")
    assert r["status"] == "ok", r


def test_system_exit_while_inspecting_keeps_the_kernel(kernel):
    kernel.run("import pylive_kernel.worker as w\n"
               "def boom(p):\n"
               "    raise SystemExit(0)\n"
               "w_inst = [o for o in __import__('gc').get_objects() if type(o) is w.Worker][0]\n"
               "w_inst.h_variables_list = boom")
    resp = kernel.call("variables.list")
    assert not resp["ok"] and resp["error"]["code"] == "internal_error"
    assert kernel.run("1 + 1")["value"]["repr"] == "2"


def test_live_time_limit_waits_for_a_first_library_import(tmp_path):
    (tmp_path / "slowlib.py").write_text("import time\ntime.sleep(1.5)\nREADY = True\n")
    k = KernelProc(cwd=str(tmp_path))
    try:
        k.run("import pylive_kernel.worker as w\nw.UNTEARABLE_IMPORTS.add('slowlib')\nw.LIVE_IMPORT_SECONDS = 0.3")
        r = k.call("execute", code="import slowlib", mode="live", timeoutMs=300)["result"]
        assert r.get("interrupted") == "timeout"
        assert k.run("import sys\n'slowlib' in sys.modules")["value"]["repr"] == "True"  # not torn
        # The flags are reset, so a later Stop interrupts normally.
        rid = k.send("execute", code="import time\nfor _ in range(100):\n    time.sleep(0.05)")
        time.sleep(0.4)
        k.call("interrupt", timeout=5)
        assert k.wait(rid, 20)["result"]["interrupted"] == "interrupted"
    finally:
        k.close()


# -- matplotlib in child processes, figure folder --------------------------------------
def test_children_get_a_backend_they_can_import(kernel):
    code = ("import os, subprocess, sys\n"
            "import matplotlib\n"
            "rc = subprocess.run([sys.executable, '-c', 'import matplotlib.pyplot as plt, os; "
            "plt.plot([1, 2]); plt.savefig(os.devnull, format=\"png\")'], capture_output=True).returncode\n"
            "(os.environ['MPLBACKEND'], matplotlib.get_backend(), rc)")
    r = kernel.run(code)
    assert r["status"] == "ok", r
    assert r["value"]["repr"] == "('Agg', 'module://pylive_kernel.mpl_backend', 0)"


def test_figure_folder_is_private_and_old_ones_are_removed():
    old = tempfile.mkdtemp(prefix=worker._PLOTLY_PREFIX)
    fresh = tempfile.mkdtemp(prefix=worker._PLOTLY_PREFIX)
    past = time.time() - worker._STALE_FIGURE_SECONDS - 60
    os.utime(old, (past, past))
    d = None
    try:
        worker._remove_stale_figure_dirs()
        assert not os.path.exists(old) and os.path.isdir(fresh)
        d = worker._plotly_dir()
        assert os.path.basename(d).startswith(worker._PLOTLY_PREFIX) and d == worker._plotly_dir()
        if sys.platform != "win32":
            assert os.stat(d).st_mode & 0o077 == 0
    finally:
        for p in (old, fresh, d):
            if p and os.path.isdir(p):
                os.rmdir(p)
        worker._PLOTLY_DIR = None


def test_a_counter_or_list_that_the_loop_fills_is_kept(kernel):
    code = ("class Opt:\n"
            "    def step(self):\n"
            "        pass\n"
            "opt = Opt()\n"
            "X = [1, 2]\n"
            "count = 0\n"
            "for _ in range(3):\n"
            "    opt.step()\n"
            "    count += 1")
    kernel.run(code)
    r = kernel.call("execute", code=code, mode="live", timeoutMs=5000)["result"]
    assert r["stoppedAt"]["line"] == 4, r  # opt = Opt() comes first
    kernel.run("opt = 1")  # an int is data again; count is still filled by the loop
    r = kernel.call("execute", code=code, mode="live", timeoutMs=5000)["result"]
    assert r["stoppedAt"]["line"] == 6 and "'count'" in r["stoppedAt"]["message"], r
    assert kernel.run("count")["value"]["repr"] == "3"


def test_a_trace_that_lowers_the_recursion_limit_restores_it():
    from pylive_kernel import tracer
    before = sys.getrecursionlimit()
    tracer.run_trace("import sys\nsys.setrecursionlimit(200)\nx = 1\n")
    assert sys.getrecursionlimit() == before
