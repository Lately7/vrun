"""P1 tracer fixes: visualize with the cells above (6), endless loops (9), trace caps (12)."""
from __future__ import annotations

import json
import sys
from typing import Any

import pytest
from conftest import full_heap, full_stacks

from pylive_kernel import heap as heap_mod
from pylive_kernel import prelude as prelude_mod
from pylive_kernel import tracer


def _top(res: dict[str, Any], k: int = -1) -> dict[str, Any]:
    return dict(full_stacks(res)[k][-1]["locals"])


def _node(res: dict[str, Any], ref: dict[str, Any], k: int = -1) -> dict[str, Any]:
    return full_heap(res, k)[str(ref["ref"])]


def _decode(v: Any, heap: dict[str, Any], seen: tuple[str, ...] = ()) -> Any:
    if isinstance(v, dict) and "ref" in v:
        key = str(v["ref"])
        node = heap.get(key)
        if key in seen or node is None or v.get("missing"):
            return "<cycle>" if key in seen else "<missing>"
        inner = seen + (key,)
        if node["kind"] in ("list", "tuple", "set", "deque"):
            return (node["kind"], node["len"], [_decode(x, heap, inner) for x in node["items"]])
        if node["kind"] == "dict":
            return ("dict", node["len"], [(_decode(a, heap, inner), _decode(b, heap, inner))
                                          for a, b in node["entries"]])
        if node["kind"] == "object":
            return (node["type"], [(f, _decode(x, heap, inner)) for f, x in node["fields"]])
        return (node["kind"], json.dumps(node, sort_keys=True))
    if isinstance(v, dict) and v.get("$t") == "fn":
        return ("fn", v["v"])
    return v


def _views(res: dict[str, Any]) -> list[Any]:
    out = []
    heap: dict[str, Any] = {}
    for step, stack in zip(res["steps"], full_stacks(res)):
        heap.update(step["heap"])
        for key in step.get("gone", []):
            heap.pop(key, None)
        out.append([(f["func"], f["line"], [(n, _decode(v, heap)) for n, v in f["locals"]]) for f in stack])
    return out


# -- 12: caps that cover beginner programs ---------------------------------------

BFS20 = """
from collections import deque
R, C = 20, 20
grid = [[0] * C for _ in range(R)]
for r in range(3, 17):
    grid[r][10] = 1
start, goal = (0, 0), (19, 19)
dist = {start: 0}
visited = {start}
queue = deque([start])
while queue:
    r, c = queue.popleft()
    if (r, c) == goal:
        break
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nr, nc = r + dr, c + dc
        if 0 <= nr < R and 0 <= nc < C and grid[nr][nc] == 0 and (nr, nc) not in visited:
            visited.add((nr, nc))
            dist[(nr, nc)] = dist[(r, c)] + 1
            queue.append((nr, nc))
"""


def test_a_bfs_on_a_20x20_grid_shows_every_visited_cell_in_row_order() -> None:
    res = tracer.run_trace(BFS20, max_steps=20_000, max_seconds=60)
    assert res["error"] is None and res["stopped"] is None
    loc = _top(res)
    heap = full_heap(res)
    visited = heap[str(loc["visited"]["ref"])]
    assert visited["len"] == len(visited["items"]) > 300
    cells = [tuple(heap[str(x["ref"])]["items"]) for x in visited["items"]]
    assert cells == sorted(cells)  # a cut would keep a coherent prefix, not hash order
    dist = heap[str(loc["dist"]["ref"])]
    assert dist["len"] == len(dist["entries"]) == visited["len"]
    assert not any(s.get("truncated") for s in res["steps"])
    assert '"missing"' not in json.dumps(res["steps"])


def test_a_tuple_of_plain_values_is_sent_once() -> None:
    res = tracer.run_trace(BFS20, max_steps=3000)
    sent: dict[str, int] = {}
    for s in res["steps"]:
        for key, node in s["heap"].items():
            if node["kind"] == "tuple":
                sent[key] = sent.get(key, 0) + 1
    assert sent and max(sent.values()) == 1


def test_sorting_two_hundred_numbers_and_a_memo_of_three_hundred_keys_fit() -> None:
    code = ("import random\nrandom.seed(1)\na = [random.randint(1, 999) for _ in range(200)]\n"
            "a.sort()\nmemo = {}\nfor i in range(300):\n    memo[i] = i * i\n")
    res = tracer.run_trace(code, max_steps=5000)
    loc = _top(res)
    assert _node(res, loc["a"])["items"] == sorted(_node(res, loc["a"])["items"])
    assert len(_node(res, loc["a"])["items"]) == 200
    memo = _node(res, loc["memo"])
    assert memo["len"] == len(memo["entries"]) == 300


def test_a_cut_container_keeps_its_true_length_and_a_sorted_prefix() -> None:
    res = tracer.run_trace("s = {(r, c) for r in range(9, -1, -1) for c in range(5)}\n"
                           "big = list(range(700))\n")
    loc = _top(res)
    s = _node(res, loc["s"])
    heap = full_heap(res)
    assert s["len"] == 50 and len(s["items"]) == 50
    big = _node(res, loc["big"])
    assert big["len"] == 700 and big["items"] == list(range(tracer.MAX_ITEMS))
    enc = heap_mod.HeapEncoder(max_items=10)
    root = enc.encode({(r, c) for r in range(9, -1, -1) for c in range(5)})
    node = enc.heap[str(root["ref"])]
    firsts = [tuple(enc.heap[str(x["ref"])]["items"]) for x in node["items"]]
    assert node["len"] == 50 and firsts == [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (1, 0), (1, 1), (1, 2), (1, 3), (1, 4)]
    assert heap  # (the full heap is what the webview rebuilds)


def test_sets_of_mixed_or_user_values_are_not_sorted_and_run_no_user_code() -> None:
    called: list[str] = []

    class Weird:
        def __lt__(self, other: object) -> bool:
            called.append("lt")
            return True

        def __eq__(self, other: object) -> bool:
            called.append("eq")
            return False

        __hash__ = object.__hash__

    for value in ({1, "a", 2.5}, {Weird(), Weird()}, {(1, "a"), ("b", 2)}, {(1, Weird())}):
        enc = heap_mod.HeapEncoder()
        root = enc.encode(value)
        assert enc.heap[str(root["ref"])]["len"] == len(value)
    assert called == []


def test_lists_of_plain_values_encode_like_the_slow_path() -> None:
    values = [[1, 2, 3], [1.5, float("nan"), 2.0], [2**60, 1], [1, 2.5], [True, 1], ["a" * 100, "b"],
              ["x", None], [None, None], [1, True, None, "s"], [float("inf")], [10**400, 1.0]]
    for v in values:
        fast = heap_mod.HeapEncoder(memo=heap_mod.HeapMemo(), ids={}, keepalive=[])
        slow = heap_mod.HeapEncoder()
        slow._scalars = lambda items: None  # type: ignore[method-assign]
        a, b = fast.encode(v), slow.encode(v)
        assert fast.heap[str(a["ref"])] == slow.heap[str(b["ref"])], v


def test_the_node_cap_still_marks_missing_refs() -> None:
    code = "class N:\n    pass\nnodes = [N() for i in range(1200)]\nx = 1\n"
    res = tracer.run_trace(code, max_nodes=50, max_items=2000, max_steps=5000)
    last = res["steps"][-1]
    items = _node(res, _top(res)["nodes"])["items"]
    assert len(items) == 1200 and any(x.get("missing") for x in items)
    assert last.get("truncated")


def test_two_dimensional_arrays_keep_64_by_64() -> None:
    np = pytest.importorskip("numpy")
    enc = heap_mod.HeapEncoder(max_items=512, max_matrix=64)
    root = enc.encode(np.zeros((100, 100)))
    node = enc.heap[str(root["ref"])]
    assert len(node["rows"]) == 64 and len(node["rows"][0]) == 64 and enc.cut


MUTATIONS = """
grid = [[0] * 12 for _ in range(10)]
for i in range(10):
    grid[i][i] = 1
seen = set(range(20))
seen.discard(3)
seen.add(100)
seen.discard(100)
seen.add(3)
big = [1000 + i for i in range(30)]
big[5] = big[5] + 0
pairs = [(i, i + 1) for i in range(12)]
pairs[3] = (3, 4)
holder = ([1, 2], [3, 4], [5, 6], [7, 8])
holder[0].append(9)
nested = ((1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16))
d = {(i, i): [i] for i in range(10)}
d[(1, 1)].append(5)
d[(2, 2)] = [7]
del d[(3, 3)]
"""


OBJECTS = """
class Node:
    def __init__(self, v, nxt=None):
        self.val = v
        self.next = nxt
class P:
    __slots__ = ("x", "y")
    def __init__(self):
        self.x = 1
head = None
for i in range(12):
    head = Node(i, head)
cur = head
while cur.next:
    cur.val += 100
    cur = cur.next
cur.next = Node(-1)
head.next.next = head.next.next.next
p = P()
p.y = 5
p.x = (1, 2)
del p.x
p.x = [p.y]
head.__dict__["extra"] = [1]
head.__dict__.pop("val")
head.val = 2**70
head.__dict__["__hidden"] = 3
"""


class _NoStore(dict):  # type: ignore[type-arg]
    def get(self, key: Any, default: Any = None) -> Any:
        return None

    def __setitem__(self, key: Any, value: Any) -> None:
        pass


class _NeverSet(set):  # type: ignore[type-arg]
    def __contains__(self, item: object) -> bool:
        return False

    def add(self, item: Any) -> None:
        pass


@pytest.mark.parametrize("code", [BFS20, MUTATIONS, OBJECTS], ids=["bfs20", "mutations", "objects"])
def test_reused_nodes_show_what_encoding_every_node_shows(code: str, monkeypatch: pytest.MonkeyPatch) -> None:
    real = tracer.run_trace(code, max_steps=600)

    class NoMemo(heap_mod.HeapMemo):
        def __init__(self) -> None:
            super().__init__()
            self.nodes = _NoStore()
            self.frozen = _NeverSet()

    monkeypatch.setattr(tracer, "HeapMemo", NoMemo)
    ref = tracer.run_trace(code, max_steps=600)
    assert real["error"] is None and len(real["steps"]) == len(ref["steps"])
    for k, (a, b) in enumerate(zip(_views(real), _views(ref))):
        assert a == b, k


def test_reused_nodes_are_not_sent_again() -> None:
    res = tracer.run_trace("grid = [[0] * 30 for _ in range(30)]\nfor i in range(200):\n    x = i\n")
    first = next(k for k, s in enumerate(res["steps"]) if s["heap"])  # grid is bound
    assert len(res["steps"][first]["heap"]) == 31
    assert all(not s["heap"] for s in res["steps"][first + 1:])


# -- 9: endless loops ----------------------------------------------------------------

BINSEARCH = """# lower bound
nums = [1, 2, 4, 4, 4, 6, 8]
target = 5
lo, hi = 0, len(nums) - 1
while lo < hi:
    mid = (lo + hi) // 2
    if nums[mid] < target:
        lo = mid
    else:
        hi = mid
print("first >= target at", lo)
"""


def test_a_frozen_binary_search_is_reported_as_a_likely_endless_loop() -> None:
    res = tracer.run_trace(BINSEARCH, max_steps=5000)
    assert len(res["steps"]) == 5000  # not stopped early
    loop = res["loop"]
    assert (loop["first"], loop["repeat"], loop["line"]) == (17, 21, 7)
    assert dict((n, v) for n, v in loop["values"] if n != "nums") == {"target": 5, "lo": 4, "hi": 5, "mid": 4}
    assert res["stopped"] == ("looks like an endless loop: step 22 repeats step 18 exactly "
                              "(line 7: target = 5, lo = 4, hi = 5, mid = 4); step limit (5000) reached")
    assert full_stacks(res)[loop["first"]][-1]["locals"] == full_stacks(res)[loop["repeat"]][-1]["locals"]


@pytest.mark.parametrize("code", [
    "nums = [3, 6, 8, 1, 4]\ni = 0\ncount = 0\nwhile i < len(nums):\n    if nums[i] % 2 == 0:\n        count += 1\n        i += 1\n",
    "def f(n):\n    while n != 1:\n        n = n // 2 if n % 2 == 0 else n\n    return n\nf(6)\n",
    "while True:\n    try:\n        x = int('a')\n    except ValueError:\n        pass\n",
    "class Node:\n    def __init__(self, v, nxt=None):\n        self.val = v\n        self.next = nxt\n"
    "head = Node(1, Node(2))\ncur = head\nwhile cur:\n    nxt = cur.next\n",
], ids=["forgot_increment", "in_a_function", "try_except", "linked_list_next"])
def test_other_frozen_loops_are_reported(code: str) -> None:
    res = tracer.run_trace(code, max_steps=2000)
    assert res.get("loop") and res["stopped"].startswith("looks like an endless loop: step ")


@pytest.mark.parametrize("code", [
    "total = 0\nfor x in [0] * 10000:\n    total += x\n",  # a long for loop: the iterator moves on
    "import time\nend = time.perf_counter() + 0.5\nwhile time.perf_counter() < end:\n    pass\n",
    "import random\nx = 0\nwhile x == 0:\n    if random.random() < 0:\n        x = 1\n",
    "it = iter(range(10**6))\nwhile next(it, None) is not None:\n    pass\n",
    "def gen():\n    while True:\n        yield 0\ng = gen()\nfor v in g:\n    pass\n",
    "i = 0\nwhile True:\n    print(i)\n    i += 1\n",  # output goes on
    "data = []\nwhile True:\n    data.append(1)\n    data.pop()\n",  # the heap changes
    "import sys\nwhile True:\n    line = sys.stdin.readline()\n",
], ids=["for_loop", "clock", "random", "next", "generator", "output", "heap_changes", "stdin"])
def test_no_loop_is_claimed_when_state_is_hidden_or_moves_on(code: str) -> None:
    res = tracer.run_trace(code, max_steps=3000, max_seconds=5, stdin="")
    assert "loop" not in res, res["stopped"]
    assert not (res["stopped"] or "").startswith("looks like")


LINKED_MODULE = """
class Node:
    def __init__(self, v, nxt=None):
        self.v = v
        self.next = nxt


def build(n):
    head = None
    for i in range(n):
        head = Node(i, head)
    return head


class Counter:
    def __init__(self):
        self.n = 0

    def incr(self):
        self.n += 1


_k = [0]


def bump():
    _k[0] += 1
    return _k[0]
"""


@pytest.fixture
def linked_module(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """The learner's own module: its objects are shown only as tags."""
    (tmp_path / "linked_p1.py").write_text(LINKED_MODULE)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "linked_p1", raising=False)


@pytest.mark.parametrize("code", [
    "class C:\n    n = 0\nwhile C.n < 10**6:\n    C.n += 1\n",
    "from linked_p1 import build\ncur = build(20000)\nwhile cur:\n    cur = cur.next\n",
    "import linked_p1\nlinked_p1.k = 0\nwhile linked_p1.k < 10**6:\n    linked_p1.k += 1\n",
    "def f():\n    pass\nf.c = 0\nwhile f.c < 10**6:\n    f.c += 1\n",
    "x = 2**4000 + 1\nwhile x < 2**4000 + 10**6:\n    x += 2\n",
    "def make():\n    n = 0\n    def c():\n        nonlocal n\n        n += 1\n        return n\n    return c\n"
    "c = make()\nwhile c() < 10**6:\n    pass\n",
    "class C:\n    items = []\nwhile len(C.items) < 10**6:\n    C.items.append(1)\n",
    "class C:\n    n = 0\n    def bump(self):\n        self.__class__.n += 1\nc = C()\nwhile C.n < 10**6:\n    c.bump()\n",
    "class C:\n    n = 0\n    def bump(self):\n        type(self).n += 1\nc = C()\nwhile C.n < 10**6:\n    c.bump()\n",
    "from linked_p1 import Counter\nc = Counter()\nwhile c.n < 10**6:\n    c.incr()\n",
    "import linked_p1\nwhile linked_p1.bump() < 10**6:\n    pass\n",
    "import io\nbuf = io.StringIO()\nwhile len(buf.getvalue()) < 10**6:\n    print('x', file=buf)\n",
    "def make(k):\n    return lambda x: x + k\nf = make(0)\nwhile f(0) < 10**6:\n    f = make(f(0) + 1)\n",
    "s = 'a' * 100 + chr(1)\nwhile ord(s[-1]) < 60000:\n    s = s[:-1] + chr(ord(s[-1]) + 1)\n",
    # A cut container: what it does not show is compared by value.
    "a = [None] * 600 + [0]\nwhile a[600] < 10**6:\n    a[600] += 1\n",
    "d = {i: 0 for i in range(700)}\nwhile d[650] < 10**6:\n    d[650] += 1\n",
    "s = set(range(600))\nk = 1000\nwhile len(s) < 10**6:\n    s.add(k)\n    s.discard(k - 1)\n    k += 1\n",
    # A name that held a traced function holds random.random later.
    "import random\ndef same():\n    return 0\nfn = same\nk = 0\nwhile k < 1:\n    if fn() < 0.99999:\n        k = 0\n"
    "    else:\n        k = 1\n    fn = random.random\n",
], ids=["class_attr", "imported_list", "module_attr", "function_attr", "big_int", "closure", "class_list",
        "dunder_class", "type_self", "imported_method", "module_function", "stringio", "make_adder", "long_str",
        "cut_list", "cut_dict", "cut_set", "rebound_name"])
def test_no_loop_is_claimed_when_the_change_is_in_state_the_trace_shows_only_as_a_tag(
        code: str, linked_module: None) -> None:
    res = tracer.run_trace(code, max_steps=2000, max_seconds=10)
    assert res["error"] is None and res["stopped"] == "step limit (2000) reached", res["stopped"]
    assert "loop" not in res


@pytest.mark.parametrize("code", [
    "from linked_p1 import build\ncur = build(5)\nwhile cur:\n    x = cur.v\n",  # forgot cur = cur.next
    "a = list(range(1000))\ni = 0\nwhile a[i] < 10**6:\n    i = i\n",
    "d = {i: i for i in range(600)}\nk = 0\nwhile d[k] >= 0:\n    k = k\n",
    "s = set(range(600))\nk = 1000\nwhile len(s) < 10**6:\n    s.add(k)\n    s.discard(k - 1)\n",
    "import heapq\nh = [3, 1, 2]\nheapq.heapify(h)\nwhile h:\n    top = h[0]\n",
    "from functools import lru_cache\n@lru_cache(None)\ndef f(n):\n    return n\ni = 0\nwhile f(i) == 0:\n    i = i\n",
    "x = 2**4000\nwhile x > 0:\n    y = x % 7\n",
], ids=["imported_list", "cut_list", "cut_dict", "cut_set", "heapq", "lru_cache", "big_int"])
def test_frozen_loops_over_cut_or_tag_shown_state_are_still_reported(code: str, linked_module: None) -> None:
    res = tracer.run_trace(code, max_steps=3000)
    assert res.get("loop"), res["stopped"]


def test_a_frozen_loop_with_a_debug_print_is_reported() -> None:
    # Learners add prints exactly when a loop misbehaves; output does not
    # change what the program does next.
    code = ("a = [1, 3, 5, 7, 9, 11, 13]\nlo, hi = 0, 6\nwhile lo < hi:\n    mid = (lo + hi) // 2\n"
            "    print(lo, hi, mid)\n    if a[mid] < 13:\n        lo = mid\n    else:\n        hi = mid\n")
    res = tracer.run_trace(code, max_steps=5000)
    assert res["loop"]["prints"] is True
    assert "(line 3: lo = 5, hi = 6, mid = 5), printing the same output each time; step limit" in res["stopped"]
    res = tracer.run_trace(BINSEARCH, max_steps=5000)
    assert "prints" not in res["loop"]


def test_a_trace_leaves_the_kernels_random_numbers_alone() -> None:
    import random

    random.seed(7)
    expected = [random.random() for _ in range(3)]
    random.seed(7)
    tracer.run_trace("import random\nrandom.seed(1)\nx = random.random()\n")
    tracer.run_trace("print(data)\n", prelude="import random\nrandom.seed(2)\ndata = [random.random()]\n")
    assert [random.random() for _ in range(3)] == expected


def test_no_loop_is_claimed_without_a_limit() -> None:
    res = tracer.run_trace("i = 0\nwhile i < 3:\n    j = 0\n    i += 1\n")
    assert res["stopped"] is None and "loop" not in res


def test_a_loop_is_reported_at_the_size_and_time_limits_too() -> None:
    res = tracer.run_trace(BINSEARCH, max_steps=50_000, max_bytes=20_000)
    assert res["loop"]["repeat"] == 21 and "size limit" in res["stopped"]
    res = tracer.run_trace(BINSEARCH, max_steps=10**7, max_seconds=0.3)
    assert res["loop"]["repeat"] == 21 and res["stopped"].endswith("time limit reached")


def test_a_loop_calling_a_function_from_the_cells_above_is_not_claimed() -> None:
    # Untraced code may use state the trace cannot see.
    res = tracer.run_trace("x = 0\nwhile x == 0:\n    x = same(x)\n", max_steps=500,
                           prelude="def same(v):\n    return v\n")
    assert "loop" not in res


BS_ABOVE = ("# %%\ndef bs(a, t):\n    lo, hi = 0, len(a) - 1\n    while lo < hi:\n        mid = (lo + hi) // 2\n"
            "        if a[mid] < t:\n            lo = mid\n        else:\n            hi = mid\n    return lo\n"
            "def work(n):\n    s = 0\n    for i in range(n):\n        s += i\n    return s\n"
            "def spin(f):\n    while True:\n        try:\n            f()\n        except:\n            pass\n")


@pytest.mark.parametrize("cell, stopped", [
    ("print(bs([1, 3, 5, 7, 9, 11, 13], 13))\n", "time limit reached in bs() from the cells above"),
    ("print(work(10**9))\n", "time limit reached in work() from the cells above"),
    ("def g():\n    x = 1\nspin(g)\n", "step limit (5000) reached"),  # a bare except in the helper
    ("spin(int)\n", "time limit reached in spin() from the cells above"),
], ids=["endless_loop", "slow", "bare_except_steps", "bare_except_time"])
def test_a_function_from_the_cells_above_is_held_to_the_limits(cell: str, stopped: str) -> None:
    # Untraced, it never checked the clock: Visualize spun until interrupted.
    res = tracer.run_trace("# %%\n" + cell, max_steps=5000, max_seconds=1.0, prelude=BS_ABOVE)
    assert res["stopped"] == stopped and res["error"] is None
    assert res["elapsedMs"] < 4000
    assert sys.monitoring.get_tool(4) is None and sys.monitoring.get_tool(3) is None


# -- 6: visualize with the cells above ------------------------------------------

HANOI_ABOVE = """# %% define the function once
def hanoi(n, src, dst, via):
    if n == 0:
        return 0
    a = hanoi(n - 1, src, via, dst)
    b = hanoi(n - 1, via, dst, src)
    return a + 1 + b

"""


def test_a_cell_uses_a_function_from_the_cell_above() -> None:
    alone = tracer.run_trace('print(hanoi(3, "A", "C", "B"))\n')
    assert alone["error"]["ename"] == "NameError"
    res = tracer.run_trace('# %% try it\nprint(hanoi(3, "A", "C", "B"))\n', prelude=HANOI_ABOVE)
    assert res["error"] is None and res["stdout"] == "7\n"
    assert res["notes"][0] == "using from the cells above: hanoi"
    assert "steps inside hanoi() are not shown" in res["notes"][1]
    assert all(f["func"] == "<module>" for st in full_stacks(res) for f in st)  # untraced


LINKED_SETUP = """# %% setup
from typing import Optional
import heapq


class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next


def build(values):
    dummy = ListNode()
    tail = dummy
    for v in values:
        tail.next = ListNode(v)
        tail = tail.next
    return dummy.next

print("setup done")
graph = {"A": ["B"], "B": []}
graph["B"].append("A")
head = build([9, 9])
"""

REVERSE = """def reverse(head: Optional[ListNode]) -> Optional[ListNode]:
    prev = None
    while head:
        head.next, prev, head = prev, head, head.next
    return prev
r = reverse(build([1, 2, 3]))
print(r.val, graph, head.val)
"""


def test_classes_imports_data_and_safe_calls_come_from_the_cells_above() -> None:
    res = tracer.run_trace(REVERSE, prelude=LINKED_SETUP)
    assert res["error"] is None
    assert res["stdout"] == "3 {'A': ['B'], 'B': ['A']} 9\n"  # the setup's print is not shown
    assert res["notes"][0] == "using from the cells above: Optional, ListNode, build, graph, head"
    assert any(st[-1]["func"] == "reverse" for st in full_stacks(res))  # the cell's own code is traced


def test_unsafe_statements_above_are_skipped_with_a_note() -> None:
    above = ("import json\nrows = json.load(open('data.json'))\nmodel = Model()\nmodel.fit(rows)\n"
             "total = 0\nwhile total < 10:\n    total += 1\nlimit = 3\n")
    res = tracer.run_trace("print(limit)\nprint(total)\n", prelude=above)
    assert res["stdout"] == "3\n" and res["error"]["ename"] == "NameError"
    notes = res["notes"]
    assert notes[0] == "using from the cells above: limit"
    assert any(n.startswith("not run from the cells above: line 6 `while total < 10:`") and "total is not defined"
               in n for n in notes), notes
    res = tracer.run_trace("print(rows)\n", prelude=above)
    assert "it calls open()" in res["notes"][0] or "it calls json.load()" in res["notes"][0]


def test_helpers_above_are_called_only_when_their_bodies_only_compute(
        tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    # The Live Mode heuristics alone missed these: shelve.open writes a file,
    # an import inside the helper (fetch_openml downloads), a decorator.
    above = ("import shelve\n"
             "def load():\n    db = shelve.open('db')\n    return dict(db)\n"
             "def fetch():\n    from sklearn.datasets import fetch_openml\n    return fetch_openml('mnist_784')\n"
             "def deco(fn):\n    open('marker', 'w').close()\n    return fn\n"
             "@deco\ndef wrapped():\n    return 1\n"
             "class Store:\n    def __init__(self):\n        self.rows = []\n"
             "    def save(self):\n        open('rows.txt', 'w').close()\n"
             "data = load()\nmnist = fetch()\nstore = Store()\n")
    res = tracer.run_trace("print(data, mnist, wrapped, store)\n", prelude=above)
    assert res["error"]["ename"] == "NameError" and list(tmp_path.iterdir()) == []
    notes = " | ".join(res["notes"])
    assert "it calls load(), which calls shelve.open(), so data is not defined here" in notes
    # (which part is named depends on whether sklearn is loaded already)
    assert any(f"it calls fetch(), which {why}, so mnist is not defined here" in notes
               for why in ("imports from sklearn.datasets", "calls fetch_openml()"))
    assert "it calls deco(), which calls open()" in notes
    assert "not run from the cells above: 1 more statement(s)" in notes  # at most 3 are named
    res = tracer.run_trace("print(store)\n", prelude=above)
    assert res["notes"][0].endswith(
        "it calls Store(), which has a method save() that calls open(), so store is not defined here")
    # A built-in passed as a value is called by the callee.
    res = tracer.run_trace("print(files)\n", prelude="import functools\nfiles = list(map(open, ['x'], ['w']))\n"
                           "f = functools.partial(open, 'y', 'w')\n")
    assert list(tmp_path.iterdir()) == [] and "it uses open, so files is not defined here" in res["notes"][0]


def test_helpers_that_only_compute_come_from_the_cells_above() -> None:
    above = ("from dataclasses import dataclass, field\nimport heapq\nimport sys\nINF = sys.maxsize\n"
             "class Node:\n    def __init__(self, val, next=None):\n        self.val = val\n        self.next = next\n"
             "    def __repr__(self):\n        return f'{type(self).__name__}({self.val})'\n"
             "class EmptyError(Exception):\n    pass\n"
             "class Stack(list):\n    def __init__(self):\n        super().__init__()\n"
             "    def top(self):\n        if not self:\n            raise EmptyError('empty')\n        return self[-1]\n"
             "    @property\n    def size(self):\n        return len(self)\n"
             "@dataclass\nclass Edge:\n    u: int\n    v: int\n    tags: list = field(default_factory=list)\n"
             "def memo(f):\n    cache = {}\n    def wrapper(*a):\n        if a not in cache:\n            cache[a] = f(*a)\n"
             "        return cache[a]\n    return wrapper\n"
             "@memo\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n"
             "def evens(n):\n    for i in range(n):\n        if i % 2 == 0:\n            yield i\n"
             "def smallest(xs, k):\n    import bisect\n    return heapq.nsmallest(k, xs)\n"
             "head = Node(1, Node(2))\nst = Stack()\nst.append(7)\n")
    res = tracer.run_trace("print(head.next, st.top(), st.size, Edge(1, 2), fib(40), list(evens(5)), "
                           "smallest([5, 1, 4], 2), INF > 0)\n", prelude=above)
    assert res["error"] is None, res["notes"]
    assert res["stdout"] == "Node(2) 7 1 Edge(u=1, v=2, tags=[]) 102334155 [0, 2, 4] [1, 4] True\n"
    assert not any(n.startswith("not run") for n in res["notes"])


def test_a_name_last_set_by_a_skipped_statement_gets_no_older_value() -> None:
    res = tracer.run_trace("print(data)\n", prelude="data = [1, 2]\ndata = load_rows()\n")
    assert res["error"]["ename"] == "NameError"
    assert "line 2 `data = load_rows()`: it calls load_rows(), so data is not defined here" in res["notes"][0]


def test_a_failing_statement_above_is_skipped_and_the_trace_runs() -> None:
    res = tracer.run_trace("print(a, b)\n", prelude="a = 1\nb = [1][5]\n")
    assert res["error"]["ename"] == "NameError"
    assert "line 2 `b = [1][5]` failed: IndexError: list index out of range" in res["notes"]
    assert len(res["steps"]) >= 1


def test_without_needed_names_the_trace_is_the_same() -> None:
    code = "a = [3, 1, 2]\na.sort()\nprint(a)\n"
    plain = tracer.run_trace(code)
    with_above = tracer.run_trace(code, prelude="import heapq\nx = 1\ndef f():\n    return 2\n")
    for r in (plain, with_above):
        r.pop("elapsedMs")
    assert json.dumps(plain, sort_keys=True) == json.dumps(with_above, sort_keys=True)


def test_a_cell_above_with_a_syntax_error_does_not_hide_the_others() -> None:
    above = "# %% a\nx = 5\n# %% b (being edited)\ndef broken(:\n    pass\n# %% c\n%time y = 2\n"
    res = tracer.run_trace("print(x)\n", prelude=above)
    assert res["stdout"] == "5\n" and res["notes"] == ["using from the cells above: x"]
    res = tracer.run_trace("print(broken)\n", prelude=above)
    assert res["notes"][0] == "the cell at line 3 above has a syntax error (line 4); it was not used"


def test_the_cells_above_get_part_of_the_time_budget() -> None:
    above = "def slow():\n    n = 0\n    for i in range(10**9):\n        n += i\n    return n\nbig = slow()\nsmall = 1\n"
    res = tracer.run_trace("print(small)\nprint(big)\n", prelude=above, max_seconds=1.0)
    # The slow call is stopped; the cheap statement after it still runs.
    assert res["stdout"] == "1\n" and res["error"]["ename"] == "NameError"
    assert any(n.startswith("the cells above took more than 0.5 s, so Visualize stopped line 6 `big = slow()`")
               for n in res["notes"]), res["notes"]
    assert res["elapsedMs"] < 1500


def test_a_bare_except_cannot_keep_the_cells_above_or_the_trace_running() -> None:
    # CPython drops a trace function from a frame once it raised; a bare
    # except around the line where the limit hit then looped forever.
    body = "".join(f"            a{i} = n + {i}\n" for i in range(30))
    above = "def spin():\n    n = 0\n    while n >= 0:\n        try:\n" + body + "        except:\n            pass\nr = spin()\nk = 2\n"
    res = tracer.run_trace("print(k)\nprint(r)\n", prelude=above, max_seconds=1.0)
    assert res["stdout"] == "2\n" and res["error"]["ename"] == "NameError" and res["elapsedMs"] < 3000
    assert any("Visualize stopped line 37 `r = spin()`" in n for n in res["notes"]), res["notes"]
    code = "n = 0\nwhile n >= 0:\n    try:\n" + body.replace("            ", "        ") + "    except:\n        pass\n"
    res = tracer.run_trace(code, max_steps=500)
    assert len(res["steps"]) == 500 and res["stopped"].endswith("step limit (500) reached")
    res = tracer.run_trace(code.replace("n >= 0", "True"), max_steps=10**7, max_seconds=0.5)
    assert res["stopped"].endswith("time limit reached") and res["elapsedMs"] < 3000
    assert sys.monitoring.get_tool(4) is None and sys.monitoring.get_tool(3) is None  # released


def test_program_input_is_left_for_the_traced_cell() -> None:
    above = "import sys\ninput = sys.stdin.readline\nn = int(input())\n"
    res = tracer.run_trace("first = input()\nprint(first.strip())\n", prelude=above, stdin="4\n7\n")
    assert res["stdout"] == "4\n"


def test_decorators_star_imports_and_class_bodies_from_above() -> None:
    above = ("from functools import lru_cache\nfrom math import *\n\n@lru_cache(maxsize=None)\n"
             "def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n\n"
             "class Grid:\n    '''a grid'''\n    SIZE = 3\n    def cells(self):\n        return self.SIZE * self.SIZE\n")
    res = tracer.run_trace("print(fib(20), floor(2.5), Grid().cells())\n", prelude=above)
    assert res["error"] is None and res["stdout"] == "6765 2 9\n"


def test_a_star_import_above_brings_only_the_needed_names() -> None:
    res = tracer.run_trace("x = floor(2.5)\n", prelude="from math import *\nfrom collections import *\n")
    names = {n for st in full_stacks(res) for n, _ in st[0]["locals"]}
    assert names == {"floor", "x"}  # not math's pi, e, sqrt, ... in every step
    res = tracer.run_trace("x = 1\n", prelude="from math import *\n")
    assert "notes" not in res and {n for n, _ in res["steps"][-1]["stack"][0]["locals"]} == {"x"}


def test_free_names_follow_python_scopes() -> None:
    import ast

    code = ("import heapq\nys = [x * k for x in data]\ntotal += 1\n"
            "def f(head):\n    prev = None\n    return helper(head, prev) + LIMIT\n")
    names = prelude_mod.free_names(code, ast.parse(code))
    assert {"data", "k", "total", "helper", "LIMIT"} <= names
    assert not {"x", "head", "prev", "heapq", "ys", "f"} & names
    # Bound in the cell itself before `j -= 1`, `r -= 1`: nothing from above.
    code = "for i in range(1, 5):\n    j = i - 1\n    while j >= 0:\n        j -= 1\nl, r = 0, 9\nwhile l < r:\n    r -= 1\n"
    assert prelude_mod.free_names(code, ast.parse(code)) == {"range"}
    res = tracer.run_trace(code, prelude="j = 4\nr = 1\n")
    assert "notes" not in res


@pytest.mark.parametrize("code, needed, not_needed", [
    ("head = reverse(head)\n", {"reverse", "head"}, set()),
    ("nums = sorted(nums)\n", {"nums"}, set()),
    ("print(nums)\nnums = [1]\n", {"nums"}, set()),
    ("if len(nums) > 5:\n    nums = []\nprint(nums)\n", {"nums"}, set()),
    ("if c:\n    x = 1\nelse:\n    x = 2\nprint(x)\n", {"c"}, {"x"}),
    ("try:\n    y = f()\nexcept ValueError:\n    y = 0\nprint(y)\n", {"f"}, {"y"}),
    ("try:\n    y = f()\nexcept ValueError:\n    pass\nprint(y)\n", {"y"}, set()),
    ("for i in range(3):\n    total = total + i\n", {"total"}, {"i"}),
    ("for i in range(3):\n    t = i\nprint(i, t)\n", {"i", "t"}, set()),
    ("while q:\n    seen = 1\nprint(seen)\n", {"q", "seen"}, set()),
    ("if (n := len(a)) > 3:\n    print(n)\n", {"a"}, {"n"}),
    ("ok = a and (b := 1)\nprint(b)\n", {"a", "b"}, set()),
    ("ys = [x for x in xs if x > k]\nk = 2\n", {"xs", "k"}, {"x"}),
    ("g = (x + k for x in xs)\nk = 2\nprint(list(g))\n", {"xs"}, {"k", "x"}),  # runs when consumed
    ("def f():\n    return g()\ndef g():\n    return 1\nf()\n", set(), {"g", "f"}),
    ("class A:\n    n = N\n    m = n + 1\n", {"N"}, {"n", "m"}),
    ("with open(p) as fh:\n    data = fh.read()\nprint(data)\n", {"p"}, {"fh", "data"}),
    ("del x\n", {"x"}, set()),
])
def test_names_the_cell_reads_before_binding_them_come_from_above(
        code: str, needed: set[str], not_needed: set[str]) -> None:
    import ast

    names = prelude_mod.free_names(code, ast.parse(code))
    assert needed <= names and not (not_needed & names), names


@pytest.mark.parametrize("cell", [
    "head = reverse(head)\nprint(head.val)\n",
    "nums = sorted(nums)\nprint(nums)\n",
    "print(nums)\nnums = [1]\n",
    "if len(nums) > 5:\n    nums = []\nprint(nums)\n",
])
def test_a_cell_that_rebinds_a_name_from_above_gets_it(cell: str) -> None:
    above = ("class ListNode:\n    def __init__(self, val, next=None):\n        self.val = val\n        self.next = next\n"
             "def build(vals):\n    head = None\n    for v in reversed(vals):\n        head = ListNode(v, head)\n"
             "    return head\n"
             "def reverse(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n"
             "    return prev\n"
             "head = build([1, 2, 3])\nnums = [5, 3, 8]\n")
    res = tracer.run_trace(cell, prelude=above)
    assert res["error"] is None, res.get("notes")
    assert res["stdout"] in ("3\n", "[3, 5, 8]\n", "[5, 3, 8]\n")
    assert res["notes"][0].startswith("using from the cells above:")


def test_a_module_not_imported_yet_is_not_imported_from_the_cells_above(
        tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "trainer_p1.py").write_text(
        "import pathlib\npathlib.Path(__file__).with_name('SIDE_EFFECT.txt').write_text('imported')\nVALUE = 42\n")
    (tmp_path / "pkg_p1").mkdir()
    (tmp_path / "pkg_p1" / "__init__.py").write_text("")
    (tmp_path / "pkg_p1" / "sub.py").write_text("open(__file__ + '.ran', 'w').close()\nX = 1\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    for name in ("trainer_p1", "pkg_p1", "pkg_p1.sub"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    res = tracer.run_trace("print(trainer_p1.VALUE)\n", prelude="import trainer_p1\n")
    assert not (tmp_path / "SIDE_EFFECT.txt").exists() and res["error"]["ename"] == "NameError"
    assert res["notes"] == ["not run from the cells above: line 1 `import trainer_p1`: it imports trainer_p1, "
                            "which is not imported yet (run the cell above first), so trainer_p1 is not defined here"]
    import pkg_p1  # noqa: F401  - the package is, its submodule is not
    res = tracer.run_trace("print(sub)\n", prelude="from pkg_p1 import sub\n")
    assert not (tmp_path / "pkg_p1" / "sub.py.ran").exists()
    assert "it imports pkg_p1.sub, which is not imported yet" in res["notes"][0]
    import trainer_p1  # noqa: F401  - once Run Cell imported it, it is free
    res = tracer.run_trace("print(trainer_p1.VALUE)\n", prelude="import trainer_p1\nimport json\n")
    assert res["stdout"] == "42\n"
    # Inside a helper the same rule holds.
    res = tracer.run_trace("print(v)\n", prelude="def load():\n    import never_imported_p1\n    return 1\nv = load()\n")
    assert "it calls load(), which imports never_imported_p1" in res["notes"][0]


def test_an_exception_whose_str_is_stopped_by_the_time_budget_is_still_a_note() -> None:
    # str() of the learner's exception runs under the guard: once the budget
    # is used up, its __str__ is stopped, which must not end the trace.
    above = ("class Slow(Exception):\n    def __str__(self):\n        while True:\n            pass\n"
             "def boom():\n    raise Slow()\nx = boom()\ny = 2\n")
    res = tracer.run_trace("print(y)\nprint(x)\n", prelude=above, max_seconds=1.0)
    assert res["stdout"] == "2\n" and res["error"]["ename"] == "NameError"
    assert "line 7 `x = boom()` failed: Slow" in res["notes"], res["notes"]


def test_a_statement_above_that_ran_out_of_time_is_not_run_again_for_the_same_text() -> None:
    above = "def slow():\n    n = 0\n    for i in range(10**9):\n        n += i\n    return n\nbig = slow()\nsmall = 1\n# v2\n"
    first = tracer.run_trace("print(small)\nprint(big)\n", prelude=above, max_seconds=1.0)
    again = tracer.run_trace("print(small, 1)\nprint(big)\n", prelude=above, max_seconds=1.0)
    for res in (first, again):
        assert any("Visualize stopped line 6 `big = slow()`" in n for n in res["notes"])
    assert again["elapsedMs"] < 200 < first["elapsedMs"]
    more = tracer.run_trace("print(small)\nprint(big)\n", prelude=above, max_seconds=4.0)  # more time: tried again
    assert more["elapsedMs"] > 1500
