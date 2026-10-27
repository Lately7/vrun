# Codex review rounds and resolutions

Process: Codex reviews or attacks a bounded scope; Claude reproduces every
claim (by test or by reading the code), then fixes, or rebuts with evidence.
Rebuttals are sent back into the same Codex session (`codex exec resume`),
and Codex either agrees and updates its tests or keeps an `xfail` with its
reasoning. Nothing is accepted without a passing test.

## Round 1 — independent code review (read-only)

| # | Finding (Codex) | Verdict | Resolution |
|---|---|---|---|
| 1 | Run Selection expands to whole lines, runs unselected code (`a(); b()`) | agree | exact selection; start inside indentation snaps to col 0 (`selectionRange`) |
| 2 | Several figures can exceed the 8 MiB message limit after base64 | agree | 5 MiB aggregate base64 budget for figures |
| 3 | POSIX kill only kills the worker, not its children | agree | `detached` process group + `kill(-pid)`; Windows keeps `taskkill /T` |
| 4 | Integer filter through `float()` merges values > 2^53 | agree | `Decimal` parsing, integral → exact `int`, non-integral bounds → floor/ceil |
| 5 | Summary / column detail can land on a different frame | agree | results committed only if name+revision still shown |
| 6 | Trace swaps global `sys.stdout` and `sys.modules['__main__']` | **partial** — subprocess isolation rejected as too heavy | stdout routed per thread (`_ThreadRouter`), `__main__` no longer swapped; regression test |
| 7 | Output budget counted characters, protocol limit is bytes | agree | UTF-8 byte budget, 256 K-char chunks; plus lone-surrogate fix found while verifying |
| 8 | `sys.getsizeof` runs user `__sizeof__` | agree | sizes only for exact built-in types |
| 9 | Evicted output blocks leak in the map | agree | map entry deleted on eviction |
| 10 | Output trimming deletes a single huge span entirely | agree | character-wise trimming of the oldest span |
| 11 | Superseded live runs leave "live…/Tracing…" forever | agree | `superseded` / `traceSuperseded` messages |
| 12 | Playback timer survives a failed trace | agree (for `failed`) / disagree (for `started`: stopping playback on every live re-trace is unwanted; `setTrace` stops it) | `stop()` in `failed()` |

## Round 2 — adversarial kernel tests (Codex wrote `python/tests/test_codex_adversarial.py`)

25 tests, 6 failed initially.

| Test | Verdict | Resolution |
|---|---|---|
| replacing `sys.stdout` disables capture | **disagree** — Python/Jupyter semantics keep the user's redirection. Codex agreed after rebuttal. The test exposed two real bugs: `sys.__stdout__` pointed at the redirected fd 1, and end-of-task flush skipped our streams | `sys.__stdout__`/`__stderr__` are the capture streams; worker always flushes its own streams |
| late thread output labelled with the wrong exec | agree | see round 2b rule |
| hostile `__dict__` property executed by inspection | agree | `instance_dict()` uses only the built-in getset descriptor |
| invalid bool filter silently `False` | agree | explicit true/false tokens, otherwise `bad_request` |
| 0-d array value missing | agree | `node["value"]` |
| structured array records lost | agree | `{"$t": "record"}` |

## Round 2b — Codex attacked the fixes (8 new failures)

| Test | Verdict | Resolution |
|---|---|---|
| metaclass `__dict__` property still runs | agree | class namespaces/MRO/module/qualname read via `type`'s own descriptors; `isinstance` → `issubclass(type(x))` (isinstance falls back to a user `__class__`) |
| subclass property hides base slot | agree | keep scanning the MRO for the member descriptor |
| `Int64` filter `"…993.0"` | agree | Decimal-based comparison |
| 0-d object array tuple tagged as record | agree on the tag; **disagree** on inline encoding — elements of object arrays are now heap refs so nested objects stay explorable; asked Codex to resolve refs in its test | object-dtype elements via `HeapEncoder._value` |
| nested structured record flattened | agree | recursive `_record_text` |
| thread-pool reuse mislabels output | agree that a *wrong* label is a bug | rule: background output keeps its exec id only while no newer execution started, otherwise `None` ("never wrong") |
| `_thread.start_new_thread` / subclass overriding `start` give `None` | **disagree** — exact attribution would need patching private stdlib internals that changed across 3.12–3.15; `None` is shown as "Background output" | documented limitation |

While implementing the rule, a new bug surfaced: output printed by a
background thread after its run ended stayed buffered until the next run —
fixed with a 100 ms flush loop (`test_background_output_while_its_run_is_latest_keeps_exec_id`).
The webview previously appended `execId: null` output to the newest run; it now
has a separate "Background output" block.
