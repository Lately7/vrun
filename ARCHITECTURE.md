# vrun — Architecture

## 1. Component diagram

```
┌──────────────────────────── VS Code ─────────────────────────────┐
│                                                                  │
│  Editor (.py)  ──commands/edits──▶  Extension Host (TypeScript)  │
│       ▲                               │  src/extension.ts        │
│       │ decorations, error ranges     │  src/exec/*  (cells,     │
│       └───────────────────────────────┤   live controller,       │
│                                       │   debounce, stale gen)   │
│  Webview panel (plain TS + SVG)       │  src/kernel/* (client,   │
│   media/ built from webview/*         │   protocol, resolver)    │
│   Variables │ DataFrame │ Output │    │  src/ui/* (panel, status │
│   Visualizer (DSA) │ Errors           │   bar, validation)       │
│        ▲  postMessage (validated)     │                          │
│        └──────────────────────────────┤                          │
└───────────────────────────────────────┼──────────────────────────┘
                                        │ stdin/stdout, NDJSON
                                        ▼ (no network sockets)
                   Python worker process (python/pylive_kernel)
                   ├─ reader thread: parses requests, handles
                   │   control msgs (interrupt/cancel/shutdown)
                   └─ main thread: sequential task queue
                       executor · inspector · dataframe ·
                       serialize · safety (AST) · tracer (DSA)
```

## 2. Backend lifecycle

1. `KernelClient.start()` resolves the interpreter (setting `vrun.pythonPath`
   → Python extension's active interpreter → `python` on PATH) and spawns
   `python -u <ext>/python/launcher.py` with `shell: false`, an argument array,
   `cwd` = the active file's folder (else the workspace folder), and env
   additions `PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`
   (UTF-8 mode: `open()` reads the UTF-8 files VS Code saves, whatever the
   Windows code page), `MPLBACKEND=Agg`.
2. The worker duplicates fd 0/1 for the protocol, then points fd 0 at
   `os.devnull` and fd 1 at fd 2. Native (C-level) writes to stdout therefore
   go to stderr (shown as the kernel log) and can never corrupt the protocol.
   Python-level `sys.stdout`/`sys.stderr` are replaced by capturing streams
   that emit `stream` events.
3. The worker sends a `ready` event carrying a random `session` token, Python
   version and pid. The host stores the token as the kernel **generation**.
4. Status transitions: `starting → idle ⇄ busy → (interrupting) → idle`,
   `crashed` on unexpected exit, `restarting`, `stopped`.
5. Stop: send `shutdown`, wait up to 2 s, then kill the process tree
   (`taskkill /T /F /PID` on Windows, `SIGKILL` elsewhere).
6. The worker exits when its stdin reaches EOF, so a crashed VS Code never
   leaves an orphaned kernel. Grandchild processes created by user code
   (e.g. `multiprocessing`) are killed only by the tree kill.

## 3. Communication protocol

Newline-delimited JSON (UTF-8). Every request: `{id, type, ...params}`.
Every response: `{id, type: "response", ok, result | error:{code,message}}`.
Asynchronous events: `{type: "event", event, ...}` (`ready`, `stream`,
`status`, `display`). Outgoing messages above `MAX_MESSAGE_BYTES` (8 MiB)
are replaced by a `message_too_large` error.

| Request              | Runs on      | Purpose                                         |
|----------------------|--------------|-------------------------------------------------|
| `execute`            | main queue   | run code (`mode`: manual / live); returns value |
| `trace`              | main queue   | run code in an isolated namespace under a line tracer, return bounded snapshots (DSA visualizer) |
| `analyze`            | main queue   | AST safety heuristics only                      |
| `variables.list`     | main queue   | cheap metadata for all user variables           |
| `variables.inspect`  | main queue   | bounded detail + structure view of one variable |
| `variables.image`    | main queue   | PNG grid (stdlib zlib) of up to 16 images from an image-shaped array / tensor |
| `variables.series`   | main queue   | downsampled numbers over time (losses, history dicts, Keras History) |
| `dataframe.metadata` | main queue   | shape, dtypes, memory (shallow)                 |
| `dataframe.page`     | main queue   | rows `[offset, offset+limit)` with optional full-data sort/filter |
| `dataframe.summary`  | main queue   | null counts / describe (full scan, on demand)   |
| `interrupt`          | reader thread| interrupt the currently running task            |
| `cancel`             | reader thread| drop a queued (not yet started) request         |
| `shutdown`           | reader thread| exit                                            |

Captured output (`outbuf.py`): stdout and stderr append to one ordered
segment buffer, flushed every 50 ms or 8 KB (user `flush()` calls are
batched to the same rate). Frames that a later `\r` overwrites are dropped
before sending. A run may send 2 MB: past the head budget, output goes to a
256 KB tail that is sent, after a marker, when the task ends. The streams
report `isatty()` true; the webview's terminal model (`webview/terminal.ts`)
interprets `\r`, `\b`, SGR colours and cursor / erase codes.

Processes started by user code join the kernel's Windows Job Object
(`KILL_ON_JOB_CLOSE`), or its POSIX process group, so they end with it.
When matplotlib is imported in the kernel, an import hook switches it to the
kernel's own backend (`mpl_backend.py`): Agg drawing, with `plt.show()`
handing figures to the run in order. `MPLBACKEND` stays `Agg`, because child
processes inherit it and cannot import `pylive_kernel`.

Variable handles are `{session, revision, name}`. A request carrying a session
that is not the worker's current session is rejected with `stale_handle`
(kernel restarted); a request carrying an older `revision` (execution count)
is rejected with `stale_revision`, and the DataFrame viewer reloads its
metadata. Only one thread — the writer thread — writes protocol output, so a
`KeyboardInterrupt` in the main thread can never cut a message in half.

## 4. Execution flow

```
command → ExecutionManager → KernelClient.request(execute, {code, file,
lineOffset, mode, execId}) → worker queue → ast.parse → (live: safety check)
→ exec body / eval last expr → capture streams, figures → response
→ host: if response.generation is stale → drop; else update panel,
  decorations, diagnostics → refresh variables.list
```

* **Manual**: Run Selection / Cell (`# %%`) / File.
* **Live**: per-document opt-in. After a debounce (default 800 ms) the live
  cells (`# %% [live]`) — or, if none, the cell under the cursor — are re-run
  in `live` mode. The worker refuses live code that the AST heuristics flag
  (model fitting, search/CV, I/O, network, `input`, subprocess, unbounded
  `while True`). Live runs have a time budget (default 5 s) enforced by a real
  interrupt. At most one live request per document is in flight; edits that
  arrive meanwhile are coalesced into one follow-up request (backpressure).
* **Load once** (ADR-007): live cells execute statement by statement; data
  loads run once and are later restored from a snapshot copy.
* **Program input**: the host sends the text of `<script>.in` as `stdin` with
  `execute`/`trace`; `input()` and `sys.stdin` read it.
* **Before each run** (`worker._prepare_run`, one queue on the main thread, so
  a process-wide `chdir` never happens in the middle of another run):
  * **Working folder** (`workdir.py`): `execute` and `trace` carry `cwd`, the
    folder of a saved file. If `os.getcwd()` is still the folder vrun chose
    last time, the kernel moves there and replaces the `sys.path` entry it
    added for the previous folder; a learner's own `os.chdir` is kept. A
    top-level module of the learner that the new folder has its own copy of
    (`utils.py` per lesson) is set aside and swapped (`reloader.follow_folder`).
  * **Reload** (`reloader.py`, manual runs and traces only): the learner's own
    modules (outside the standard library, site-packages and vrun) whose file
    changed since import are reloaded in dependency order from their own
    folder; names that point to old functions or classes are rebound, and a
    class with a plain `type` metaclass keeps its identity and takes the new
    body. A failed reload restores the old module.
  * **Shadowed built-ins** (`shadows.py`): a built-in name another file bound
    in the shared namespace is removed before a run of a different file that
    does not bind it itself.
  * Each step adds a line to `result.notes` when it changes something; notes of
    a run the host does not show (blocked Live run) wait for the next result.
* **Trained state** (`livestate.TrainedNames`): manual runs record names whose
  objects a training statement built or filled (models, fitted estimators,
  optimizers, histories, by weak reference or id); Live stops before a
  statement that would rebind one, with a fallback check of the objects
  themselves (fitted estimator, optimizer state, gradients, Keras history).
* **Live Visualize** (DSA): same debounce/coalescing, but issues `trace`.
* Every request carries an `execId`; each document has a monotonically
  increasing live generation. Responses for older generations are discarded.

## 5. DataFrame paging

The DataFrame stays in kernel memory. `dataframe.page` returns at most
`limit ≤ 500` rows and `≤ 200` columns. Cell values are encoded by
`serialize.encode_scalar` (NaN/NaT/None/inf, timestamps as ISO strings,
integers outside ±2^53 as strings, truncated strings). Sorting and filtering
are **full-data** operations executed in the kernel; the resulting ordering
is cached only until the next `execute` (any execution may mutate the frame).
Null counts and `describe()` are computed only when the user asks.

## 6. Interrupt handling

* The reader thread receives `interrupt{target}` and, if that task is still
  current, calls `_thread.interrupt_main()` (a simulated SIGINT →
  `KeyboardInterrupt` at the next bytecode boundary). Under a lock, at most
  one interrupt is issued per task, so exactly one `KeyboardInterrupt` can
  arrive: inside the task, inside the bookkeeping after it (caught by an outer
  handler that still sends the reply), or as a pending signal that a
  `_drain_pending_interrupt()` call surfaces before the next task starts.
  Interrupt also cancels queued executions.
* Inspection requests have a worker-side deadline enforced the same way.
* Long native calls (a single huge NumPy op, `time.sleep` on Windows, code
  that swallows `KeyboardInterrupt`) cannot be interrupted. After a grace
  period (default 3 s) the host offers to **restart** the kernel, which kills
  the process and loses all variables. This is stated in the UI.

## 7. DSA visualizer

`trace` compiles the code with a private filename, runs it in a fresh
namespace (the persistent namespace is untouched) under `sys.settrace`, and
records a snapshot per executed line of user code: line number, call stack,
locals of each user frame, and a heap of referenced objects (lists, dicts,
sets, tuples, user objects with `__dict__`/`__slots__`) with stable ids.

The snapshots are compact:

* **Heap deltas** (`heapDelta: true`): a step carries only the heap nodes
  whose encoding changed since they were last sent; `gone` lists ids that
  fell over the node cap, so an older copy is never shown as current. The
  webview (`traceModel.ts`) rebuilds the heap of any step from checkpoints
  every 64 steps.
* **Frames:** a suspended caller cannot change its own locals, so only the
  top frame, the module frame and frames that own closure cells are
  re-encoded on each step; the others reuse their last encoding. A caller is
  re-encoded once more when it calls (its line has not finished:
  comprehension variables, `f(i := i + 1)`) and when the callee returns
  (the callee may have changed its objects). Its objects can otherwise only
  change through a frame that reaches them, which is encoded; a builtin
  bound method (`out.append` passed as a callback) carries its owner
  (`"of"`) so the list stays reachable. A closure's free variables are shown
  in the running frame and in the frame that owns the cell, not in every
  suspended copy. Library frames between traced ones (a `key=lambda` called
  by `heapq`) are skipped, not the end of the stack.
* **Stack runs** (`stackRuns: true`): in `stack`, a number n stands for n
  frames that are the same objects as at those positions of the previous
  step; the top frame is always sent. A 1000-deep recursion is about
  0.4 MB and 1 s instead of stopping at the 6 MB limit at depth ~460.
* **Calls:** every frame has a call id (`fid`) and, on its first step, its
  parameter names (`params`), the id of its code object (`code`: two
  lambdas are different functions, a recursive lambda is one) and its
  qualified name (`qual`) when it differs. A frame's `return` step says how
  it ended: `ret`, `ret` with `yield: true` (a generator suspended; it keeps
  its id until it really ends), or `raised` (an exception left the frame,
  from the opcode at `f_lasti`; `GeneratorExit` means closed). The
  `StopIteration` that `yield from` / `await` raise internally is not
  recorded. The webview builds the recursion tree, step over / step out and
  per-line run counts from these.

* **Cells above** (`prelude.py`): `trace` may carry `prelude`, the text above
  a traced `# %%` cell. Only safe top-level statements are kept (definitions,
  imports of already-imported or standard modules, plain values, simple loops,
  calls of helpers whose bodies pass the same whitelist), and only those the
  cell needs; they run untraced under `<pylive-trace-prelude>`, output
  discarded, within half the time budget, and functions defined there get a
  time-only trace. The result's `notes` list what was used and what was
  skipped and why.
* **Endless loops**: the recorder compares each step's frames (top frame,
  line, encoded locals, plus fingerprints of what a tag hides) with earlier
  ones; the comparison restarts on any heap change, input, or a line that can
  change state the trace does not show (iterators, random, time, untraced
  calls). If the trace stops at a limit while a cycle repeats up to the end,
  the result carries `loop: {first, repeat, line, values, prints?}`; the trace
  never stops early because of it.
* **Stopper**: a `sys.monitoring` LINE callback on the traced code objects
  keeps raising the limit, so a bare `except:` cannot swallow it and loop on
  untraced.

Hard limits: steps (default 5000), 1000 objects per snapshot, 512 items per
container (64×64 for 2-D arrays, 80 characters per string), total bytes, wall
time. Nodes keep `len` next to the items sent, and a ref over the node cap is
`{ref, missing: true}`, so the views say what was cut. Tuples of plain values
are sent once, and unchanged containers and objects reuse their node
(identity snapshots). Exceeding a limit stops the trace cleanly and the
partial trace is still shown. The webview infers views from the data:

| Data shape                              | View                          |
|-----------------------------------------|-------------------------------|
| list of numbers                         | bar array with index pointers (`i`, `j`, `lo`, `mid`, …) |
| numeric scalars / set of numbers        | number line                   |
| list of lists                           | matrix / DP table; `(r, c)` sets coloured |
| dict of key → list/set of keys, edge list | graph (adjacency), highlights `visited`/`queue`/`stack`, stable layout |
| objects with `left`/`right`/`children`  | binary / n-ary tree, trie     |
| nested dicts                            | trie                          |
| `parent` list of indexes                | union-find forest             |
| list with `None` named `tree`/`root`    | level-order binary tree       |
| objects with `next`                     | linked list                   |
| list named `heap` / used with `heapq`   | heap as tree                  |
| list of (x, y) pairs, or `xs`/`ys`       | line chart (function graph)   |
| string indexed by the code              | character cells               |

Which names point where comes from the source (`webview/viz/sourceHints.ts`):
a pointer is drawn on a sequence only when the code indexes that sequence
with it, or it is a bound name (`lo`, `hi`, `left`, …) of a sequence the
code scans, and only from the frame that holds the sequence. Views key
their elements (`data-anim` within a card's `data-anim-scope`) and
`webview/viz/animate.ts` animates from the previous step's layout (FLIP).

`variables.inspect` returns the same structure description for persistent
variables, so the Visualizer also works without tracing.

## 8. Security boundaries

* Trusted: code the user runs explicitly (or opts in to via Live Mode).
* Untrusted: anything coming from the webview. The webview can only send an
  allowlisted set of message types; every field is validated (type, length,
  integer range). Webview messages never contain code or shell strings.
* No network server; IPC is the child process's pipes. No pickle.
* Process spawn uses an argv array with `shell: false`.
* Webview CSP: `default-src 'none'`, nonce-based scripts, local styles,
  `img-src data:` for figures.
* Variable metadata never calls `repr` on objects of unknown types; it only
  uses type names and cheap attributes of known types.
