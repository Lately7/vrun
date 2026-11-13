"""Warnings in a practice loop: shown on every run, repeats folded.

Python shows a warning once per code location for the life of the process,
so re-running a cell hid a warning it had shown before (``np.log(0)``),
while libraries that reset the registry (scikit-learn's catch_warnings)
printed the same 10-line ConvergenceWarning once per loop iteration. Each
run now starts with a fresh registry, and a warning repeated within a run is
printed once followed by a one-line count at the end of the run.
"""

from __future__ import annotations

import warnings
from typing import Any

MAX_KEYS = 1000

_original: Any = None
# (category name, message text, filename, lineno) -> [count, category, text]
_counts: dict[tuple[str, str, str, int], list[Any]] = {}


def install() -> None:
    global _original
    if _original is None:
        _original = warnings.showwarning
        warnings.showwarning = _show


def _show(message: Any, category: Any, filename: str, lineno: int, file: Any = None, line: Any = None) -> None:
    try:
        text = str(message)  # what warnings.formatwarning does as well
    except Exception:  # noqa: BLE001
        text = "?"
    name = getattr(category, "__name__", "Warning")
    key = (name if type(name) is str else "Warning", text, str(filename), int(lineno or 0))
    entry = _counts.get(key)
    if entry is not None:
        entry[0] += 1
        return
    if len(_counts) < MAX_KEYS:
        _counts[key] = [1, key[0], text]
    _original(message, category, filename, lineno, file, line)


def start_run(ns: dict[str, Any]) -> None:
    _counts.clear()
    ns.pop("__warningregistry__", None)
    # Bumping the filters version invalidates every module's
    # __warningregistry__ ("once per location" restarts with this run).
    mutated = getattr(warnings, "_filters_mutated", None) or getattr(warnings, "_filters_mutated_lock_held", None)
    if mutated is not None:
        try:
            mutated()
        except Exception:  # noqa: BLE001
            pass


def summary() -> str:
    lines = []
    for count, category, text in _counts.values():
        if count > 1:
            first = (text.strip().splitlines() or [""])[0][:140]
            times = "time" if count == 2 else "times"
            lines.append(f"[{category} above repeated {count - 1} more {times}: {first}]")
    _counts.clear()
    return "\n".join(lines) + "\n" if lines else ""
