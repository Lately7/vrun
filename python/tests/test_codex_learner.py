"""Learner-experience QA through the real PyLive worker protocol."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import uuid

import pytest
from conftest import full_heap, full_stacks


def _trace(kernel, code: str, **params: object) -> dict[str, object]:
    response = kernel.call("trace", code=code, **params)
    assert response["ok"], response
    return response["result"]


def _locals(step: dict[str, object], frame: int = -1) -> dict[str, object]:
    stack = step["stack"]
    assert isinstance(stack, list)
    selected = stack[frame]
    assert isinstance(selected, dict)
    return dict(selected["locals"])


def _module_locals(result: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    steps = result["steps"]
    assert isinstance(steps, list) and steps
    step = steps[-1]
    assert isinstance(step, dict)
    # Steps carry heap and stack deltas: give the helpers the complete ones.
    full = {**step, "stack": full_stacks(result)[-1], "heap": full_heap(result)}
    return _locals(full, 0), full


def _heap_node(step: dict[str, object], value: object) -> dict[str, object]:
    assert isinstance(value, dict) and "ref" in value
    heap = step["heap"]
    assert isinstance(heap, dict)
    node = heap[str(value["ref"])]
    assert isinstance(node, dict)
    return node


def _quoted(path: Path) -> str:
    return json.dumps(str(path))


@pytest.fixture()
def pandas_module():
    return pytest.importorskip("pandas")


class _FlatTmpPath:
    def __init__(self) -> None:
        self.prefix = f"pylive-learner-{uuid.uuid4().hex}-"
        self.paths: list[Path] = []

    def __truediv__(self, name: str) -> Path:
        path = Path(tempfile.gettempdir()) / f"{self.prefix}{name}"
        self.paths.append(path)
        return path


@pytest.fixture()
def tmp_path():
    # Python 3.15 on Windows can make newly-created temp directories unreadable.
    # Unique files in the existing temp root retain tmp_path's isolation.
    temporary = _FlatTmpPath()
    yield temporary
    for path in temporary.paths:
        path.unlink(missing_ok=True)


# DSA visualizer and program-input journeys ---------------------------------


def test_student_fib_25_stops_at_step_limit_instead_of_hanging(kernel):
    result = _trace(
        kernel,
        "def fib(n):\n"
        "    if n < 2:\n"
        "        return n\n"
        "    return fib(n - 1) + fib(n - 2)\n"
        "answer = fib(25)\n",
        maxSteps=250,
        timeoutMs=5_000,
    )
    assert result["error"] is None
    assert result["stopped"] == "step limit (250) reached"
    assert len(result["steps"]) == 250


def test_student_can_follow_mutual_recursion(kernel):
    result = _trace(
        kernel,
        "def is_even(n):\n"
        "    return True if n == 0 else is_odd(n - 1)\n"
        "def is_odd(n):\n"
        "    return False if n == 0 else is_even(n - 1)\n"
        "answer = is_even(8)\n",
    )
    locals_, _ = _module_locals(result)
    functions = {
        frame["func"]
        for stack in full_stacks(result)
        for frame in stack
    }
    assert result["error"] is None
    assert {"is_even", "is_odd"} <= functions
    assert locals_["answer"] is True


def test_student_sees_generator_yields_and_collected_values(kernel):
    result = _trace(
        kernel,
        "def squares(n):\n"
        "    for i in range(n):\n"
        "        yield i * i\n"
        "values = list(squares(4))\n",
    )
    locals_, step = _module_locals(result)
    values = _heap_node(step, locals_["values"])
    yielded = [
        trace_step.get("ret")
        for trace_step in result["steps"]
        if trace_step["event"] == "return"
        and trace_step["stack"][-1]["func"] == "squares"
        and trace_step.get("ret") is not None
    ]
    assert result["error"] is None
    assert values["items"] == [0, 1, 4, 9]
    assert yielded == [0, 1, 4, 9]


def test_student_sees_list_comprehension_inside_function(kernel):
    result = _trace(
        kernel,
        "def make_squares(n):\n"
        "    return [i * i for i in range(n)]\n"
        "answer = make_squares(5)\n",
    )
    locals_, step = _module_locals(result)
    answer = _heap_node(step, locals_["answer"])
    assert result["error"] is None
    assert answer["items"] == [0, 1, 4, 9, 16]
    assert any(trace_step["line"] == 2 for trace_step in result["steps"])


def test_student_sees_slots_linked_list_nodes(kernel):
    result = _trace(
        kernel,
        "class Node:\n"
        "    __slots__ = ('value', 'next')\n"
        "    def __init__(self, value):\n"
        "        self.value = value\n"
        "        self.next = None\n"
        "head = Node(1)\n"
        "head.next = Node(2)\n"
        "tail = head.next\n",
    )
    locals_, step = _module_locals(result)
    head = _heap_node(step, locals_["head"])
    assert result["error"] is None
    assert head["kind"] == "object"
    assert head["type"] == "Node"
    assert dict(head["fields"])["value"] == 1
    assert "next" in dict(head["fields"])


def test_student_sees_tuple_assignment_swaps_in_bubble_sort(kernel):
    result = _trace(
        kernel,
        "arr = [5, 1, 4, 2]\n"
        "for i in range(len(arr)):\n"
        "    for j in range(len(arr) - i - 1):\n"
        "        if arr[j] > arr[j + 1]:\n"
        "            arr[j], arr[j + 1] = arr[j + 1], arr[j]\n",
    )
    locals_, step = _module_locals(result)
    arr = _heap_node(step, locals_["arr"])
    snapshots = []
    for k, trace_step in enumerate(result["steps"]):
        current = _locals(trace_step, 0).get("arr")
        if isinstance(current, dict) and "ref" in current:
            full = {**trace_step, "heap": full_heap(result, k)}  # steps carry heap deltas
            snapshots.append(_heap_node(full, current)["items"])
    assert result["error"] is None
    assert arr["items"] == [1, 2, 4, 5]
    assert [1, 5, 4, 2] in snapshots


def test_student_defaultdict_list_is_visible_as_a_graph(kernel):
    result = _trace(
        kernel,
        "from collections import defaultdict\n"
        "graph = defaultdict(list)\n"
        "for u, v in [('A', 'B'), ('A', 'C'), ('B', 'D')]:\n"
        "    graph[u].append(v)\n"
        "visited = {'A'}\n",
    )
    locals_, step = _module_locals(result)
    assert result["error"] is None
    assert isinstance(locals_["graph"], dict) and "ref" in locals_["graph"], locals_["graph"]
    graph = _heap_node(step, locals_["graph"])
    assert graph["kind"] == "dict"
    assert graph["len"] == 2


def test_student_heapq_of_priority_tuples_keeps_heap_shape(kernel):
    result = _trace(
        kernel,
        "import heapq\n"
        "pq = []\n"
        "for item in [(3, 'C'), (1, 'A'), (2, 'B')]:\n"
        "    heapq.heappush(pq, item)\n"
        "first = heapq.heappop(pq)\n",
    )
    locals_, step = _module_locals(result)
    pq = _heap_node(step, locals_["pq"])
    first = _heap_node(step, locals_["first"])
    assert result["error"] is None
    assert first["items"] == [1, "A"]
    assert pq["len"] == 2
    assert all(isinstance(item, dict) and "ref" in item for item in pq["items"])


def test_student_dict_of_sets_is_visible_for_adjacency(kernel):
    result = _trace(
        kernel,
        "graph = {'A': {'B', 'C'}, 'B': {'A'}, 'C': {'A'}}\n"
        "seen = set()\n"
        "seen.add('A')\n",
    )
    locals_, step = _module_locals(result)
    graph = _heap_node(step, locals_["graph"])
    set_nodes = [
        _heap_node(step, value)
        for _, value in graph["entries"]
    ]
    assert result["error"] is None
    assert graph["kind"] == "dict"
    assert all(node["kind"] == "set" for node in set_nodes)


def test_student_judge_input_handles_multiple_test_cases(kernel):
    code = (
        "t = int(input())\n"
        "answers = []\n"
        "for _ in range(t):\n"
        "    a, b = map(int, input().split())\n"
        "    answers.append(a + b)\n"
        "print(*answers, sep='\\n')\n"
    )
    result = _trace(kernel, code, stdin="3\n1 2\n10 20\n-5 8\n")
    assert result["error"] is None
    assert result["stdout"] == "3\n30\n3\n"


def test_student_fast_io_with_sys_stdin_read_split(kernel):
    result = kernel.run(
        "import sys\nnums = list(map(int, sys.stdin.read().split()))\nsum(nums)",
        stdin="5\n10 20 30 40 50\n",
    )
    assert result["status"] == "ok"
    assert result["value"]["repr"] == "155"


def test_student_gets_clear_message_when_program_input_is_exhausted(kernel):
    result = kernel.run(
        "first = input()\nsecond = input()\n",
        file="solution.py",
        stdin="only one line\n",
    )
    assert result["status"] == "error"
    assert result["error"]["ename"] == "EOFError"
    assert "no more lines in the .in file" in result["error"]["evalue"]
    assert result["error"]["userFrame"]["line"] == 2


def test_student_print_sep_and_end_are_preserved(kernel):
    kernel.run("print('left', 'right', sep=' -> ', end='!')\nprint('done')")
    assert kernel.stream_text("stdout") == "left -> right!done\n"


def test_student_recursionlimit_change_is_traced_and_restored(kernel):
    result = _trace(
        kernel,
        "import sys\n"
        "old_limit = sys.getrecursionlimit()\n"
        "try:\n"
        "    sys.setrecursionlimit(80)\n"
        "    def dive(n):\n"
        "        return dive(n + 1)\n"
        "    dive(0)\n"
        "except RecursionError:\n"
        "    caught = True\n"
        "    print('caught')\n"
        "finally:\n"
        "    sys.setrecursionlimit(old_limit)\n",
        maxSteps=1_000,
    )
    locals_, _ = _module_locals(result)
    assert result["error"] is None
    assert result["stopped"] == (
        "tracing stopped at the recursion limit; later steps are not shown"
    )
    assert result["stdout"] == "caught\n"
    assert locals_.get("caught") is None


def test_student_very_long_single_line_output_is_cleanly_truncated(kernel):
    result = _trace(kernel, "print('x' * 250000, end='')")
    assert result["error"] is None
    assert result["stdoutTruncated"] is True
    assert result["stdout"].startswith("x" * 200_000)
    assert "output truncated" in result["stdout"]


def test_student_nested_trace_error_highlights_the_raising_line(kernel):
    result = _trace(
        kernel,
        "def explode():\n"
        "    return 10 / 0\n"
        "def wrapper():\n"
        "    return explode()\n"
        "wrapper()\n",
    )
    error = result["error"]
    assert error["ename"] == "ZeroDivisionError"
    assert error["userFrame"]["line"] == 2
    assert "return 10 / 0" in error["traceback"]


def test_student_global_and_nonlocal_updates_appear_in_trace(kernel):
    result = _trace(
        kernel,
        "total = 0\n"
        "def add_global(x):\n"
        "    global total\n"
        "    total += x\n"
        "def make_counter():\n"
        "    count = 0\n"
        "    def step():\n"
        "        nonlocal count\n"
        "        count += 1\n"
        "        return count\n"
        "    return step\n"
        "counter = make_counter()\n"
        "add_global(7)\n"
        "values = [counter(), counter()]\n",
    )
    locals_, step = _module_locals(result)
    values = _heap_node(step, locals_["values"])
    assert result["error"] is None
    assert locals_["total"] == 7
    assert values["items"] == [1, 2]


# Pandas preprocessing journeys in Live Mode -------------------------------


def test_live_preprocessing_is_pristine_and_does_not_reread_deleted_csv(
    kernel, tmp_path, pandas_module
):
    csv_path = tmp_path / "students.csv"
    pandas_module.DataFrame(
        {
            "student": ["Ada", "Bob", "Cy"],
            "age": [20, None, 22],
            "score": [None, 8.5, 9.0],
            "unused": [1, 2, 3],
        }
    ).to_csv(csv_path, index=False)
    code = (
        "import pandas as pd\n"
        f"path = {_quoted(csv_path)}\n"
        "df = pd.read_csv(path)\n"
        "df.dropna(subset=['age'], inplace=True)\n"
        "df['score'] = df['score'].fillna(0)\n"
        "df['age'] = df['age'].astype('int64')\n"
        "df.rename(columns={'student': 'name'}, inplace=True)\n"
        "df.drop(columns=['unused'], inplace=True)\n"
        "df.to_dict('records')\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    csv_path.unlink()
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    third = kernel.run(code, mode="live", timeoutMs=5_000)
    expected = "[{'name': 'Ada', 'age': 20, 'score': 0.0}, {'name': 'Cy', 'age': 22, 'score': 9.0}]"
    assert first["value"]["repr"] == expected
    assert second["value"]["repr"] == third["value"]["repr"] == expected
    assert len(first["loadedNow"]) == 1
    assert len(second["skippedLoads"]) == len(third["skippedLoads"]) == 1


def test_live_inplace_series_operation_and_chained_assignment_are_repeatable(
    kernel, tmp_path, pandas_module
):
    csv_path = tmp_path / "scores.csv"
    pandas_module.DataFrame({"score": [None, 2.0], "keep": [True, False]}).to_csv(
        csv_path, index=False
    )
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(csv_path)})\n"
        "df['score'].fillna(0, inplace=True)\n"
        "df.loc[df['keep'], 'score'] = 99\n"
        "df['score'].tolist()\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    assert first["value"]["repr"] == "[99.0, 2.0]"
    assert second["value"]["repr"] == "[99.0, 2.0]"
    assert second["skippedLoads"]


def test_live_groupby_agg_and_value_counts_match_student_expectation(
    kernel, tmp_path, pandas_module
):
    csv_path = tmp_path / "sales.csv"
    pandas_module.DataFrame(
        {"team": ["red", "red", "blue"], "score": [2, 4, 5]}
    ).to_csv(csv_path, index=False)
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(csv_path)})\n"
        "summary = df.groupby('team').agg(total=('score', 'sum'), average=('score', 'mean'))\n"
        "counts = df['team'].value_counts()\n"
        "(summary.loc['red', 'total'], summary.loc['blue', 'average'], counts.to_dict())\n"
    )
    result = kernel.run(code, mode="live", timeoutMs=5_000)
    assert result["value"]["repr"] == "(6, 5.0, {'red': 2, 'blue': 1})"


def test_live_second_load_can_depend_on_first_then_merge_without_rereading(
    kernel, tmp_path, pandas_module
):
    right_path = tmp_path / "grades.csv"
    left_path = tmp_path / "students-with-path.csv"
    pandas_module.DataFrame({"id": [1, 2], "grade": [90, 80]}).to_csv(
        right_path, index=False
    )
    pandas_module.DataFrame(
        {
            "id": [1, 2],
            "name": ["Ada", "Bob"],
            "right_path": [str(right_path), str(right_path)],
        }
    ).to_csv(left_path, index=False)
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(left_path)})\n"
        "path2 = df.loc[0, 'right_path']\n"
        "df2 = pd.read_csv(path2)\n"
        "merged = df.merge(df2, on='id')\n"
        "merged[['name', 'grade']].to_dict('records')\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    left_path.unlink()
    right_path.unlink()
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    expected = "[{'name': 'Ada', 'grade': 90}, {'name': 'Bob', 'grade': 80}]"
    assert first["value"]["repr"] == second["value"]["repr"] == expected
    assert len(first["loadedNow"]) == 2
    assert len(second["skippedLoads"]) == 2


def test_live_to_datetime_and_apply_lambda(kernel, tmp_path, pandas_module):
    csv_path = tmp_path / "dates.csv"
    pandas_module.DataFrame(
        {"when": ["2024-01-02", "2024-02-03"], "name": ["ada", "bob"]}
    ).to_csv(csv_path, index=False)
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(csv_path)})\n"
        "df['when'] = pd.to_datetime(df['when'])\n"
        "df['name'] = df['name'].apply(lambda value: value.title())\n"
        "(df['when'].dt.month.tolist(), df['name'].tolist())\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    assert first["value"]["repr"] == second["value"]["repr"] == "([1, 2], ['Ada', 'Bob'])"


def test_live_df_head_as_last_expression_is_a_dataframe_result(
    kernel, tmp_path, pandas_module
):
    csv_path = tmp_path / "many.csv"
    pandas_module.DataFrame({"x": range(10), "y": range(10, 20)}).to_csv(
        csv_path, index=False
    )
    code = f"import pandas as pd\ndf = pd.read_csv({_quoted(csv_path)})\ndf.head()"
    result = kernel.run(code, mode="live", timeoutMs=5_000)
    assert result["status"] == "ok"
    assert result["value"]["dataframe"] is True
    assert result["value"]["shape"] == [5, 2]
    assert "0  10" in result["value"]["repr"]


def test_live_df_describe_as_last_expression_is_useful(kernel, tmp_path, pandas_module):
    csv_path = tmp_path / "numbers.csv"
    pandas_module.DataFrame({"x": [1, 2, 3], "y": [10, 20, 30]}).to_csv(
        csv_path, index=False
    )
    code = f"import pandas as pd\ndf = pd.read_csv({_quoted(csv_path)})\ndf.describe()"
    result = kernel.run(code, mode="live", timeoutMs=5_000)
    assert result["value"]["dataframe"] is True
    assert result["value"]["shape"] == [8, 2]
    assert "mean" in result["value"]["repr"]
    assert "20.0" in result["value"]["repr"]


def test_live_new_column_filter_sort_and_reset_index(kernel, tmp_path, pandas_module):
    csv_path = tmp_path / "orders.csv"
    pandas_module.DataFrame(
        {"item": ["a", "b", "c"], "price": [4, 10, 6], "qty": [3, 1, 2]}
    ).to_csv(csv_path, index=False)
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(csv_path)})\n"
        "df['total'] = df['price'] * df['qty']\n"
        "result = df[df['total'] >= 12].sort_values('total', ascending=False).reset_index(drop=True)\n"
        "result[['item', 'total']].to_dict('records')\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    expected = "[{'item': 'a', 'total': 12}, {'item': 'c', 'total': 12}]"
    assert first["value"]["repr"] == second["value"]["repr"] == expected


def test_live_pivot_table_result_is_stable(kernel, tmp_path, pandas_module):
    csv_path = tmp_path / "pivot.csv"
    pandas_module.DataFrame(
        {
            "team": ["red", "red", "blue", "blue"],
            "day": ["Mon", "Tue", "Mon", "Tue"],
            "score": [2, 4, 3, 5],
        }
    ).to_csv(csv_path, index=False)
    code = (
        "import pandas as pd\n"
        f"df = pd.read_csv({_quoted(csv_path)})\n"
        "table = df.pivot_table(index='team', columns='day', values='score', aggfunc='sum')\n"
        "(table.loc['red', 'Mon'], table.loc['blue', 'Tue'], table.shape)\n"
    )
    first = kernel.run(code, mode="live", timeoutMs=5_000)
    second = kernel.run(code, mode="live", timeoutMs=5_000)
    assert first["value"]["repr"] == second["value"]["repr"] == "(2, 5, (2, 2))"


def test_live_editing_read_statement_forces_reread(kernel, tmp_path, pandas_module):
    csv_path = tmp_path / "edit-read.csv"
    pandas_module.DataFrame({"x": [1, 2]}).to_csv(csv_path, index=False)
    first_code = f"import pandas as pd\ndf = pd.read_csv({_quoted(csv_path)})\ndf['x'].sum()"
    edited_code = (
        f"import pandas as pd\ndf = pd.read_csv({_quoted(csv_path)}, "
        "dtype={'x': 'int64'})\ndf['x'].sum()"
    )
    first = kernel.run(first_code, mode="live", timeoutMs=5_000)
    edited = kernel.run(edited_code, mode="live", timeoutMs=5_000)
    assert len(first["loadedNow"]) == len(edited["loadedNow"]) == 1
    assert edited["skippedLoads"] == []
    assert first["value"]["repr"] == edited["value"]["repr"] == "3"


def test_live_editing_path_variable_forces_reread(kernel, tmp_path, pandas_module):
    first_path = tmp_path / "first.csv"
    second_path = tmp_path / "second.csv"
    pandas_module.DataFrame({"x": [1]}).to_csv(first_path, index=False)
    pandas_module.DataFrame({"x": [7]}).to_csv(second_path, index=False)
    template = "import pandas as pd\npath = {path}\ndf = pd.read_csv(path)\ndf['x'].sum()"
    first = kernel.run(
        template.format(path=_quoted(first_path)), mode="live", timeoutMs=5_000
    )
    second = kernel.run(
        template.format(path=_quoted(second_path)), mode="live", timeoutMs=5_000
    )
    assert len(second["loadedNow"]) == 1
    assert second["skippedLoads"] == []
    assert first["value"]["repr"] == "1"
    assert second["value"]["repr"] == "7"


def test_live_read_excel_without_openpyxl_gives_install_hint(kernel, tmp_path, pandas_module):
    kernel.run(
        "import importlib.abc\n"
        "import sys\n"
        "import pandas as pd\n"
        "class BlockOpenpyxl(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, fullname, path=None, target=None):\n"
        "        if fullname == 'openpyxl' or fullname.startswith('openpyxl.'):\n"
        "            raise ModuleNotFoundError(\"No module named 'openpyxl'\")\n"
        "block_openpyxl = BlockOpenpyxl()\n"
        "sys.meta_path.insert(0, block_openpyxl)\n"
        "for module_name in list(sys.modules):\n"
        "    if module_name == 'openpyxl' or module_name.startswith('openpyxl.'):\n"
        "        del sys.modules[module_name]\n"
    )
    missing_path = tmp_path / "workbook.xlsx"
    result = kernel.run(
        f"df = pd.read_excel({_quoted(missing_path)}, engine='openpyxl')",
        file="clean_data.py",
        mode="live",
        timeoutMs=5_000,
    )
    assert result["status"] == "error"
    assert result["error"]["ename"] in {"ImportError", "ModuleNotFoundError"}
    message = result["error"]["evalue"].lower()
    assert "openpyxl" in message
    assert "install" in message
    assert result["error"]["userFrame"]["line"] == 1


def test_live_failed_load_points_to_line_and_is_retried_next_run(
    kernel, tmp_path, pandas_module
):
    csv_path = tmp_path / "appears-later.csv"
    code = (
        "import pandas as pd\n"
        f"path = {_quoted(csv_path)}\n"
        "df = pd.read_csv(path)\n"
        "df['x'].sum()\n"
    )
    first = kernel.run(
        code, file="retry_load.py", mode="live", timeoutMs=5_000
    )
    assert first["status"] == "error"
    assert first["error"]["ename"] == "FileNotFoundError"
    assert first["error"]["userFrame"]["file"] == "retry_load.py"
    assert first["error"]["userFrame"]["line"] == 3
    pandas_module.DataFrame({"x": [4, 6]}).to_csv(csv_path, index=False)
    second = kernel.run(
        code, file="retry_load.py", mode="live", timeoutMs=5_000
    )
    assert second["status"] == "ok"
    assert len(second["loadedNow"]) == 1
    assert second["skippedLoads"] == []
    assert second["value"]["repr"] == "10"
