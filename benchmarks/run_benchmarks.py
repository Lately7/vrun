#!/usr/bin/env python3
"""Run end-to-end PyLive kernel DataFrame benchmarks over NDJSON."""

from __future__ import annotations

import argparse
import ast
import json
import os
import platform
import statistics
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "python"
TESTS_DIR = PYTHON_DIR / "tests"
for path in (str(PYTHON_DIR), str(TESTS_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

# This benchmark intentionally drives the exact same real-worker helper as the
# tests, so protocol or launcher changes cannot silently diverge here.
from conftest import KernelProc  # noqa: E402

try:
    import psutil
except ImportError:  # pragma: no cover - depends on the benchmark environment
    psutil = None


DEFAULT_SIZES = (1_000, 100_000, 500_000, 1_000_000)
QUICK_SIZES = (1_000, 100_000)
COLD_START_REPEATS = 3
PAGE_LIMIT = 50


class RecordingKernelProc(KernelProc):
    """KernelProc that retains the byte length of each raw NDJSON response."""

    def __init__(self, cwd: str | None = None) -> None:
        self.response_bytes: dict[Any, int] = {}
        self.event_bytes: dict[str, list[int]] = {}
        started = time.perf_counter()
        super().__init__(cwd=cwd)
        self.startup_ms = (time.perf_counter() - started) * 1_000

    def _read(self) -> None:
        assert self.proc.stdout
        for line in self.proc.stdout:
            msg = json.loads(line)
            with self.cv:
                if msg.get("type") == "response":
                    self.response_bytes[msg.get("id")] = len(line)
                    self.responses[msg.get("id")] = msg
                else:
                    event = str(msg.get("event", msg.get("type", "unknown")))
                    self.event_bytes.setdefault(event, []).append(len(line))
                    self.events.append(msg)
                self.cv.notify_all()


class PeakRssSampler:
    """Sample worker RSS while a benchmark case runs."""

    def __init__(self, pid: int) -> None:
        self.peak: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._process = psutil.Process(pid) if psutil is not None else None

    def start(self) -> None:
        if self._process is None:
            return
        self._sample()
        self._thread = threading.Thread(target=self._run, name="benchmark-rss", daemon=True)
        self._thread.start()

    def _sample(self) -> None:
        assert self._process is not None
        try:
            rss = int(self._process.memory_info().rss)
        except (psutil.Error, OSError):
            return
        self.peak = rss if self.peak is None else max(self.peak, rss)

    def _run(self) -> None:
        while not self._stop.wait(0.005):
            self._sample()

    def stop(self) -> int | None:
        if self._process is None:
            return None
        self._sample()
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)
        return self.peak


def require_ok(response: dict[str, Any], operation: str) -> dict[str, Any]:
    if not response.get("ok"):
        raise RuntimeError(f"{operation} failed: {response}")
    return response["result"]


def timed_call(
    kernel: RecordingKernelProc,
    type_: str,
    *,
    timeout: float = 120,
    **params: Any,
) -> tuple[dict[str, Any], dict[str, float | int]]:
    started = time.perf_counter()
    rid = kernel.send(type_, **params)
    response = kernel.wait(rid, timeout=timeout)
    elapsed_ms = (time.perf_counter() - started) * 1_000
    sample: dict[str, float | int] = {
        "ms": elapsed_ms,
        "response_bytes": kernel.response_bytes[rid],
    }
    return response, sample


def summarize(samples: list[dict[str, float | int]]) -> dict[str, Any]:
    latencies = [float(sample["ms"]) for sample in samples]
    sizes = [int(sample["response_bytes"]) for sample in samples]
    return {
        "samples": samples,
        "latency_ms": {
            "min": min(latencies),
            "median": statistics.median(latencies),
            "max": max(latencies),
        },
        "response_bytes": {
            "min": min(sizes),
            "median": statistics.median(sizes),
            "max": max(sizes),
        },
    }


def dataframe_code(rows: int) -> str:
    return f"""
import numpy as np
import pandas as pd
_bench_n = {rows}
_bench_rng = np.random.default_rng(20261027 + _bench_n)
_bench_stock_values = np.array([f"S{{i:05d}}" for i in range(4000)], dtype=object)
_bench_stock = _bench_stock_values[np.arange(_bench_n) % len(_bench_stock_values)]
_bench_descriptions = np.array(
    ["WHITE HANGING HEART T-LIGHT HOLDER", "JUMBO BAG RED RETROSPOT",
     "REGENCY CAKESTAND 3 TIER", "ASSORTED COLOUR BIRD ORNAMENT"],
    dtype=object,
)[np.arange(_bench_n) % 4].copy()
_bench_descriptions[_bench_rng.random(_bench_n) < 0.003] = None
_bench_customer = _bench_rng.integers(10000, 19000, _bench_n).astype(float)
_bench_customer[_bench_rng.random(_bench_n) < 0.25] = np.nan
df = pd.DataFrame({{
    "InvoiceNo": np.arange(536365, 536365 + _bench_n, dtype=np.int64),
    "StockCode": _bench_stock,
    "Description": _bench_descriptions,
    "Quantity": _bench_rng.integers(-10, 100, _bench_n, dtype=np.int64),
    "InvoiceDate": pd.date_range("2010-12-01", periods=_bench_n, freq="min"),
    "UnitPrice": _bench_rng.random(_bench_n) * 100.0,
    "CustomerID": _bench_customer,
    "Country": pd.Categorical(_bench_rng.choice(
        ["United Kingdom", "France", "Germany", "Netherlands", "EIRE"],
        size=_bench_n,
        p=[0.72, 0.08, 0.08, 0.04, 0.08],
    )),
}})
del (_bench_n, _bench_rng, _bench_stock_values, _bench_stock,
     _bench_descriptions, _bench_customer)
"""


def repeated_request(
    kernel: RecordingKernelProc,
    repeats: int,
    type_: str,
    **params: Any,
) -> dict[str, Any]:
    # One untimed request moves imports and one-time pandas paths out of the
    # measured warm samples.
    require_ok(kernel.call(type_, timeout=120, **params), type_)
    samples: list[dict[str, float | int]] = []
    for _ in range(repeats):
        response, sample = timed_call(kernel, type_, **params)
        require_ok(response, type_)
        samples.append(sample)
    return summarize(samples)


def benchmark_sort_pairs(kernel: RecordingKernelProc, repeats: int) -> tuple[dict[str, Any], dict[str, Any]]:
    first: list[dict[str, float | int]] = []
    cached: list[dict[str, float | int]] = []
    params = {"name": "df", "offset": 0, "limit": PAGE_LIMIT,
              "sort": {"column": 5, "ascending": False}}
    require_ok(kernel.call("dataframe.page", timeout=120, **params), "sort warmup")
    for _ in range(repeats):
        # Any execute increments the revision and clears the worker page cache.
        kernel.run("df = df")
        response, sample = timed_call(kernel, "dataframe.page", **params)
        require_ok(response, "uncached sort")
        first.append(sample)
        response, sample = timed_call(kernel, "dataframe.page", **params)
        require_ok(response, "cached sort")
        cached.append(sample)
    return summarize(first), summarize(cached)


def benchmark_filter(kernel: RecordingKernelProc, repeats: int) -> dict[str, Any]:
    samples: list[dict[str, float | int]] = []
    params = {"name": "df", "offset": 0, "limit": PAGE_LIMIT,
              "filter": {"column": 7, "op": "eq", "value": "France"}}
    require_ok(kernel.call("dataframe.page", timeout=120, **params), "filter warmup")
    for _ in range(repeats):
        kernel.run("df = df")
        response, sample = timed_call(kernel, "dataframe.page", **params)
        require_ok(response, "filter")
        samples.append(sample)
    return summarize(samples)


def wait_until_busy(kernel: RecordingKernelProc, deadline: float) -> None:
    while time.perf_counter() < deadline:
        response = kernel.call("ping", timeout=2)
        if require_ok(response, "ping")["busy"]:
            return
        time.sleep(0.005)
    raise TimeoutError("infinite-loop execute did not become busy")


def benchmark_interrupt(kernel: RecordingKernelProc, repeats: int) -> dict[str, Any]:
    samples: list[dict[str, float | int]] = []
    for number in range(repeats):
        execute_id = kernel.send(
            "execute", code="while True:\n    pass\n", execId=f"benchmark-interrupt-{number}"
        )
        wait_until_busy(kernel, time.perf_counter() + 5)
        started = time.perf_counter()
        interrupt_id = kernel.send("interrupt", target=execute_id)
        execute_response = kernel.wait(execute_id, timeout=10)
        elapsed_ms = (time.perf_counter() - started) * 1_000
        interrupt_response = kernel.wait(interrupt_id, timeout=10)
        result = require_ok(execute_response, "interrupted execute")
        if result.get("interrupted") != "interrupted":
            raise RuntimeError(f"execute was not interrupted: {execute_response}")
        require_ok(interrupt_response, "interrupt")
        samples.append({
            "ms": elapsed_ms,
            "response_bytes": kernel.response_bytes[execute_id],
            "interrupt_response_bytes": kernel.response_bytes[interrupt_id],
        })
    summary = summarize(samples)
    interrupt_sizes = [int(sample["interrupt_response_bytes"]) for sample in samples]
    summary["interrupt_response_bytes"] = {
        "min": min(interrupt_sizes),
        "median": statistics.median(interrupt_sizes),
        "max": max(interrupt_sizes),
    }
    return summary


def cold_start_benchmark() -> dict[str, Any]:
    samples: list[dict[str, float | int]] = []
    for _ in range(COLD_START_REPEATS):
        kernel = RecordingKernelProc(cwd=str(ROOT))
        try:
            ready_sizes = kernel.event_bytes.get("ready", [])
            samples.append({
                "ms": kernel.startup_ms,
                "response_bytes": ready_sizes[-1],
            })
        finally:
            kernel.close()
    return summarize(samples)


def worker_versions() -> dict[str, str]:
    kernel = RecordingKernelProc(cwd=str(ROOT))
    try:
        result = kernel.run(
            "import sys, numpy as np, pandas as pd\n"
            "sys.version.split()[0] + '|' + pd.__version__ + '|' + np.__version__"
        )
        value_repr = result.get("value", {}).get("repr")
        if not isinstance(value_repr, str):
            raise RuntimeError(f"unexpected version result: {result}")
        value = ast.literal_eval(value_repr)
        python_version, pandas_version, numpy_version = value.split("|", maxsplit=2)
        return {
            "python": python_version,
            "numpy": numpy_version,
            "pandas": pandas_version,
        }
    finally:
        kernel.close()


def benchmark_size(rows: int, repeats: int) -> dict[str, Any]:
    print(f"Benchmarking {rows:,} rows...", flush=True)
    kernel = RecordingKernelProc(cwd=str(ROOT))
    # On Windows a venv executable may be a small redirector whose PID differs
    # from the real interpreter announced by the worker's ready event.
    sampler = PeakRssSampler(int(kernel.ready["pid"]))
    sampler.start()
    try:
        response, creation_roundtrip = timed_call(
            kernel, "execute", code=dataframe_code(rows), timeout=180
        )
        creation_result = require_ok(response, "DataFrame creation")
        if creation_result.get("status") != "ok":
            raise RuntimeError(f"DataFrame creation failed: {creation_result}")
        creation = {
            "worker_elapsed_ms": float(creation_result["elapsedMs"]),
            "roundtrip_ms": float(creation_roundtrip["ms"]),
            "response_bytes": int(creation_roundtrip["response_bytes"]),
        }

        metrics: dict[str, Any] = {}
        metrics["variables.list"] = repeated_request(kernel, repeats, "variables.list")
        metrics["dataframe.metadata"] = repeated_request(
            kernel, repeats, "dataframe.metadata", name="df"
        )
        metrics["dataframe.page.first"] = repeated_request(
            kernel, repeats, "dataframe.page", name="df", offset=0, limit=PAGE_LIMIT
        )
        metrics["dataframe.page.middle"] = repeated_request(
            kernel, repeats, "dataframe.page", name="df",
            offset=max(0, rows // 2), limit=PAGE_LIMIT
        )
        metrics["dataframe.page.last"] = repeated_request(
            kernel, repeats, "dataframe.page", name="df",
            offset=max(0, rows - PAGE_LIMIT), limit=PAGE_LIMIT
        )
        first_sort, cached_sort = benchmark_sort_pairs(kernel, repeats)
        metrics["dataframe.page.sort_first"] = first_sort
        metrics["dataframe.page.sort_cached"] = cached_sort
        metrics["dataframe.page.filter"] = benchmark_filter(kernel, repeats)
        metrics["dataframe.summary"] = repeated_request(
            kernel, repeats, "dataframe.summary", name="df"
        )
        interrupt = benchmark_interrupt(kernel, repeats)
        return {
            "rows": rows,
            "creation": creation,
            "inspection": metrics,
            "interrupt": interrupt,
            "peak_rss_bytes": sampler.stop(),
        }
    except Exception:
        sampler.stop()
        stderr = b"".join(kernel.stderr[-20:]).decode("utf-8", "replace")
        if stderr:
            print("Worker stderr tail:\n" + stderr, file=sys.stderr)
        raise
    finally:
        kernel.close()


def format_number(value: float | int) -> str:
    if isinstance(value, float):
        return f"{value:.3f}"
    return f"{value:,}"


def render_markdown(results: dict[str, Any]) -> str:
    env = results["environment"]
    lines = [
        "# PyLive Inspector benchmark results",
        "",
        f"Generated: `{results['timestamp']}`",
        "",
        "## Environment",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| OS | {env['os']} |",
        f"| CPU | {env['cpu'] or '(not reported)'} |",
        f"| Python | {env['python']} |",
        f"| pandas | {env['pandas']} |",
        f"| NumPy | {env['numpy']} |",
        f"| psutil | {'available' if env['psutil_available'] else 'not installed'} |",
        "",
        "## Cold kernel startup",
        "",
        "| Runs | Min ms | Median ms | Max ms | Ready bytes (median) |",
        "|---:|---:|---:|---:|---:|",
    ]
    cold = results["cold_start"]
    lines.append(
        f"| {len(cold['samples'])} | {cold['latency_ms']['min']:.3f} | "
        f"{cold['latency_ms']['median']:.3f} | {cold['latency_ms']['max']:.3f} | "
        f"{format_number(cold['response_bytes']['median'])} |"
    )

    lines.extend([
        "",
        "## DataFrame creation and peak RSS",
        "",
        "| Rows | Worker creation ms | Round-trip ms | Response bytes | Peak RSS MiB |",
        "|---:|---:|---:|---:|---:|",
    ])
    for dataset in results["datasets"]:
        creation = dataset["creation"]
        peak = dataset["peak_rss_bytes"]
        peak_text = "null" if peak is None else f"{peak / (1024 * 1024):.2f}"
        lines.append(
            f"| {dataset['rows']:,} | {creation['worker_elapsed_ms']:.3f} | "
            f"{creation['roundtrip_ms']:.3f} | {creation['response_bytes']:,} | {peak_text} |"
        )

    for dataset in results["datasets"]:
        lines.extend([
            "",
            f"## {dataset['rows']:,} rows — warm inspection ({results['config']['repeats']} runs)",
            "",
            "| Request | Min ms | Median ms | Max ms | Response bytes min/median/max |",
            "|---|---:|---:|---:|---:|",
        ])
        for name, metric in dataset["inspection"].items():
            latency = metric["latency_ms"]
            sizes = metric["response_bytes"]
            lines.append(
                f"| `{name}` | {latency['min']:.3f} | {latency['median']:.3f} | "
                f"{latency['max']:.3f} | {sizes['min']:,} / "
                f"{format_number(sizes['median'])} / {sizes['max']:,} |"
            )
        interrupt = dataset["interrupt"]
        ilatency = interrupt["latency_ms"]
        execute_sizes = interrupt["response_bytes"]
        control_sizes = interrupt["interrupt_response_bytes"]
        lines.extend([
            "",
            "### Interrupt",
            "",
            "Latency is measured from sending `interrupt` until the infinite-loop "
            "`execute` response arrives.",
            "",
            "| Min ms | Median ms | Max ms | Execute response bytes (median) | Interrupt response bytes (median) |",
            "|---:|---:|---:|---:|---:|",
            f"| {ilatency['min']:.3f} | {ilatency['median']:.3f} | {ilatency['max']:.3f} | "
            f"{format_number(execute_sizes['median'])} | {format_number(control_sizes['median'])} |",
        ])

    lines.extend([
        "",
        "Response sizes are exact UTF-8 NDJSON line lengths, including the trailing newline. "
        "Uncached sort and filter samples clear the page cache with a no-op execute before each run.",
        "",
    ])
    return "\n".join(lines)


def parse_sizes(value: str) -> list[int]:
    try:
        sizes = [int(part.strip()) for part in value.split(",") if part.strip()]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("sizes must be comma-separated integers") from exc
    if not sizes or any(size <= 0 for size in sizes):
        raise argparse.ArgumentTypeError("sizes must contain positive integers")
    return sizes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sizes", type=parse_sizes, default=list(DEFAULT_SIZES),
        help="comma-separated row counts (default: 1000,100000,500000,1000000)",
    )
    parser.add_argument(
        "--repeats", type=int, default=5,
        help="number of warm inspection and interrupt samples (default: 5)",
    )
    parser.add_argument(
        "--quick", action="store_true",
        help="benchmark only 1,000 and 100,000 rows (overrides --sizes)",
    )
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats must be at least 1")
    if args.quick:
        args.sizes = list(QUICK_SIZES)
    return args


def main() -> int:
    args = parse_args()
    versions = worker_versions()
    print("Measuring cold kernel startup...", flush=True)
    cold = cold_start_benchmark()
    datasets = [benchmark_size(rows, args.repeats) for rows in args.sizes]
    results = {
        "schema_version": 1,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "environment": {
            "os": platform.platform(),
            "cpu": platform.processor(),
            "python": versions["python"],
            "pandas": versions["pandas"],
            "numpy": versions["numpy"],
            "psutil_available": psutil is not None,
        },
        "config": {
            "sizes": args.sizes,
            "repeats": args.repeats,
            "cold_start_repeats": COLD_START_REPEATS,
            "page_limit": PAGE_LIMIT,
        },
        "cold_start": cold,
        "datasets": datasets,
    }

    output_dir = ROOT / "benchmarks" / "results"
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "latest.json"
    markdown_path = output_dir / "latest.md"
    json_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(results), encoding="utf-8")
    print(f"Wrote {json_path}")
    print(f"Wrote {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
