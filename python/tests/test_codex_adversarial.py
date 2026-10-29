"""Adversarial end-to-end tests for worker protocol and inspection edges."""

from __future__ import annotations

import json
import sys
import time
from typing import Any

import pytest

from pylive_kernel import tracer


def _write_raw(kernel: Any, payload: bytes) -> None:
    assert kernel.proc.stdin
    kernel.proc.stdin.write(payload + b"\n")
    kernel.proc.stdin.flush()


def _write_message(kernel: Any, message: dict[str, Any]) -> None:
    _write_raw(kernel, json.dumps(message).encode("utf-8"))


def test_unicode_crlf_and_no_final_newline_execute(kernel):
    code = "greeting = '你好, chào bạn 😀'\r\nprint(greeting)\r\ngreeting"
    result = kernel.run(code, file="unicodé_😀.py")

    assert result["status"] == "ok"
    assert result["value"]["repr"] == repr("你好, chào bạn 😀")
    assert "你好, chào bạn 😀\n" in kernel.stream_text()


def test_lone_surrogate_output_does_not_kill_protocol(kernel):
    rid = kernel.send("execute", code="print('\\ud800')\n123")
    response = kernel.wait(rid, timeout=5)

    assert response["ok"] is True
    assert response["result"]["value"]["repr"] == "123"
    assert kernel.call("ping", timeout=2)["result"]["pong"] is True


def test_execute_recursion_error_is_reported_and_kernel_recovers(kernel):
    result = kernel.run("def dive(n):\n    return dive(n + 1)\ndive(0)", file="deep.py")

    assert result["status"] == "error"
    assert result["error"]["ename"] == "RecursionError"
    assert result["error"]["userFrame"]["file"] == "deep.py"
    assert kernel.run("6 * 7")["value"]["repr"] == "42"


def test_trace_recursion_error_is_bounded_and_restores_process_state():
    before_trace = sys.gettrace()
    result = tracer.run_trace(
        "def dive(n):\n    return dive(n + 1)\ndive(0)\n",
        max_steps=5_000,
        max_bytes=100_000_000,
        max_seconds=5,
    )

    assert result["stopped"] is None
    assert result["error"]["ename"] == "RecursionError"
    assert len(result["steps"]) < 5_000
    assert sys.gettrace() is before_trace


def test_raising_repr_as_last_expression_is_safe(kernel):
    result = kernel.run(
        "class BadRepr:\n"
        "    def __repr__(self):\n"
        "        raise RuntimeError('repr exploded')\n"
        "BadRepr()"
    )

    assert result["status"] == "ok"
    assert result["value"]["repr"] == "<repr failed: RuntimeError>"
    assert kernel.run("40 + 2")["value"]["repr"] == "42"


def test_replacing_and_restoring_sys_stdout_follows_python_semantics(kernel):
    kernel.run("import io, sys\nredirected = io.StringIO()\nsys.stdout = redirected")
    before = len(kernel.events)
    kernel.run("print('only in buffer')", execId="redirected")
    redirected_events = kernel.events[before:]

    assert not any(
        event.get("event") == "stream" and "only in buffer" in event.get("text", "")
        for event in redirected_events
    )
    assert kernel.run("redirected.getvalue()")["value"]["repr"] == "'only in buffer\\n'"

    kernel.run("sys.stdout = sys.__stdout__")
    before = len(kernel.events)
    kernel.run("print('capture restored')", execId="restored")
    restored_events = kernel.events[before:]
    assert any(
        event.get("event") == "stream"
        and event.get("execId") == "restored"
        and "capture restored" in event.get("text", "")
        for event in restored_events
    )


def test_late_thread_output_becomes_background_after_new_execution(kernel):
    kernel.run(
        "import threading, time\n"
        "def late_print():\n"
        "    time.sleep(0.25)\n"
        "    print('late-from-first')\n"
        "threading.Thread(target=late_print, daemon=True).start()",
        execId="first",
    )
    before = len(kernel.events)
    kernel.run("import time\ntime.sleep(0.5)", execId="second")
    late_events = [
        event for event in kernel.events[before:]
        if event.get("event") == "stream" and "late-from-first" in event.get("text", "")
    ]

    assert late_events
    assert {event.get("execId") for event in late_events} == {None}


def test_inspect_cyclic_list_and_dict_preserves_back_references(kernel):
    kernel.run(
        "cyclic_list = []\n"
        "cyclic_list.append(cyclic_list)\n"
        "cyclic_dict = {}\n"
        "cyclic_dict['self'] = cyclic_dict"
    )
    list_info = kernel.call("variables.inspect", name="cyclic_list")["result"]
    dict_info = kernel.call("variables.inspect", name="cyclic_dict")["result"]

    list_ref = list_info["root"]["ref"]
    dict_ref = dict_info["root"]["ref"]
    assert list_info["heap"][str(list_ref)]["items"] == [{"ref": list_ref}]
    assert dict_info["heap"][str(dict_ref)]["entries"] == [
        ["self", {"ref": dict_ref}]
    ]


def test_slots_and_hostile_dict_descriptor_are_inspected_without_user_code(kernel):
    kernel.run(
        "dict_reads = 0\n"
        "class Slotted:\n"
        "    __slots__ = ('value',)\n"
        "    def __init__(self): self.value = 9\n"
        "class HostileDict:\n"
        "    __slots__ = ()\n"
        "    @property\n"
        "    def __dict__(self):\n"
        "        global dict_reads\n"
        "        dict_reads += 1\n"
        "        raise RuntimeError('must not run')\n"
        "slotted = Slotted()\n"
        "hostile = HostileDict()"
    )
    slotted = kernel.call("variables.inspect", name="slotted")
    hostile = kernel.call("variables.inspect", name="hostile")

    assert slotted["ok"] is True
    root = slotted["result"]["root"]["ref"]
    assert dict(slotted["result"]["heap"][str(root)]["fields"])["value"] == 9
    assert hostile["ok"] is True, hostile
    assert kernel.run("dict_reads")["value"]["repr"] == "0"


def test_metaclass_dict_property_is_not_run_by_inspection(kernel):
    kernel.run(
        "meta_dict_reads = []\n"
        "class DictMeta(type):\n"
        "    @property\n"
        "    def __dict__(cls):\n"
        "        meta_dict_reads.append('read')\n"
        "        raise RuntimeError('metaclass __dict__ must not run')\n"
        "class MetaVictim(metaclass=DictMeta):\n"
        "    pass\n"
        "meta_victim = MetaVictim()"
    )
    response = kernel.call("variables.inspect", name="meta_victim")
    reads = kernel.run("meta_dict_reads")["value"]["repr"]

    assert response["ok"] is True and reads == "[]", (response, reads)


def test_shadowing_property_does_not_hide_safe_base_slot(kernel):
    kernel.run(
        "slot_property_reads = 0\n"
        "class BaseSlot:\n"
        "    __slots__ = ('value',)\n"
        "class SlotChild(BaseSlot):\n"
        "    __slots__ = ()\n"
        "    @property\n"
        "    def value(self):\n"
        "        global slot_property_reads\n"
        "        slot_property_reads += 1\n"
        "        raise RuntimeError('property must not run')\n"
        "shadowed_slot = SlotChild()\n"
        "BaseSlot.__dict__['value'].__set__(shadowed_slot, 42)"
    )
    info = kernel.call("variables.inspect", name="shadowed_slot")["result"]
    root = info["root"]["ref"]
    fields = dict(info["heap"][str(root)]["fields"])

    assert fields["value"] == 42
    assert kernel.run("slot_property_reads")["value"]["repr"] == "0"


def test_dataframe_duplicate_multiindex_and_non_string_columns(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "df_labels = pd.DataFrame([[1, 2, 3]], "
        "columns=pd.MultiIndex.from_tuples([('a', 1), ('a', 1), (2, 'x')]))"
    )
    metadata = kernel.call("dataframe.metadata", name="df_labels")["result"]
    page = kernel.call("dataframe.page", name="df_labels", offset=0, limit=5)["result"]

    expected = ["(a, 1)", "(a, 1)", "(2, x)"]
    assert [column["name"] for column in metadata["columns"]] == expected
    assert page["columns"] == expected
    assert page["rows"] == [[1, 2, 3]]


def test_dataframe_huge_integer_cell_remains_lossless(kernel):
    pytest.importorskip("pandas")
    kernel.run("import pandas as pd\nhuge_df = pd.DataFrame({'n': [10**5000]})")
    page = kernel.call("dataframe.page", name="huge_df", offset=0, limit=1)["result"]

    cell = page["rows"][0][0]
    assert cell["$t"] == "int"
    assert cell["bits"] > 16_000
    assert cell["sign"] == 1


def test_dataframe_empty_and_offset_beyond_total(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "empty_df = pd.DataFrame(columns=['a'])\n"
        "small_df = pd.DataFrame({'a': [1, 2]})"
    )
    empty = kernel.call("dataframe.page", name="empty_df", offset=0, limit=10)["result"]
    beyond = kernel.call("dataframe.page", name="small_df", offset=99, limit=10)["result"]

    assert empty["total"] == 0 and empty["rows"] == [] and empty["columns"] == ["a"]
    assert beyond["total"] == 2 and beyond["rows"] == [] and beyond["positions"] == []


def test_dataframe_invalid_boolean_filter_is_rejected(kernel):
    pytest.importorskip("pandas")
    kernel.run("import pandas as pd\nbool_df = pd.DataFrame({'flag': [True, False]})")
    response = kernel.call(
        "dataframe.page",
        name="bool_df",
        offset=0,
        limit=10,
        filter={"column": 0, "op": "eq", "value": "definitely-not-a-bool"},
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"


def test_dataframe_nullable_boolean_filters_do_not_match_na(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "nullable_bool_df = pd.DataFrame({\n"
        "    'flag': pd.Series([True, False, pd.NA], dtype='boolean')\n"
        "})"
    )
    false_page = kernel.call(
        "dataframe.page",
        name="nullable_bool_df",
        offset=0,
        limit=10,
        filter={"column": 0, "op": "eq", "value": "false"},
    )["result"]
    true_page = kernel.call(
        "dataframe.page",
        name="nullable_bool_df",
        offset=0,
        limit=10,
        filter={"column": 0, "op": "eq", "value": "TRUE"},
    )["result"]

    assert false_page["positions"] == [1]
    assert true_page["positions"] == [0]


def test_dataframe_nullable_integer_decimal_filter_is_exact_above_2_53(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "nullable_big_df = pd.DataFrame({\n"
        "    'n': pd.Series([2**53, 2**53 + 1, pd.NA], dtype='Int64')\n"
        "})"
    )
    page = kernel.call(
        "dataframe.page",
        name="nullable_big_df",
        offset=0,
        limit=10,
        filter={"column": 0, "op": "eq", "value": f"{2**53 + 1}.0"},
    )["result"]

    assert page["positions"] == [1]


def test_dataframe_timezone_and_numeric_category_filters(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "typed_df = pd.DataFrame({\n"
        "    'when': pd.to_datetime(['2024-01-01', '2024-01-02'], utc=True),\n"
        "    'category': pd.Categorical([1, 2]),\n"
        "})"
    )
    dates = kernel.call(
        "dataframe.page",
        name="typed_df",
        offset=0,
        limit=10,
        filter={"column": 0, "op": "eq", "value": "2024-01-02T00:00:00Z"},
    )["result"]
    categories = kernel.call(
        "dataframe.page",
        name="typed_df",
        offset=0,
        limit=10,
        filter={"column": 1, "op": "eq", "value": 2},
    )["result"]

    assert dates["total"] == 1 and dates["positions"] == [1]
    assert categories["total"] == 1 and categories["positions"] == [1]


def test_dataframe_mixed_object_sort_fails_cleanly(kernel):
    pytest.importorskip("pandas")
    kernel.run("import pandas as pd\nmixed_df = pd.DataFrame({'value': [1, 'two', 3]})")
    response = kernel.call(
        "dataframe.page",
        name="mixed_df",
        offset=0,
        limit=10,
        sort={"column": 0, "ascending": True},
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert kernel.run("21 * 2")["value"]["repr"] == "42"


def test_variables_list_queued_behind_interrupted_execute_still_runs(kernel):
    running = kernel.send("execute", code="counter = 0\nwhile True:\n    counter += 1")
    queued = kernel.send("variables.list")
    time.sleep(0.2)
    interrupt = kernel.call("interrupt", target=running)

    assert interrupt["result"]["interrupted"] is True
    assert kernel.wait(running, timeout=5)["result"]["interrupted"] == "interrupted"
    listed = kernel.wait(queued, timeout=5)
    assert listed["ok"] is True
    assert "counter" in {item["name"] for item in listed["result"]["variables"]}


def test_interrupt_during_trace_returns_promptly_and_kernel_recovers(kernel):
    running = kernel.send(
        "trace",
        code="import time\nwhile True:\n    time.sleep(0.02)",
        maxSteps=20_000,
        timeoutMs=10_000,
    )
    time.sleep(0.2)
    interrupt = kernel.call("interrupt", target=running)
    response = kernel.wait(running, timeout=5)

    assert interrupt["result"]["interrupted"] is True
    assert response["ok"] is False
    assert response["error"]["code"] == "interrupted"
    assert kernel.run("7 * 6")["value"]["repr"] == "42"


def test_malformed_and_non_object_json_recover_for_next_request(kernel):
    _write_raw(kernel, b"{this is not json}")
    malformed = kernel.wait(None, timeout=3)
    _write_raw(kernel, b"[1, 2, 3]")
    non_object = kernel.wait(None, timeout=3)

    assert malformed["error"]["code"] == "bad_request"
    assert non_object["error"]["code"] == "bad_request"
    assert kernel.call("ping", timeout=2)["result"]["pong"] is True


def test_string_request_id_round_trips_and_unknown_cancel_is_harmless(kernel):
    request_id = "request-😀"
    _write_message(kernel, {"id": request_id, "type": "ping"})
    ping = kernel.wait(request_id, timeout=3)
    cancel = kernel.call("cancel", target="does-not-exist")

    assert ping["id"] == request_id and ping["result"]["pong"] is True
    assert cancel["ok"] is True and cancel["result"]["cancelled"] is False


def test_ten_megabyte_print_is_bounded_and_kernel_survives(kernel):
    result = kernel.run("print('x' * (10 * 1024 * 1024))")
    output = kernel.stream_text()

    assert result["status"] == "ok"
    assert result["outputTruncated"] is True
    assert "[vrun: output truncated]" in output
    assert len(output) <= 2 * 1024 * 1024 + 100
    assert kernel.call("ping", timeout=2)["result"]["pong"] is True


def test_inspect_deleted_variable_returns_not_found(kernel):
    kernel.run("temporary = {'alive': True}")
    kernel.run("del temporary")
    response = kernel.call("variables.inspect", name="temporary")

    assert response["ok"] is False
    assert response["error"]["code"] == "not_found"


def test_generator_and_lambda_listing_does_not_consume_generator(kernel):
    kernel.run("gen = (i for i in range(3))\nfn = lambda x: x + 1")
    variables = kernel.call("variables.list")["result"]["variables"]
    by_name = {item["name"]: item for item in variables}

    assert by_name["gen"]["kind"] == "object"
    assert by_name["fn"]["kind"] == "function"
    assert kernel.run("next(gen)")["value"]["repr"] == "0"


def test_numpy_zero_dimensional_array_inspection_includes_value(kernel):
    pytest.importorskip("numpy")
    kernel.run("import numpy as np\nscalar_array = np.array(7)")
    info = kernel.call("variables.inspect", name="scalar_array")["result"]
    root = info["root"]["ref"]
    node = info["heap"][str(root)]
    payload = {key: value for key, value in node.items() if key not in {"kind", "shape", "dtype"}}

    assert node["kind"] == "ndarray" and node["shape"] == []
    assert "7" in json.dumps(payload)


def test_numpy_zero_dimensional_object_tuple_resolves_through_heap(kernel):
    pytest.importorskip("numpy")
    kernel.run(
        "import numpy as np\n"
        "object_scalar = np.empty((), dtype=object)\n"
        "object_scalar[()] = (1, [2, 3])"
    )
    info = kernel.call("variables.inspect", name="object_scalar")["result"]
    root = info["root"]["ref"]
    value = info["heap"][str(root)]["value"]
    tuple_node = info["heap"][str(value["ref"])]
    nested_ref = tuple_node["items"][1]["ref"]
    nested_node = info["heap"][str(nested_ref)]

    assert tuple_node["kind"] == "tuple" and tuple_node["items"][0] == 1
    assert nested_node["kind"] == "list" and nested_node["items"] == [2, 3]


def test_numpy_structured_array_inspection_preserves_record_values(kernel):
    pytest.importorskip("numpy")
    kernel.run(
        "import numpy as np\n"
        "records = np.array([(1, 2.5)], dtype=[('count', 'i4'), ('score', 'f8')])"
    )
    info = kernel.call("variables.inspect", name="records")["result"]
    root = info["root"]["ref"]
    first = info["heap"][str(root)]["items"][0]
    encoded = json.dumps(first, sort_keys=True)

    assert "1" in encoded and "2.5" in encoded


def test_numpy_nested_structured_array_preserves_nested_field_values(kernel):
    pytest.importorskip("numpy")
    kernel.run(
        "import numpy as np\n"
        "nested_records = np.array([((1, 2), 'ok')], dtype=[\n"
        "    ('point', [('x', 'i4'), ('y', 'i4')]), ('label', 'U4')\n"
        "])"
    )
    info = kernel.call("variables.inspect", name="nested_records")["result"]
    root = info["root"]["ref"]
    first = info["heap"][str(root)]["items"][0]
    encoded = json.dumps(first, sort_keys=True)

    assert first["$t"] == "record"
    assert all(value in encoded for value in ('1', '2', 'ok'))


def test_thread_pool_reuse_becomes_background_after_new_execution(kernel):
    kernel.run(
        "from concurrent.futures import ThreadPoolExecutor\n"
        "pool = ThreadPoolExecutor(max_workers=1)\n"
        "pool.submit(lambda: None).result()",
        execId="pool-first",
    )
    before = len(kernel.events)
    kernel.run(
        "pool.submit(lambda: print('from-reused-pool-thread')).result()",
        execId="pool-second",
    )
    events = [
        event for event in kernel.events[before:]
        if event.get("event") == "stream" and "from-reused-pool-thread" in event.get("text", "")
    ]

    assert events
    assert {event.get("execId") for event in events} == {None}


def test_raw_thread_output_is_background(kernel):
    before = len(kernel.events)
    kernel.run(
        "import _thread, threading\n"
        "raw_done = threading.Event()\n"
        "def raw_print():\n"
        "    print('from-raw-thread')\n"
        "    raw_done.set()\n"
        "_thread.start_new_thread(raw_print, ())\n"
        "assert raw_done.wait(2)",
        execId="raw-origin",
    )
    events = [
        event for event in kernel.events[before:]
        if event.get("event") == "stream" and "from-raw-thread" in event.get("text", "")
    ]

    assert events
    assert {event.get("execId") for event in events} == {None}


def test_thread_subclass_overriding_start_output_is_background(kernel):
    before = len(kernel.events)
    kernel.run(
        "import _thread, threading\n"
        "subclass_done = threading.Event()\n"
        "class DirectStartThread(threading.Thread):\n"
        "    def start(self):\n"
        "        _thread.start_new_thread(self.run, ())\n"
        "def subclass_print():\n"
        "    print('from-overridden-start')\n"
        "    subclass_done.set()\n"
        "DirectStartThread(target=subclass_print).start()\n"
        "assert subclass_done.wait(2)",
        execId="subclass-origin",
    )
    events = [
        event for event in kernel.events[before:]
        if event.get("event") == "stream" and "from-overridden-start" in event.get("text", "")
    ]

    assert events
    assert {event.get("execId") for event in events} == {None}


def test_stale_background_parent_cannot_label_child_as_newer_execution(kernel):
    kernel.run(
        "import threading, time\n"
        "stale_child_done = threading.Event()\n"
        "def stale_parent():\n"
        "    time.sleep(0.5)\n"
        "    def stale_child():\n"
        "        print('child-of-stale-parent')\n"
        "        stale_child_done.set()\n"
        "    threading.Thread(target=stale_child, daemon=True).start()\n"
        "threading.Thread(target=stale_parent, daemon=True).start()",
        execId="old-execution",
    )
    kernel.run("newer_execution_finished = True", execId="newer-execution")
    time.sleep(1.0)
    # This task does not advance the execution sequence, but guarantees that
    # any small background-output buffer is flushed before assertions.
    kernel.call("variables.list")
    events = [
        event for event in kernel.events
        if event.get("event") == "stream" and "child-of-stale-parent" in event.get("text", "")
    ]

    assert events
    assert {event.get("execId") for event in events} == {None}


def test_dataframe_object_cell_does_not_read_user_class_property(kernel):
    pytest.importorskip("pandas")
    kernel.run(
        "import pandas as pd\n"
        "cell_class_reads = 0\n"
        "class ClassTrap:\n"
        "    @property\n"
        "    def __class__(self):\n"
        "        global cell_class_reads\n"
        "        cell_class_reads += 1\n"
        "        return object\n"
        "trapped_cell = ClassTrap()\n"
        "class_trap_df = pd.DataFrame({'value': pd.Series([trapped_cell], dtype=object)})\n"
        "cell_class_reads = 0"
    )
    page = kernel.call("dataframe.page", name="class_trap_df", offset=0, limit=1)
    reads = kernel.run("cell_class_reads")["value"]["repr"]

    assert page["ok"] is True
    assert reads == "0"


def test_expression_result_does_not_read_metaclass_module_property(kernel):
    result = kernel.run(
        "result_module_reads = 0\n"
        "class ResultMeta(type):\n"
        "    @property\n"
        "    def __module__(cls):\n"
        "        global result_module_reads\n"
        "        result_module_reads += 1\n"
        "        return '__main__'\n"
        "class ResultVictim(metaclass=ResultMeta):\n"
        "    pass\n"
        "result_victim = ResultVictim()\n"
        "result_module_reads = 0\n"
        "result_victim"
    )
    reads = kernel.run("result_module_reads")["value"]["repr"]

    assert result["status"] == "ok"
    assert reads == "0"


def test_os_exit_inside_trace_terminates_worker_without_hanging(kernel):
    kernel.send("trace", code="import os\nos._exit(23)", timeoutMs=5_000)
    return_code = kernel.proc.wait(timeout=5)

    assert return_code == 23
