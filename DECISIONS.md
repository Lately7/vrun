# Decisions (ADR log)

## ADR-001 — Custom Python worker instead of ipykernel / Jupyter messaging

**Status:** accepted (Milestone 1)

**Context.** We need a persistent Python process with interrupt, restart,
bounded inspection and a small dependency footprint on Windows. Detected
environment: Python 3.12 has only NumPy; Python 3.15 has NumPy/Pandas/sklearn;
neither has `ipykernel`, `jupyter_client` or `pyzmq`.

| Criterion            | ipykernel + Jupyter protocol                           | Custom NDJSON worker over pipes |
|----------------------|--------------------------------------------------------|---------------------------------|
| Dependencies         | ipykernel, pyzmq, jupyter_client (Python) + a ZMQ client in Node (`zeromq` native module, rebuilt per Electron ABI) | stdlib only |
| Transport            | 5 TCP sockets on localhost + HMAC key                  | the child's own stdin/stdout    |
| Interrupt on Windows | parent-created event handle passed via env (`JPY_INTERRUPT_EVENT`); requires Win32 calls from Node | `_thread.interrupt_main()` from a reader thread; kill escalation |
| Inspection API       | none for DataFrame paging — would be built as code strings executed in the user namespace (pollutes history, `In[]`, user-visible) | first-class typed requests |
| Lifecycle            | well tested                                            | ~small, owned by us, unit tested |
| Code execution       | robust IPython semantics (magics, `display`)           | `exec`/`eval` of AST (no magics) |

**Decision.** Custom worker. The things ipykernel does better (magics, rich
display protocol) are not MVP requirements, while its cost (native ZMQ
module inside the VS Code extension host, localhost TCP sockets, executing
inspection as user code) conflicts with the security and packaging goals.
We do **not** write a REPL parser: code is parsed with `ast`, and the last
expression statement is evaluated like IPython does.

**Consequences.** No `%magic` support. Interrupt cannot stop long native calls;
restart is the documented fallback. Revisit if users need Jupyter kernels.

## ADR-002 — NDJSON on duplicated stdio file descriptors

Protocol uses duplicates of fd 0/1; fd 1 is re-pointed to stderr so native
prints cannot corrupt framing. Extra pipes (fd 3+) were rejected because
CRT fd inheritance on Windows is fragile.

## ADR-003 — Plain TypeScript + SVG webview (no React)

The UI is a handful of panels with tables and SVG drawings. A framework would
add bundle weight and a build pipeline without clear benefit. esbuild bundles
`webview/main.ts` to `media/webview.js`.

## ADR-004 — Full-data sort/filter, cache valid for one execution count

Sorting/filtering a DataFrame preview-only would mislead users. Operations
run on the full frame in the kernel and return a page. Caches keyed by the
execution counter are discarded on every `execute`, because any execution
may mutate the frame in place. Correctness over speed.

## ADR-005 — AST heuristics gate Live Mode; never claim safety

Live re-execution is refused when AST heuristics find expensive or
side-effecting calls (`fit`, `GridSearchCV`, `cross_val_score`, `train`,
`read_*`, `open`, `requests`, `subprocess`, `input`, `while True`, …).
Unknown calls are allowed only because the user opted in and live runs have a
time budget enforced by real interrupt. The UI says "heuristic".

## ADR-006 — DSA tracing in an isolated namespace with `sys.settrace`

Algorithm visualization (Python-Tutor style) runs the code in a fresh
namespace so tracing never mutates the user's persistent variables.
`sys.settrace` was chosen over `sys.monitoring` (3.12+) because the trace
callback gives frames with locals uniformly on 3.12–3.15 and per-line cost is
acceptable under a step budget. Limits are enforced by raising from the trace
function, which stops the traced code deterministically.

## Rejected alternatives

* Automatic dependency-aware re-execution (out of MVP scope; Python's mutable
  and hidden state makes naive caching incorrect).
* Sending whole DataFrames to the webview (memory, latency).
* Pickle-based transport (unsafe, unnecessary).
