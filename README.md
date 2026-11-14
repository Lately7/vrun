# vrun

A VS Code extension for people learning **Python, data science, machine
learning and data structures & algorithms**. Run ordinary `.py` files in a persistent Python
kernel, explore variables and large pandas DataFrames without printing them,
and watch algorithms run step by step as pictures: bars with `i`/`j`
pointers, number lines, graphs, trees, linked lists and DP tables.

## Features

| Area | What you get |
|---|---|
| Persistent kernel | One long-running Python process per window. Variables and imports survive between runs. stdout/stderr captured, tracebacks mapped to your file's lines, status `idle / busy / interrupting / crashed`. |
| Execution | Run Selection, Run Cell (`# %%` cells), Run File. **Run Cell \| Run Above \| Visualize** links above every `# %%` line; *Run Cell and Go to Next Cell*, *Run Cells Above*. Expression results are shown inline in the editor (`⇒ value`) and in the Output tab. Errors are underlined in the editor. Each run works in the **folder of its file** (`pd.read_csv("data.csv")`, `import helpers` find files next to the script; a lesson's own `utils.py` is the one imported). Your own modules are **reloaded after you edit them** (also names taken with `from helpers import f`; objects made earlier run the new methods). A built-in name that another file overwrote (`max = 0`, `input = sys.stdin.readline`) is removed before a different file runs, with a note. |
| Live Mode (opt-in) | Turning it on runs once right away (starting the kernel if needed); then, after you stop typing (800 ms), re-runs `# %% [live]` cells — or the cell under the cursor. **Data is loaded once**: `pd.read_csv/read_excel/...`, `np.load/loadtxt` run the first time only; later runs restore a fresh copy of what they loaded, so preprocessing such as `df["price"] *= 1.1` is never applied twice. A load re-runs when you edit its line or a variable it uses (e.g. the path). Model training (also chained, `RandomForestClassifier().fit(X, y)`, and inside your own helpers such as `train_epoch()`), writing files, network, `while True` are never re-run automatically (AST heuristic): Live runs the cell **up to** that statement and marks it *Live stops here*. It stops earlier rather than re-create a trained model, an optimizer or a loss list that the training uses (`model = LogisticRegression()` above `model.fit`), so the trained model is kept. Live also never replaces what an earlier Run Cell trained, in any cell or file: a model, a fitted estimator, an optimizer, or a history that training filled (also one a helper filled, as in `train_epoch(model, opt, losses)`); it stops before `model = MLP()` and says which line trained it, and Run Cell rebuilds it on purpose. Cheap preprocessing (`StandardScaler().fit_transform`) and imports (`import torch`, bounded separately) do run. Each live run has a 5 s budget (first-time loads and imports excluded) enforced by a real interrupt. |
| Program input | For judge-style exercises, `input()` and `sys.stdin` read `<script>.in` next to the script (`solution.py` → `solution.in`); *vrun: Edit Program Input* creates/opens it. Editing the `.in` file re-runs Live. |
| Output | Shows the latest run only, like a terminal: tqdm / Keras / LightGBM progress bars redraw one line, ANSI colours show, stdout and stderr keep their order. A run that prints more than 2 MB keeps its start **and its end** (final epochs, test accuracy). Repeated warnings are folded into one line with a count, and show again on every run. |
| Safe ML | Re-running a cell that trains a model (`.fit`, `GridSearchCV`, `cross_val_score`, `.backward()`, `optimizer.step()` …) asks for confirmation if it already ran in this kernel session and took at least `vrun.safeMl.confirmAfterSeconds` (5 s). The dialog reminds you that Keras / PyTorch models keep their weights. `# pylive: manual` in a cell excludes it from Live Mode. |
| Variables | Name, type, shape/len, dtype(s), short value, shallow memory size. No `repr()` is called on unknown objects; DataFrame metadata never scans the data. Expand lists/dicts/objects, open DataFrames, draw structures. Metrics dicts show their values (`accuracy: 0.95, f1: 0.91`). Strings are shown quoted, as Python prints them (`'10'` is not `10`; `'abba\n'` shows its newline); a deque reads `deque([...])`, Counter / OrderedDict / defaultdict name their type. A variable that hides a built-in (`max = 0`, your own `def sum`) is tagged *shadows built-in*. |
| Practising ML | **Tensors** (PyTorch, TensorFlow): shape, dtype, device, `requires_grad`, the value of a loss. **Models**: parameter count, layers, device, train/eval mode (torch `nn.Module`, Keras). **scikit-learn**: changed hyperparameters (`SVC(C=10)`), pipeline steps, fitted or not, `best_params_` / `best_score_`, `classes_`. Optimizers (`Adam(lr=0.001)`), DataLoaders, sparse matrices (shape, non-zeros), `load_iris()` bunches. **image** button on image arrays and tensors (digits, MNIST, CIFAR batches, `(C, H, W)`), 16 at a time. **chart** button on loss / accuracy lists, `history` dicts and Keras `History`, with the best epoch marked. 2-D arrays open in the DataFrame tab. |
| Notebook habits | `%matplotlib inline` and other setup magics are ignored (with a note), `%timeit` / `%time` work, `!pip install x` explains the terminal command to use, `display(obj)` prints, a trailing `;` hides the value. |
| Practice files | *vrun: New Practice File* opens a ready exercise: scikit-learn tabular classification, a PyTorch or Keras network on handwritten digits (bundled datasets, no download), pandas, and DSA practice (sorting / binary search / two pointers / sliding window, recursion and backtracking, graphs and grids, linked lists / BST / heap / trie), each with exercises. Snippets: `vrun-seed`, `vrun-sklearn`, `vrun-torch-loop`, `vrun-cell`. |
| DataFrame viewer | The frame stays in the kernel. Pages of 25–500 rows, column windows for wide frames, dtype colours, NaN/NaT/None/<NA> rendered distinctly, **full-data** sort and filter (clearly labelled), on-demand missing-value % and statistics, per-column top values, copy cell/row. |
| Visualizer (DSA) | `vrun: Visualize Algorithm` traces the current cell/file/selection in a fresh namespace and lets you step through it (⏮ ◀ ▶ ⏭, slider, play speed up to 8×, ←/→ keys) while the current line is highlighted in the editor. **Step over** (↓) a call, **step out** (↑) to its return, **click a code line** to run to it (Shift+click: back to the previous time). Each line shows how often it ran so far, and the line about to run shows its values (`arr[j] = 5 · arr[j + 1] = 1`). **Recursion tree** for recursive code: one box per call with its arguments and returned value, the stack highlighted, click a call to jump to it. **Animation** between steps: swapped values slide, pointers move, heap values sift, new nodes fade in, changed cells flash (✦ Animate toggles it; off with the OS "reduce motion" setting). Up to 5000 steps by default. **Live Visualize** re-traces as you type, keeping your step position. **Visualize on a cell** brings in what the cell needs from the cells above (definitions, plain values, imports of modules already imported, calls of your own helpers that only compute; never file reads, input, data loading or training) and lists it in the run header; *vrun: Visualize File* traces the whole file and steps into those functions. **Endless loops**: when a trace reaches its limit while repeating exactly the same state, it says so and links both steps. **Deep recursion** is folded (the first and last calls of a long chain and those around the current step; the call stack shows the 10 innermost frames) and the cards scroll, so a RecursionError stays readable. Generator expressions are not drawn as calls; **Recursive calls only** folds helper calls (`safe()`, `merge()`) into a `+4 safe()` badge. The values row marks the subscript that failed in red (`nums[j + 1]: index 4, len 4 (0..3)`). |
| Figures | `matplotlib.pyplot` / seaborn figures are rendered and shown in the Output tab; each `plt.show()` is its own figure (a plot per loop iteration works), a `fig` value is drawn, `[<Line2D …>]` is not printed. Plotly's `fig.show()` never opens a browser by itself: the Output tab offers *Open interactive figure*. |
| Recovery | Interrupt (real `KeyboardInterrupt`), automatic offer to restart if native code does not respond, restart/stop with process-tree cleanup, crash detection; old variable handles are rejected after a restart. Worker processes your code starts (`n_jobs=-1`, `DataLoader(num_workers=…)`, `multiprocessing`) end with the kernel. An interrupt during a first `import torch` waits for the import, so the library is never left half-loaded. Errors carry hints: a missing package names the exact `pip install` command for the kernel's Python; DataLoader worker failures on Windows explain the fix. Error summaries keep Python's own *Did you mean ...?*. An off-by-one IndexError names the index, its value, the length and the loop bound to fix (`nums[j + 1]: j + 1 = 4 (j = 3), but len(nums) = 4 … use range(n - i - 1)`); a file not found next to the script, a misspelled file name, a module name in the wrong case, a module edited after import, a built-in name you overwrote and Excel / ANSI encodings get their own explanation. |

### What the visualizer draws

| Your data | Picture |
|---|---|
| `arr = [5, 1, 4]` + int locals that index it (`arr[j]`, `nums[mid]`) or bound it (`lo`, `hi`, `left`, `right`, …) | bar chart / cells with pointer arrows from the frame that uses them, the range between `lo..hi` / `left..right` shaded, changed cells highlighted |
| a string indexed or scanned by the code (`s[i]`, `enumerate(s)`) | character cells with the same pointers and window shading (palindromes, sliding windows) |
| numeric variables (`lo = 0`, `target = 11`, `x = 2.5`) | **number line** (trục số) with labelled marks; next to a drawing only when a value is a float |
| `set` of numbers | points on a number line |
| list of `(x, y)` pairs, or `xs` + `ys` lists | **function graph** (đồ thị hàm số) |
| `[[...], [...]]`, 2-D NumPy arrays | matrix / DP table with heat colours, the `[i][j]` the code indexes highlighted, cells in `visited` / `queue` / `path` sets of `(r, c)` coloured, row/column headers from the two strings of an LCS / edit-distance table |
| `{"A": ["B", "C"], ...}` or `{u: {v: w}}` | **graph** (đồ thị), layered for trees and DAGs, vertices stay in place while stepping — `visited`/`seen` filled, `queue`/`stack` outlined, current `u` and neighbour `v` marked with the edge between them, `dist` next to vertices, `path` edges in red |
| `edges = [(0, 1), (1, 2, 5)]` | the same graph view (weights from the third value) |
| objects with `left`/`right` (or `children` as a list or dict) | binary tree / n-ary tree / **trie** with letters on the edges and end-of-word nodes |
| nested dicts (`node = node.setdefault(ch, {})`) | trie |
| `parent = list(range(n))` (union-find) | **forest** of parent links |
| `tree = [3, 9, 20, None, None, 15, 7]` | binary tree in level order |
| objects with `next` | linked list with `head`, `prev`, `cur`… labels and cycle detection; with `prev` links too, a doubly linked list (a link still broken after the list's own method returns is red and explained, `dll.head` / `self.tail` label their nodes) |
| a stack / queue / heap of nodes or tuples | the nodes' values and tuples as `(1,0,5)`, `((2,3),4)`; tree and list nodes waiting in it are outlined in their drawing |
| a list named `heap`/`pq` | binary heap drawn as a tree |
| recursive functions | **recursion tree** of the calls so far, arguments and returned values |

Array cards can switch between *bars · cells · chart · number line · heap* (union-find: *forest*, edge lists: *graph*, level-order lists: *tree*).

## Requirements

* VS Code 1.90 or newer (tested on 1.143.1, Windows 11)
* Python 3.12+ (tested 3.12.10 and 3.15.1). The kernel uses only the
  standard library; pandas/NumPy/scikit-learn/matplotlib are used when you
  import them.

## Install (local VSIX, any machine)

The `.vsix` file is self-contained (about 90 KB): it bundles the extension and
its Python kernel, and needs nothing from this repository.

### Installer bundle (recommended)

`npm run dist` builds the VSIX and `dist/vrun-<version>-installer.zip`
(VSIX + `install.cmd` / `install.ps1` / `install.sh` + `INSTALL.md`, with
instructions in Vietnamese and English). Send the zip; on the other machine:

* **Windows:** unzip and double-click `install.cmd`. It finds VS Code and
  Python 3.12+ (offering to install missing ones with `winget`), offers to
  install pandas / numpy / matplotlib / openpyxl into that Python, removes the
  old PyLive / Veil extensions, installs the Python extension and vrun.
  `install.cmd -Yes` runs unattended, `-NoLibraries` skips the libraries.
* **macOS / Linux:** `sh install.sh`.

### Manual install

On the other machine:

1. Install **VS Code 1.90+** and **Python 3.12+**. Install the libraries the
   scripts use into that Python, e.g. `python -m pip install pandas openpyxl
   numpy scikit-learn matplotlib` (`openpyxl` is needed for `read_excel`).
2. Install the extension, from a terminal:

   ```powershell
   code --install-extension vrun-0.3.0.vsix
   ```

   or in VS Code: *Extensions* view → `…` → *Install from VSIX…*.
3. Reload the window. Open a folder and trust it when asked (vrun only runs
   in **trusted** workspaces, because it executes code).
4. vrun uses the interpreter selected in the Python extension (*Python:
   Select Interpreter*), else `python` on PATH; set `vrun.pythonPath` to
   force one. *vrun: Show Kernel Log* shows which one started.

Optional panels (*Settings → vrun*): `vrun.features.visualizer`
(DSA visualizer) and `vrun.features.dataframe` (DataFrame viewer).

## Usage

1. Open a `.py` file, or run *vrun: New Practice File* and pick an exercise
   (`examples/ml_sklearn_tabular.py`, `ml_pytorch_digits.py`,
   `ml_keras_digits.py`, `pandas_demo.py`, `dsa_demo.py` are also inside the
   installed extension folder).
2. Click **Run Cell** above a `# %%` line (or `Ctrl+Alt+C`), `Ctrl+Alt+Enter`
   **Run Selection** (or the current line), *vrun: Run File*. The inspector
   opens beside the editor.
3. **Visualize** above a cell (or `Ctrl+Alt+V` **Visualize Algorithm**), then
   step with ← / →. *vrun: Visualize File* traces the whole file, all cells.
4. `Ctrl+Alt+I` **Interrupt**, *vrun: Restart Kernel* to start fresh
   (*vrun: Run Cells Above* then brings the variables back).

The triangle *Run Python File* and Shift+Enter belong to the Python extension
(they run in a terminal, where vrun sees no variables), and the Jupyter
extension's *Run Cell* / Shift+Enter / Ctrl+Enter run in Jupyter's own Python.
To make Shift+Enter run the cell in vrun and move to the next one (and
Ctrl+Enter too when the Jupyter extension is installed), turn on
`vrun.shiftEnterRunsCell`; when Jupyter is present, vrun offers this once.

Commands (Command Palette → "vrun"): Start / Restart / Stop Kernel, Run
Selection / Cell / File, Run Cell and Go to Next Cell, Run Cells Above,
Toggle Live Mode, Visualize Algorithm, Visualize File, Toggle Live
Visualize, Open Variable Explorer, Open DataFrame Viewer, Interrupt
Execution, Show Kernel Log, New Practice File.

### Settings

The inspector starts minimal — **Variables** and **Output** only. Turn on the
extra tabs in *Settings → vrun* (or when a command asks):

| Setting | Default | Meaning |
|---|---|---|
| `vrun.features.visualizer` | false | show the **Visualizer** tab (DSA step-by-step drawings) and its commands |
| `vrun.features.dataframe` | false | show the **DataFrame** tab (paging, sort, filter, summaries) |
| `vrun.pythonPath` | `""` | interpreter override |
| `vrun.live.debounceMs` | 800 | delay before a live re-run |
| `vrun.live.timeoutMs` | 5000 | time budget of one live run |
| `vrun.interrupt.graceMs` | 3000 | wait before offering a restart |
| `vrun.dataframe.pageSize` | 50 | rows per page |
| `vrun.inspect.timeoutMs` | 20000 | budget for summaries/sorts |
| `vrun.trace.maxSteps` | 5000 | visualizer step limit |
| `vrun.trace.timeoutMs` | 15000 | visualizer time limit |
| `vrun.safeMl.confirmRepeatTraining` | true | confirm repeated training |
| `vrun.safeMl.confirmAfterSeconds` | 5 | only confirm when the previous training run took this long (0 = always) |
| `vrun.codeLens` | true | Run Cell / Run Above / Visualize above each `# %%` line |
| `vrun.shiftEnterRunsCell` | false | Shift+Enter runs the cell in vrun and moves to the next one (with a selection: runs the selection); with the Jupyter extension, Ctrl+Enter in a `# %%` file also runs the cell in vrun |

The kernel works in the folder of the file you run, as `python script.py`
from that folder would, and that folder is first on `sys.path`. So
`pd.read_csv("data.csv")` and `import helpers` find files next to your
script, and the Output says `working folder: …` when it changes. When each
lesson folder has its own `utils.py`, `import utils` loads the copy next to
the file you run (going back to lesson 1 brings its copy back as it was). If
your code calls `os.chdir`, vrun leaves the folder where you put it, and says
so once when another file runs. A New Practice File (untitled) runs in the
last folder.

Text files are read and written as UTF-8 by default (the kernel runs Python
in UTF-8 mode, like VS Code saves files). A CSV saved by Excel as "CSV (Comma
delimited)" is not UTF-8: save it as "CSV UTF-8", or pass
`encoding='cp1258'` (Vietnamese) or `encoding='cp1252'` (Western European).

## Develop

Needs Node.js 20+ and Python 3.12+. On Windows one command sets everything
up (npm dependencies, a `.venv` with `python/requirements-dev.txt`, build,
type check, unit tests) and rebuilds a `.venv` copied from another machine:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-dev.ps1
```

The test scripts use `.venv` automatically; set `PYLIVE_PYTHON` to test with
another interpreter (it needs pandas). By hand:

```powershell
npm ci
python -m venv .venv; .venv\Scripts\python -m pip install -r python\requirements-dev.txt
npm run typecheck
npm test               # Node unit tests incl. KernelClient against real Python
npm run test:py        # pytest (kernel, DataFrame, tracer, safety, serialization)
npm run test:vscode    # integration tests in an Extension Development Host
npm run package        # → vrun-0.3.0.vsix
npm run dist           # → VSIX + dist/vrun-0.3.0-installer.zip for other machines
python benchmarks/run_benchmarks.py     # see BENCHMARKS.md
python scripts/build_harness.py         # dev/harness.html: webview with real data in a browser
```

Press `F5` with this folder open to start an Extension Development Host.

Design and measurements are documented in the repository: `ARCHITECTURE.md`,
`DECISIONS.md`, `BENCHMARKS.md`, `TASKS.md`, `AGENTS.md`.

## Known limitations

* **Load once** keys a data load by its code and the values of the simple
  variables it uses (paths, numbers). It does not notice that the file on
  disk changed: use *Run Cell* to re-read. Reused data costs one extra copy in
  memory (cheap with pandas copy-on-write, the default in pandas 3). Loads
  whose result cannot be copied safely are re-run every time.

* **Interrupt** raises `KeyboardInterrupt` between Python bytecodes. A single
  long native call (big NumPy/pandas operation, `time.sleep` on Windows) or
  code that swallows `KeyboardInterrupt` cannot be interrupted; vrun then
  offers a restart, which loses all variables.
* **Live Mode safety is heuristic.** The AST check sees chained calls and
  your own helper functions (defined in the same code or earlier), but not
  aliases, library wrappers or dynamic code. Live Mode is opt-in per file and
  every live run has a time budget; it is not a sandbox.
* **Visualizer** traces in a fresh namespace (your kernel variables are not
  visible to it and not modified), but imports and module-level side effects
  are shared with the kernel process. Large programs are cut off at
  `trace.maxSteps` / size / time limits. Only user-defined classes and
  built-in containers (plus `defaultdict`, `Counter`, `OrderedDict`) are
  expanded; library objects are shown by type name. `input()` reads the
  `<script>.in` file. Each step shows up to 512 items of a list, set or dict,
  80 characters of a string, 64×64 of a 2-D array and about 1000 objects;
  anything cut says so (`… 188 more not shown`, `j=650 (beyond the 512
  shown)`, `not shown: too many objects`). Sets of numbers, strings or tuples
  of them are shown sorted. Bigger caps mean bigger traces: a program that
  changes a long list on every step reaches the trace size limit sooner if
  you raise `vrun.trace.maxSteps`.
* **Visualize on a cell** runs the needed statements of the cells above
  untraced: steps inside functions from the cells above are not shown (use
  *vrun: Visualize File*), but they count against the time limit. A statement
  above that ran out of time is not run again while the text above stays the
  same. Visualize leaves the kernel's `random` state as it was.
* **Endless-loop detection is a hint, not proof.** It never reports loops
  that depend on time, random numbers, input, iterators, code outside the
  traced cell, objects of other modules' classes changed through their
  methods, or containers larger than 10,000 items.
* **Index watches** do not evaluate guards: on a line that did raise, a
  subscript behind `i < len(a) and a[i]` can still be red, and an IndexError
  from a call on the same line (`stack.pop()`) cannot be told apart from a
  subscript's.
* **Reloading your modules**: an edited class whose metaclass, base classes
  or `__slots__` changed becomes a new class (objects made before keep the
  old one). A module that trains or reads input when imported is not
  reloaded automatically (the note says so). Live Mode does not reload; it
  says so once per save. After switching lessons, a cell that uses `utils`
  without its own `import utils` keeps the other lesson's module until an
  import line of this lesson runs.
* `subprocess.run(..., text=True)` decodes output as UTF-8 (UTF-8 mode): for
  Windows console tools that print accented text, pass `encoding='oem'` or
  `errors='replace'`.
* Sort/filter caches live for one execution count only; a background thread
  that mutates a DataFrame between executions can make a page inconsistent.
* Output printed by background threads is attributed to the run that started
  the thread only until a newer run starts; after that (and for threads made
  with `_thread` or thread pools reused across runs) it appears under
  "Background output" — never under a wrong run.
* This is a plain Python kernel (see ADR-001): only a few notebook magics are
  understood (`%matplotlib`, `%timeit`, `%time` and similar); `!` shell lines
  and `%pip` are explained, not run.
* Windows starts DataLoader / multiprocessing workers by importing your saved
  script: classes defined only in cells or unsaved files are not visible to
  them. Use `num_workers=0` while practising, or put the Dataset in a module.
* Plotly figures open in your browser (an offline HTML file); static images
  of them need `kaleido` and `pio.renderers.default = "png"`.
* DataFrame memory is reported shallow (`≥` for object/string columns).
* Child processes started by your code end with the kernel (Windows Job
  Object; POSIX process group), except programs that explicitly break away
  (`CREATE_BREAKAWAY_FROM_JOB`, `setsid`).
