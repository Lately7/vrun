# Benchmarks

All numbers below were **measured** by `benchmarks/run_benchmarks.py` on
2026-10-27 (raw data: `benchmarks/results/latest.json`, full tables:
`benchmarks/results/latest.md`). Nothing is estimated.

## Environment

| | |
|---|---|
| OS | Windows 11 (10.0.26200) |
| CPU | Intel64 Family 6 Model 154 (as reported by `platform.processor()`) |
| Python | 3.15.1 |
| pandas / NumPy | 3.1.0 / 2.5.4 |
| Transport | real worker process over stdin/stdout NDJSON (same code path as the extension) |

## Methodology

* Synthetic Online-Retail-like frame, 8 columns (int64, 2 object/str with
  ~0.3 % `None`, datetime64, float64 with 25 % NaN, categorical).
* **Cold start**: spawn → `ready` event, fresh process each time (3 runs).
  Does not include importing pandas.
* **Creation**: one `execute` that builds the frame; *includes the first
  `import pandas`* in a fresh kernel (~1.3 s of the numbers below), so it is
  reported separately from inspection.
* **Warm inspection**: one untimed warm-up request, then 5 timed requests;
  min / median / max round-trip from the client's send to the response line.
* **Uncached sort/filter**: a no-op `execute` clears the page cache before
  each sample (that is what happens after every user execution).
* **Message size**: exact bytes of the NDJSON response line.
* **Peak RSS**: worker process, sampled every 5 ms with psutil.
* **Interrupt**: `while True: pass` running, then time from sending
  `interrupt` to receiving the interrupted `execute` response.

## Results (median of 5, milliseconds)

| Rows | Create (incl. import) | variables.list | metadata | page (first) | page (middle) | page (last) | full sort, 1st | sort, cached | full filter | summary (nulls+stats) | interrupt | peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1442 | 1.0 | 1.2 | 1.6 | 1.4 | 1.4 | 1.9 | 1.9 | 2.3 | 5.2 | 16.0 | 82 MiB |
| 100,000 | 1395 | 1.1 | 1.2 | 1.5 | 1.5 | 1.4 | 17.3 | 2.0 | 8.8 | 27.9 | 15.7 | 97 MiB |
| 500,000 | 1665 | 1.0 | 2.3 | 1.5 | 1.5 | 1.4 | 93.8 | 2.3 | 32.9 | 120.8 | 16.0 | 178 MiB |
| 1,000,000 | 1729 | 1.1 | 1.0 | 1.3 | 1.5 | 1.5 | 194.9 | 2.5 | 63.0 | 227.6 | 15.9 | 274 MiB |

Cold kernel start: **min 347 ms, median 360 ms, max 360 ms** (3 runs).

### Message sizes (bytes)

| Request | 1,000 rows | 1,000,000 rows |
|---|---:|---:|
| variables.list | 320 | 326 |
| dataframe.metadata | 783 | 789 |
| dataframe.page (50 rows × 8 cols) | 7,134 | 7,149 |
| dataframe.summary | 1,186 | 1,212 |

## Interpretation

* Paging is **independent of frame size** (≈1.5 ms, ≈7 KB per 50-row page
  from 1 k to 1 M rows): only the requested window is serialized.
* Variable listing and metadata do no data scans (≈1 ms at every size).
* Full-data **sort is O(n log n)** and **filter / summary are O(n)**: they
  grow with the data, which is why they run only on explicit user action and
  have a time budget. A sorted ordering is cached until the next execution.
* Interrupting pure-Python code takes ≈16 ms. Native code is not covered by
  this number (see README "Known limitations").
* Extension-host responsiveness was measured separately in the integration
  test: max event-loop lag **16 ms** while the kernel computed for 3 s.

## Limitations

* One machine, one run per configuration (5 warm samples each); background
  load and power management add noise.
* Webview rendering time is not included (a 50×8 page is a small DOM table).
* Python 3.12 was functionally tested but not benchmarked (no pandas installed
  for it on this machine).
