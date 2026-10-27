"""Encode an object graph (lists, dicts, user nodes) for the DSA visualizer.

Output shape::

    {"kind": "list", "items": [<value>, ...], "len": 10}
    {"kind": "dict", "entries": [[<key>, <value>], ...], "len": 3}
    {"kind": "object", "type": "Node", "fields": [["val", 1], ["next", {"ref": 2}]]}

where ``<value>`` is either an encoded scalar or ``{"ref": <id>}``. Only
exact built-in container types and instances of *user-defined* classes are
expanded; fields are read from the instance ``__dict__`` / slots directly so
no property, ``__getattr__`` or ``__repr__`` code runs.
"""

from __future__ import annotations

import collections
import sys
from typing import Any

from .serialize import encode_scalar, type_name

_SEQ_KINDS: dict[type, str] = {
    list: "list",
    tuple: "tuple",
    set: "set",
    frozenset: "set",
    collections.deque: "deque",
}

USER_MODULES = {"__main__", "__pylive_trace__"}

_SCALAR_TYPES = (int, float, bool, str, complex, bytes, type(None))


class HeapEncoder:
    """Encodes values into a shared heap with small stable ids.

    ``ids`` may be shared between encoders (e.g. across trace steps) so the
    same Python object keeps the same id in every snapshot; ``keepalive``
    prevents ``id()`` reuse while the mapping is alive.
    """

    def __init__(
        self,
        max_nodes: int = 200,
        max_items: int = 64,
        max_str: int = 80,
        ids: dict[int, int] | None = None,
        keepalive: list[object] | None = None,
    ) -> None:
        self.max_nodes = max_nodes
        self.max_items = max_items
        self.max_str = max_str
        self.heap: dict[str, Any] = {}
        self.truncated = False
        self._ids = ids if ids is not None else {}
        self._keepalive = keepalive if keepalive is not None else []
        self._pending: list[tuple[int, object]] = []

    # -- public -----------------------------------------------------------
    def encode(self, value: object) -> Any:
        ref = self._value(value)
        self._drain()
        return ref

    # -- internals --------------------------------------------------------
    def _object_id(self, obj: object) -> int:
        key = id(obj)
        oid = self._ids.get(key)
        if oid is None:
            oid = len(self._ids) + 1
            self._ids[key] = oid
            self._keepalive.append(obj)
        return oid

    def _expandable(self, obj: object) -> bool:
        t = type(obj)
        if t in _SEQ_KINDS or t is dict:
            return True
        if t.__module__ in USER_MODULES and not isinstance(obj, type):
            return True
        mod = t.__module__
        if mod == "numpy" and t.__name__ == "ndarray":
            return True
        return False

    def _value(self, v: object) -> Any:
        if type(v) in _SCALAR_TYPES or not self._expandable(v):
            if callable(v) and not isinstance(v, type) and type(v).__module__ == "builtins":
                return {"$t": "fn", "v": getattr(v, "__name__", "?")}
            if isinstance(v, type):
                return {"$t": "cls", "v": v.__qualname__}
            if type(v).__name__ == "function":
                return {"$t": "fn", "v": v.__qualname__}  # type: ignore[attr-defined]
            return encode_scalar(v, self.max_str)
        oid = self._object_id(v)
        key = str(oid)
        if key not in self.heap:
            if len(self.heap) >= self.max_nodes:
                self.truncated = True
                return {"ref": oid, "missing": True}
            self.heap[key] = None  # reserve; filled by _drain
            self._pending.append((oid, v))
        return {"ref": oid}

    def _drain(self) -> None:
        # Breadth-first so a node cap keeps the nodes nearest to the roots.
        while self._pending:
            oid, obj = self._pending.pop(0)
            self.heap[str(oid)] = self._node(obj)

    def _node(self, obj: object) -> dict[str, Any]:
        t = type(obj)
        if t is dict:
            d: dict[Any, Any] = obj  # type: ignore[assignment]
            entries = []
            for i, (k, val) in enumerate(dict.items(d)):
                if i >= self.max_items:
                    break
                entries.append([self._value(k), self._value(val)])
            return {"kind": "dict", "entries": entries, "len": len(d)}
        kind = _SEQ_KINDS.get(t)
        if kind is not None:
            seq = obj
            if kind == "set":
                # Sort only plain numbers/strings: comparing user objects
                # would run their __lt__.
                items_src: Any = seq
                if len(seq) <= 10_000 and all(type(x) in (int, float, str) for x in seq):  # type: ignore[arg-type]
                    try:
                        items_src = sorted(seq)  # type: ignore[type-var, call-overload]
                    except TypeError:
                        pass
            else:
                items_src = seq
            items = []
            for i, item in enumerate(items_src):  # type: ignore[arg-type]
                if i >= self.max_items:
                    break
                items.append(self._value(item))
            return {"kind": kind, "items": items, "len": len(seq)}  # type: ignore[arg-type]
        if t.__module__ == "numpy" and t.__name__ == "ndarray":
            return self._ndarray(obj)
        return self._user_object(obj)

    def _ndarray(self, arr: Any) -> dict[str, Any]:
        shape = list(arr.shape)
        node: dict[str, Any] = {"kind": "ndarray", "shape": shape, "dtype": str(arr.dtype)}
        if arr.ndim == 1:
            node["items"] = [encode_scalar(x) for x in arr[: self.max_items].tolist()]
        elif arr.ndim == 2:
            rows = arr[: self.max_items, : self.max_items].tolist()
            node["rows"] = [[encode_scalar(x) for x in r] for r in rows]
        return node

    def _user_object(self, obj: object) -> dict[str, Any]:
        fields: list[list[Any]] = []
        try:
            d = object.__getattribute__(obj, "__dict__")
        except AttributeError:
            d = None
        if type(d) is dict:
            for i, (k, val) in enumerate(d.items()):
                if i >= self.max_items:
                    break
                if isinstance(k, str) and not k.startswith("__"):
                    fields.append([k, self._value(val)])
        for slot in _slot_names(type(obj)):
            try:
                val = object.__getattribute__(obj, slot)
            except AttributeError:
                continue
            fields.append([slot, self._value(val)])
        return {"kind": "object", "type": type(obj).__qualname__, "fields": fields}


def _slot_names(t: type) -> list[str]:
    names: list[str] = []
    for klass in t.__mro__:
        slots = klass.__dict__.get("__slots__")
        if slots is None:
            continue
        if isinstance(slots, str):
            slots = (slots,)
        for s in slots:
            if s not in ("__dict__", "__weakref__") and s not in names:
                names.append(s)
    return names


def viz_hint(obj: object) -> str | None:
    """Cheap guess of which visualizer view suits a value (no deep scans)."""
    t = type(obj)
    if t in (int, float) and not isinstance(obj, bool):
        return "numberline"
    if t in (list, tuple, collections.deque):
        seq: Any = obj
        if not seq:
            return "array"
        head = list(seq[:20]) if t is not collections.deque else list(seq)[:20]
        if all(type(x) in (list, tuple) for x in head):
            if all(len(x) == 2 and all(type(y) in (int, float) for y in x) for x in head):
                return "chart"
            return "matrix"
        if all(type(x) in (int, float) for x in head):
            return "array"
        return "array"
    if t in (set, frozenset):
        return "numberline" if all(type(x) in (int, float) for x in list(obj)[:20]) else "array"  # type: ignore[call-overload]
    if t is dict:
        d: dict[Any, Any] = obj  # type: ignore[assignment]
        vals = list(dict.values(d))[:20]
        if vals and all(type(v) in (list, set, tuple, dict) for v in vals):
            return "graph"
        return "dict"
    if t.__module__ in USER_MODULES:
        try:
            d2 = object.__getattribute__(obj, "__dict__")
        except AttributeError:
            d2 = {}
        keys = set(d2) | set(_slot_names(t))
        if {"left", "right"} & keys:
            return "tree"
        if "next" in keys:
            return "linkedlist"
        if "children" in keys:
            return "tree"
        return "object"
    if t.__module__ == "numpy" and t.__name__ == "ndarray":
        ndim = getattr(obj, "ndim", 0)
        return "array" if ndim == 1 else "matrix" if ndim == 2 else None
    return None


def approx_size(obj: object) -> int | None:
    try:
        return sys.getsizeof(obj)
    except Exception:  # noqa: BLE001
        return None


__all__ = ["HeapEncoder", "viz_hint", "approx_size", "type_name", "USER_MODULES"]
