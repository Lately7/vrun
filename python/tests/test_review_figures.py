"""Regression tests for the figure, plotly, magics and import-hint review findings."""

from __future__ import annotations

import base64
import glob
import hashlib
import os
import shutil
import subprocess
import sys
from typing import Any

import pytest

from conftest import KernelProc
from pylive_kernel import executor, magics


def _pngs(result: dict[str, Any]) -> list[bytes]:
    return [base64.b64decode(f["png"]) for f in result["figures"] if "png" in f]


# -- plt.pause() / show(block=False) live-update loops (33) ---------------------
FINAL_HASH = "import hashlib, pylive_kernel.executor as _ex\nprint('final', hashlib.sha256(_ex._png_of(fig)).hexdigest())\n"


@pytest.mark.parametrize("update", ["plt.pause(0.001)", "plt.show(block=False)", "plt.show()  # after plt.ion()"])
def test_live_update_loop_shows_the_final_frame(kernel, update):
    code = ("import matplotlib.pyplot as plt\n" + ("plt.ion()\n" if "ion" in update else "")
            + "fig, ax = plt.subplots()\nlosses = []\nfor epoch in range(20):\n"
            "    losses.append(1 / (epoch + 1))\n    ax.clear(); ax.set_title(f'epoch {epoch}'); ax.plot(losses)\n"
            f"    {update}\n" + FINAL_HASH + "plt.ioff()\n")
    r = kernel.run(code)
    assert r["status"] == "ok", r
    pngs = _pngs(r)
    assert len(pngs) == 1 and [f for f in r["figures"] if "png" not in f] == []
    final = kernel.stream_text().split("final ")[1].split()[0]
    assert hashlib.sha256(pngs[0]).hexdigest() == final  # the last frame, not the first


def test_figure_closed_after_a_pause_is_still_shown_once(kernel):
    code = ("import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nfor i in range(3):\n"
            "    ax.plot([0, i])\n    plt.pause(0.001)\n" + FINAL_HASH + "plt.close(fig)\n")
    r = kernel.run(code)
    pngs = _pngs(r)
    assert len(pngs) == 1
    assert hashlib.sha256(pngs[0]).hexdigest() == kernel.stream_text().split("final ")[1].split()[0]
    # A blocking show after a pause loop draws the figure once, not twice.
    r = kernel.run("fig, ax = plt.subplots()\nfor i in range(3):\n    ax.plot([0, i])\n    plt.pause(0.001)\nplt.show()")
    assert len(_pngs(r)) == 1


def test_pause_does_not_change_the_current_figure(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\na = plt.figure()\nb = plt.figure()\nplt.pause(0.001)\n"
                   "plt.gcf() is b")
    assert r["value"]["repr"] == "True"


def test_a_new_figure_per_pause_is_counted_once_over_the_limit(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nfor i in range(10):\n    plt.figure()\n    plt.plot([i])\n"
                   "    plt.pause(0.001)")
    assert len(_pngs(r)) == 8
    assert "2 more figures not shown" in r["figures"][-1]["error"]


def test_blocking_show_in_a_loop_still_gives_one_figure_each(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nfor j in range(3):\n    plt.hist([j, j + 1])\n    plt.show()")
    assert len(_pngs(r)) == 3


# -- values of plotting calls (42, 43) -------------------------------------------
def test_matplotlib_values_that_are_not_plots_are_shown(kernel):
    kernel.run("import matplotlib, matplotlib.pyplot as plt, matplotlib.colors as mc")
    for code in ("matplotlib.rcParams", "plt.get_cmap('viridis')", "mc.Normalize(0, 1)"):
        r = kernel.run(code)
        assert r["status"] == "ok" and "value" in r, code


def test_plot_call_results_stay_hidden(kernel):
    kernel.run("import matplotlib.pyplot as plt")
    for code in ("plt.plot([1, 2])", "plt.xlabel('x')", "plt.gca()", "plt.bar([1, 2], [3, 4])",
                 "plt.colorbar(plt.imshow([[1, 2], [3, 4]]))", "plt.subplots()", "plt.legend(['a'])"):
        r = kernel.run(code)
        assert r["status"] == "ok" and "value" not in r, (code, r.get("value"))
        assert len(_pngs(r)) == 1, code


def test_subfigure_value_draws_its_figure_without_an_error(kernel):
    r = kernel.run("import matplotlib.pyplot as plt\nfig = plt.figure()\nsf = fig.subfigures(1, 2)\n"
                   "sf[0].subplots().plot([1, 2])\nsf[0]")
    assert r["status"] == "ok" and "value" not in r
    assert len(_pngs(r)) == 1 and all("png" in f for f in r["figures"])


# -- magics (35, 38, 41) ---------------------------------------------------------
@pytest.mark.parametrize("inner", ["%time python train.py\n%matplotlib inline", "![loss curve](loss.png)",
                                   "%(name)s scored", "!run me"])
def test_magic_like_lines_inside_strings_are_text(inner):
    code = f'%matplotlib inline\nusage = """\n{inner}\n"""\nprint(usage)'
    out, notes = magics.rewrite(code)
    ns: dict[str, Any] = {}
    compile(out, "<t>", "exec")
    exec(compile(out.replace("print(usage)", "pass"), "<t>", "exec"), ns)
    assert ns["usage"] == f"\n{inner}\n"
    assert notes == ["line 1: '%matplotlib' ignored: figures are shown automatically"]


def test_an_unrelated_syntax_error_is_reported_as_it_is():
    code = 'def f():\n    """Usage:\n    !run me\n    """\n    return 1\nx = (1,\n'
    assert magics.rewrite(code) == (code, [])
    # The original error is kept when it is not on a magic line...
    code = "def f(:\n    pass\n%matplotlib inline\n"
    assert magics.rewrite(code) == (code, [])
    # ...and the next real one is reported when the parser stopped at a magic.
    out, _ = magics.rewrite("%matplotlib inline\nx = 1 +\n")
    with pytest.raises(SyntaxError) as e:
        compile(out, "<t>", "exec")
    assert e.value.lineno == 2


def test_hash_and_brackets_inside_strings_do_not_hide_a_magic():
    for code in ('import math\nlabel = dict(color="#1f77b4")\n%timeit math.sqrt(2)\n',
                 'print("#" * 30, "(")\n%timeit 1 + 1\n'):
        out, _ = magics.rewrite(code)
        assert magics.TIMEIT_NAME in out and out.count("\n") == code.count("\n")
    with pytest.raises(magics.MagicError) as e:
        magics.rewrite('print("#" * 30)\n!pip install xgboost\n')
    assert e.value.line == 2 and "pip install xgboost" in str(e.value)
    # A continuation is still not a magic.
    assert magics.rewrite("x = (1\n% 2)") == ("x = (1\n% 2)", [])
    assert magics.rewrite("x = 7 \\\n% 2")[0] == "x = 7 \\\n% 2"


def test_bare_line_magic_with_crlf_line_ends():
    out, notes = magics.rewrite("%matplotlib\r\nimport math\r\nx = math.sqrt(4)\r\n")
    assert out == "pass\r\nimport math\r\nx = math.sqrt(4)\r\n" and notes


def test_writefile_writes_the_cell_body_and_does_not_run_it(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    cell = ('# %% write the training script\n%%writefile train_job.py\nimport os\n'
            'def main():\n    raise SystemExit("ran in the kernel")\nif __name__ == "__main__":\n    main()\n\n')
    out, notes = magics.rewrite(cell)
    assert out.count("\n") == cell.count("\n") and notes == []
    exec(compile(out, "<t>", "exec"), {"__name__": "__main__"})
    body = cell.split("train_job.py\n", 1)[1].rstrip("\n") + "\n"
    assert (tmp_path / "train_job.py").read_text(encoding="utf-8") == body
    assert capsys.readouterr().out == "Writing train_job.py\n"
    exec(compile(magics.rewrite(cell)[0], "<t>", "exec"), {})
    assert capsys.readouterr().out == "Overwriting train_job.py\n"
    out, _ = magics.rewrite("%%writefile -a 'train_job.py'\r\nprint('more')\r\n")
    exec(compile(out, "<t>", "exec"), {})
    assert capsys.readouterr().out == "Appending to train_job.py\n"
    assert (tmp_path / "train_job.py").read_text(encoding="utf-8") == body + "print('more')\n"


def test_writefile_body_ends_at_the_next_cell():
    code = "# %%\n%%writefile a.txt\nhello\n# %% next cell\nx = 1\n"
    out, _ = magics.rewrite(code)
    lines = out.split("\n")
    assert "'hello\\n'" in lines[1] and lines[2] == "" and lines[4] == "x = 1"


def test_cell_magics_that_cannot_run_are_errors_and_their_body_never_runs():
    for code, line in (("%%bash\nls -la\n", 1), ("%%html\n<b>hi</b>\n", 1), ("x = 1\n%%time\ny = 2\n", 2),
                       ("%%writefile\nx\n", 1), ("%%writefile -q f.py\nx\n", 1)):
        with pytest.raises(magics.MagicError) as e:
            magics.rewrite(code)
        assert e.value.line == line, code
    out, notes = magics.rewrite("# %% timing\n%%time\nx = sum(range(10))\n")
    assert out.split("\n")[1] == "pass" and "x = sum" in out and notes


def test_writefile_in_the_kernel_and_not_in_live_mode(tmp_path):
    k = KernelProc(cwd=str(tmp_path))
    try:
        cell = "%%writefile job.py\nprint('RAN IN THE KERNEL')\n"
        r = k.call("execute", code=cell, mode="live", timeoutMs=5000)["result"]
        assert r["status"] == "blocked" and not (tmp_path / "job.py").exists()
        r = k.run(cell, file=str(tmp_path / "nb.py"))
        assert r["status"] == "ok", r
        assert (tmp_path / "job.py").read_text(encoding="utf-8") == "print('RAN IN THE KERNEL')\n"
        out = k.stream_text()
        assert "Writing job.py" in out and "RAN IN THE KERNEL" not in out
        r = k.run("%matplotlib\r\nimport math\r\nx = math.sqrt(4)\r\n", file=str(tmp_path / "crlf.py"))
        assert r["status"] == "ok" and r["notes"]
    finally:
        k.close()


# -- ModuleNotFoundError hint (39) -----------------------------------------------
def test_missing_sibling_module_is_not_sent_to_pip(kernel, tmp_path):
    week = tmp_path / "week4"
    week.mkdir()
    (week / "my_data_utils.py").write_text("X = 1\n")
    script = week / "train.py"
    script.write_text("import my_data_utils\n")
    r = kernel.run("import my_data_utils\n", file=str(script))
    hint = r["error"]["hint"]
    assert "sys.path.insert(0, " in hint and str(week) in hint and "pip" not in hint


@pytest.mark.parametrize("name,pip", [("sklearn", "scikit-learn"), ("cv2", "opencv-python"), ("PIL", "pillow"),
                                      ("yaml", "pyyaml"), ("bs4", "beautifulsoup4")])
def test_known_import_names_map_to_their_pip_names(name, pip):
    hint = executor.error_hint("ModuleNotFoundError", "", ModuleNotFoundError(name, name=name), [])
    assert hint is not None and hint.endswith(f"-m pip install {pip} - then restart the kernel.")


def test_unknown_missing_module_is_worded_as_a_pypi_guess():
    hint = executor.error_hint("ModuleNotFoundError", "", ModuleNotFoundError("x", name="notapackage123"), [])
    assert hint is not None and "If it is a package from PyPI" in hint and "-m pip install notapackage123" in hint


# -- plotly files (29, 36, 37, 40) -----------------------------------------------
FAKE_JS = "/* fake plotly.js */" + "x" * 1000

FAKE_PLOTLY = {
    "plotly/__init__.py": "",
    "plotly/io/__init__.py": (
        "from ._base_renderers import ExternalRenderer\n"
        "class _Renderers(dict):\n    default = 'browser'\n"
        "renderers = _Renderers()\n"
        "def to_html(fig, include_plotlyjs=True, full_html=True):\n"
        "    from plotly.offline import get_plotlyjs\n"
        "    if isinstance(include_plotlyjs, str):\n"
        "        return '<script src=\"%s\"></script><div>figure</div>' % include_plotlyjs\n"
        "    return '<script>' + get_plotlyjs() + '</script><div>figure</div>'\n"),
    "plotly/io/_base_renderers.py": "class ExternalRenderer:\n    pass\n",
    "plotly/offline.py": f"def get_plotlyjs():\n    return {FAKE_JS!r}\ndef get_plotlyjs_version():\n    return '9.9.9'\n",
}


@pytest.fixture()
def fake_plotly(tmp_path, monkeypatch):
    if any(m == "plotly" or m.startswith("plotly.") for m in sys.modules):
        pytest.skip("a real plotly is already imported")
    root = tmp_path / "fakepkgs"
    for rel, text in FAKE_PLOTLY.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    monkeypatch.syspath_prepend(str(root))
    monkeypatch.setattr(executor, "_plotly_ready", False)
    monkeypatch.setattr(executor, "_plotly_files", [])
    monkeypatch.setattr(executor, "_plotly_bundles", {})
    executor.reset_figures()
    yield tmp_path / "figs"
    executor.reset_figures()
    for m in [m for m in sys.modules if m == "plotly" or m.startswith("plotly.")]:
        del sys.modules[m]


def _show(title: str = "t") -> None:
    pio = sys.modules["plotly.io"]
    pio.renderers[pio.renderers.default].render({"data": [{"type": "bar"}], "layout": {"title": {"text": title}}})


def test_prepare_plotly_is_a_no_op_until_plotly_is_imported(fake_plotly):
    executor.prepare_plotly(str(fake_plotly))
    assert executor._plotly_ready is False and "plotly.io" not in sys.modules


def test_plotly_without_plotly_io_gets_the_vrun_renderer(fake_plotly):
    import plotly  # noqa: F401 - like `import plotly.graph_objects`: plotly.io not loaded yet

    assert "plotly.io" not in sys.modules
    executor.prepare_plotly(str(fake_plotly))
    assert sys.modules["plotly.io"].renderers.default == "vrun"


def test_plotly_figures_share_one_bundle_and_old_files_are_removed(fake_plotly):
    import plotly  # noqa: F401

    executor.prepare_plotly(str(fake_plotly))
    paths = []
    for run in range(6):
        for n in range(8):
            _show(f"run {run} figure {n}")
        figures = executor.capture_figures()
        assert [f["title"] for f in figures] == [f"run {run} figure {n}" for n in range(8)]
        paths += [f["html"] for f in figures]
    html_files = glob.glob(os.path.join(str(fake_plotly), "*.html"))
    assert len(html_files) == executor.MAX_PLOTLY_FILES
    assert all(os.path.exists(p) for p in paths[-executor.MAX_PLOTLY_FILES:])
    assert not any(os.path.exists(p) for p in paths[:-executor.MAX_PLOTLY_FILES])
    assert os.listdir(str(fake_plotly)).count("plotly-9.9.9.min.js") == 1
    with open(os.path.join(str(fake_plotly), "plotly-9.9.9.min.js"), encoding="utf-8") as fh:
        assert fh.read() == FAKE_JS
    with open(paths[-1], encoding="utf-8") as fh:
        page = fh.read()
    assert 'src="plotly-9.9.9.min.js"' in page and FAKE_JS not in page


def test_plotly_figures_over_the_limit_write_no_file(fake_plotly):
    import plotly  # noqa: F401

    executor.prepare_plotly(str(fake_plotly))
    for n in range(10):
        _show(str(n))
    figures = executor.capture_figures()
    assert len([f for f in figures if "html" in f]) == 8
    assert "2 more figures not shown" in figures[-1]["error"]
    assert len(glob.glob(os.path.join(str(fake_plotly), "*.html"))) == 8


def test_plotly_files_never_follow_a_planted_file_or_link(fake_plotly, tmp_path):
    import plotly  # noqa: F401

    fake_plotly.mkdir()
    victim = tmp_path / "victim.txt"
    victim.write_text("keep me")
    bundle = fake_plotly / "plotly-9.9.9.min.js"
    try:
        os.symlink(victim, bundle)
    except (OSError, NotImplementedError):
        bundle.write_text("planted")  # Windows without symlink rights: a wrong file
    executor.prepare_plotly(str(fake_plotly))
    _show()
    figures = executor.capture_figures()
    assert "html" in figures[0], figures
    assert victim.read_text() == "keep me"
    assert not bundle.is_symlink() and bundle.read_text(encoding="utf-8") == FAKE_JS


def _python_with_plotly() -> str | None:
    for py in (os.environ.get("PYLIVE_PLOTLY_PYTHON"), sys.executable):
        if py and subprocess.run([py, "-c", "import plotly"], capture_output=True).returncode == 0:
            return py
    return None


def test_real_plotly_graph_objects_first_show(tmp_path, monkeypatch):
    py = _python_with_plotly()
    if py is None:
        pytest.skip("no interpreter with plotly (set PYLIVE_PLOTLY_PYTHON)")
    monkeypatch.setattr(sys, "executable", py)  # KernelProc starts sys.executable
    k = KernelProc(cwd=str(tmp_path))
    page = ""
    try:
        # Fails the test instead of opening a browser tab.
        k.run("import webbrowser\ndef _no(*a, **k):\n    raise AssertionError('browser opened')\n"
              "webbrowser.open = webbrowser.open_new = webbrowser.open_new_tab = _no\n"
              "webbrowser.get = lambda *a, **k: (_ for _ in ()).throw(AssertionError('browser opened'))")
        r = k.run("import plotly.graph_objects as go\nfig = go.Figure(go.Scatter(x=[1, 2], y=[3, 4]))\nfig.show()")
        assert r["status"] == "ok", r
        assert [f.get("title") for f in r["figures"]] == ["plotly figure: scatter"]
        page = r["figures"][0]["html"]
        assert os.path.getsize(page) < 200_000
        bundles = glob.glob(os.path.join(os.path.dirname(page), "plotly-*.min.js"))
        assert len(bundles) == 1 and os.path.getsize(bundles[0]) > 1_000_000
        with open(page, encoding="utf-8") as fh:
            assert f'src="{os.path.basename(bundles[0])}"' in fh.read()
    finally:
        k.close()
        if page:
            shutil.rmtree(os.path.dirname(page), ignore_errors=True)  # normally removed by the kernel
