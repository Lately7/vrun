# PyLive Inspector

A VS Code extension for people learning **Python, data science and data
structures & algorithms**. Run ordinary `.py` files in a persistent Python
kernel, explore variables and large pandas DataFrames without printing them,
and watch algorithms run step by step as pictures: bars with `i`/`j`
pointers, number lines, graphs, trees, linked lists and DP tables.

## Features

| Area | What you get |
|---|---|
| Persistent kernel | One long-running Python process per window. Variables and imports survive between runs. stdout/stderr captured, tracebacks mapped to your file's lines, status `idle / busy / interrupting / crashed`. |
| Execution | Run Selection, Run Cell (`# %%` cells), Run File. Expression results are shown inline in the editor (`⇒ value`) and in the Output tab. Errors are underlined in the editor. |
| Live Mode (opt-in) | Turning it on runs once right away (starting the kernel if needed); then, after you stop typing (800 ms), re-runs `# %% [live]` cells — or the cell under the cursor. **Data is loaded once**: `pd.read_csv/read_excel/...`, `np.load/loadtxt` run the first time only; later runs restore a fresh copy of what they loaded, so preprocessing such as `df["price"] *= 1.1` is never applied twice. A load re-runs when you edit its line or a variable it uses (e.g. the path). Model training, writing files, network, `while True` are never re-run automatically (AST heuristic). Each live run has a 5 s budget (first-time loads excluded) enforced by a real interrupt. |
| Program input | For judge-style exercises, `input()` and `sys.stdin` read `<script>.in` next to the script (`solution.py` → `solution.in`); *PyLive: Edit Program Input* creates/opens it. Editing the `.in` file re-runs Live. |
| Output | Shows the latest run only; a new run replaces the previous result. |
| Safe ML | Re-running a cell that trains a model (`.fit`, `GridSearchCV`, `cross_val_score`, `.train()` …) asks for confirmation if it already ran in this kernel session. `# pylive: manual` in a cell excludes it from Live Mode. |
| Variables | Name, type, shape/len, dtype(s), short value, shallow memory size. No `repr()` is called on unknown objects; DataFrame metadata never scans the data. Expand lists/dicts/objects, open DataFrames, draw structures. |
| DataFrame viewer | The frame stays in the kernel. Pages of 25–500 rows, column windows for wide frames, dtype colours, NaN/NaT/None/<NA> rendered distinctly, **full-data** sort and filter (clearly labelled), on-demand missing-value % and statistics, per-column top values, copy cell/row. |
| Visualizer (DSA) | `PyLive: Visualize Algorithm` traces the current cell/file/selection in a fresh namespace and lets you step through it (⏮ ◀ ▶ ⏭, slider, play speed, ←/→ keys) while the current line is highlighted in the editor. **Live Visualize** re-traces as you type, keeping your step position. |
| Figures | `matplotlib.pyplot` figures are rendered (Agg) and shown in the Output tab. |
| Recovery | Interrupt (real `KeyboardInterrupt`), automatic offer to restart if native code does not respond, restart/stop with process-tree cleanup, crash detection; old variable handles are rejected after a restart. |

### What the visualizer draws

| Your data | Picture |
|---|---|
| `arr = [5, 1, 4]` + int locals named `i, j, lo, hi, mid, left, right, …` | bar chart / cells with pointer arrows, changed cells highlighted |
| numeric variables (`lo = 0`, `target = 11`, `x = 2.5`) | **number line** (trục số) with labelled marks |
| `set` of numbers | points on a number line |
| list of `(x, y)` pairs, or `xs` + `ys` lists | **function graph** (đồ thị hàm số) |
| `[[...], [...]]`, 2-D NumPy arrays | matrix / DP table with heat colours and `[i][j]` highlight |
| `{"A": ["B", "C"], ...}` or `{u: {v: w}}` | **graph** (đồ thị) — `visited`/`seen` filled, `queue`/`stack` outlined, current `node` highlighted, `dist` shown under vertices, `path` edges in red |
| objects with `left`/`right` (or `children`) | binary tree / n-ary tree |
| objects with `next` | linked list with `head`, `prev`, `cur`… labels and cycle detection |
| a list named `heap`/`pq` | binary heap drawn as a tree |

Every array card can switch between *bars · cells · chart · number line · heap*.

## Requirements

* VS Code 1.90 or newer (tested on 1.143.1, Windows 11)
* Python 3.12+ (tested 3.12.10 and 3.15.1). The kernel uses only the
  standard library; pandas/NumPy/scikit-learn/matplotlib are used when you
  import them.

## Install (local VSIX, any machine)

The `.vsix` file is self-contained (about 90 KB): it bundles the extension and
its Python kernel, and needs nothing from this repository.

On the other machine:

1. Install **VS Code 1.90+** and **Python 3.12+**. Install the libraries the
   scripts use into that Python, e.g. `python -m pip install pandas openpyxl
   numpy scikit-learn matplotlib` (`openpyxl` is needed for `read_excel`).
2. Install the extension, from a terminal:

   ```powershell
   code --install-extension pylive-inspector-0.2.0.vsix
   ```

   or in VS Code: *Extensions* view → `…` → *Install from VSIX…*.
3. Reload the window. Open a folder and trust it when asked (PyLive only runs
   in **trusted** workspaces, because it executes code).
4. PyLive uses the interpreter selected in the Python extension (*Python:
   Select Interpreter*), else `python` on PATH; set `pylive.pythonPath` to
   force one. *PyLive: Show Kernel Log* shows which one started.

Optional panels (*Settings → PyLive Inspector*): `pylive.features.visualizer`
(DSA visualizer) and `pylive.features.dataframe` (DataFrame viewer).

## Usage

1. Open a `.py` file (try `examples/dsa_demo.py` or `examples/pandas_demo.py`
   from the repository; both are also inside the installed extension folder).
2. `Ctrl+Alt+C` **Run Cell**, `Ctrl+Alt+Enter` **Run Selection** (or the current
   line), *PyLive: Run File*. The inspector opens beside the editor.
3. `Ctrl+Alt+V` **Visualize Algorithm**, then step with ← / →.
4. `Ctrl+Alt+I` **Interrupt**, *PyLive: Restart Kernel* to start fresh.

Commands (Command Palette → "PyLive"): Start / Restart / Stop Kernel, Run
Selection / Cell / File, Toggle Live Mode, Visualize Algorithm, Toggle Live
Visualize, Open Variable Explorer, Open DataFrame Viewer, Interrupt
Execution, Show Kernel Log.

### Settings

The inspector starts minimal — **Variables** and **Output** only. Turn on the
extra tabs in *Settings → PyLive Inspector* (or when a command asks):

| Setting | Default | Meaning |
|---|---|---|
| `pylive.features.visualizer` | false | show the **Visualizer** tab (DSA step-by-step drawings) and its commands |
| `pylive.features.dataframe` | false | show the **DataFrame** tab (paging, sort, filter, summaries) |
| `pylive.pythonPath` | `""` | interpreter override |
| `pylive.live.debounceMs` | 800 | delay before a live re-run |
| `pylive.live.timeoutMs` | 5000 | time budget of one live run |
| `pylive.interrupt.graceMs` | 3000 | wait before offering a restart |
| `pylive.dataframe.pageSize` | 50 | rows per page |
| `pylive.inspect.timeoutMs` | 20000 | budget for summaries/sorts |
| `pylive.trace.maxSteps` | 1000 | visualizer step limit |
| `pylive.trace.timeoutMs` | 15000 | visualizer time limit |
| `pylive.safeMl.confirmRepeatTraining` | true | confirm repeated training |

The working directory of the kernel is the folder of the file that was active
when it started, so `pd.read_excel("Online Retail.xlsx")` finds files next to
your script.

## Develop

```powershell
npm install
python -m venv --system-site-packages .venv; .venv\Scripts\python -m pip install pytest psutil
$env:PYLIVE_PYTHON = (Resolve-Path .venv\Scripts\python.exe)
npm run typecheck
npm test               # Node unit tests incl. KernelClient against real Python
npm run test:py        # pytest (kernel, DataFrame, tracer, safety, serialization)
npm run test:vscode    # integration tests in an Extension Development Host
npm run package        # → pylive-inspector-0.1.0.vsix
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
  code that swallows `KeyboardInterrupt` cannot be interrupted; PyLive then
  offers a restart, which loses all variables.
* **Live Mode safety is heuristic.** The AST check cannot see through
  aliases, helper functions or dynamic code. Live Mode is opt-in per file and
  every live run has a time budget; it is not a sandbox.
* **Visualizer** traces in a fresh namespace (your kernel variables are not
  visible to it and not modified), but imports and module-level side effects
  are shared with the kernel process. Large programs are cut off at
  `trace.maxSteps` / size / time limits. Only user-defined classes and
  built-in containers (plus `defaultdict`, `Counter`, `OrderedDict`) are
  expanded; library objects are shown by type name. `input()` reads the
  `<script>.in` file.
* Sort/filter caches live for one execution count only; a background thread
  that mutates a DataFrame between executions can make a page inconsistent.
* Output printed by background threads is attributed to the run that started
  the thread only until a newer run starts; after that (and for threads made
  with `_thread` or thread pools reused across runs) it appears under
  "Background output" — never under a wrong run.
* No IPython magics (`%timeit`, `!pip`) — this is a plain Python kernel (see
  ADR-001).
* DataFrame memory is reported shallow (`≥` for object/string columns).
* Child processes started by your code are killed on restart/stop (tree kill),
  but not when they detach themselves.
