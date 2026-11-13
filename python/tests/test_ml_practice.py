"""ML practice workflows: worker processes, training output, figures, Live
Mode on ML files, notebook habits and the inspection of ML objects."""

from __future__ import annotations

import os
import time

import psutil
import pytest

from conftest import KernelProc
from pylive_kernel import images, magics, outbuf, safety, series


def _gone(pid: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            p = psutil.Process(pid)
            if p.status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        time.sleep(0.1)
    return False


def _streams(kernel: KernelProc) -> list[tuple[str, str]]:
    with kernel.cv:
        return [(e["name"], e["text"]) for e in kernel.events if e.get("event") == "stream"]


# -- processes -----------------------------------------------------------------
@pytest.mark.parametrize("how", ["shutdown", "stdin_eof"])
def test_processes_started_by_user_code_end_with_the_kernel(how: str) -> None:
    # n_jobs=-1 / DataLoader workers used to outlive Stop and Restart.
    k = KernelProc(new_session=True)
    child = None
    try:
        r = k.run("import subprocess, sys\n"
                  "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                  "p.pid")
        child = int(r["value"]["repr"])
        assert psutil.pid_exists(child)
        if how == "shutdown":
            k.send("shutdown")
        else:
            assert k.proc.stdin
            k.proc.stdin.close()
        k.proc.wait(10)
        assert _gone(child), "worker process survived the kernel"
    finally:
        k.close()
        if child is not None:
            try:
                psutil.Process(child).kill()
            except Exception:  # noqa: BLE001
                pass


# -- output ------------------------------------------------------------------
def test_stdout_and_stderr_keep_their_order(kernel):
    kernel.run("import sys\nfor i in range(3):\n    print('out', i)\n    sys.stderr.write(f'err {i}\\n')")
    text = "".join(t for _, t in _streams(kernel))
    assert text.index("out 0") < text.index("err 0") < text.index("out 1") < text.index("err 1") < text.index("out 2")


def test_progress_frames_collapse_and_streams_look_like_a_terminal(kernel):
    r = kernel.run("import sys, time\n"
                   "for i in range(300):\n"
                   "    sys.stderr.write(f'\\r{i:3d}/300 [' + '#' * (i // 30) + ']')\n"
                   "    sys.stderr.flush()\n"
                   "sys.stderr.write('\\n')\n"
                   "sys.stdout.isatty()")
    assert r["value"]["repr"] == "True"  # Keras / tqdm then redraw in place
    text = "".join(t for n, t in _streams(kernel) if n == "stderr")
    assert len(text) < 2000, len(text)  # 300 frames of ~20 chars collapsed
    assert "299/300" in text


def test_collapse_carriage_returns_matches_terminal_overlay():
    c = outbuf.collapse_carriage_returns
    assert c("a\r10%\r20%\r30%|xx\n") == "a\r30%|xx\n"
    assert c("p\rlong frame\rshort\r") == "p\rshortframe\r"
    assert c("x\r\ny\r\n") == "x\r\ny\r\n"
    assert c("\x1b[1m\r1\r2\r3") == "\x1b[1m\r1\r2\r3"  # escape codes: left alone


def test_end_of_a_long_training_log_is_kept(kernel):
    r = kernel.run("for i in range(150000):\n    print('step', i, 'loss', 1 / (i + 1))\nprint('FINAL TEST ACCURACY 0.97')")
    text = "".join(t for _, t in _streams(kernel))
    assert r["outputTruncated"] is True
    assert "[vrun: output truncated]" in text and "FINAL TEST ACCURACY 0.97" in text
    assert len(text.encode()) <= 2 * 1024 * 1024 + 1000


def test_warnings_come_back_on_rerun_and_repeats_are_folded(kernel):
    code = "import warnings\nwarnings.warn('check your data')"
    kernel.run(code)
    kernel.events.clear()
    kernel.run(code)
    assert "check your data" in kernel.stream_text("stderr")
    kernel.events.clear()
    kernel.run("import warnings\nfor i in range(5):\n    with warnings.catch_warnings():\n"
               "        warnings.simplefilter('default')\n        warnings.warn('lbfgs failed to converge')")
    err = kernel.stream_text("stderr")
    assert err.count("UserWarning: lbfgs failed") == 1
    assert "repeated 4 more times" in err


# -- figures -------------------------------------------------------------------
def test_plt_show_in_a_loop_gives_one_figure_each(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nfor j in range(3):\n    plt.plot([0, j])\n    plt.title(f'feature {j}')\n    plt.show()")
    assert len([f for f in r["figures"] if "png" in f]) == 3


def test_plot_return_values_are_hidden_and_figures_are_drawn(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])")
    assert "value" not in r and len(r["figures"]) == 1
    r = kernel.run("fig, ax = plt.subplots()\nax.bar([1, 2], [3, 4])\nfig")
    assert "value" not in r and len([f for f in r["figures"] if "png" in f]) == 1
    r = kernel.run("41 + 1;")
    assert "value" not in r


def test_figures_beyond_the_limit_are_reported(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nfor i in range(10):\n    plt.figure()\n    plt.plot([i])")
    assert len([f for f in r["figures"] if "png" in f]) == 8
    assert "2 more figures not shown" in r["figures"][-1]["error"]


def test_multiline_text_results_are_shown_as_text(kernel):
    r = kernel.run("from sklearn.metrics import classification_report\nclassification_report([0, 1, 1], [0, 1, 0])")
    assert r["value"]["text"] is True and r["value"]["repr"].lstrip().startswith("precision")


def test_wide_dataframe_result_is_not_cut_mid_row(kernel):
    r = kernel.run("import pandas as pd, numpy as np\npd.DataFrame(np.ones((30, 31))).corr()")
    assert "…" not in r["value"]["repr"] and r["value"]["repr"].count("\n") >= 30


# -- Live Mode and Safe ML ---------------------------------------------------
def test_safety_sees_chained_and_hidden_training():
    for code in ("rf = RandomForestClassifier(n_estimators=300).fit(X, y)",
                 "model = make_pipeline(StandardScaler(), SVC()).fit(X, y)",
                 "labels = KMeans(3).fit_predict(X)", "models['rf'].fit(X, y)",
                 "opt.apply_gradients(zip(g, w))", "w.assign_sub(lr * g)",
                 "def train_epoch():\n    loss.backward()\nfor e in range(3):\n    train_epoch()"):
        assert safety.analyze_source(code)["training"], code
    for code in ("Xs = StandardScaler().fit_transform(X)", "sc = StandardScaler()\nXs = sc.fit_transform(X)",
                 "import torch\nt = torch.ones(3)", "def train_epoch():\n    loss.backward()",
                 "class LR:\n    def fit(self, X, y):\n        return self"):
        assert safety.analyze_source(code)["liveSafe"], code
    # model.train() is a mode switch only for a known torch module.
    assert safety.analyze_source("model.train()", torch_modules=frozenset({"model"}))["liveSafe"]
    assert safety.analyze_source("trainer = Trainer(model=m)\ntrainer.train()")["training"]
    for code in ("df.dropna().to_csv('out.csv')", "Path('a.txt').unlink()"):
        assert not safety.analyze_source(code)["liveSafe"], code


def test_code_risk_reads_names_of_earlier_helpers():
    def train(net, opt):
        net().backward()

    def prep(x):
        return StandardScaler().fit_transform(x)  # noqa: F821

    def train_model(X, y):
        Xs = StandardScaler().fit_transform(X)  # noqa: F821
        return LogisticRegression().fit(Xs, y)  # noqa: F821

    assert safety.code_risk(train.__code__)[0] == "training"
    assert safety.code_risk(prep.__code__) is None
    # A scaler next to .fit does not make the helper cheap.
    assert safety.code_risk(train_model.__code__)[0] == "training"


def test_live_runs_the_safe_prefix_and_reports_the_document_line(kernel):
    code = "x = 2\nprint('before', x)\nfrom sklearn.svm import SVC\nm = SVC().fit([[0], [1]], [0, 1])\nprint('after')"
    r = kernel.call("execute", code=code, mode="live", timeoutMs=5000, lineOffset=20)["result"]
    out = kernel.stream_text()
    assert r["status"] == "ok" and "before 2" in out and "after" not in out
    assert r["stoppedAt"]["line"] == 24 and r["stoppedAt"]["category"] == "training"
    assert "m" not in kernel.run("sorted(globals())")["value"]["repr"].split("'")[1::2]


def test_live_blocks_a_helper_defined_in_an_earlier_run(kernel):
    kernel.run("class Net:\n    def __call__(self):\n        return self\n    def backward(self):\n        pass\n"
               "net = Net()\ncount = 0\ndef train_epoch():\n    global count\n    count += 1\n    net().backward()")
    r = kernel.call("execute", code="for e in range(3):\n    train_epoch()", mode="live", timeoutMs=5000)["result"]
    assert r["status"] == "blocked" and "train_epoch" in r["stoppedAt"]["message"]
    assert kernel.run("count")["value"]["repr"] == "0"


def test_repeat_training_asks_only_after_a_slow_run(kernel):
    code = "from sklearn.linear_model import LogisticRegression\nclf = LogisticRegression().fit([[0], [1]], [0, 1])"
    assert kernel.run(code, confirmAfterMs=5000)["status"] == "ok"
    assert kernel.run(code, confirmAfterMs=5000)["status"] == "ok"  # it took milliseconds
    r = kernel.run(code, confirmAfterMs=0)
    assert r["status"] == "needs_confirmation" and r["lastElapsedMs"] >= 0


def test_interrupt_during_a_first_library_import_waits_for_it(tmp_path):
    (tmp_path / "slowlib.py").write_text("import time\ntime.sleep(1.5)\nREADY = True\n")
    k = KernelProc(cwd=str(tmp_path))
    try:
        k.run("import pylive_kernel.worker as w\nw.UNTEARABLE_IMPORTS.add('slowlib')")
        rid = k.send("execute", code="import slowlib\nimport time\ntime.sleep(10)")
        time.sleep(0.4)
        k.call("interrupt", timeout=5)
        r = k.wait(rid, 20)["result"]
        assert r["interrupted"] == "interrupted"
        assert k.run("slowlib.READY")["value"]["repr"] == "True"  # imported whole, not torn
    finally:
        k.close()


# -- notebook habits -------------------------------------------------------------
def test_magics_are_rewritten_or_explained():
    code, notes = magics.rewrite("%matplotlib inline\nimport numpy as np\n%timeit np.ones(3)\nx = 1")
    assert code.split("\n")[0] == "pass" and magics.TIMEIT_NAME in code and notes
    assert magics.rewrite("x = (1\n% 2)")[0] == "x = (1\n% 2)"  # valid Python is untouched
    with pytest.raises(magics.MagicError) as e:
        magics.rewrite("!pip install xgboost")
    assert "-m pip install xgboost" in str(e.value)


def test_timeit_display_and_pip_in_the_kernel(kernel):
    kernel.run("import numpy as np\na = np.arange(100)\n%timeit a.sum()")
    assert "per loop" in kernel.stream_text()
    r = kernel.run("!pip install xgboost")
    assert r["status"] == "error" and "-m pip install xgboost" in r["error"]["evalue"]
    kernel.events.clear()
    kernel.run("display({'accuracy': 0.9})")
    assert "accuracy" in kernel.stream_text()


def test_errors_carry_hints(kernel):
    r = kernel.run("import notapackage123")
    assert "-m pip install notapackage123" in r["error"]["hint"]
    r = kernel.run("raise RuntimeError('DataLoader worker (pid(s) 1) exited unexpectedly')")
    assert "num_workers=0" in r["error"]["hint"]


def test_saved_script_gets_dunder_file(kernel, tmp_path):
    script = tmp_path / "train.py"
    script.write_text("here = __file__\n")
    r = kernel.run("here = __file__\nhere", file=str(script))
    assert os.path.samefile(r["value"]["repr"].strip("'").replace("\\\\", "\\"), script)


# -- inspection of ML objects ------------------------------------------------------
def test_estimators_show_params_pipelines_and_numpy_grids(kernel):
    kernel.run("import numpy as np\nfrom sklearn.pipeline import make_pipeline\nfrom sklearn.preprocessing import StandardScaler\n"
               "from sklearn.svm import SVC\nfrom sklearn.model_selection import GridSearchCV\nfrom sklearn.neighbors import KNeighborsClassifier\n"
               "from sklearn.datasets import load_iris\nX, y = load_iris(return_X_y=True)\n"
               "pipe = make_pipeline(StandardScaler(), SVC(C=10)).fit(X, y)\n"
               "gs = GridSearchCV(KNeighborsClassifier(), {'n_neighbors': np.arange(1, 8, 2)}, cv=3).fit(X, y)\n"
               "iris = load_iris()")
    v = {x["name"]: x for x in kernel.call("variables.list")["result"]["variables"]}
    assert v["pipe"]["fitted"] is True and [s[1] for s in v["pipe"]["steps"]] == ["StandardScaler", "SVC"]
    assert v["gs"]["facts"]["best_params_"]["n_neighbors"] in (1, 3, 5, 7)
    assert v["iris"]["kind"] == "dict"  # sklearn Bunch


def test_sparse_matrices_and_arrays_as_tables(kernel):
    kernel.run("import numpy as np, scipy.sparse as sp, pandas as pd\nS = sp.random(100, 50, density=0.05, format='csr')\nX = np.ones((20, 3))")
    v = {x["name"]: x for x in kernel.call("variables.list")["result"]["variables"]}
    assert v["S"]["kind"] == "sparse" and v["S"]["nnz"] == 250 and v["S"]["format"] == "csr"
    assert v["X"]["table"] is True
    meta = kernel.call("dataframe.metadata", name="X")
    assert meta["ok"] and meta["result"]["shape"] == [20, 3]


def test_training_histories_are_charted(kernel):
    kernel.run("history = {'loss': [1.0, 0.6, 0.4], 'val_loss': [1.1, 0.8, 0.7]}\nlosses = [1 / (i + 1) for i in range(5000)]")
    v = {x["name"]: x for x in kernel.call("variables.list")["result"]["variables"]}
    assert v["history"]["viz"] == "series" and v["history"]["chart"] is True  # not a graph of floats
    s = kernel.call("variables.series", name="history", maxPoints=100)["result"]
    assert [x["name"] for x in s["series"]] == ["loss", "val_loss"]
    s = kernel.call("variables.series", name="losses", maxPoints=100)["result"]
    assert s["downsampled"] and s["series"][0]["len"] == 5000 and len(s["series"][0]["y"]) <= 100


def test_image_arrays_get_previews(kernel):
    kernel.run("from sklearn.datasets import load_digits\nd = load_digits()\nimgs = d.images\nflat = d.data")
    v = {x["name"]: x for x in kernel.call("variables.list")["result"]["variables"]}
    assert v["imgs"]["image"] == {"count": 1797, "layout": "hw"}
    assert v["flat"]["image"]["layout"] == "flat"
    r = kernel.call("variables.image", name="imgs", start=16, count=16)["result"]
    assert r["shown"] == 16 and r["start"] == 16 and r["tile"] == [8, 8] and r["png"]


def test_png_encoder_and_layout_guess():
    np = pytest.importorskip("numpy")
    out = images.preview(np.zeros((4, 3, 16, 16), dtype=np.float32))
    assert out["layout"] == "chw" and out["channels"] == 3 and out["shown"] == 4
    assert images.image_layout((5,)) is None
    xs, ys = series._downsample([float(i % 7) for i in range(1000)], 100)
    assert len(ys) <= 100 and max(y for y in ys if y is not None) == 6.0  # peaks survive


def test_torch_objects_are_described(kernel):
    probe = kernel.run("import importlib.util\nimportlib.util.find_spec('torch') is not None")
    if probe["value"]["repr"] != "True":
        pytest.skip("torch is not installed in the test interpreter")
    kernel.run("import torch\nfrom torch import nn\nnet = nn.Sequential(nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 10))\n"
               "opt = torch.optim.Adam(net.parameters(), lr=1e-3)\nloss = net(torch.ones(2, 64)).sum()\nbatch = torch.rand(16, 1, 28, 28)")
    v = {x["name"]: x for x in kernel.call("variables.list")["result"]["variables"]}
    assert v["net"]["kind"] == "model" and v["net"]["paramCount"] == 64 * 32 + 32 + 32 * 10 + 10
    assert v["opt"]["kind"] == "optimizer" and v["opt"]["params"]["lr"] == 0.001
    assert v["loss"]["kind"] == "tensor" and v["loss"]["hasGradFn"] is True and "value" in v["loss"]
    assert v["batch"]["image"] == {"count": 16, "layout": "chw"}
