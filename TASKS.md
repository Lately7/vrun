# Tasks and milestones

Status legend: ✅ done (with evidence) · ⏳ open

## Milestones

| # | Milestone | Acceptance criteria | Status |
|---|---|---|---|
| 1 | Repository & architecture | env inspected; git repo; ARCHITECTURE/DECISIONS/AGENTS; Codex architecture risk review integrated | ✅ |
| 2 | Persistent kernel | variables persist; stdout/stderr; tracebacks; restart/stop; crash handling; tests | ✅ |
| 3 | Variable explorer | cheap metadata, no unsafe repr, click-to-inspect, unsupported objects degrade gracefully | ✅ |
| 4 | DataFrame viewer | bounded pages, dtypes, nulls, stats, full-data sort/filter, large-frame tests | ✅ |
| 5 | Execution management | manual/cell/selection, live mode, debounce, queue, stale handling, interrupt, recovery | ✅ |
| 6 | ML safety | live never re-runs training; confirm repeated training; tested | ✅ |
| 7 | Performance & release | benchmarks measured; docs; VSIX built and install-verified; Codex final review resolved | ✅ |
| + | DSA visualizer (user request) | step tracer; number line; arrays with pointers; graph; tree; linked list; DP matrix; function graph; live re-trace | ✅ |

## Definition of Done — evidence

| # | Criterion | Evidence |
|---|---|---|
| 1 | Launches in Extension Development Host | `npm run test:vscode` — 8 passing in VS Code 1.143.1 dev host |
| 2 | Kernel starts | integration + `test_ready_event`, KernelClient unit test |
| 3 | Variables persist | `test_variables_persist_and_expression_value`; integration "Run File … persistent kernel" |
| 4 | Expressions execute | pytest + integration (`df["Quantity"].median()`) |
| 5 | Exceptions shown meaningfully | `test_runtime_error_traceback_points_to_user_line`, editor diagnostics |
| 6 | DataFrame inspectable | `test_dataframe_and_vars.py` (16 tests), harness screenshots |
| 7 | Pagination without full transfer | page ≈ 7 KB for 1 k … 1 M rows (BENCHMARKS.md) |
| 8 | UI responsive during execution | integration test: max event-loop lag 16 ms during 3 s computation |
| 9 | Interrupt / restart | `test_interrupt_*`, integration interrupt + restart tests, 16 ms interrupt latency |
| 10 | Stale responses dropped | LiveScheduler tests; `stale_handle` / `stale_revision` tests; webview request sequence numbers |
| 11 | Automated tests | pytest, node:test, VS Code integration (see CHANGELOG) |
| 12 | Large synthetic dataset | 500 k and 1 M rows benchmarked; 200 k-row pytest fixture |
| 13 | VSIX generated | `pylive-inspector-0.1.0.vsix` (21 files, 66 KB), installed into a temp extensions dir |
| 14 | Installation documented | README "Install (local VSIX)" |
| 15 | Codex implementation + review | see Codex log below |

## Codex log

| Task | Mode | Result |
|---|---|---|
| Architecture risk review | `codex exec --sandbox read-only` | 11 risks (`docs/reviews/codex-01-architecture-risks.md`). Integrated: single writer thread, one interrupt per task + drain, `BaseException` trace limit, `msvcrt.setmode` binary pipes, revision in handles, figure caps, Workspace Trust requirement. Deferred: delta-encoded traces, trace subprocess isolation. |
| Benchmark script | `codex exec --sandbox workspace-write`, owned `benchmarks/` only | `benchmarks/run_benchmarks.py` (reuses the test KernelProc, cold/warm, RSS, message sizes, interrupt). Reviewed by Claude; ran unchanged for the full 1 k–1 M run. |
| Final code review | `codex exec --sandbox read-only` | see `docs/reviews/codex-02-final-review.md` and the resolution table there |

## Remaining issues / future work

* ⏳ Delta encoding of trace heaps (reduces message size for long traces).
* ⏳ Optional trace execution in a disposable subprocess for hard limits.
* ⏳ Dependency-aware re-execution (explicitly out of MVP scope; see ADR log).
* ⏳ Virtualized rendering for very wide DataFrames (currently 50-column windows).
* ⏳ `input()` support through a webview prompt.
