# Changelog

## 0.3.0 — 2026-10-29

### Renamed
* The extension is now **vrun** (extension id `vrun-local.vrun`, commands
  `vrun: …`). Settings moved from `veil.*` to `vrun.*`. Uninstall the old
  `veil-local.veil` extension.
* New logo: a plain black square with a white play mark; the panel tab no
  longer shows a logo.

### Changed
* The run header shows the time at the right edge, and a live run reads
  `cleaning.py · line 1` instead of `live: line 1`.

## 0.2.0 — 2026-10-29

### Renamed
* The extension is now **Veil** (extension id `veil-local.veil`, commands
  `Veil: …`). Settings moved from `pylive.*` to `veil.*` — re-apply any
  custom values (e.g. `veil.pythonPath`). Uninstall the old
  `pylive-local.pylive-inspector` extension.
* New black-and-white sparkle logo.

### Added
* Live Mode loads data once and restores it from a snapshot (ADR-007); turning
  Live on starts the kernel and runs immediately.
* Program input: `<script>.in` feeds `input()`/`sys.stdin`; *PyLive: Edit
  Program Input*.
* Visualizer: linked lists / trees inside wrapper classes, heaps and queues of
  tuples; quieter number line and call stack.

### Changed
* Output shows only the latest run, in full (no inner scroll box, no run counter); DataFrames show all columns (pandas display width raised once, unless set by the user).
* Integration tests run from paths with spaces.
* Output: the file name and run time share one line; no run counter.
* Run Cell's editor-title icon is a circled play button, distinct from the
  Python extension's Run/Debug triangle.

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

### Fixed in the Codex review/attack rounds
* Run Selection executes exactly the selected text.
* Output budget in UTF-8 bytes with chunked stream events; lone surrogates no
  longer drop a message; aggregate figure budget.
* Inspection never runs user code: no `__dict__`/`__class__`/`__sizeof__`
  properties, no metaclass properties, no overridden `__int__`/`isoformat`,
  base slots read through member descriptors.
* Exact (Decimal-based) integer filters, strict boolean filters.
* 0-d, object-dtype and (nested) structured NumPy arrays are inspectable.
* Background-thread output is never attributed to the wrong run, is flushed
  even when no run follows, and is shown in a "Background output" block.
* `sys.stdout = sys.__stdout__` restores capture; trace no longer swaps
  `sys.modules['__main__']` or captures other threads' output.
* POSIX process-group kill; stale `ready`/`info` handling; ready-event
  validation.
* Live Mode: no overlapping runs after cancel, edits during manual runs are
  deferred (not dropped), per-document Live state, superseded runs close their
  UI blocks, live block cleanup per document.
* Webview: stale summary/column/trace responses ignored, output trimming keeps
  the newest text, evicted blocks no longer leak, selection reset on paging,
  validated persisted state, playback stops on failure.
* `dedent` uses the common whitespace prefix.

### Fixed during development
* pandas 3 reports the default string dtype as `str`; memory lower-bound flag
  and filters now handle it; categorical columns accept text filters.
* Syntax errors in a cell now report document line numbers.
* `numpy.random.Generator` was listed as a number.
* Graph view no longer treats a BFS `order` list as a path.
* DP table highlights the current column variable (`w`) before the limit (`cap`).
* Drawings scale down to the panel width.
