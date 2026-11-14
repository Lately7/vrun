# Changelog

## Unreleased — fixes from a beginner review

Seventeen problems that learners of Python, ML and algorithms hit first.

### Added
* **Run Cell | Run Above | Visualize** links above every `# %%` line
  (`vrun.codeLens`); *Run Cell and Go to Next Cell*, *Run Cells Above*,
  *Visualize File* (whole file, all cells). Opt-in Shift+Enter
  (`vrun.shiftEnterRunsCell`; with the Jupyter extension it also takes
  Ctrl+Enter in `# %%` files). When the Jupyter extension is present, a
  one-time notice explains that its Run Cell runs in a separate Python and
  offers to give Run Cell and the keys to vrun, or only hide Jupyter's links.
* Visualize on a cell brings in what the cell needs from the cells above
  (definitions, plain values, imports of modules already imported, calls of
  your own helpers that only compute; never files, input, data loading,
  training or a first import), also for names the cell reassigns; the run
  header lists what it used and what it skipped. A NameError for a value an
  earlier cell computes offers *Visualize whole file*.
* Likely **endless loops** are named when a trace reaches its limit (also
  when the loop prints), with buttons to jump to the two identical steps;
  the maxSteps hint shows only for a plain step limit.
* **Recursive calls only**: helper calls that never recurse fold into a
  `+4 safe()` badge on the caller (on by default when helpers make more than
  3 calls). A RecursionError says how deep the function went and how its
  argument changed.
* Error hints: an off-by-one IndexError names the index, its value, the
  length and the loop bound to fix (a different list of another length,
  rows vs columns, a missing base case in recursion, pop from an empty
  stack); a file not found next to the script, misspelled file names,
  backslash paths; a module name in the wrong case; a module edited after
  import (`mod.f` and `from mod import f`); a built-in name you rebound;
  Excel / ANSI encodings (cp1258 only for Vietnamese tone marks).
* Variables tag names that hide a built-in (*shadows built-in*).

### Changed
* Runs and traces work in the folder of the file being run (data files,
  `import helpers`, a lesson's own `utils.py`; an `os.chdir` of yours is
  kept), with a `working folder: …` note when it changes.
* Your own modules are reloaded from their own folder before Run Cell and
  Visualize after you edit them, also names taken with `from x import f`;
  a reloaded class keeps its identity, so objects made earlier run the new
  methods and `isinstance` keeps working.
* The kernel runs Python in UTF-8 mode (`PYTHONUTF8=1`): `open()`, `csv`,
  `json`, `Path.read_text` use UTF-8, like VS Code.
* Trace caps raised from 64 items / 150 objects to 512 / 1000; tuples are
  sent once, unchanged containers and objects are reused (BFS on a 40×40
  grid traces in 2 s instead of 14 s, an LCS table in 2 s instead of 13.6 s).
  Sets of plain values are sorted, and every view says what was cut
  (`… 188 more not shown`, `j=650 (beyond the 512 shown)`, `not shown: too
  many objects`).
* Strings are quoted in Variables and in the visualizer, a deque reads
  `deque([...])`, a list of strings says *list of str*; stacks, queues and
  heaps of nodes or tuples show their values, and nodes waiting in them are
  outlined in their tree or list.
* Doubly linked lists draw `prev` links; a link still broken after the
  list's own method returns is red and explained (while the method runs it
  reads *not linked yet*); `dll.head` / `self.tail` label their nodes.

### Fixed
* Error summaries dropped Python's *Did you mean ...?* suggestion; error
  squiggles sat to the right on lines with Vietnamese text.
* `open()` on a UTF-8 file failed with `'charmap' codec can't decode`, or
  read Vietnamese garbled, on Windows code pages.
* `pd.read_csv("data.csv")` next to a script in a subfolder was not found.
* Live Mode under pandas 3 rewound to `read_csv` in every cell that writes
  or trains; it now stops at that line.
* Live Mode re-created a model, optimizer or history trained by an earlier
  Run Cell (also histories filled by a helper); a `time.sleep` animation loop
  or a recomputed loss tensor no longer blocks Live.
* Visualize on a cell failed with NameError for functions of the cells above.
* An edited module kept running its old code until Restart Kernel.
* `max = 0` or `input = sys.stdin.readline` from one exercise broke the next.
* A RecursionError made the visualizer page about 100,000 px tall;
  `<genexpr>` frames doubled the recursion tree; "N of N calls drawn"
  appeared when nothing was left out.
* The out-of-range subscript was dropped from the values row; an error from
  a called function no longer marks the caller's subscripts red.
* Module-level errors read "leaving the function"; they read "(program
  stopped)".
* Visualize hung when a bare `except:` caught the trace's limit, or when a
  function from the cells above looped forever; Visualize no longer reseeds
  the kernel's random numbers.
* Long containers and big ints were cut without saying so (`memo[299]`
  showed 8 digits of a 63-digit number).

## Unreleased — practising DSA

### Added
* Visualizer: **recursion tree** (calls with arguments and returned values,
  the stack highlighted, click to jump); **step over** (↓) / **step out**
  (↑); click a code line to run to it; how often each line ran; the values
  of the subscripts on the line about to run (`arr[j] = 5`).
* **Animation** between steps: swaps slide, pointers move, heap values sift,
  nodes move to their new place, new ones fade in, changed values flash.
  ✦ Animate toggles it; it is off with the OS "reduce motion" setting.
* New drawings: strings as character cells, ranges between `lo..hi` /
  `left..right`, `visited` / `queue` cells on grids, tries (objects and
  nested dicts), union-find forests, edge lists as graphs, level-order
  lists as trees, LCS / edit-distance headers, the current edge `u → v`.
* Practice files: sorting and searching, recursion and backtracking, graphs
  and grids, data structures — each with exercises.

### Changed
* Pointer arrows come from the frame that holds the array and only from
  names the code uses to index or bound it (no outer `mid` on an inner
  array, no `i` on a list it never indexes).
* Graphs keep their vertex positions while stepping; trees and DAGs are
  drawn in layers.
* A trace sends only what changed per step (heap nodes, and runs of
  unchanged frames) and re-encodes only the running frame: 5000 steps by
  default (was 1000), and a 1000-deep recursion traces in about 1 s and
  0.4 MB instead of stopping at the size limit.

### Fixed
* A set of `(r, c)` cells was drawn as a function graph; the number line
  showed counters next to every drawing; a trie showed only its root.
* A trace that lowered the recursion limit left the kernel at that limit.
* From a review of the visualizer (57 confirmed findings):
  * Trace: suspended frames showed old values of `nonlocal` variables, a
    list filled through `out.append` passed as a callback stayed empty, a
    caller's comprehension variable or walrus was a step behind; generator
    calls were merged (shared ids) and ended at their first yield; a call
    that raised read "return None"; `yield from` showed red StopIteration
    lines; a `key=lambda` called by `heapq` lost its callers; a 500-deep
    recursion stopped at the size limit (stacks are now sent as runs).
  * Player: the slider could not be dragged; arrow keys stopped after
    clicking a button or a code line; a wide recursion tree slid back and
    forth and lost the running call; every step reset the code scroll;
    a failed live re-trace lost the step; the play button stayed ⏸ at the
    end; ↑ at module level jumped to the end; Animate could not be turned
    on with "reduce motion".
  * Line values: read callers' locals, wrapped `a[j]` with `j = -1`, were
    wrong for long NumPy arrays and emoji strings, showed the outer `j` for
    `[a[j] for j in …]`; strings are now quoted (`'0'`).
  * Recursion tree: "✗ IndexError" for calls that raised, no "→ None",
    `insert(8, 3)` and `Node(3)` instead of type names, past 300 calls the
    calls around the current step are kept and the rest folded into "…";
    two lambdas are no longer recursion.
  * Drawings: Kruskal's `(w, u, v)` edges, grid graphs keyed by `(r, c)`,
    directed edge lists (Bellman-Ford) with both directions' weights,
    `adj = [[] for _ in range(n)]` and dicts of lists that are not graphs
    (a value → indices map is a table); 2-column DP tables and int pairs
    no longer open as a line chart; mazes as lists of strings are grids;
    containers in fields (`self.heap`, `self.parent`) get their own card;
    a parameter that shadows the module's `root` no longer hides the rest
    of the tree; pointers at `s[i-1]`, `dp[a-c]`; the solid DP cell is the
    one on the line about to run; `enumerate` indexes are pointers;
    union-find with negative sizes; long vertex names stay apart; `visited`
    and `order` lists draw as cells; BFS keeps no stale current edge after
    its loop; the heap practice cell sifts by hand so the swaps animate;
    linked-list reversal slides nodes between the lists.

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
