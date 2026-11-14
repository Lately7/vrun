"""P1 error messages and hints (track A1): Python's own suggestion, file paths,
text encodings, off-by-one indexes, edited modules and shadowed built-ins."""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import types

import pytest

from conftest import PY_DIR, KernelProc
from pylive_kernel import executor, magics

REPO = os.path.dirname(PY_DIR)
CELL = "<p1-hint-cell>"


def fail(code: str, ns: dict | None = None, filename: str = CELL) -> dict:
    """format_exception() of `code` run in-process, as the worker runs a cell."""
    executor.register_source(filename, code, 0)
    scope = {"__builtins__": __builtins__, **(ns or {})}
    try:
        exec(compile(code, filename, "exec"), scope)
    except Exception as exc:  # noqa: BLE001
        return executor.format_exception(exc, {filename})
    raise AssertionError("the code did not fail")


# -- 0. Python's "Did you mean ...?" is kept -----------------------------------
@pytest.mark.parametrize("code,ename,message", [
    ("pirnt('xin chao')", "NameError", "name 'pirnt' is not defined. Did you mean: 'print'?"),
    ("trung_binh = 8.5\nprint(trung_bnh)", "NameError",
     "name 'trung_bnh' is not defined. Did you mean: 'trung_binh'?"),
    ("import math\nmath.sqr(4)", "AttributeError", "module 'math' has no attribute 'sqr'. Did you mean: 'sqrt'?"),
    ("ds = [1, 2]\nds.apend(3)", "AttributeError",
     "'list' object has no attribute 'apend'. Did you mean: 'append'?"),
])
def test_error_summary_keeps_pythons_suggestion(kernel, tmp_path, code, ename, message):
    r = kernel.run(code, file=str(tmp_path / "bai.py"))
    assert r["error"]["ename"] == ename
    assert r["error"]["evalue"] == message  # what the Output summary, inline note and Problems show


def test_notes_and_multiline_messages_are_not_glued_on():
    e = fail("e = ValueError('bad value')\ne.add_note('extra note')\nraise e")
    assert e["evalue"] == "bad value" and "extra note" in e["traceback"]
    assert fail("raise ValueError('line 1\\nline 2')")["evalue"] == "line 1\nline 2"
    assert fail("raise KeyError('toan')")["evalue"] == "'toan'"
    assert fail("raise ValueError()")["evalue"] == ""


def test_message_of_an_exception_whose_str_fails_is_unchanged():
    e = fail("class E(Exception):\n    def __str__(self):\n        raise RuntimeError('no')\nraise E()")
    assert e["evalue"] == "<unprintable exception>"


def test_runtime_syntax_error_message_is_unchanged():
    e = fail("compile('x = (', 'f', 'exec')")
    assert e["ename"] == "SyntaxError" and "\n" not in e["evalue"]


def test_error_column_counts_characters_not_utf8_bytes():
    # 'Điểm' is 4 characters but 8 UTF-8 bytes: the squiggle sat 4 columns too far right.
    e = fail("t = [1]; print('Điểm', t[5])")
    line = "t = [1]; print('Điểm', t[5])"
    assert e["userFrame"]["col"] == line.index("t[5]") + 1
    assert e["userFrame"]["endCol"] == line.index("t[5]") + len("t[5]") + 1


# -- 1. files next to the script, typos, Windows paths -------------------------
@pytest.fixture()
def lessons(tmp_path):
    bai1, bai2 = tmp_path / "bai1", tmp_path / "bai2"
    bai1.mkdir()
    bai2.mkdir()
    (bai2 / "data.csv").write_text("ten,diem\nAn,8\n", encoding="utf-8")
    k = KernelProc(cwd=str(bai1))  # started while lesson 1 was the active file
    yield k, bai1, bai2
    k.close()


def test_file_next_to_the_script_explains_the_working_folder(lessons):
    k, bai1, bai2 = lessons
    r = k.run("f = open('data.csv')", file=str(bai2 / "bai2.py"))
    hint = r["error"]["hint"]
    assert f"'data.csv' is in {bai2}, next to your script" in hint
    assert f"working folder is {bai1}" in hint
    assert "Path(__file__).parent / 'data.csv'" in hint


def test_misspelled_file_name_gets_close_names(lessons):
    k, bai1, bai2 = lessons
    (bai1 / "diem_lop.csv").write_text("x\n", encoding="utf-8")
    r = k.run("open('diem_lp.csv')", file=str(bai1 / "bai1.py"))
    assert "Did you mean 'diem_lop.csv'?" in r["error"]["hint"]
    assert "your script's folder" in r["error"]["hint"]
    # A close name in the script's folder, which is not the working folder, says where it is.
    r = k.run("open('dta.csv')", file=str(bai2 / "bai2.py"))
    assert f"'data.csv' (in {bai2})" in r["error"]["hint"]


def test_unknown_file_says_where_python_looked(lessons):
    k, bai1, _ = lessons
    r = k.run("open('khong_co_gi_giong.xyz')", file=str(bai1 / "bai1.py"))
    assert f"Relative paths start in the kernel's working folder, {bai1}" in r["error"]["hint"]


def test_absolute_path_typo_gets_close_names(tmp_path):
    (tmp_path / "scores.csv").write_text("x\n", encoding="utf-8")
    e = fail(f"open(r'{tmp_path / 'score.csv'}')")
    assert e["hint"] == f"There is no 'score.csv' in {tmp_path}. Did you mean 'scores.csv'?"


def test_backslash_escape_in_a_windows_path():
    e = fail("open('C:\\new\\tables.csv')")  # the cell holds 'C:\new\tables.csv': a newline and a tab
    assert e["hint"].startswith("The path contains \\n, \\t: in a normal string a backslash starts an escape")
    # The learner's own path back, as typed, not a fixed example.
    assert "r'C:\\new\\tables.csv'" in e["hint"] and "'C:/new/tables.csv'" in e["hint"]
    assert "r'bai\\test.csv', or with forward slashes, 'bai/test.csv'" in fail("open('bai\\test.csv')")["hint"]


def test_close_name_keeps_the_separator_the_learner_typed(tmp_path, monkeypatch):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "data.csv").write_text("x\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert "Did you mean 'data/data.csv'?" in fail("open('data/dta.csv')")["hint"]


def test_module_name_that_differs_only_in_case(tmp_path, monkeypatch):
    # Windows' isfile() finds hinh_hoc_p1.py for Hinh_hoc_p1.py; import does not.
    (tmp_path / "hinh_hoc_p1.py").write_text("X = 1\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    exc = ModuleNotFoundError("No module named 'Hinh_hoc_p1'", name="Hinh_hoc_p1")
    hint = executor.error_hint("ModuleNotFoundError", str(exc), exc, [str(tmp_path)])
    assert hint == (f"There is no module 'Hinh_hoc_p1', but {tmp_path} has hinh_hoc_p1.py: spell it hinh_hoc_p1 "
                    "in the import (module names are case-sensitive, even on Windows).")
    # The exact name in a folder on sys.path: the import cache had not seen it.
    exc = ModuleNotFoundError("No module named 'hinh_hoc_p1'", name="hinh_hoc_p1")
    assert "invalidate_caches()" in executor.error_hint("ModuleNotFoundError", str(exc), exc, [str(tmp_path)])


def test_pathlib_paths_are_explained_too(lessons):
    k, _, bai2 = lessons
    r = k.run("from pathlib import Path\nPath('data.csv').read_text()", file=str(bai2 / "bai2.py"))
    assert "next to your script" in r["error"]["hint"]


def test_module_hint_no_longer_blames_the_workspace_folder(kernel, tmp_path):
    week = tmp_path / "week4"
    week.mkdir()
    (week / "my_utils_p1.py").write_text("X = 1\n")
    r = kernel.run("import my_utils_p1\n", file=str(week / "train.py"))
    hint = r["error"]["hint"]
    assert "workspace" not in hint and "not on sys.path" in hint and str(week) in hint


# -- 2. UTF-8 files on Windows ------------------------------------------------
def test_kernel_client_starts_python_in_utf8_mode():
    with open(os.path.join(REPO, "src", "kernel", "kernelClient.ts"), encoding="utf-8") as fh:
        source = fh.read()
    env_block = source[source.index("const env: NodeJS.ProcessEnv"):source.index("const proc = spawn(")]
    assert re.search(r"PYTHONUTF8:\s*'1'", env_block)


def test_utf8_mode_kernel_reads_and_writes_vietnamese(monkeypatch, tmp_path):
    # As kernelClient.ts spawns it: PYTHONUTF8=1 added, whatever the parent had.
    monkeypatch.delenv("PYTHONUTF8", raising=False)
    monkeypatch.setenv("PYTHONUTF8", "1")
    (tmp_path / "danhsach.txt").write_text("Nguyễn Văn An,8.5\nÝ kiến,9\n", encoding="utf-8")
    k = KernelProc(cwd=str(tmp_path))
    try:
        code = ("import csv, json, sys\nfrom pathlib import Path\n"
                "with open('danhsach.txt') as f:\n    a = f.read()\n"
                "with open('danhsach.txt', newline='') as f:\n    b = list(csv.reader(f))\n"
                "with open('ketqua.json', 'w') as f:\n    json.dump({'tên': 'Bình'}, f, ensure_ascii=False)\n"
                "with open('ketqua.txt', 'w') as f:\n    f.write('Điểm trung bình: 8.25\\n')\n"
                "(sys.flags.utf8_mode, a == Path('danhsach.txt').read_text(), b[0][0])")
        r = k.run(code, file=str(tmp_path / "bai.py"))
        assert r["status"] == "ok", r
        assert r["value"]["repr"] == "(1, True, 'Nguyễn Văn An')"
        written = (tmp_path / "ketqua.txt").read_bytes().replace(b"\r\n", b"\n")  # text mode on Windows
        assert written == "Điểm trung bình: 8.25\n".encode("utf-8")
        assert (tmp_path / "ketqua.json").read_bytes() == '{"tên": "Bình"}'.encode("utf-8")
    finally:
        k.close()


def test_charmap_decode_error_suggests_utf8(tmp_path):
    path = tmp_path / "y_kien.txt"
    path.write_text("Ý kiến\n", encoding="utf-8")  # Ý is C3 9D; 0x9D has no cp1252 letter
    e = fail(f"open(r'{path}', encoding='cp1252').read()")
    assert e["ename"] == "UnicodeDecodeError"
    assert "encoding='utf-8'" in e["hint"] and "VS Code saves files as UTF-8" in e["hint"]


def test_charmap_encode_error_suggests_utf8(tmp_path):
    e = fail(f"with open(r'{tmp_path / 'out.txt'}', 'w', encoding='cp1252') as f:\n    f.write('Điểm')")
    assert "has no 'Đ'" in e["hint"] and "open(path, 'w', encoding='utf-8')" in e["hint"]


def _cp1258(text: str) -> bytes:
    """Bytes as Excel writes a CSV on Vietnamese Windows: base vowels precomposed, tone marks combining."""
    import unicodedata

    t = unicodedata.normalize("NFD", text)
    for a, b in (("o\u0302", "ô"), ("e\u0302", "ê"), ("a\u0302", "â"), ("a\u0306", "ă"),
                 ("o\u031b", "ơ"), ("u\u031b", "ư")):
        t = t.replace(a, b)
    return t.encode("cp1258")


def test_excel_ansi_csv_read_as_utf8_suggests_cp1258(tmp_path):
    path = tmp_path / "excel.csv"
    path.write_bytes(_cp1258("Họ tên,Điểm\nNguyễn Văn An,8\n"))
    e = fail(f"open(r'{path}', encoding='utf-8').read()")
    assert "This file is not UTF-8" in e["hint"] and "save it again in Excel as 'CSV UTF-8'" in e["hint"]
    assert "pd.read_csv(path, encoding='cp1258')" in e["hint"] and "normalize('NFC'" in e["hint"]
    # The advice works: cp1258 reads the names back (as decomposed text, hence the NFC note).
    import unicodedata

    assert unicodedata.normalize("NFC", path.read_bytes().decode("cp1258")).startswith("Họ tên,Điểm")


def test_non_vietnamese_ansi_file_read_as_utf8_suggests_the_code_page():
    data = "Café crème\n".encode("cp1252")
    exc = UnicodeDecodeError("utf-8", data, 3, 4, "invalid continuation byte")
    hint = executor.error_hint("UnicodeDecodeError", str(exc), exc)
    assert "Read it with encoding=" in hint and "'CSV UTF-8'" in hint


@pytest.mark.parametrize("text", ["cidade\nSão Paulo\nGoiânia\nCuritibã\n", "città,così\nperò,più\n",
                                  "Þórður,Guðrún\n"])
def test_western_ansi_file_is_not_called_vietnamese(text):
    # ã õ ð ý ì ò Ì Ò Þ are cp1258's ă ơ đ ư and tone marks: Vietnamese needs a tone mark after a vowel.
    data = text.encode("cp1252")
    exc = UnicodeDecodeError("utf-8", data, 0, 1, "invalid continuation byte")
    hint = executor.error_hint("UnicodeDecodeError", str(exc), exc)
    assert "Vietnamese" not in hint and "encoding='cp1252'" in hint


def test_charmap_label_does_not_guess_the_machines_code_page(tmp_path):
    # In UTF-8 mode a 'charmap' error comes from an encoding= in the code, maybe cp1258.
    e = fail(f"open(r'{tmp_path / 'o.txt'}', 'w', encoding='cp1258').write('\\U0001f600')")
    assert "a Windows code page ('charmap'" in e["hint"] and "Windows' cp" not in e["hint"]


@pytest.mark.parametrize("data,expected", [
    (b"\xff\xfeh\x00i\x00", "encoding='utf-16'"),
    (b"PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00\xb5", "pd.read_excel(path)"),
    (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\xff", "open(path, 'rb')"),
])
def test_utf8_decode_error_of_other_files(data, expected):
    exc = UnicodeDecodeError("utf-8", data, len(data) - 1, len(data), "invalid start byte")
    assert expected in executor.error_hint("UnicodeDecodeError", str(exc), exc)


# -- 8. off-by-one IndexError ---------------------------------------------------
BUBBLE = ("nums = [4, 2, 7, 1]\nn = len(nums)\nfor i in range(n):\n    for j in range(n - i):\n"
          "        if nums[j] > nums[j + 1]:\n            nums[j], nums[j + 1] = nums[j + 1], nums[j]\n")


def test_bubble_sort_off_by_one_names_the_subscript_and_the_loop(kernel, tmp_path):
    r = kernel.run(BUBBLE, file=str(tmp_path / "bubble.py"))
    assert r["error"]["hint"] == ("nums[j + 1]: j + 1 = 4 (j = 3), but len(nums) = 4 (valid indexes 0..3). "
                                  "'for j in range(n - i)' runs up to j = 3, so j + 1 = 4: use range(n - i - 1).")


@pytest.mark.parametrize("code,parts", [
    ("s = 'abba'\nfor i in range(len(s) + 1):\n    s[i]", ["s[i]: i = 4, but len(s) = 4", "use range(len(s))"]),
    ("a = [0] * 3\nfor i in range(1, 4):\n    a[i] = i", ["a[i]: i = 3, but len(a) = 3", "use range(1, len(a))"]),
    ("a = [1, 2, 3]\nn = 4\nfor i in range(n):\n    a[i]", ["'for i in range(n)' runs up to i = 3 (n = 4): use range(len(a))."]),
    ("g = [[1, 2, 3], [4, 5, 6]]\nfor i in range(3):\n    g[i][0]", ["runs up to i = 2: use range(len(g))."]),
    ("a, b = [1, 2, 3], [4, 5, 6]\nfor i in range(len(b)):\n    a[i + 1]", ["use range(len(b) - 1)"]),  # same length
    ("a = [1, 2, 3]\nd = [a[i] for i in range(4)]", ["'for i in range(4)' runs up to i = 3", "use range(len(a))"]),
    ("a = [1, 2, 3, 4]\nn = len(a)\na.pop()\nfor i in range(n):\n    a[i]",
     ["n = 4 was len(a) when it was set, but a has 3 items now"]),
    ("def f(a, i):\n    return a[i] + f(a, i + 1)\nf([1, 2], 0)",
     ["a[i]: i = 2, but len(a) = 2", "f() calls itself", "(e.g. if i == len(a): return ...)"]),
    ("i = 0\na = [1, 2]\nwhile i <= len(a):\n    a[i]\n    i += 1", ["use < instead of <="]),
    ("res = []\nres[0] = 5", ["res is empty, so it has no index 0", "res.append(value)"]),
    ("a = [1, 2, 3]\na[-5]", ["-3..-1 from the end", "-5 is before the start"]),
    ("a = []\nlast = a[-1]", ["a[-1]: a is empty, so it has no index -1."]),
    ("a = [1, 2, 3]\ni = 3\nprint(a[i])", ["a[i]: i = 3, but len(a) = 3 (valid indexes 0..2)", "one past"]),
    ("grid = [[1, 2], [3, 4]]\nr, c = 1, 2\ngrid[r][c]", ["grid[r][c]: c = 2, but len(grid[r]) = 2"]),
    ("def last(xs):\n    return xs[len(xs)]\nlast([1, 2])", ["xs[len(xs)]: len(xs) = 2 is one past", "xs[-1]"]),
    ("stack = []\nstack.pop()", ["stack.pop(): stack is empty here"]),
    ("import collections\nq = collections.deque()\nq.popleft()", ["q.popleft(): q is empty here"]),
    ("import heapq\nh = []\nheapq.heappop(h)", ["the heap h is empty here"]),
    ("class S:\n    def __init__(self):\n        self.data = [1]\n    def top(self):\n"
     "        return self.data[2]\nS().top()", ["self.data[2]: len(self.data) = 1 (only index 0 is valid)"]),
])
def test_index_error_hints(code, parts):
    hint = fail(code)["hint"]
    for part in parts:
        assert part in hint, hint


@pytest.mark.parametrize("code,expected", [
    # The range counts names, the failing subscript is scores: range(len(names) - 1) would drop 'Dung'.
    ("names = ['An', 'Binh', 'Chi', 'Dung']\nscores = [8, 9, 7]\nfor i in range(len(names)):\n"
     "    print(names[i], scores[i])",
     "scores[i]: i = 3, but len(scores) = 3 (valid indexes 0..2). 'for i in range(len(names))' runs up to i = 3. "
     "names and scores have different lengths (4 and 3), so a range over names runs past the end of scores. "
     "If they should match, check the data; zip(names, scores) pairs their items and stops at the shorter one."),
    ("names = ['An', 'Binh', 'Chi', 'Dung']\nscores = [8, 9, 7]\nn = len(names)\nfor i in range(n):\n"
     "    print(names[i], scores[i])",
     "scores[i]: i = 3, but len(scores) = 3 (valid indexes 0..2). 'for i in range(n)' runs up to i = 3 "
     "(n = len(names)). names and scores have different lengths (4 and 3), so a range over names runs past the "
     "end of scores. If they should match, check the data; zip(names, scores) pairs their items and stops at the "
     "shorter one."),
    ("g = [[1, 2, 3], [4, 5, 6]]\nfor i in range(len(g[0])):\n    g[i][0]",
     "g[i]: i = 2, but len(g) = 2 (valid indexes 0..1). 'for i in range(len(g[0]))' runs up to i = 2. "
     "len(g[0]) = 3 is the length of a row of g, but g has 2 rows: to go over the rows use range(len(g))."),
    ("g = [[1, 2], [3, 4], [5, 6]]\nfor i in range(2):\n    for j in range(len(g)):\n        g[i][j]",
     "g[i][j]: j = 2, but len(g[i]) = 2 (valid indexes 0..1). 'for j in range(len(g))' runs up to j = 2. "
     "len(g) = 3 counts the rows of g, but the row g[i] has 2 items: to go along a row use range(len(g[i]))."),
    ("a = [1, 2, 3]\nb = [1, 2, 3, 4]\nd = [a[i] for i in range(len(b))]",
     "a[i] in this list comprehension: 'for i in range(len(b))' runs up to i = 3, but len(a) = 3 (valid indexes "
     "0..2). b and a have different lengths (4 and 3), so a range over b runs past the end of a. If they should "
     "match, check the data; zip(b, a) pairs their items and stops at the shorter one."),
])
def test_range_of_another_sequence_is_not_shortened(code, expected):
    assert fail(code)["hint"] == expected


def test_index_hint_inside_the_learners_own_module(kernel, tmp_path):
    (tmp_path / "sapxep_p1.py").write_text(
        "def bubble(nums):\n    n = len(nums)\n    for i in range(n):\n        for j in range(n - i):\n"
        "            if nums[j] > nums[j + 1]:\n                nums[j], nums[j + 1] = nums[j + 1], nums[j]\n"
        "    return nums\n", encoding="utf-8")
    r = kernel.run(f"import sys\nsys.path.insert(0, {str(tmp_path)!r})\nfrom sapxep_p1 import bubble\n"
                   "bubble([4, 2, 7, 1])\n", file=str(tmp_path / "main.py"))
    assert r["error"]["hint"].startswith("nums[j + 1]: j + 1 = 4 (j = 3), but len(nums) = 4")
    assert "use range(n - i - 1)" in r["error"]["hint"]


def test_index_hint_runs_no_user_code():
    calls: list[str] = []
    code = ("class Box:\n    @property\n    def items(self):\n        calls.append('items')\n        return [1]\n"
            "class Idx:\n    def __index__(self):\n        calls.append('index')\n        return 7\n"
            "class L(list):\n    def __len__(self):\n        calls.append('len')\n        return 1\n"
            "b = Box()\nb.items[5]")
    assert fail(code, {"calls": calls}).get("hint") is None
    assert calls == ["items"]  # only the learner's own evaluation, never the hint's
    calls.clear()
    assert fail(code.replace("b.items[5]", "a = [1]\na[Idx()]"), {"calls": calls}).get("hint") is None
    assert calls == ["index"]
    calls.clear()
    assert fail(code.replace("b.items[5]", "x = L([1])\nx[3]"), {"calls": calls}).get("hint") is None
    assert calls == []


def test_index_hint_ignores_functions_from_an_earlier_cell(kernel, tmp_path):
    f = str(tmp_path / "cells.py")
    assert kernel.run("def last(xs):\n    return xs[len(xs)]\n", file=f)["status"] == "ok"
    r = kernel.run("x = [1, 2]\nlast(x)\n", file=f)  # linecache now holds this cell at those lines
    assert r["error"]["ename"] == "IndexError" and "hint" not in r["error"]


def test_numpy_index_error_keeps_its_own_message():
    np = pytest.importorskip("numpy")
    e = fail("a = np.arange(3)\na[5]", {"np": np})
    assert "out of bounds" in e["evalue"] and e.get("hint") is None


def test_visualizer_trace_gets_the_index_hint():
    from pylive_kernel import tracer

    r = tracer.run_trace("nums = [1, 2]\nfor i in range(len(nums) + 1):\n    x = nums[i]\n", max_steps=200)
    assert "use range(len(nums))" in r["error"]["hint"]


# -- 10. a module edited after it was imported -----------------------------------
def _load(path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_attribute_error_of_an_edited_own_module(tmp_path):
    path = tmp_path / "hinh_hoc_p1.py"
    path.write_text("def chu_vi(a, b):\n    return a + b\n", encoding="utf-8")
    mod = _load(path)
    path.write_text("def chu_vi(a, b):\n    return 2 * (a + b)\n\ndef duong_cheo(a, b):\n    return 5\n",
                    encoding="utf-8")
    exc = AttributeError("module 'hinh_hoc_p1' has no attribute 'duong_cheo'", name="duong_cheo", obj=mod)
    hint = executor.error_hint("AttributeError", str(exc), exc)
    assert hint.startswith("hinh_hoc_p1.py now defines 'duong_cheo', but the kernel still has the copy")
    assert "importlib.reload(hinh_hoc_p1)" in hint
    exc = AttributeError("module 'hinh_hoc_p1' has no attribute 'dien_tich'", name="dien_tich", obj=mod)
    assert executor.error_hint("AttributeError", str(exc), exc) is None  # a plain typo


def test_from_import_of_an_edited_own_module(tmp_path, monkeypatch):
    path = tmp_path / "hinh_from_p1.py"
    path.write_text("def chu_vi(a, b):\n    return a + b\n", encoding="utf-8")
    monkeypatch.setitem(sys.modules, "hinh_from_p1", _load(path))
    path.write_text("def chu_vi(a, b):\n    return 2 * (a + b)\n\ndef duong_cheo(a, b):\n    return 5\n",
                    encoding="utf-8")
    e = fail("from hinh_from_p1 import duong_cheo")
    assert e["ename"] == "ImportError"
    assert e["hint"].startswith("hinh_from_p1.py now defines 'duong_cheo', but the kernel still has the copy")
    assert fail("from hinh_from_p1 import dien_tich").get("hint") is None  # a plain typo
    assert fail("from json import dumpz").get("hint") is None  # a library module


def test_attribute_error_of_a_library_module_gets_no_reload_hint():
    import json

    exc = AttributeError("module 'json' has no attribute 'dumps2'", name="dumps2", obj=json)
    assert executor.error_hint("AttributeError", str(exc), exc) is None


def test_live_run_after_editing_a_module_explains_it(kernel, tmp_path):
    (tmp_path / "hinh_p1.py").write_text("def chu_vi(a, b):\n    return a + b\n", encoding="utf-8")
    f = str(tmp_path / "main.py")
    r = kernel.run(f"import sys\nsys.path.insert(0, {str(tmp_path)!r})\nimport hinh_p1\n", file=f)
    assert r["status"] == "ok"
    (tmp_path / "hinh_p1.py").write_text("def chu_vi(a, b):\n    return a + b\n\ndef cheo(a):\n    return a\n",
                                         encoding="utf-8")
    r = kernel.run("import hinh_p1\nhinh_p1.cheo(3)\n", file=f, mode="live")  # Live Mode never reloads
    assert r["status"] == "error", r
    assert r["error"]["hint"].startswith("hinh_p1.py now defines 'cheo', but the kernel still has the copy")
    assert "Live Mode does not" in r["error"]["hint"]


def _guarded_module(tmp_path, name: str):
    path = tmp_path / f"{name}.py"
    path.write_text("def chu_vi(a, b):\n    return a + b\n\ntry:\n    import numpy_khong_co as np\n"
                    "except ImportError:\n    pass\n\nif __name__ == '__main__':\n    ket_qua = chu_vi(1, 2)\n",
                    encoding="utf-8")
    return path, _load(path)


def _attr_hint(mod: types.ModuleType, name: str, message: str | None = None) -> str | None:
    exc = AttributeError(message or f"module '{mod.__name__}' has no attribute '{name}'", name=name, obj=mod)
    return executor.error_hint("AttributeError", str(exc), exc)


@pytest.mark.parametrize("write_bytecode", [True, False])
def test_names_that_never_ran_on_import_get_no_reload_hint(tmp_path, monkeypatch, write_bytecode):
    monkeypatch.setattr(sys, "dont_write_bytecode", not write_bytecode)
    _, mod = _guarded_module(tmp_path, f"hinh_guard_p1_{write_bytecode}")
    # Unedited: the main-guard body and the failed import never bound these names.
    assert _attr_hint(mod, "ket_qua") is None
    assert _attr_hint(mod, "np") is None
    assert _attr_hint(mod, "chu_vi2", "partially initialized module 'm' has no attribute 'chu_vi2' "
                                      "(most likely due to a circular import)") is None


def test_conditional_name_after_an_edit_needs_the_pyc_to_tell(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "dont_write_bytecode", False)
    path, mod = _guarded_module(tmp_path, "hinh_pyc_p1")
    assert os.path.isfile(mod.__cached__)
    path.write_text(path.read_text(encoding="utf-8") + "if True:\n    canh = 3\n", encoding="utf-8")
    assert _attr_hint(mod, "canh").startswith("hinh_pyc_p1.py now defines 'canh'")
    assert _attr_hint(mod, "ket_qua") is None  # still only under the main guard
    # Without a .pyc a conditional binding proves nothing; an unconditional def still does.
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    path2, mod2 = _guarded_module(tmp_path, "hinh_nopyc_p1")
    path2.write_text(path2.read_text(encoding="utf-8") + "if True:\n    canh = 3\ndef cheo(a):\n    return a\n",
                     encoding="utf-8")
    assert _attr_hint(mod2, "canh") is None
    assert _attr_hint(mod2, "cheo").startswith("hinh_nopyc_p1.py now defines 'cheo'")


def test_autoreload_note_matches_what_vrun_does():
    _, notes = magics.rewrite("%load_ext autoreload\n%autoreload 2\nimport os\n")
    note = next(n for n in notes if "%autoreload" in n)
    assert "re-run the cell that imports" not in note and "reloads" in note
    assert "the run's notes say when it could not" in note  # risky modules are not reloaded


# -- 11. built-in names the learner rebound --------------------------------------
def test_called_builtin_rebound_in_the_same_cell():
    e = fail("max = 0\nfor x in [3, 1]:\n    max = x if x > max else max\nprint(max([1, 2]))")
    assert e["hint"] == ("max is a built-in function, but here max holds 3, set on line 1 (max = 0), so max(...) "
                         "calls that instead. Rename your variable (e.g. max_value), or run del max to get the "
                         "built-in back.")


def test_called_builtin_rebound_by_an_earlier_run():
    e = fail("a = [3, 9, 2]\nprint(max(a))", {"max": 0})
    assert "max holds 0, set by code you ran earlier (maybe in another file" in e["hint"]
    assert "del max" in e["hint"]


def test_builtin_type_rebound_and_local_rebinding():
    assert "list is a built-in type, but here list holds a list of 2 items" in \
        fail("list = [1, 2]\nb = list(range(3))")["hint"]
    hint = fail("def f(xs):\n    sum = 0\n    for x in xs:\n        sum += x\n    return sum(xs)\nf([1, 2])")["hint"]
    assert "sum holds 3, set inside f()" in hint and "del" not in hint


def test_input_replaced_by_stdin_readline(kernel, tmp_path):
    r = kernel.run("import sys\ninput = sys.stdin.readline\nn = input('Nhap n: ')\n",
                   file=str(tmp_path / "cf.py"), stdin="5\n")
    hint = r["error"]["hint"]
    assert "input holds sys.stdin.readline, set on line 2 (input = sys.stdin.readline)" in hint
    assert "takes no prompt" in hint


def test_shadow_hint_shows_only_the_start_of_a_long_string():
    hint = fail("input = 'x' * 100000\nn = input('n = ')")["hint"]
    assert "input holds '" + "x" * 35 + "...', set on line 1" in hint


def test_shadow_hint_never_reprs_the_value_and_ignores_own_functions():
    calls: list[str] = []
    code = "class W:\n    def __repr__(self):\n        calls.append('repr')\n        return 'W'\nmax = W()\nmax(1)"
    hint = fail(code, {"calls": calls})["hint"]
    assert "max holds a W object" in hint and calls == []
    # A function the learner named sum on purpose, called wrongly: not a shadowing problem.
    assert fail("def sum(a, b):\n    return a + b\nsum([1, 2])").get("hint") is None
