"""P1 fixes in how the kernel runs code: pandas 3 in Live Mode, trained state
across cells, the working folder, edited modules, leftover built-in names."""
from __future__ import annotations

import os
import sys
import time

import pytest
from conftest import KernelProc

from pylive_kernel import livestate, reloader


def _bump(path, text: str) -> None:
    """Rewrite a module and move its mtime forward: a quick edit can land in
    the same mtime tick as the import."""
    path.write_text(text, encoding="utf-8")
    later = time.time() + 5
    os.utime(path, (later, later))


def _value(result: dict) -> str:
    assert result["status"] == "ok", result
    return result["value"]["repr"]


@pytest.fixture()
def folder_kernel(tmp_path):
    start = tmp_path / "start"
    start.mkdir()
    k = KernelProc(cwd=str(start))
    yield k, tmp_path
    k.close()


# -- item 4: pandas 3 frames are plain data -------------------------------------
def test_pandas_frames_count_as_plain_data():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"a": [1]})
    assert livestate.is_plain_data(df) and livestate.is_plain_data(df["a"])
    assert livestate.is_plain_data(pd.Index([1]))


def test_live_cleaning_cell_stops_at_to_csv_not_at_read_csv(kernel, tmp_path):
    pytest.importorskip("pandas")
    src = tmp_path / "don_hang.csv"
    src.write_text("so_luong,don_gia\n1,1000\n,2000\n3,3000\n", encoding="utf-8")
    out = tmp_path / "ket_qua.csv"
    code = ("import pandas as pd\n"
            f"df = pd.read_csv({str(src)!r})\n"
            "df['so_luong'] = df['so_luong'].fillna(1)\n"
            "df['doanh_thu'] = df['so_luong'] * df['don_gia']\n"
            "df = df[df['doanh_thu'] > 0]\n"
            "df['doanh_thu'].sum()")
    assert kernel.run(code)["status"] == "ok"
    live = code + f"\ndf.to_csv({str(out)!r}, index=False)"
    r = kernel.call("execute", code=live, mode="live", timeoutMs=5000, lineOffset=20)["result"]
    assert r["status"] == "ok", r
    assert r["stoppedAt"]["line"] == 27 and "to_csv" in r["stoppedAt"]["message"], r["stoppedAt"]
    assert not out.exists()
    assert kernel.run("float(df['doanh_thu'].sum())")["value"]["repr"] == "12000.0"


# -- item 5: Live keeps what manual runs trained -----------------------------------
SKLEARN_DATA = ("from sklearn.linear_model import LogisticRegression\n"
                "X = [[0.0], [1.0], [2.0], [3.0]]\n"
                "y = [0, 0, 1, 1]\n")


def test_live_does_not_rebuild_a_model_trained_in_another_cell(kernel):
    pytest.importorskip("sklearn")
    build = SKLEARN_DATA + "model = LogisticRegression()\n"
    assert kernel.run(build, file="lesson.py", lineOffset=0)["status"] == "ok"
    assert kernel.run("model.fit(X, y)", file="lesson.py", lineOffset=10)["status"] == "ok"
    r = kernel.call("execute", code=build + "# a comment", mode="live", timeoutMs=5000,
                    file="lesson.py", lineOffset=0)["result"]
    assert r["status"] == "ok" and r["stoppedAt"]["line"] == 4, r
    assert r["stoppedAt"]["category"] == "trained"
    assert r["stoppedAt"]["message"] == "would replace the fitted model 'model' (fitted at line 11)"
    assert _value(kernel.run("hasattr(model, 'coef_')")) == "True"
    # Run Cell rebuilds it on purpose; then Live may rebuild the unfitted model.
    assert kernel.run(build, file="lesson.py")["status"] == "ok"
    r = kernel.call("execute", code=build, mode="live", timeoutMs=5000, file="lesson.py")["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


def test_live_names_the_file_that_trained(kernel):
    pytest.importorskip("sklearn")
    kernel.run(SKLEARN_DATA + "clf = LogisticRegression()\nclf.fit(X, y)", file=r"C:\work\bai9.py")
    r = kernel.call("execute", code="clf = None", mode="live", timeoutMs=5000, file=r"C:\work\bai10.py")["result"]
    assert r["status"] == "blocked"
    assert r["stoppedAt"]["message"] == "would replace the fitted model 'clf' (fitted at line 5 of bai9.py)"


def test_live_still_runs_a_data_cell_that_training_only_reads(kernel):
    pytest.importorskip("sklearn")
    kernel.run(SKLEARN_DATA + "model = LogisticRegression()")
    kernel.run("model.fit(X, y)")
    r = kernel.call("execute", code="X = [[5.0], [6.0], [7.0], [8.0]]\ny = [1, 1, 0, 0]",
                    mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


def test_live_may_rebuild_an_unfitted_estimator_and_a_scaler(kernel):
    pytest.importorskip("sklearn")
    kernel.run(SKLEARN_DATA + "from sklearn.preprocessing import StandardScaler\n"
               "from sklearn.model_selection import cross_val_score\n"
               "model = LogisticRegression()\n"
               "scaler = StandardScaler()\n"
               "Xs = scaler.fit_transform(X)\n"
               "scores = cross_val_score(model, Xs, y, cv=2)")
    r = kernel.call("execute", code="model = LogisticRegression(C=2.0)\nscaler = StandardScaler()\n"
                    "Xs = scaler.fit_transform(X)", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


def test_live_fallback_sees_a_fitted_estimator_without_a_training_statement(kernel):
    pytest.importorskip("sklearn")
    # getattr(...) hides the .fit call from the analysis: only inspection sees it.
    kernel.run(SKLEARN_DATA + "model = LogisticRegression()\ngetattr(model, 'fit')(X, y)")
    r = kernel.call("execute", code="model = LogisticRegression()", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "blocked"
    assert r["stoppedAt"]["message"] == "would replace the fitted model 'model'"


HAND_MADE = ("class Opt:\n"
             "    def __init__(self):\n"
             "        self.t = 0\n"
             "    def step(self):\n"
             "        self.t += 1\n"
             "opt = Opt()\n"
             "history = []\n"
             "total = 0\n")
TRAIN = ("for epoch in range(3):\n"
         "    loss = 1.0 / (epoch + 1)\n"
         "    opt.step()\n"
         "    history.append(loss)\n"
         "    total += 1\n")


def test_live_keeps_history_and_state_filled_by_a_training_loop(kernel):
    assert kernel.run(HAND_MADE, file="nn.py")["status"] == "ok"
    assert kernel.run(TRAIN, file="nn.py", lineOffset=20)["status"] == "ok"
    r = kernel.call("execute", code=HAND_MADE, mode="live", timeoutMs=5000, file="nn.py")["result"]
    assert r["status"] == "ok" and r["stoppedAt"]["line"] == 6, r
    assert r["stoppedAt"]["message"] == "would replace 'opt', which training at line 21 changed"
    # The loop's own per-epoch values are not protected; the data it fills is.
    r = kernel.call("execute", code="loss = 0\nepoch = 0\nhistory = []", mode="live", timeoutMs=5000,
                    file="nn.py")["result"]
    assert r["stoppedAt"]["line"] == 3, r
    assert r["stoppedAt"]["message"] == "would reset 'history', which training at line 21 filled"
    assert _value(kernel.run("(opt.t, len(history), total)")) == "(3, 3, 3)"
    r = kernel.call("execute", code="del total", mode="live", timeoutMs=5000, file="nn.py")["result"]
    assert r["status"] == "blocked" and "'total'" in r["stoppedAt"]["message"], r


def test_rebinding_a_model_to_itself_is_not_a_reset():
    import ast

    class Opt:
        def step(self) -> None:
            pass

        def to(self, device: str) -> "Opt":
            return self

    names = livestate.TrainedNames()
    ns = {"opt": Opt(), "X": [1, 2]}
    names.record(ast.parse("for i in X:\n    opt.step()").body[0], 7, "a.py", ns)
    body = ast.parse("X = [3]\nopt = opt.to('cpu')\nopt = Opt()").body
    assert names.first_replacement(body, None, ns, "a.py") == (2, "would replace 'opt', which training at line 7 changed")
    assert names.first_replacement(body, 2, ns, "a.py") is None
    assert names.first_replacement(body, None, ns, r"C:\x\b.py")[1].endswith("at line 7 of a.py changed")


def test_interrupted_training_is_protected_too(kernel):
    kernel.run(HAND_MADE)
    rid = kernel.send("execute", code="import time\nfor i in range(1000):\n    opt.step()\n    time.sleep(0.01)")
    time.sleep(1.0)
    kernel.call("interrupt")
    assert kernel.wait(rid)["result"]["error"]["ename"] == "KeyboardInterrupt"
    r = kernel.call("execute", code="opt = Opt()", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "blocked" and "'opt'" in r["stoppedAt"]["message"], r


def test_trained_records_hold_no_reference(kernel):
    kernel.run(HAND_MADE)
    kernel.run(TRAIN)
    kernel.run("import weakref, gc\nold = weakref.ref(opt)\nopt = Opt()\ngc.collect()")
    assert _value(kernel.run("old() is None")) == "True"
    r = kernel.call("execute", code="opt = Opt()", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


HELPER_FILLS = ("class M:\n"
                "    def fit(self):\n"
                "        return self\n"
                "def train_epoch(m, hist):\n"
                "    m.fit()\n"
                "    hist.append(1.0)\n")


def test_a_history_filled_by_a_helper_is_protected(kernel):
    # The helper fills the lists; the training statement only passes them.
    assert kernel.run(HELPER_FILLS, file="h.py")["status"] == "ok"
    model_cell = "losses = []\nhist = {'loss': []}\nm = M()\ndata = [1, 2, 3]"
    assert kernel.run(model_cell, file="h.py", lineOffset=10)["status"] == "ok"
    train = "for e in range(3):\n    train_epoch(m, losses)\n    train_epoch(m, hist['loss'])\n    len(data)"
    assert kernel.run(train, file="h.py", lineOffset=20)["status"] == "ok"
    r = kernel.call("execute", code=model_cell, mode="live", timeoutMs=5000, file="h.py",
                    lineOffset=10)["result"]
    assert r["status"] == "blocked", r
    assert r["stoppedAt"]["message"] == "would reset 'losses', which training at line 21 filled"
    r = kernel.call("execute", code="hist = {'loss': []}", mode="live", timeoutMs=5000, file="h.py")["result"]
    assert r["status"] == "blocked" and "'hist'" in r["stoppedAt"]["message"], r
    # Data the helper only read is not training state.
    r = kernel.call("execute", code="data = [4, 5]", mode="live", timeoutMs=5000, file="h.py")["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r
    assert _value(kernel.run("len(losses), len(hist['loss'])")) == "(3, 3)"


def test_a_sleep_loop_is_not_training(kernel):
    assert kernel.run("import time\nframes = []\nfor i in range(3):\n    frames.append(i)\n"
                      "    time.sleep(0.01)")["status"] == "ok"
    r = kernel.call("execute", code="frames = []\nframes.append(9)\nframes", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


def test_a_loss_tensor_is_not_trained_state(kernel):
    torch = pytest.importorskip("torch")  # noqa: F841 - the kernel runs this interpreter
    kernel.run("import torch\nw = torch.ones(3, requires_grad=True)\nloss = (w * 2).sum()")
    assert kernel.run("loss.backward()")["status"] == "ok"
    r = kernel.call("execute", code="loss = (w * 3).sum()", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "ok" and "stoppedAt" not in r, r


def test_trained_records_count_only_real_training():
    assert livestate.trains([{"category": "training", "message": "'.fit()' trains or updates a model"}])
    assert livestate.trains([{"category": "expensive", "message": "'cross_val_score()' runs repeated model fitting"}])
    assert not livestate.trains([{"category": "expensive", "message": "'time.sleep()' blocks execution"}])
    assert not livestate.trains([{"category": "load", "message": "'read_csv()' loads external data"}])


# -- item 1: the working folder follows the file (C1) ---------------------------
def test_working_folder_follows_the_document(folder_kernel):
    k, tmp = folder_kernel
    lesson = tmp / "lesson2"
    lesson.mkdir()
    (lesson / "data.txt").write_text("xin chao", encoding="utf-8")
    (lesson / "helper_l2.py").write_text("VALUE = 42\n", encoding="utf-8")
    script = str(lesson / "bai.py")
    r = k.run("import helper_l2\nopen('data.txt', encoding='utf-8').read(), helper_l2.VALUE",
              file=script, cwd=str(lesson))
    assert _value(r) == "('xin chao', 42)"
    assert r["notes"] == [f"working folder: {lesson}"]
    r = k.run("import os, sys\nos.getcwd(), sys.path[0], sys.path.count(os.path.abspath('../start'))",
              file=script, cwd=str(lesson))
    assert _value(r) == repr((str(lesson), str(lesson), 0))
    assert "notes" not in r  # said once per change
    # An untitled buffer (no cwd) stays where the kernel is.
    assert _value(k.run("os.getcwd()")) == repr(str(lesson))


def test_the_learners_own_chdir_is_kept(folder_kernel):
    k, tmp = folder_kernel
    a, b = tmp / "a", tmp / "b"
    a.mkdir()
    b.mkdir()
    start = str(tmp / "start")
    own = str(tmp / "start" / "s.py")
    # The cell that moved, and the next cell of its file, need no note.
    assert "notes" not in k.run(f"import os\nos.chdir({str(a)!r})", file=own, cwd=start)
    r = k.run("os.getcwd()", file=own, cwd=start)
    assert _value(r) == repr(str(a)) and "notes" not in r
    # A file of another folder: vrun leaves the folder and says why, once.
    r = k.run("os.getcwd()", file=str(b / "x.py"), cwd=str(b))
    assert _value(r) == repr(str(a))
    assert r["notes"] == [f"working folder stays at {a} (your code changed it with os.chdir)"]
    assert "notes" not in k.run("os.getcwd()", file=str(b / "x.py"), cwd=str(b))
    # Back in the folder vrun chose: vrun follows the document again.
    k.run(f"os.chdir({start!r})")
    r = k.run("os.getcwd()", file=str(b / "x.py"), cwd=str(b))
    assert _value(r) == repr(str(b)) and r["notes"] == [f"working folder: {b}"]


def test_a_chdir_in_another_buffer_is_explained(folder_kernel):
    k, tmp = folder_kernel
    a = tmp / "a"
    a.mkdir()
    k.run(f"import os\nos.chdir({str(a)!r})")  # a practice buffer (no file, no folder)
    r = k.run("os.getcwd()", file=str(tmp / "start" / "s.py"), cwd=str(tmp / "start"))
    assert _value(r) == repr(str(a))
    assert r["notes"] == [f"working folder stays at {a} (your code changed it with os.chdir)"]


def test_bad_or_missing_folders_are_ignored(folder_kernel):
    k, tmp = folder_kernel
    r = k.run("import os\nos.getcwd()", cwd=str(tmp / "gone"))
    assert _value(r) == repr(str(tmp / "start")) and "notes" not in r
    r = k.run("os.getcwd()", cwd="relative/path")
    assert _value(r) == repr(str(tmp / "start"))
    bad = k.call("execute", code="1", cwd=5)
    assert not bad["ok"] and bad["error"]["code"] == "bad_request"


def test_trace_uses_the_same_working_folder(folder_kernel):
    k, tmp = folder_kernel
    lesson = tmp / "lesson3"
    lesson.mkdir()
    (lesson / "input.txt").write_text("5 7", encoding="utf-8")
    r = k.call("trace", code="a, b = map(int, open('input.txt').read().split())\nprint(a + b)",
               cwd=str(lesson))["result"]
    assert r["status"] == "ok" and r.get("error") is None, r
    assert r["stdout"].strip() == "12"
    assert f"working folder: {lesson}" in r["notes"]


# -- item 6: Visualize passes the cells above through (C3) -------------------------
def test_trace_passes_the_prelude_to_the_tracer(kernel):
    r = kernel.call("trace", code="print(hanoi(3))", prelude="def hanoi(n):\n    return 2 ** n - 1\n")["result"]
    assert r["status"] == "ok" and r.get("error") is None, r
    assert r["stdout"].strip() == "7"


# -- item 10: edited modules are reloaded ----------------------------------------
def test_an_edited_module_is_reloaded_and_from_imports_follow(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "hinh_hoc.py").write_text("def dien_tich(a, b):\n    return a + b\n", encoding="utf-8")
    main = str(tmp / "bai.py")
    run = lambda code: k.run(code, file=main, cwd=str(tmp))  # noqa: E731
    assert _value(run("import hinh_hoc\nfrom hinh_hoc import dien_tich\ndien_tich(3, 4)")) == "7"
    _bump(tmp / "hinh_hoc.py", "def dien_tich(a, b):\n    return a * b\n\n"
                               "def duong_cheo(a, b):\n    return (a * a + b * b) ** 0.5\n")
    r = run("dien_tich(3, 4), hinh_hoc.dien_tich(3, 4), hinh_hoc.duong_cheo(3, 4)")
    assert _value(r) == "(12, 12, 5.0)"
    assert "reloaded hinh_hoc.py (changed on disk)" in r["notes"]
    r = run("dien_tich(1, 1)")
    assert "notes" not in r  # unchanged since: no second reload


def test_objects_made_before_the_edit_run_the_new_methods(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "shapes.py").write_text("class Rect:\n    def __init__(self, w, h):\n        self.w, self.h = w, h\n"
                                   "    def area(self):\n        return self.w + self.h\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("from shapes import Rect\nr = Rect(2, 3)")
    _bump(tmp / "shapes.py", "class Rect:\n    def __init__(self, w, h):\n        self.w, self.h = w, h\n"
                             "    def area(self):\n        return self.w * self.h\n")
    assert _value(run("r.area(), Rect(4, 5).area()")) == "(6, 20)"


def test_modules_reload_in_dependency_order(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "base_m.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    (tmp / "user_m.py").write_text("from base_m import f\ndef g():\n    return f() * 10\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    assert _value(run("from user_m import g\ng()")) == "10"
    _bump(tmp / "base_m.py", "def f():\n    return 2\n")
    _bump(tmp / "user_m.py", "from base_m import f\ndef g():\n    return f() * 100\n")
    r = run("g()")
    assert _value(r) == "200"
    assert r["notes"] == ["reloaded base_m.py (changed on disk)", "reloaded user_m.py (changed on disk)"]
    # Only the base changed: the unchanged module's `from base_m import f` follows.
    _bump(tmp / "base_m.py", "def f():\n    return 3\n")
    assert _value(run("g()")) == "300"


@pytest.mark.parametrize("pyc", [True, False], ids=["pyc", "no-pyc"])
def test_an_edit_saved_while_the_importing_run_was_busy_counts(tmp_path, monkeypatch, pyc):
    # With a .pyc its header tells the imported version; without one
    # (PYTHONDONTWRITEBYTECODE) the file's mtime against the run's start does.
    if pyc:
        monkeypatch.delenv("PYTHONDONTWRITEBYTECODE", raising=False)
    else:
        monkeypatch.setenv("PYTHONDONTWRITEBYTECODE", "1")
    (tmp_path / "busy_m.py").write_text("N = 1\n", encoding="utf-8")
    old = time.time() - 60
    os.utime(tmp_path / "busy_m.py", (old, old))
    k = KernelProc(cwd=str(tmp_path))
    try:
        run = lambda code: k.run(code, file=str(tmp_path / "main.py"), cwd=str(tmp_path))  # noqa: E731
        # The run imports the module, then (like a learner saving during a
        # long training) the file changes before the run ends.
        assert _value(run("import busy_m, os, sys, time\n"
                          "open('busy_m.py', 'w').write('N = 2\\n')\n"
                          "t = time.time() + 5\nos.utime('busy_m.py', (t, t))\n"
                          "busy_m.N, sys.dont_write_bytecode")) == f"(1, {not pyc})"
        r = run("busy_m.N")
        assert _value(r) == "2" and r["notes"] == ["reloaded busy_m.py (changed on disk)"]
        assert "notes" not in run("busy_m.N")
    finally:
        k.close()


def test_a_broken_edit_keeps_the_old_module(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "util_b.py").write_text("def h():\n    return 'old'\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("import util_b")
    _bump(tmp / "util_b.py", "X = 1\ndef h(:\n    return 'new'\n")
    r = run("util_b.h(), hasattr(util_b, 'X')")
    assert _value(r) == "('old', False)"
    assert r["notes"][0].startswith("could not reload util_b.py (SyntaxError: ")
    assert r["notes"][0].endswith("; the kernel still runs its old code")
    # Tried once per save: each try re-ran the module's top-level code.
    assert "notes" not in run("util_b.h()")
    _bump(tmp / "util_b.py", "def h():\n    return 'fixed'\n")
    r = run("util_b.h()")
    assert _value(r) == "'fixed'" and r["notes"] == ["reloaded util_b.py (changed on disk)"]


def test_a_failing_reload_runs_the_module_code_once(folder_kernel):
    k, tmp = folder_kernel
    log = tmp / "imports.log"
    body = f"open({str(log)!r}, 'a').write('x')\n"
    (tmp / "noisy_m.py").write_text(body, encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("import noisy_m")
    _bump(tmp / "noisy_m.py", body + "raise ValueError('half done')\n")
    assert run("1")["notes"] == ["could not reload noisy_m.py (ValueError: half done); "
                                 "the kernel still runs its old code"]
    run("2")
    assert log.read_text() == "xx"


def test_a_module_that_trains_at_import_is_not_reloaded(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "train_m.py").write_text("class M:\n    def fit(self, X):\n        return self\n"
                                    "model = M()\nmodel.fit([1])\nRUNS = 1\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("import train_m")
    _bump(tmp / "train_m.py", "class M:\n    def fit(self, X):\n        return self\n"
                              "model = M()\nmodel.fit([1])\nRUNS = 2\n")
    r = run("train_m.RUNS")
    assert _value(r) == "1"
    assert r["notes"] == ["train_m.py changed on disk, but vrun did not reload it: importing it "
                          "'.fit()' trains or updates a model (line 5). Run importlib.reload(train_m) "
                          "yourself, or vrun: Restart Kernel"]
    assert "notes" not in run("train_m.RUNS")  # said once per edit


def test_main_guard_code_does_not_block_a_reload(folder_kernel):
    k, tmp = folder_kernel
    body = "def solve(n):\n    return n + {}\n\nif __name__ == '__main__':\n    print(solve(int(input())))\n"
    (tmp / "sol_m.py").write_text(body.format(1), encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("from sol_m import solve")
    _bump(tmp / "sol_m.py", body.format(2))
    assert _value(run("solve(1)")) == "3"


def test_live_runs_do_not_reload_but_say_the_code_is_old(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "live_m.py").write_text("N = 1\n", encoding="utf-8")
    k.run("import live_m", file=str(tmp / "main.py"), cwd=str(tmp))
    _bump(tmp / "live_m.py", "N = 2\n")
    r = k.call("execute", code="live_m.N", mode="live", timeoutMs=5000, file=str(tmp / "main.py"),
               cwd=str(tmp))["result"]
    assert r["value"]["repr"] == "1"
    assert r["notes"] == ["live_m.py changed on disk; Live keeps running the old code until you run a cell "
                          "(Ctrl+Alt+C) or Visualize"]
    # Live runs on every keystroke: said once per save.
    r = k.call("execute", code="live_m.N + 0", mode="live", timeoutMs=5000, file=str(tmp / "main.py"),
               cwd=str(tmp))["result"]
    assert r["value"]["repr"] == "1" and "notes" not in r, r
    _bump(tmp / "live_m.py", "N = 3\n")
    os.utime(tmp / "live_m.py", (time.time() + 10, time.time() + 10))
    r = k.call("execute", code="live_m.N", mode="live", timeoutMs=5000, file=str(tmp / "main.py"),
               cwd=str(tmp))["result"]
    assert len(r["notes"]) == 1, r


def test_visualize_traces_the_saved_module(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "algo_m.py").write_text("def best(xs):\n    return min(xs)\n", encoding="utf-8")
    k.run("import algo_m", file=str(tmp / "main.py"), cwd=str(tmp))
    _bump(tmp / "algo_m.py", "def best(xs):\n    return max(xs)\n")
    r = k.call("trace", code="from algo_m import best\nprint(best([3, 9, 4]))", cwd=str(tmp))["result"]
    assert r["stdout"].strip() == "9"
    assert "reloaded algo_m.py (changed on disk)" in r["notes"]


def _lessons(tmp, *names):
    out = []
    for n in names:
        (tmp / n).mkdir()
        out.append(tmp / n)
    return out


def test_a_module_reloads_from_its_own_folder(folder_kernel):
    # Run from lesson 4 (no hh.py there), the edit of lesson 3's hh.py used
    # to fail on every run: reload looked the module up on sys.path.
    k, tmp = folder_kernel
    l3, l4 = _lessons(tmp, "l3", "l4")
    (l3 / "hh.py").write_text("def area(a, b):\n    return a + b\n", encoding="utf-8")
    in3 = lambda code: k.run(code, file=str(l3 / "b3.py"), cwd=str(l3))  # noqa: E731
    in4 = lambda code: k.run(code, file=str(l4 / "b4.py"), cwd=str(l4))  # noqa: E731
    assert _value(in3("from hh import area\narea(3, 4)")) == "7"
    _bump(l3 / "hh.py", "def area(a, b):\n    return a * b\n")
    r = in4("area(3, 4)")
    assert _value(r) == "12"
    assert r["notes"] == [f"working folder: {l4}", "reloaded hh.py (changed on disk)"]
    assert "notes" not in in4("1")
    assert _value(in3("import hh\narea(3, 4), hh.__file__")) == repr((12, str(l3 / "hh.py")))


def test_each_lesson_folder_imports_its_own_copy(folder_kernel):
    k, tmp = folder_kernel
    l1, l2 = _lessons(tmp, "l1", "l2")
    log = tmp / "imports.log"
    for lesson in (l1, l2):
        (lesson / "utils.py").write_text(f"open({str(log)!r}, 'a').write('{lesson.name} ')\n"
                                         f"def greet():\n    return '{lesson.name}'\n", encoding="utf-8")
    in1 = lambda code: k.run(code, file=str(l1 / "bai1.py"), cwd=str(l1))  # noqa: E731
    in2 = lambda code: k.run(code, file=str(l2 / "bai2.py"), cwd=str(l2))  # noqa: E731
    assert _value(in1("import utils\nfrom utils import greet\ngreet()")) == "'l1'"
    r = in2("import utils\nfrom utils import greet\ngreet(), utils.greet()")
    assert _value(r) == "('l2', 'l2')"
    assert r["notes"] == [f"working folder: {l2}",
                          f"import utils now loads {os.path.join('l2', 'utils.py')} (this folder's), "
                          f"not {os.path.join('l1', 'utils.py')}"]
    # Back in lesson 1, its module returns as it was, without running again,
    # and the names its cells imported point into it again.
    r = in1("greet(), utils.greet(), utils.__file__")
    assert _value(r) == repr(("l1", "l1", str(l1 / "utils.py")))
    assert log.read_text() == "l1 l2 "


def test_a_folder_the_learner_put_first_on_sys_path_still_wins(folder_kernel):
    k, tmp = folder_kernel
    l1, l2, common = _lessons(tmp, "l1", "l2", "common")
    for folder in (l2, common):
        (folder / "utils.py").write_text(f"WHERE = '{folder.name}'\n", encoding="utf-8")
    k.run(f"import sys\nsys.path.insert(0, {str(common)!r})\nimport utils", file=str(l1 / "a.py"), cwd=str(l1))
    r = k.run("import utils\nutils.WHERE", file=str(l2 / "b.py"), cwd=str(l2))
    assert _value(r) == "'common'" and r["notes"] == [f"working folder: {l2}"]


def test_an_edit_in_one_lesson_does_not_load_the_other_lessons_file(folder_kernel):
    k, tmp = folder_kernel
    l5, l6 = _lessons(tmp, "l5", "l6")
    (l5 / "helpers.py").write_text("WHO = 'l5 v1'\ndef who():\n    return WHO\n", encoding="utf-8")
    (l6 / "helpers.py").write_text("WHO = 'l6'\ndef who():\n    return WHO\n", encoding="utf-8")
    in5 = lambda code: k.run(code, file=str(l5 / "a.py"), cwd=str(l5))  # noqa: E731
    in6 = lambda code: k.run(code, file=str(l6 / "b.py"), cwd=str(l6))  # noqa: E731
    assert _value(in5("import helpers\nhelpers.who()")) == "'l5 v1'"
    _bump(l5 / "helpers.py", "WHO = 'l5 v2'\ndef who():\n    return WHO\n")
    assert _value(in6("import helpers\nhelpers.who(), helpers.__file__")) == repr(("l6", str(l6 / "helpers.py")))
    r = in5("helpers.who(), helpers.__file__")
    assert _value(r) == repr(("l5 v2", str(l5 / "helpers.py")))
    assert "reloaded helpers.py (changed on disk)" in r["notes"]


NODE = "class Node:\n    def __init__(self, v, nxt=None):\n        self.v, self.nxt = v, nxt\n"


def test_an_edited_class_keeps_its_identity(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "cau_truc.py").write_text(NODE + "EMPTY = Node(None)\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("import cau_truc\nfrom cau_truc import Node\nhead = Node(1, Node(2))\nOld = Node")
    _bump(tmp / "cau_truc.py", NODE + "    def __len__(self):\n"
                                     "        return 1 + (len(self.nxt) if isinstance(self.nxt, Node) else 0)\n"
                                     "EMPTY = Node(None)\nNut = Node\nROOTS = [Node(1)]\n")
    r = run("len(head), isinstance(head, Node), isinstance(head.nxt, Node), Node is Old, "
            "isinstance(cau_truc.EMPTY, Node), len(Node(5, head)), cau_truc.Nut is Node, "
            "type(cau_truc.ROOTS[0]) is Node")
    assert _value(r) == "(2, True, True, True, True, 3, True, True)"
    assert r["notes"] == ["reloaded cau_truc.py (changed on disk)"]


def test_super_and_removed_methods_follow_an_edit(folder_kernel):
    k, tmp = folder_kernel
    src = ("class Base:\n    def f(self):\n        return 1\n"
           "class Child(Base):\n    def f(self):\n        return super().f() + {}\n{}")
    (tmp / "fam.py").write_text(src.format(10, "    def extra(self):\n        return 0\n"), encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("from fam import Base, Child\nc = Child()")
    _bump(tmp / "fam.py", src.format(20, ""))
    assert _value(run("c.f(), Child().f(), isinstance(c, Base), hasattr(c, 'extra')")) == "(21, 21, True, False)"


def test_a_class_whose_slots_change_becomes_a_new_class(folder_kernel):
    k, tmp = folder_kernel
    (tmp / "pt.py").write_text("class P:\n    __slots__ = ('x',)\n    def __init__(self, x):\n"
                               "        self.x = x\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("from pt import P\np = P(1)")
    _bump(tmp / "pt.py", "class P:\n    __slots__ = ('x', 'y')\n    def __init__(self, x):\n"
                         "        self.x, self.y = x, 2\n")
    assert _value(run("p.x, P(3).y, type(p) is P")) == "(1, 2, False)"


def test_the_analysis_sees_the_edited_helper(folder_kernel):
    # The reload runs before the safety analysis: a helper edited to train
    # is training on the first run after the save.
    k, tmp = folder_kernel
    (tmp / "hp.py").write_text("def run(m):\n    return 1\n", encoding="utf-8")
    run = lambda code: k.run(code, file=str(tmp / "main.py"), cwd=str(tmp))  # noqa: E731
    run("from hp import run\nclass M:\n    def fit(self, x):\n        return self\nm = M()")
    assert "analysis" not in run("run(m)")
    _bump(tmp / "hp.py", "def run(m):\n    m.fit([1])\n    return 2\n")
    r = run("run(m)")
    assert _value(r) == "2" and r["analysis"]["training"] is True, r


def test_libraries_and_vrun_itself_are_never_the_learners():
    key = reloader._key
    assert reloader._is_library(key(os.path.join(sys.prefix, "Lib", "site-packages", "x.py")))
    assert reloader._is_library(key(os.path.join("C:\\", "proj", ".venv", "Lib", "site-packages", "y.py")))
    assert reloader._is_library(key(reloader.__file__))
    assert reloader._is_library(key(os.__file__))
    assert not reloader._is_library(key(os.path.join("C:\\", "proj", "helpers.py")))


# -- item 11: built-in names do not leak between files ---------------------------
def test_builtins_rebound_by_another_file_are_removed(kernel, tmp_path):
    cf = str(tmp_path / "cf_1520A.py")
    k = kernel
    assert k.run("import sys\ninput = sys.stdin.readline\nmax = 0", file=cf)["status"] == "ok"
    # A later cell of the same file keeps them.
    assert _value(k.run("type(input).__name__, max", file=cf)) == "('method', 0)"
    r = k.run("max([1, 5, 2]), input is __builtins__['input']", file=str(tmp_path / "palindrome.py"))
    assert _value(r) == "(5, True)"
    assert r["notes"] == ["removed input = sys.stdin.readline, max = 0 left over from cf_1520A.py; "
                          "they hid the built-ins of the same names"]


def test_one_leftover_note_shows_the_value(kernel, tmp_path):
    kernel.run("sum = 10", file=str(tmp_path / "a.py"))
    r = kernel.run("sum([1, 2])", file=str(tmp_path / "b.py"))
    assert _value(r) == "3"
    assert r["notes"] == ["removed sum = 10 left over from a.py; it hid the built-in sum"]


def test_a_file_that_binds_the_name_itself_keeps_it(kernel, tmp_path):
    kernel.run("import sys\ninput = sys.stdin.readline", file=str(tmp_path / "a.py"))
    r = kernel.run("import sys\ninput = sys.stdin.readline\ntype(input).__name__", file=str(tmp_path / "b.py"))
    assert _value(r) == "'method'" and "notes" not in r


def test_star_import_leftovers_are_removed(kernel, tmp_path):
    kernel.run("from math import *", file=str(tmp_path / "a.py"))
    r = kernel.run("pow(2, 10, 1000)", file=str(tmp_path / "b.py"))
    assert _value(r) == "24"
    assert r["notes"] == ["removed pow = <function pow> left over from a.py; it hid the built-in pow"]


def test_live_runs_of_another_file_also_see_the_built_in(kernel, tmp_path):
    kernel.run("max = 0", file=str(tmp_path / "a.py"))
    r = kernel.call("execute", code="max([2, 7])", mode="live", timeoutMs=5000, file=str(tmp_path / "b.py"))["result"]
    assert r["value"]["repr"] == "7"
    assert r["notes"] == ["removed max = 0 left over from a.py; it hid the built-in max"]


def test_runs_without_a_file_label_keep_their_names(kernel):
    kernel.run("max = 3")
    assert _value(kernel.run("max")) == "3"


def test_match_patterns_bind_names():
    import ast

    from pylive_kernel import shadows
    tree = ast.parse("match x:\n    case [first, *list]:\n        pass\n    case {'k': 1, **dict}:\n        pass\n"
                     "    case str() as max:\n        pass\n")
    assert {"first", "list", "dict", "max"} <= shadows.top_level_bindings(tree.body)
