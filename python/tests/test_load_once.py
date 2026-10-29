"""Live-mode data loads execute once and remain sensitive to their inputs."""

from __future__ import annotations

import json
import time

import pytest


pd = pytest.importorskip("pandas")


def _quoted(value: object) -> str:
    return json.dumps(str(value))


def _install_counting_reader(kernel) -> None:
    kernel.run(
        "import pandas as pd\n"
        "class CountingReader:\n"
        "    def __init__(self):\n"
        "        self.count = 0\n"
        "    def read_counter(self, path, **kwargs):\n"
        "        self.count += 1\n"
        "        return pd.read_csv(path, **kwargs)\n"
        "reader = CountingReader()"
    )


def _count(kernel) -> int:
    return int(kernel.run("reader.count")["value"]["repr"])


def test_read_calls_have_distinct_load_findings(kernel):
    pandas_readers = (
        "read_csv", "read_excel", "read_parquet", "read_json", "read_sql",
        "read_table", "read_feather", "read_pickle", "read_html", "read_fwf",
        "read_hdf", "read_spss", "read_stata", "read_sas", "read_xml", "read_orc",
    )
    for name in pandas_readers:
        result = kernel.call("analyze", code=f"df = pd.{name}(path)")["result"]
        assert result["statements"][0]["load"] is True
        assert {finding["category"] for finding in result["findings"]} == {"load"}

    for name in ("load", "loadtxt", "genfromtxt", "fromfile"):
        result = kernel.call("analyze", code=f"arr = np.{name}(path)")["result"]
        assert result["statements"][0]["load"] is True

    clipboard = kernel.call("analyze", code="df = pd.read_clipboard()")["result"]
    assert clipboard["statements"][0]["load"] is False
    assert clipboard["findings"][0]["category"] == "io"


def test_live_load_once_key_changes_and_result_metadata(kernel, tmp_path):
    first_csv = tmp_path / "first.csv"
    second_csv = tmp_path / "second.csv"
    pd.DataFrame({"value": [1, 2]}).to_csv(first_csv, index=False)
    pd.DataFrame({"value": [3]}).to_csv(second_csv, index=False)
    _install_counting_reader(kernel)

    code = f"path = {_quoted(first_csv)}\ndf = reader.read_counter(path)\ndf.shape"
    first = kernel.run(code, mode="live")
    assert first["value"]["repr"] == "(2, 1)"
    assert first["skippedLoads"] == []
    assert first["loadedNow"] == [
        {"line": 2, "code": "df = reader.read_counter(path)"},
    ]
    assert _count(kernel) == 1

    second = kernel.run(code, mode="live")
    assert second["loadedNow"] == []
    assert second["skippedLoads"] == [
        {"line": 2, "code": "df = reader.read_counter(path)"},
    ]
    assert second["value"]["repr"] == "(2, 1)"
    assert _count(kernel) == 1

    formatting_edit = (
        f"path = {_quoted(first_csv)}\n# comment-only edit\n\n"
        "df  =  reader.read_counter( path )\ndf.shape"
    )
    formatted = kernel.run(formatting_edit, mode="live")
    assert formatted["loadedNow"] == []
    assert formatted["skippedLoads"][0]["line"] == 4
    assert _count(kernel) == 1

    changed_statement = (
        f"path = {_quoted(first_csv)}\n"
        "df = reader.read_counter(path, encoding='utf-8')"
    )
    assert kernel.run(changed_statement, mode="live")["loadedNow"]
    assert _count(kernel) == 2

    changed_free_name = (
        f"path = {_quoted(second_csv)}\n"
        "df = reader.read_counter(path, encoding='utf-8')"
    )
    changed = kernel.run(changed_free_name, mode="live")
    assert changed["loadedNow"] and _count(kernel) == 3
    assert kernel.run("df.shape")["value"]["repr"] == "(1, 1)"

    kernel.run("del df")
    restored_binding = kernel.run(changed_free_name, mode="live")
    assert restored_binding["skippedLoads"] and _count(kernel) == 3
    assert kernel.run("df.shape")["value"]["repr"] == "(1, 1)"


def test_manual_load_is_recorded_for_following_live_run(kernel, tmp_path):
    csv_path = tmp_path / "manual.csv"
    pd.DataFrame({"x": [10]}).to_csv(csv_path, index=False)
    _install_counting_reader(kernel)
    code = f"path = {_quoted(csv_path)}\ndf = reader.read_counter(path)"

    manual = kernel.run(code, mode="manual")
    assert manual["loadedNow"] == [
        {"line": 2, "code": "df = reader.read_counter(path)"},
    ]
    live = kernel.run(code, mode="live")
    assert live["loadedNow"] == []
    assert live["skippedLoads"]
    assert _count(kernel) == 1


def test_skipped_load_restores_pristine_data_before_preprocessing(kernel, tmp_path):
    csv_path = tmp_path / "prices.csv"
    pd.DataFrame({"price": [10.0, None, 20.0]}).to_csv(csv_path, index=False)
    _install_counting_reader(kernel)
    code = (
        f"path = {_quoted(csv_path)}\n"
        "df = reader.read_counter(path)\n"
        "df['price'] *= 1.1\n"
        "df.dropna(inplace=True)\n"
        "df['price'].tolist()"
    )

    results = [kernel.run(code, mode="live") for _ in range(3)]
    assert [result["value"]["repr"] for result in results] == [
        "[11.0, 22.0]", "[11.0, 22.0]", "[11.0, 22.0]",
    ]
    assert results[0]["loadedNow"]
    assert results[1]["skippedLoads"] and results[2]["skippedLoads"]
    assert _count(kernel) == 1


def test_last_expression_load_restores_and_returns_cached_value(kernel, tmp_path):
    csv_path = tmp_path / "expression.csv"
    pd.DataFrame({"x": [1, 2, 3]}).to_csv(csv_path, index=False)
    _install_counting_reader(kernel)
    code = f"path = {_quoted(csv_path)}\nreader.read_counter(path)"

    first = kernel.run(code, mode="live")
    second = kernel.run(code, mode="live")
    assert first["value"]["shape"] == [3, 1]
    assert second["value"]["shape"] == [3, 1]
    assert second["skippedLoads"] and second["loadedNow"] == []
    assert _count(kernel) == 1


def test_unsupported_bound_object_is_never_skipped(kernel):
    kernel.run(
        "class Opaque:\n"
        "    pass\n"
        "class OpaqueReader:\n"
        "    def __init__(self):\n"
        "        self.count = 0\n"
        "    def read_opaque(self):\n"
        "        self.count += 1\n"
        "        return Opaque()\n"
        "opaque_reader = OpaqueReader()"
    )
    code = "opaque = opaque_reader.read_opaque()"

    first = kernel.run(code, mode="live")
    second = kernel.run(code, mode="live")
    count = kernel.run("opaque_reader.count")["value"]["repr"]
    assert first["loadedNow"] and second["loadedNow"]
    assert first["skippedLoads"] == second["skippedLoads"] == []
    assert second["loadCache"] == 0
    assert count == "2"


def test_no_binding_nonfinal_load_always_runs(kernel):
    kernel.run(
        "class ScalarReader:\n"
        "    def __init__(self):\n"
        "        self.count = 0\n"
        "    def read_scalar(self):\n"
        "        self.count += 1\n"
        "        return self.count\n"
        "scalar_reader = ScalarReader()"
    )
    cached_expression = kernel.run("scalar_reader.read_scalar()", mode="live")
    assert cached_expression["value"]["repr"] == "1"

    nonfinal = kernel.run("scalar_reader.read_scalar()\n0", mode="live")
    assert nonfinal["loadedNow"] and nonfinal["skippedLoads"] == []
    assert kernel.run("scalar_reader.count")["value"]["repr"] == "2"


def test_changed_free_name_replaces_snapshot_for_statement_slot(kernel, tmp_path):
    paths = [tmp_path / f"data-{index}.csv" for index in range(3)]
    for index, path in enumerate(paths):
        pd.DataFrame({"x": [index]}).to_csv(path, index=False)
    _install_counting_reader(kernel)

    for path in paths:
        result = kernel.run(
            f"path = {_quoted(path)}\ndf = reader.read_counter(path)", mode="live"
        )
        assert result["loadedNow"]
        assert result["loadCache"] == 1
    assert _count(kernel) == 3


@pytest.mark.parametrize("code", ["model.fit(X, y)", "df.to_csv('forbidden.csv')"])
def test_non_load_side_effects_still_block_live(kernel, code):
    result = kernel.run(code, mode="live")
    assert result["status"] == "blocked"
    assert result["skippedLoads"] == []
    assert result["loadedNow"] == []


def test_first_load_ignores_live_timeout_but_non_load_does_not(kernel):
    kernel.run(
        "import time\n"
        "class SlowReader:\n"
        "    def read_slow(self):\n"
        "        time.sleep(0.65)\n"
        "        return 17\n"
        "slow_reader = SlowReader()\n"
        "def slow_work():\n"
        "    deadline = time.perf_counter() + 2\n"
        "    while time.perf_counter() < deadline:\n"
        "        pass"
    )

    started = time.perf_counter()
    loaded = kernel.run("answer = slow_reader.read_slow()\nanswer", mode="live", timeoutMs=300)
    assert time.perf_counter() - started >= 0.6
    assert loaded["status"] == "ok"
    assert loaded["value"]["repr"] == "17"
    assert loaded["loadedNow"]

    interrupted = kernel.run("slow_work()", mode="live", timeoutMs=300)
    assert interrupted["status"] == "error"
    assert interrupted["interrupted"] == "timeout"


def test_statement_execution_preserves_lines_and_last_value(kernel):
    result = kernel.run(
        "base = 20\nbase + 2", file="live-lines.py", lineOffset=40, mode="live"
    )
    assert result["value"]["repr"] == "22"

    failed = kernel.run(
        "first = 1\nsecond = 0\nfirst / second",
        file="live-lines.py",
        lineOffset=40,
        mode="live",
    )
    assert failed["status"] == "error"
    assert failed["error"]["userFrame"]["file"] == "live-lines.py"
    assert failed["error"]["userFrame"]["line"] == 43
