"""Numbers over time for the training-curve chart.

Accepts what learners keep while training: ``losses = []`` lists, dicts of
lists (``history = {"loss": [...], "val_loss": [...]}``), Keras ``History``
objects, 1-D NumPy arrays / pandas Series / CPU tensors, and lists of 0-d
tensors (``losses.append(loss)``). Long series are downsampled by keeping
the min and max of each bucket, so spikes survive.

Only exact library types and built-in containers are read; nothing defined
by user code runs.
"""

from __future__ import annotations

import math
import sys
from typing import Any

from .heap import class_mro, in_package, instance_dict, is_torch_tensor
from .serialize import type_module, type_qualname

MAX_SERIES = 12
DEFAULT_POINTS = 800
# Lists are read item by item in Python; arrays are bucketed in NumPy.
MAX_LEN = 5_000_000


class NotASeries(ValueError):
    pass


def _number(x: object) -> float | None:
    t = type(x)
    if t is bool:
        return float(x)  # type: ignore[arg-type]
    if t in (int, float):
        f = float(x)  # type: ignore[arg-type]
        return f if math.isfinite(f) else None
    np = sys.modules.get("numpy")
    if np is not None and type_module(t) == "numpy" and issubclass(t, (np.integer, np.floating, np.bool_)):
        f = float(x)  # type: ignore[arg-type]
        return f if math.isfinite(f) else None
    return None


def _tensor_item(x: object) -> tuple[float | None, bool]:
    """(value, had_grad_graph) of a 0-d torch tensor, else (None, False)."""
    t = type(x)
    if not is_torch_tensor(t):
        return None, False
    v: Any = x
    if v.numel() != 1 or v.is_complex():
        return None, False
    f = float(v.detach().reshape(()).item())
    return (f if math.isfinite(f) else None), v.grad_fn is not None


def _values(value: object) -> tuple[Any, str | None] | None:
    """All values of one series (a list of floats / None, or a 1-D numeric
    array), plus an optional teaching note."""
    t = type(value)
    if t in (list, tuple):
        seq: Any = value
        if len(seq) > MAX_LEN:
            raise NotASeries("too long to chart")
        out: list[float | None] = []
        graphs = 0
        for x in seq:
            n = _number(x)
            if n is None and type(x) not in (int, float):
                n, graph = _tensor_item(x)
                if n is None and not in_package(type_module(type(x)), ("torch",)):
                    return None
                graphs += graph
            out.append(n)
        note = None
        if graphs:
            note = ("This list holds tensors that still carry their autograd graph: append "
                    "loss.item() instead of loss, so each step's graph can be freed.")
        return out, note
    np = sys.modules.get("numpy")
    if np is None:
        return None
    mod = type_module(t)
    name = type_qualname(t)
    arr: Any = None
    if mod == "numpy" and name == "ndarray":
        arr = value
    elif in_package(mod, ("pandas",)) and name == "Series":
        arr = value.to_numpy()  # type: ignore[attr-defined]
    elif is_torch_tensor(t):
        tv: Any = value
        if tv.is_complex():
            return None
        arr = tv.detach().to("cpu").float().numpy() if tv.dim() == 1 else None
    if arr is None or arr.ndim != 1 or arr.dtype.kind not in "biuf":
        return None
    # Stays an array: tolist() of 20M values costs GBs; only the points that
    # are drawn become Python floats (_downsample).
    return (arr if arr.dtype.kind == "f" else arr.astype(np.float64)), None


def _history_dict(value: object) -> dict[Any, Any] | None:
    t = type(value)
    if issubclass(t, dict):
        return value  # type: ignore[return-value]
    # Keras History: its data is the plain dict in .history.
    if any(type_qualname(k) == "History" and in_package(type_module(k), ("keras", "tf_keras", "tensorflow"))
           for k in class_mro(t)):
        d = (instance_dict(value) or {}).get("history")
        return d if type(d) is dict else None
    return None


def _finite(x: float) -> float | None:
    return x if math.isfinite(x) else None


def _downsample(y: Any, max_points: int) -> tuple[list[int], list[float | None]]:
    """At most max_points points: each bucket's min and max (spikes survive)
    plus the first and last point (the legend shows the last value as the
    current loss).

    y is a list of floats / None or a 1-D numeric array (NaN / inf = gap).
    """
    n = len(y)
    if type(y) is not list:
        np = sys.modules["numpy"]
        if n <= max_points:
            return list(range(n)), [_finite(float(v)) for v in y.tolist()]

        def extremes(lo: int, hi: int) -> tuple[int, int] | None:
            # Per bucket, so no full-size temporary is made.
            seg = y[lo:hi]
            ok = np.isfinite(seg)
            if not ok.all():
                if not ok.any():
                    return None
                return lo + int(np.where(ok, seg, np.inf).argmin()), lo + int(np.where(ok, seg, -np.inf).argmax())
            return lo + int(seg.argmin()), lo + int(seg.argmax())

        def value(i: int) -> float | None:
            return _finite(float(y[i]))
    else:
        if n <= max_points:
            return list(range(n)), y

        def extremes(lo: int, hi: int) -> tuple[int, int] | None:
            best_min = best_max = None
            for i in range(lo, hi):
                v = y[i]
                if v is None:
                    continue
                if best_min is None or v < y[best_min]:
                    best_min = i
                if best_max is None or v > y[best_max]:
                    best_max = i
            return None if best_min is None or best_max is None else (best_min, best_max)

        def value(i: int) -> float | None:
            return y[i]  # type: ignore[no-any-return]
    buckets = max(1, (max_points - 2) // 2)  # room for the forced first and last point
    xs: list[int] = []
    ys: list[float | None] = []
    for b in range(buckets):
        # Integer bounds: float ones rounded the last bucket's end to n - 1.
        lo, hi = b * n // buckets, (b + 1) * n // buckets
        got = extremes(lo, hi)
        if got is None:
            xs.append(lo)
            ys.append(None)
            continue
        for i in sorted(set(got)):
            xs.append(i)
            ys.append(value(i))
    if xs[0] != 0:
        xs.insert(0, 0)
        ys.insert(0, value(0))
    if xs[-1] != n - 1:
        xs.append(n - 1)
        ys.append(value(n - 1))
    return xs, ys


def chart(value: object, max_points: int = DEFAULT_POINTS) -> dict[str, Any]:
    max_points = max(20, min(int(max_points), 5000))
    named: list[tuple[str, object]] = []
    hist = _history_dict(value)
    if hist is not None:
        for k, v in list(dict.items(hist))[:50]:
            named.append((k if type(k) is str else str(k) if type(k) in (int, float) else "?", v))
    else:
        named.append(("value", value))
    series = []
    notes: list[str] = []
    downsampled = False
    for label, v in named:
        got = _values(v)
        if got is None:
            continue
        ys, note = got
        if note and note not in notes:
            notes.append(note)
        xs, small = _downsample(ys, max_points)
        if not any(y is not None for y in small):  # every bucket with a number keeps one
            continue
        downsampled = downsampled or len(small) < len(ys)
        series.append({"name": label[:80], "x": xs, "y": small, "len": len(ys)})
        if len(series) >= MAX_SERIES:
            break
    if not series:
        raise NotASeries("no numbers to chart")
    return {"series": series, "downsampled": downsampled, "notes": notes}


def describe_history(info: dict[str, Any], value: object) -> bool:
    """Variables-row data for a Keras History. False if it is not one."""
    d = _history_dict(value)
    if d is None or type(value) is dict or issubclass(type(value), dict):
        return False
    keys = [k for k in d if type(k) is str][:12]
    info["keys"] = keys
    first = d.get(keys[0]) if keys else None
    if type(first) is list:
        info["epochs"] = len(first)
    info["chart"] = True
    return True
