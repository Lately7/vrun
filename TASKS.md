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
| 11 | Automated tests | 119 pytest (incl. 37 written by Codex), 53 node:test (incl. 31 by Codex), 8 VS Code integration — all passing |
| 12 | Large synthetic dataset | 500 k and 1 M rows benchmarked; 200 k-row pytest fixture |
| 13 | VSIX generated | `vrun-0.3.0.vsix` (24 files, 87.59 KB), manifest checked (`vrun-local.vrun`), installed into VS Code |
| 14 | Installation documented | README "Install (local VSIX)" |
| 15 | Codex implementation + review | see Codex log below |

## Codex log

| Task | Mode | Result |
|---|---|---|
| Architecture risk review | `codex exec --sandbox read-only` | 11 risks (`docs/reviews/codex-01-architecture-risks.md`). Integrated: single writer thread, one interrupt per task + drain, `BaseException` trace limit, `msvcrt.setmode` binary pipes, revision in handles, figure caps, Workspace Trust requirement. Deferred: delta-encoded traces, trace subprocess isolation. |
| Benchmark script | `codex exec --sandbox workspace-write`, owned `benchmarks/` only | `benchmarks/run_benchmarks.py` (reuses the test KernelProc, cold/warm, RSS, message sizes, interrupt). Reviewed by Claude; ran unchanged for the full 1 k–1 M run. |
| Round 1: final code review | `codex exec --sandbox read-only` | 12 findings; 11 fixed, 1 partially (trace isolation via per-thread stdout instead of a subprocess) |
| Round 2: adversarial kernel tests | `workspace-write`, owns `python/tests/test_codex_adversarial.py` | 25 tests, 6 failures → 5 fixed, 1 rebutted (stdout semantics); the rebuttal exposed 2 real bugs |
| Round 2b/2c: Codex attacks the fixes (same session via `codex exec resume`) | same | 8 + 3 new failures; all resolved; Codex conceded 3 disputed points; 37 Codex tests, 0 failing |
| Round 3: adversarial TypeScript tests | `workspace-write`, owns `test/unit/codex.test.ts` | 24 tests, 6 failures + 7 review findings → 10 fixed, 3 rebutted (Codex conceded) |
| Round 3b: Codex attacks the round-3 fixes | same session | 5 findings, all fixed; 31 Codex tests, 0 failing |
| Round 4: cumulative regression review | `read-only` | see `docs/reviews/codex-02-final-review.md` |

Full debate log with every verdict: `docs/reviews/codex-02-final-review.md`.

## Remaining issues / future work

* ⏳ Delta encoding of trace heaps (reduces message size for long traces).
* ⏳ Optional trace execution in a disposable subprocess for hard limits.
* ⏳ Dependency-aware re-execution (explicitly out of MVP scope; see ADR log).
* ⏳ Virtualized rendering for very wide DataFrames (currently 50-column windows).
* ⏳ Keyboard navigation of DataFrame cells (arrow keys, Enter to select, copy) — currently mouse-only.
