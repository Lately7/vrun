"""Cheap variable metadata for the Variables panel.

Nothing here performs full scans of large data or calls ``repr`` on unknown
objects. DataFrame memory is reported shallow (``deep=False``); object
columns are therefore a lower bound, which the UI marks with ">=".
"""

from __future__ import annotations

import sys
import types
from typing import Any

from .heap import HeapEncoder, approx_size, instance_dict, viz_hint
from .serialize import encode_scalar, encode_str, type_name

MAX_VARIABLES = 500
PREVIEW_ITEMS = 8


def _is_hidden(name: str, value: object) -> bool:
    if name.startswith("_"):
        return True
    if isinstance(value, types.ModuleType):
        return True
    return False


def _kind(value: object) -> str:
    t = type(value)
    mod = t.__module__
    if isinstance(value, bool):
        return "bool"
    if t in (int, float, complex):
        return "number"
    if t is str:
        return "str"
    if t in (list, tuple, set, frozenset, dict) or t.__name__ == "deque":
        return t.__name__
    if mod.startswith("pandas"):
        if t.__name__ == "DataFrame":
            return "dataframe"
        if t.__name__ == "Series":
            return "series"
        return "pandas"
    if mod == "numpy" and t.__name__ == "ndarray":
        return "ndarray"
    if mod.startswith("numpy"):
        np = sys.modules.get("numpy")
        if np is not None and isinstance(value, np.generic):
            return "bool" if isinstance(value, np.bool_) else "number"
    if _is_sklearn_estimator(value):
        return "estimator"
    if isinstance(value, type):
        return "class"
    if isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
        return "function"
    return "object"


def _is_sklearn_estimator(value: object) -> bool:
    t = type(value)
    if not t.__module__.startswith("sklearn") or isinstance(value, type):
        return False
    return any(k.__name__ == "BaseEstimator" for k in t.__mro__)


def _preview_items(items: list[Any]) -> list[Any]:
    out = []
    for x in items[:PREVIEW_ITEMS]:
        if type(x) in (list, tuple, dict, set):
            out.append({"$t": "obj", "type": type(x).__name__, "len": len(x)})
        else:
            out.append(encode_scalar(x, 40))
    return out


def describe(name: str, value: object) -> dict[str, Any]:
    kind = _kind(value)
    info: dict[str, Any] = {"name": name, "type": type_name(value), "kind": kind}
    try:
        _fill(info, kind, value)
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001 - inspection must never break listing
        info["error"] = f"{type(exc).__name__}"
    return info


def _fill(info: dict[str, Any], kind: str, value: Any) -> None:
    if kind in ("bool", "number"):
        info["value"] = encode_scalar(value)
        info["viz"] = "numberline" if kind == "number" else None
        return
    if kind == "str":
        info["len"] = len(value)
        info["value"] = encode_str(value, 120)
        info["size"] = approx_size(value)
        return
    if kind in ("list", "tuple", "set", "frozenset", "deque"):
        info["len"] = len(value)
        head = list(value[:PREVIEW_ITEMS]) if kind in ("list", "tuple") else \
            [x for _, x in zip(range(PREVIEW_ITEMS), value)]
        info["preview"] = _preview_items(head)
        info["size"] = approx_size(value)
        info["viz"] = viz_hint(value)
        return
    if kind == "dict":
        info["len"] = len(value)
        keys = [k for _, k in zip(range(PREVIEW_ITEMS), dict.keys(value))]
        info["preview"] = _preview_items(keys)
        info["size"] = approx_size(value)
        info["viz"] = viz_hint(value)
        return
    if kind == "dataframe":
        rows, cols = value.shape
        info["shape"] = [int(rows), int(cols)]
        dtypes = value.dtypes
        counts: dict[str, int] = {}
        for dt in dtypes.tolist()[:2000]:
            key = str(dt)
            counts[key] = counts.get(key, 0) + 1
        info["dtypes"] = counts
        mem = value.memory_usage(index=True, deep=False)
        info["size"] = int(mem.sum())
        info["sizeIsLowerBound"] = any(_is_texty(d) for d in counts)
        info["viz"] = "dataframe"
        return
    if kind == "series":
        info["shape"] = [int(value.shape[0])]
        info["dtype"] = str(value.dtype)
        info["size"] = int(value.memory_usage(index=True, deep=False))
        info["sizeIsLowerBound"] = _is_texty(str(value.dtype))
        if value.name is not None:
            info["seriesName"] = encode_scalar(value.name, 60)
        info["viz"] = "dataframe"
        return
    if kind == "ndarray":
        info["shape"] = [int(s) for s in value.shape]
        info["dtype"] = str(value.dtype)
        info["size"] = int(value.nbytes)
        if value.size <= PREVIEW_ITEMS and value.ndim == 1:
            info["preview"] = [encode_scalar(x, 40) for x in value.tolist()]
        info["viz"] = viz_hint(value)
        return
    if kind == "estimator":
        state = instance_dict(value) or {}
        fitted = [k for k in state if k.endswith("_") and not k.startswith("_")]
        info["fitted"] = bool(fitted)
        info["fittedAttrs"] = fitted[:12]
        return
    if kind == "function":
        info["value"] = {"$t": "fn", "v": getattr(value, "__qualname__", "?")}
        return
    if kind == "class":
        info["value"] = {"$t": "cls", "v": value.__qualname__}
        return
    if kind == "object":
        info["viz"] = viz_hint(value)
        info["size"] = approx_size(value)


def _is_texty(dtype_name: str) -> bool:
    # pandas 3 reports the default string dtype as "str"; older as "object".
    return dtype_name in ("object", "str") or dtype_name.startswith("string")


def list_variables(ns: dict[str, Any]) -> dict[str, Any]:
    items = []
    hidden = 0
    for name, value in list(ns.items()):
        if _is_hidden(name, value):
            continue
        if len(items) >= MAX_VARIABLES:
            hidden += 1
            continue
        items.append(describe(name, value))
    items.sort(key=lambda v: (v["kind"] in ("function", "class"), v["name"].lower()))
    return {"variables": items, "omitted": hidden}


def inspect_variable(ns: dict[str, Any], name: str, max_nodes: int, max_items: int) -> dict[str, Any]:
    if name not in ns:
        raise KeyError(name)
    value = ns[name]
    info = describe(name, value)
    if info["kind"] in ("dataframe", "series", "estimator", "function", "class", "pandas"):
        return info
    enc = HeapEncoder(max_nodes=max_nodes, max_items=max_items)
    info["root"] = enc.encode(value)
    info["heap"] = enc.heap
    info["truncated"] = enc.truncated
    return info


def python_info() -> dict[str, Any]:
    return {"version": sys.version.split()[0], "executable": sys.executable}
