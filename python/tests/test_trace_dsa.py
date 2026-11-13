"""Trace format for the DSA visualizer: heap deltas, call ids, cheap deep stacks."""
from __future__ import annotations

from typing import Any

import pytest
from conftest import full_heap

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
    outer = dict(res["steps"][k]["stack"][1]["locals"])
    assert full_heap(res, k)[str(outer["data"]["ref"])]["items"] == [1]


def test_a_closure_changes_its_enclosing_frame() -> None:
    res = tracer.run_trace("def outer():\n    count = 0\n    def bump():\n        nonlocal count\n        count += 1\n"
                           "    bump()\n    bump()\n    return count\nouter()\n")
    bumps = [s for s in res["steps"] if s["stack"][-1]["func"] == "bump" and s["event"] == "line"]
    second_call = bumps[-1]
    assert dict(second_call["stack"][1]["locals"])["count"] == 1


def test_frames_carry_call_ids_and_parameter_names() -> None:
    res = tracer.run_trace("def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\nfib(3)\n")
    first: dict[int, dict[str, Any]] = {}
    for s in res["steps"]:
        for f in s["stack"]:
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
                           max_bytes=100_000_000, max_seconds=60)
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
