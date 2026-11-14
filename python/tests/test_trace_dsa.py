"""Trace format for the DSA visualizer: heap deltas, call ids, cheap deep stacks."""
from __future__ import annotations

from typing import Any

import pytest
from conftest import full_heap, full_stacks

from pylive_kernel import heap as heap_mod
from pylive_kernel import tracer

QUICK = """
def partition(a, lo, hi):
    pivot = a[hi]
    i = lo - 1
    for j in range(lo, hi):
        if a[j] <= pivot:
            i += 1
            a[i], a[j] = a[j], a[i]
    a[i + 1], a[hi] = a[hi], a[i + 1]
    return i + 1

def quick_sort(a, lo, hi):
    if lo < hi:
        p = partition(a, lo, hi)
        quick_sort(a, lo, p - 1)
        quick_sort(a, p + 1, hi)

nums = [10, 7, 8, 9, 1, 5, 3, 12, 6, 2]
quick_sort(nums, 0, len(nums) - 1)
"""

TRIE = """
class TrieNode:
    def __init__(self):
        self.children = {}
        self.end = False

root = TrieNode()
for w in ["cat", "car", "do"]:
    node = root
    for ch in w:
        node = node.children.setdefault(ch, TrieNode())
    node.end = True
"""


def _locals(step: dict[str, Any], frame: int = -1) -> dict[str, Any]:
    return dict(step["stack"][frame]["locals"])


@pytest.mark.parametrize("code", [QUICK, TRIE], ids=["quick_sort", "trie"])
def test_rebuilt_heaps_match_what_each_step_encoded(code: str, monkeypatch: pytest.MonkeyPatch) -> None:
    encoders: list[Any] = []

    class Recording(heap_mod.HeapEncoder):
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            encoders.append(self)

    monkeypatch.setattr(tracer, "HeapEncoder", Recording)
    res = tracer.run_trace(code, max_steps=5000)
    assert res["heapDelta"] and res["error"] is None and res["stopped"] is None
    assert len(encoders) == len(res["steps"])
    sent_less = 0
    for k, enc in enumerate(encoders):
        rebuilt = full_heap(res, k)
        for key, node in enc.heap.items():
            assert rebuilt[key] == node, (k, key)
        sent_less += len(enc.heap) - len(res["steps"][k]["heap"])
    assert sent_less > 0  # unchanged nodes were not sent again


def test_a_callers_list_changed_by_the_callee_is_current() -> None:
    res = tracer.run_trace("def inner(xs):\n    xs.append(1)\n    return 0\n"
                           "def outer():\n    data = []\n    inner(data)\n    return data\nouter()\n")
    k = next(i for i, s in enumerate(res["steps"]) if s["line"] == 3 and s["event"] == "line")
    outer = dict(full_stacks(res)[k][1]["locals"])
    assert full_heap(res, k)[str(outer["data"]["ref"])]["items"] == [1]


def test_a_closure_changes_its_enclosing_frame() -> None:
    res = tracer.run_trace("def outer():\n    count = 0\n    def bump():\n        nonlocal count\n        count += 1\n"
                           "    bump()\n    bump()\n    return count\nouter()\n")
    bumps = [st for s, st in zip(res["steps"], full_stacks(res)) if st[-1]["func"] == "bump" and s["event"] == "line"]
    second_call = bumps[-1]
    assert dict(second_call[1]["locals"])["count"] == 1


def test_frames_carry_call_ids_and_parameter_names() -> None:
    res = tracer.run_trace("def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\nfib(3)\n")
    first: dict[int, dict[str, Any]] = {}
    for s in res["steps"]:
        for f in s["stack"]:
            if isinstance(f, int):  # a run of unchanged frames
                continue
            if f["fid"] not in first:
                first[f["fid"]] = f
                assert "params" in f
            else:
                assert "params" not in f
    calls = [f for f in first.values() if f["func"] == "fib"]
    assert len(calls) == 5  # fib(3), fib(2), fib(1), fib(0), fib(1)
    assert all(f["params"] == ["n"] for f in calls)
    assert sorted(dict(f["locals"])["n"] for f in calls) == [0, 1, 1, 2, 3]
    returns = [s for s in res["steps"] if s["event"] == "return" and s["stack"][-1]["func"] == "fib"]
    assert len({s["stack"][-1]["fid"] for s in returns}) == 5


def test_deep_recursion_is_not_quadratic() -> None:
    # Every frame used to be re-encoded on every step (about 2-7 s here).
    res = tracer.run_trace("def dive(n):\n    return dive(n + 1)\ndive(0)\n", max_steps=5000,
                           max_seconds=60)
    assert res["error"]["ename"] == "RecursionError"
    assert res["elapsedMs"] < 4000


def test_a_sort_of_fifty_numbers_fits_the_default_limits() -> None:
    code = ("import random\nrandom.seed(1)\na = [random.randint(0, 99) for _ in range(50)]\n"
            "for i in range(1, len(a)):\n    key = a[i]\n    j = i - 1\n"
            "    while j >= 0 and a[j] > key:\n        a[j + 1] = a[j]\n        j -= 1\n    a[j + 1] = key\n")
    res = tracer.run_trace(code, max_steps=5000)
    assert res["stopped"] is None
    final = full_heap(res)[str(_locals(res["steps"][-1], 0)["a"]["ref"])]["items"]
    assert final == sorted(final)


def test_odd_globals_do_not_break_a_trace() -> None:
    res = tracer.run_trace("globals()[1] = 'one'\nx = 2\ny = 3\n")
    assert res["error"] is None
    assert _locals(res["steps"][-1], 0)["x"] == 2


def test_first_steps_name_methods_and_mark_class_bodies() -> None:
    res = tracer.run_trace("class A:\n    def __init__(self):\n        self.b = B()\n"
                           "class B:\n    def __init__(self):\n        self.x = 1\nA()\n")
    first: dict[int, dict[str, Any]] = {}
    for stack in full_stacks(res):
        for f in stack:
            first.setdefault(f["fid"], f)
    by_qual = {f.get("qual", f["func"]): f for f in first.values()}
    assert {"A.__init__", "B.__init__"} <= set(by_qual)
    assert by_qual["A"].get("body") and by_qual["B"].get("body")
    assert not by_qual["A.__init__"].get("body")


# -- frames that are not re-encoded on every step ----------------------------

NONLOCAL = """
def count_nodes(tree):
    total = 0
    def visit(node):
        nonlocal total
        total += 1
        for child in node[1]:
            visit(child)
    visit(tree)
    return total
count_nodes(("a", [("b", [("c", [])]), ("d", [])]))
"""

APPEND_CALLBACK = """
def walk(node, emit):
    if node is None:
        return
    walk(node[0], emit)
    emit(node[1])
    walk(node[2], emit)
def flatten(tree):
    out = []
    walk(tree, out.append)
    return out
flatten(((None, "a", None), "b", (None, "c", None)))
"""

COMPREHENSION = """
def height(node):
    kids = node[1]
    return 1 + max([height(c) for c in kids], default=0)
height(("r", [("x", []), ("y", [("z", [])])]))
"""

WALRUS = """
def check(i):
    return i < 3
i = 0
while check(i := i + 1):
    pass
"""

GEN_INORDER = """
def walk(t):
    if t:
        yield from walk(t[0])
        yield t[1]
        yield from walk(t[2])
print(list(walk(((None, 1, None), 2, ((None, 3, None), 4, None)))))
"""


def _decode(v: Any, heap: dict[str, Any], seen: tuple[str, ...] = ()) -> Any:
    if isinstance(v, dict) and "ref" in v:
        key = str(v["ref"])
        node = heap.get(key)
        if key in seen or node is None:
            return "<cycle>" if key in seen else "<missing>"
        inner = seen + (key,)
        kind = node["kind"]
        if kind in ("list", "tuple", "set", "deque"):
            return (kind, [_decode(x, heap, inner) for x in node["items"]])
        if kind == "dict":
            return ("dict", [(_decode(a, heap, inner), _decode(b, heap, inner)) for a, b in node["entries"]])
        if kind == "object":
            return (node["type"], [(f, _decode(x, heap, inner)) for f, x in node["fields"]])
        return (kind, repr(sorted(node.items())))
    if isinstance(v, dict) and v.get("$t") == "fn":
        return ("fn", v["v"])  # what a method is bound to is not a local value
    return v


def _views(res: dict[str, Any]) -> list[Any]:
    out = []
    for k, stack in enumerate(full_stacks(res)):
        heap = full_heap(res, k)
        out.append([(f["func"], f["line"], {n: _decode(v, heap) for n, v in f["locals"]}) for f in stack])
    return out


@pytest.mark.parametrize("code", [QUICK, TRIE, NONLOCAL, APPEND_CALLBACK, COMPREHENSION, WALRUS, GEN_INORDER],
                         ids=["quick_sort", "trie", "nonlocal", "append_callback", "comprehension", "walrus",
                              "gen_inorder"])
def test_reused_frames_show_what_re_encoding_every_frame_shows(code: str, monkeypatch: pytest.MonkeyPatch) -> None:
    class NoCache(dict):  # type: ignore[type-arg]
        def get(self, key: Any, default: Any = None) -> Any:
            return None

    real = tracer.run_trace(code, max_steps=5000)
    orig = tracer.Recorder.__init__

    def init(self: Any, *a: Any, **kw: Any) -> None:
        orig(self, *a, **kw)
        self.frames = NoCache()

    monkeypatch.setattr(tracer.Recorder, "__init__", init)
    ref = tracer.run_trace(code, max_steps=5000)
    assert real["error"] is None and real["stopped"] is None
    assert len(real["steps"]) == len(ref["steps"])
    for k, (a, b) in enumerate(zip(_views(real), _views(ref))):
        assert a == b, k


def test_a_list_changed_through_its_bound_method_is_current() -> None:
    res = tracer.run_trace(APPEND_CALLBACK)
    stacks = full_stacks(res)
    k = max(i for i, st in enumerate(stacks) if st[-1]["func"] == "walk")
    flatten = next(f for f in stacks[k] if f["func"] == "flatten")
    out = dict(flatten["locals"])["out"]
    assert full_heap(res, k)[str(out["ref"])]["items"] == ["a", "b", "c"]


def test_suspended_closures_leave_free_variables_to_the_running_frame() -> None:
    res = tracer.run_trace(NONLOCAL)
    for stack in full_stacks(res):
        for f in stack[:-1]:
            if f["func"] == "visit":
                assert "total" not in dict(f["locals"])
        if stack[-1]["func"] == "visit":
            assert "total" in dict(stack[-1]["locals"])


def _first_steps(res: dict[str, Any], func: str) -> list[dict[str, Any]]:
    return [f for s in res["steps"] for f in s["stack"]
            if isinstance(f, dict) and "params" in f and f["func"] == func]


def test_generators_get_one_id_per_call_and_mark_their_yields() -> None:
    res = tracer.run_trace(GEN_INORDER)
    assert res["stdout"] == "[1, 2, 3, 4]\n"
    starts = _first_steps(res, "walk")
    assert len(starts) == len({f["fid"] for f in starts}) == 9  # 4 nodes, 5 empty children
    ends = [(s, st[-1]["fid"]) for s, st in zip(res["steps"], full_stacks(res))
            if s["event"] == "return" and st[-1]["func"] == "walk"]
    finals = [fid for s, fid in ends if not s.get("yield")]
    assert sorted(finals) == sorted(f["fid"] for f in starts)  # every call ends once
    assert not any(s.get("exc") == "StopIteration" for s in res["steps"])  # yield from's own


def test_two_loops_over_a_generator_are_two_calls() -> None:
    res = tracer.run_trace("def evens(n):\n    for i in range(0, n, 2):\n        yield i\n"
                           "for x in evens(4):\n    pass\nfor y in evens(6):\n    pass\n")
    assert len({f["fid"] for f in _first_steps(res, "evens")}) == 2
    assert [s["ret"] for s in res["steps"] if s.get("yield")] == [0, 2, 0, 2, 4]


def test_a_call_that_raises_says_so_instead_of_returning_none() -> None:
    res = tracer.run_trace("def f(k):\n    return [][k]\ntry:\n    f(1)\nexcept IndexError:\n    pass\n"
                           "import contextlib\ndef s():\n    with contextlib.suppress(KeyError):\n        {}[1]\ns()\n")
    f_end = next(s for s in res["steps"] if s["event"] == "return" and s["line"] == 2)
    assert f_end["raised"] == "IndexError" and "ret" not in f_end
    s_end = next(s for s in res["steps"] if s["event"] == "return" and s["stack"][-1]["func"] == "s")
    assert "raised" not in s_end and s_end["ret"] is None  # the exception was suppressed


def test_a_closed_generator_and_a_users_own_stopiteration() -> None:
    res = tracer.run_trace("def g():\n    yield 1\n    yield 2\nit = g()\nnext(it)\nit.close()\n"
                           "def merge(a):\n    ia = iter(a)\n    while True:\n        try:\n            x = next(ia)\n"
                           "        except StopIteration:\n            return\n        yield x\nlist(merge([1]))\n")
    g_ends = [s.get("raised") for s in res["steps"] if s["line"] == 2 and s["event"] == "return"]
    assert g_ends == [None, "GeneratorExit"]
    assert not any(s.get("exc") == "GeneratorExit" for s in res["steps"])
    assert any(s.get("exc") == "StopIteration" and s["line"] == 11 for s in res["steps"])


def test_callbacks_from_library_code_keep_the_callers() -> None:
    res = tracer.run_trace("import heapq\npts = [(3, 1), (1, 1), (2, 2)]\n"
                           "best = heapq.nsmallest(2, pts, key=lambda p: p[0] * p[0] + p[1] * p[1])\n")
    lam = [st for st in full_stacks(res) if st[-1]["func"] == "<lambda>"]
    assert lam and all([f["func"] for f in st] == ["<module>", "<lambda>"] for st in lam)


def test_different_lambdas_have_different_code_ids() -> None:
    res = tracer.run_trace("a = sorted([3, 1], key=lambda x: -x)\nb = sorted([3, 1], key=lambda x: x)\n"
                           "fact = lambda n: 1 if n < 2 else n * fact(n - 1)\nfact(3)\n")
    codes = {f["fid"]: f["code"] for s in res["steps"] for f in s["stack"] if isinstance(f, dict) and "code" in f}
    by_line: dict[int, set[int]] = {}
    for s, st in zip(res["steps"], full_stacks(res)):
        if st[-1]["func"] == "<lambda>":
            by_line.setdefault(s["line"], set()).add(codes[st[-1]["fid"]])
    assert len(by_line[1]) == 1 and len(by_line[2]) == 1 and by_line[1] != by_line[2]
    assert len(by_line[3]) == 1  # the recursive lambda: one code for all its calls


def test_a_thousand_deep_recursion_fits_the_worker_limits() -> None:
    # Each step used to resend every suspended frame: 6 MB ran out at depth ~460.
    res = tracer.run_trace("import sys\nsys.setrecursionlimit(3000)\n"
                           "def total(n):\n    return 0 if n == 0 else n + total(n - 1)\nprint(total(1000))\n",
                           max_steps=5000, max_bytes=6_000_000)
    assert res["stopped"] is None and res["stdout"] == "500500\n"
    assert max(len(st) for st in full_stacks(res)) == 1002
    assert sum(len(s["stack"]) for s in res["steps"]) < 4 * len(res["steps"])


GRID_BFS = """
from collections import deque
grid = [[0] * 8 for _ in range(8)]
grid[3][3] = 1
seen = {(0, 0)}
q = deque([(0, 0)])
while q:
    r, c = q.popleft()
    for nr, nc in ((r + 1, c), (r, c + 1)):
        if nr < 8 and nc < 8 and grid[nr][nc] == 0 and (nr, nc) not in seen:
            seen.add((nr, nc))
            q.append((nr, nc))
"""


def test_reused_nodes_and_frozen_tuples_rebuild_to_what_each_step_encoded(monkeypatch: pytest.MonkeyPatch) -> None:
    # Reused nodes are in a step's heap like freshly encoded ones; frozen
    # (r, c) tuples are not, and the webview still has them from earlier.
    encoders: list[Any] = []

    class Recording(heap_mod.HeapEncoder):
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            encoders.append(self)

    monkeypatch.setattr(tracer, "HeapEncoder", Recording)
    res = tracer.run_trace(GRID_BFS, max_steps=5000)
    assert res["error"] is None and res["stopped"] is None and len(encoders) == len(res["steps"])
    for k, enc in enumerate(encoders):
        rebuilt = full_heap(res, k)
        for key, node in enc.heap.items():
            assert rebuilt[key] == node, (k, key)
    seen = full_heap(res)[str(_locals(res["steps"][-1], 0)["seen"]["ref"])]
    assert seen["len"] == len(seen["items"]) == 63
    assert all(str(x["ref"]) in full_heap(res) for x in seen["items"])
