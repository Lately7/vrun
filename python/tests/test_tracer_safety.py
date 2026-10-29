"""DSA tracer and AST safety heuristics (in-process unit tests)."""

from __future__ import annotations

from pylive_kernel import safety, tracer

BUBBLE = """
arr = [5, 1, 4, 2]
n = len(arr)
for i in range(n):
    for j in range(n - i - 1):
        if arr[j] > arr[j + 1]:
            arr[j], arr[j + 1] = arr[j + 1], arr[j]
print(arr)
"""


def _locals(step, frame=-1):
    return dict(step["stack"][frame]["locals"])


def test_trace_records_steps_and_final_state():
    res = tracer.run_trace(BUBBLE)
    assert res["error"] is None and res["stopped"] is None
    assert res["stdout"] == "[1, 2, 4, 5]\n"
    last = res["steps"][-1]
    arr_ref = _locals(last)["arr"]["ref"]
    items = last["heap"][str(arr_ref)]["items"]
    assert items == [1, 2, 4, 5]
    # The same list keeps the same id across steps.
    first_ref = _locals(res["steps"][1])["arr"]["ref"]
    assert first_ref == arr_ref


def test_trace_function_frames_and_return_values():
    code = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nr = fact(4)\n"
    res = tracer.run_trace(code)
    depths = [len(s["stack"]) for s in res["steps"]]
    assert max(depths) == 5  # <module> + 4 recursive frames
    returns = [s["ret"] for s in res["steps"] if s["event"] == "return" and s["stack"][-1]["func"] == "fact"]
    assert returns == [1, 2, 6, 24]


def test_trace_step_limit_stops_infinite_loop():
    res = tracer.run_trace("i = 0\nwhile True:\n    i += 1\n", max_steps=50)
    assert res["stopped"].startswith("step limit")
    assert len(res["steps"]) == 50


def test_trace_limit_not_swallowed_by_except_exception():
    code = "i = 0\nwhile True:\n    try:\n        i += 1\n    except Exception:\n        pass\n"
    res = tracer.run_trace(code, max_steps=30)
    assert res["stopped"]


def test_trace_user_exception_is_reported():
    res = tracer.run_trace("a = [1]\nb = a[3]\n")
    assert res["error"]["ename"] == "IndexError"
    assert res["error"]["userFrame"]["line"] == 2


def test_trace_syntax_error():
    res = tracer.run_trace("def broken(:\n")
    assert res["error"]["ename"] == "SyntaxError"


def test_trace_tree_and_graph_structures():
    code = """
class TreeNode:
    def __init__(self, v):
        self.val = v
        self.left = None
        self.right = None
root = TreeNode(2)
root.left = TreeNode(1)
root.right = TreeNode(3)
graph = {"A": ["B", "C"], "B": ["D"], "C": [], "D": []}
visited = set()
"""
    res = tracer.run_trace(code)
    last = res["steps"][-1]
    loc = _locals(last)
    root = last["heap"][str(loc["root"]["ref"])]
    assert root["type"] == "TreeNode"
    assert {f[0] for f in root["fields"]} == {"val", "left", "right"}
    graph = last["heap"][str(loc["graph"]["ref"])]
    assert graph["kind"] == "dict" and graph["len"] == 4


def test_trace_does_not_touch_sys_stdout():
    import sys

    before = sys.stdout
    tracer.run_trace("print('x')")
    assert sys.stdout is before


def test_trace_size_limit():
    res = tracer.run_trace("big = list(range(60))\nfor i in range(10000):\n    big[0] = i\n", max_bytes=20_000)
    assert res["stopped"] and "size limit" in res["stopped"]


# -- safety --------------------------------------------------------------

def test_safety_flags_ml_and_io():
    cases = {
        "model.fit(X, y)": "training",
        "GridSearchCV(est, grid)": "expensive",
        "cross_val_score(m, X, y)": "expensive",
        "torch_model.train()": "training",
        "pd.read_excel('a.xlsx')": "load",  # loaded once by Live Mode, see test_load_once.py
        "df.to_csv('out.csv')": "io",
        "open('f')": "io",
        "import requests\nrequests.get('http://x')": "io",
        "while True:\n    pass": "loop",
        "import torch": "import",
        "import time\ntime.sleep(5)": "expensive",
    }
    for code, cat in cases.items():
        res = safety.analyze_source(code)
        assert not res["safe"], code
        assert cat in {f["category"] for f in res["findings"]}, (code, res)


def test_safety_allows_lightweight_pandas():
    for code in ("df['Quantity'].mean()", "df['Quantity'].median()", "x = arr.to_numpy()",
                 "pd.to_datetime(s)", "sorted(a)"):
        assert safety.analyze_source(code)["safe"], code


def test_safety_manual_marker():
    res = safety.analyze_source("# pylive: manual\nx = 1")
    assert not res["safe"] and res["findings"][0]["category"] == "marker"
