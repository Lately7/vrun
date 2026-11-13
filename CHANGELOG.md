# Changelog

## Unreleased — practising ML

### Added
* Variables: PyTorch / TensorFlow tensors (shape, dtype, device, grad, loss
  value), networks (parameters, layers, device, mode), scikit-learn
  hyperparameters, pipeline steps, `best_params_`, optimizers, DataLoaders,
  sparse matrices, Keras `History`, sklearn bunches as dicts, metric values.
* Image preview of image-shaped arrays and tensors (PNG encoded by the
  kernel with the standard library); training-curve chart for loss lists,
  history dicts and Keras `History` (min/max downsampling, best epoch).
* 2-D arrays and CPU tensors open in the DataFrame tab.
* Output behaves like a terminal: `\r` / `\b` progress bars redraw in place,
  ANSI colours, ordered stdout/stderr, head + tail of long logs, folded
  repeated warnings; `isatty()` is true so Keras / tqdm use their one-line bars.
* `plt.show()` separates figures; `fig` values are drawn; plot return values
  and a trailing `;` hide the value; plotly figures open on request.
* Notebook habits: `%matplotlib`, `%timeit`, `%time`, `display()`; `!pip`
  explains the terminal command. Error hints for missing packages and
  DataLoader workers on Windows. `__file__` is set for saved scripts.
* *vrun: New Practice File* (sklearn, PyTorch, Keras, pandas, algorithms) and
  ML snippets.
* Setting `vrun.safeMl.confirmAfterSeconds`.

* Installer bundle for other machines: `npm run dist` builds the VSIX and
  `dist/vrun-<version>-installer.zip`. On Windows, double-click
  `install.cmd`: it finds or installs (winget) VS Code and Python 3.12+,
  offers pandas / numpy / matplotlib / openpyxl, removes the old PyLive /
  Veil extensions and installs vrun. `install.sh` for macOS / Linux,
  `INSTALL.md` in Vietnamese and English.
* `scripts/setup-dev.ps1` (`npm run setup:dev`): npm dependencies, a `.venv`
  from `python/requirements-dev.txt` (rebuilt when copied from another
  machine), build and checks.

### Changed
* Live Mode runs a cell up to its first training / I/O statement instead of
  skipping it whole, and marks that line. It stops earlier rather than
  re-create a model, optimizer, counter or loss list that the skipped
  training uses, so a trained model survives a Live run; later `[live]`
  cells wait for the next manual run. Heavy imports no longer block it.
* Recognised as training: chained `.fit()`, training inside helper functions
  (also helpers that call helpers, `@tf.function` / decorated ones), class
  methods (`Trainer().run()`, `t.run()`), helpers passed to `map()` /
  `Thread(target=)`, TensorFlow custom loops, `optimizer.step()` and
  Hugging Face `trainer.train()`. Cheap preprocessing (`StandardScaler`) is
  not, and a torch module's `model.train()` is a mode switch.
* Safe ML asks again only when the previous training run took a while.
* Wide DataFrame results (`describe()`, `corr()`) are shown in full; the
  result's *open* link works with the DataFrame tab off.
* Unit and integration tests default to the repository's `.venv`, like
  `npm run test:py`.

### Fixed
* Worker processes (`n_jobs=-1`, DataLoader workers) outlived Stop / Restart.
* A `__del__` that prints could deadlock the kernel.
* An interrupt during `import torch` left torch unimportable until restart.
* The Column panel showed the DataFrame's name instead of the column's.
* A pipeline was reported as not fitted; numpy-valued `best_params_` were dropped.
* A training-history dict was drawn as a graph; chart ticks could loop forever.
* More than 8 figures per run were dropped silently.
* Found in review of this release:
  * matplotlib in a subprocess or multiprocessing worker crashed (the kernel's
    backend leaked through `MPLBACKEND`).
  * `plt.pause()` / `plt.show(block=False)` loops showed the first, empty
    frame instead of the final plot.
  * Each plotly `fig.show()` left a 4.8 MB file in a shared temp folder; files
    are now ~7 KB, private to the kernel, and only the last 30 are kept. The
    first `fig.show()` after `import plotly.graph_objects` opened a browser.
  * `%%writefile` ran the cell instead of writing it; magics inside strings
    were rewritten; CRLF files broke `%matplotlib`. A missing sibling module
    is no longer sent to pip, and `sklearn` / `cv2` / `PIL` hints name the
    right package.
  * Inspecting a variable could run user code (classes in modules named
    like `torch_utils`, a Keras model's `weights` property) or end the kernel
    with `SystemExit`.
  * Square images were cut into strips; phone-sized photos and huge arrays
    could not be previewed or charted; label masks were black; bfloat16
    tensors showed an error; the chart dropped the last loss value and lists
    of NumPy floats had no chart.
  * Pipelines ending in `'passthrough'` or another pipeline read as not
    fitted; XGBoost listed defaults as changed; `dok_matrix` read as a dict;
    `np.bytes_` was opaque.
  * The training chart cut off its highest points; very long output lines
    lost text; huge cursor movements could freeze the panel; `ESC ( B` showed
    a stray `B`; stderr progress bars were coloured as errors; output after a
    truncated run could be lost.
  * A trace that lowered the recursion limit left the kernel at that limit.

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
