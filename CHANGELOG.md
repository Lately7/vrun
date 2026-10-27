# Changelog

## 0.1.0 — 2026-10-28 (MVP)

### Added
* Persistent Python worker (`python/pylive_kernel`), stdlib-only, NDJSON over
  duplicated stdio descriptors; single writer thread; reader thread for
  interrupt/cancel/shutdown; per-task deadlines enforced by real interrupts.
* Execution: Run Selection / Cell (`# %%`) / File, last-expression values,
  tracebacks mapped to document lines, captured stdout/stderr (bounded),
  matplotlib figure capture, `SystemExit`/`input()` handled safely.
* Live Mode with debounce, coalescing backpressure, stale-generation
  discarding, AST safety heuristics and live time budget.
* Safe ML: confirmation before re-running a training cell in the same session;
  `# pylive: manual` marker.
* Variable explorer with cheap metadata (no repr of unknown objects).
* DataFrame viewer: bounded pages, column windows, full-data sort/filter with
  per-execution cache, on-demand summary and column inspection, copy.
* DSA visualizer: step-by-step tracing in an isolated namespace; arrays with
  pointers, number line, function graph, matrix/DP table, graph (BFS/DFS
  highlighting), binary/n-ary tree, linked list, heap. Live Visualize.
* Kernel lifecycle: start/stop/restart, crash detection, process-tree kill,
  session tokens and revisions invalidate stale handles.
* Tests: pytest (kernel, DataFrame, tracer, safety, serialization), Node unit
  tests (protocol, cells, scheduler, validation, KernelClient with real
  Python), VS Code integration tests in an Extension Development Host.
* Benchmarks script (implemented by Codex) and measured results.

### Fixed during development
* pandas 3 reports the default string dtype as `str`; memory lower-bound flag
  and filters now handle it; categorical columns accept text filters.
* Syntax errors in a cell now report document line numbers.
* `numpy.random.Generator` was listed as a number.
* Graph view no longer treats a BFS `order` list as a path.
* DP table highlights the current column variable (`w`) before the limit (`cap`).
* Drawings scale down to the panel width.
