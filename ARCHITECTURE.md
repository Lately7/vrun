# PyLive Inspector — Architecture

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

1. `KernelClient.start()` resolves the interpreter (setting `pylive.pythonPath`
   → Python extension's active interpreter → `python` on PATH) and spawns
   `python -u <ext>/python/launcher.py` with `shell: false`, an argument array,
   `cwd` = workspace folder, and env additions `PYTHONUNBUFFERED=1`,
   `PYTHONIOENCODING=utf-8`, `MPLBACKEND=Agg`.
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
| `dataframe.metadata` | main queue   | shape, dtypes, memory (shallow)                 |
| `dataframe.page`     | main queue   | rows `[offset, offset+limit)` with optional full-data sort/filter |
| `dataframe.summary`  | main queue   | null counts / describe (full scan, on demand)   |
| `interrupt`          | reader thread| interrupt the currently running task            |
| `cancel`             | reader thread| drop a queued (not yet started) request         |
| `shutdown`           | reader thread| exit                                            |

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
sets, tuples, user objects with `__dict__`/`__slots__`) with stable ids. Hard
limits: steps (default 1000), objects per snapshot, items per container,
total bytes, wall time. Exceeding a limit stops the trace cleanly and the
partial trace is still shown. The webview infers views from the data:

| Data shape                              | View                          |
|-----------------------------------------|-------------------------------|
| list of numbers                         | bar array with index pointers (`i`, `j`, `lo`, `mid`, …) |
| numeric scalars / set of numbers        | number line                   |
| list of lists                           | matrix / DP table             |
| dict of key → list/set of keys          | graph (adjacency), highlights `visited`/`queue`/`stack` |
| objects with `left`/`right`             | binary tree                   |
| objects with `next`                     | linked list                   |
| list named `heap` / used with `heapq`   | heap as tree                  |
| list of (x, y) pairs, or `xs`/`ys`       | line chart (function graph)   |

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
