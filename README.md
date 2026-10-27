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
| Live Mode (opt-in) | After you stop typing (800 ms), re-runs `# %% [live]` cells — or the cell under the cursor. Code with model training, file/network I/O, `while True`, `input()`… is never re-run automatically (AST heuristic). Each live run has a 5 s budget enforced by a real interrupt. |
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

## Install (local VSIX)

```powershell
code --install-extension pylive-inspector-0.1.0.vsix
```

or in VS Code: *Extensions* view → `…` → *Install from VSIX…*. Reload the
window. The extension only runs in **trusted** workspaces (it executes code).

Choose the interpreter with the Python extension (*Python: Select
Interpreter*) or set `pylive.pythonPath`.

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

| Setting | Default | Meaning |
|---|---|---|
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
  built-in containers are expanded; library objects are shown by type name.
  `input()` is not supported.
* Sort/filter caches live for one execution count only; a background thread
  that mutates a DataFrame between executions can make a page inconsistent.
* No IPython magics (`%timeit`, `!pip`) — this is a plain Python kernel (see
  ADR-001).
* DataFrame memory is reported shallow (`≥` for object/string columns).
* Child processes started by your code are killed on restart/stop (tree kill),
  but not when they detach themselves.
