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
import types
from typing import Any

from .serialize import encode_scalar, type_module, type_name, type_qualname


def is_class(obj: object) -> bool:
    # issubclass on type(obj) avoids isinstance's __class__ fallback, which
    # can run a user-defined property.
    return issubclass(type(obj), type)


def is_ndarray(t: type) -> bool:
    return type_module(t) == "numpy" and type_qualname(t) == "ndarray"

_SEQ_KINDS: dict[type, str] = {
    list: "list",
    tuple: "tuple",
    set: "set",
    frozenset: "set",
    collections.deque: "deque",
}

# Standard-library dict subclasses that DSA code uses constantly
# (defaultdict(list) graphs, Counter frequencies). Their items are read with
# dict.items at C level, so no user code runs.
DICT_TYPES = (dict, collections.defaultdict, collections.OrderedDict, collections.Counter)

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
        if t in _SEQ_KINDS or t in DICT_TYPES:
            return True
        if type_module(t) in USER_MODULES and not is_class(obj):
            return True
        return is_ndarray(t)

    def _value(self, v: object) -> Any:
        if type(v) in _SCALAR_TYPES or not self._expandable(v):
            t = type(v)
            if is_class(v):
                return {"$t": "cls", "v": type_qualname(v)}  # type: ignore[arg-type]
            if t is types.FunctionType:
                return {"$t": "fn", "v": v.__qualname__}  # type: ignore[attr-defined]
            if t is types.BuiltinFunctionType:
                return {"$t": "fn", "v": v.__name__}  # type: ignore[attr-defined]
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
        if t in DICT_TYPES:
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
        if is_ndarray(t):
            return self._ndarray(obj)
        return self._user_object(obj)

    def _ndarray(self, arr: Any) -> dict[str, Any]:
        shape = list(arr.shape)
        node: dict[str, Any] = {"kind": "ndarray", "shape": shape, "dtype": str(arr.dtype)}
        structured = arr.dtype.fields is not None
        object_dtype = arr.dtype.kind == "O"

        def enc(x: Any) -> Any:
            # Records of structured arrays come out of tolist() as tuples; a
            # tuple stored in an object array is not a record.
            if structured and type(x) is tuple:
                return {"$t": "record", "v": _record_text(x)}
            if object_dtype:
                return self._value(x)  # elements may be containers or user objects
            return encode_scalar(x, self.max_str)

        if arr.ndim == 0:
            node["value"] = enc(arr.item())
        elif arr.ndim == 1:
            node["items"] = [enc(x) for x in arr[: self.max_items].tolist()]
        elif arr.ndim == 2:
            rows = arr[: self.max_items, : self.max_items].tolist()
            node["rows"] = [[enc(x) for x in r] for r in rows]
        return node

    def _user_object(self, obj: object) -> dict[str, Any]:
        fields: list[list[Any]] = []
        d = instance_dict(obj)
        if d is not None:
            for i, (k, val) in enumerate(d.items()):
                if i >= self.max_items:
                    break
                if isinstance(k, str) and not k.startswith("__"):
                    fields.append([k, self._value(val)])
        t = type(obj)
        for slot, desc in _slot_descriptors(t):
            try:
                val = desc.__get__(obj, t)
            except AttributeError:
                continue
            fields.append([slot, self._value(val)])
        return {"kind": "object", "type": type_qualname(t), "fields": fields}


def _record_text(rec: tuple[Any, ...], depth: int = 0) -> str:
    """Display text of a (possibly nested) structured-array record."""
    parts = []
    for v in rec[:16]:
        if type(v) is tuple and depth < 4:
            parts.append(_record_text(v, depth + 1))
        else:
            enc = encode_scalar(v, 40)
            parts.append(str(enc.get("v", enc.get("$t"))) if isinstance(enc, dict) else str(enc))
    return "(" + ", ".join(parts) + ")"


# Built-in descriptors fetched from `type` itself. Going through them never
# consults a user metaclass (whose properties could shadow __dict__/__mro__).
_TYPE_DICT = type.__dict__["__dict__"]
_TYPE_MRO = type.__dict__["__mro__"]
_GETSET = type(_TYPE_DICT)  # getset_descriptor
_MEMBER = type(type.__dict__["__dictoffset__"])  # member_descriptor


def class_ns(klass: type) -> Any:
    return _TYPE_DICT.__get__(klass, type)


def class_mro(t: type) -> tuple[type, ...]:
    return _TYPE_MRO.__get__(t, type)


def instance_dict(obj: object) -> dict[str, Any] | None:
    """The instance __dict__ via the built-in descriptor only.

    object.__getattribute__(obj, "__dict__") would run a class-level
    ``__dict__`` property defined by the user; this never does.
    """
    t = type(obj)
    for klass in class_mro(t):
        desc = class_ns(klass).get("__dict__")
        if desc is None:
            continue
        if type(desc) is not _GETSET:
            return None  # shadowed by user code: treat the object as opaque
        try:
            d = desc.__get__(obj, t)
        except (AttributeError, TypeError):
            return None
        return d if type(d) is dict else None
    return None


def _slot_descriptors(t: type) -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for name in _slot_names(t):
        for klass in class_mro(t):
            desc = class_ns(klass).get(name)
            # A subclass property may shadow the name; the base slot still
            # holds the value, so keep looking for the member descriptor.
            if type(desc) is _MEMBER:
                out.append((name, desc))
                break
    return out


def _slot_names(t: type) -> list[str]:
    names: list[str] = []
    for klass in class_mro(t):
        slots = class_ns(klass).get("__slots__")
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
    if t in DICT_TYPES:
        d: dict[Any, Any] = obj  # type: ignore[assignment]
        vals = list(dict.values(d))[:20]
        if vals and all(type(v) in (list, set, tuple, dict) for v in vals):
            return "graph"
        return "dict"
    if type_module(t) in USER_MODULES and not is_class(obj):
        d2 = instance_dict(obj) or {}
        keys = set(d2) | set(_slot_names(t))
        if {"left", "right"} & keys:
            return "tree"
        if "next" in keys:
            return "linkedlist"
        if "children" in keys:
            return "tree"
        return "object"
    if is_ndarray(t):
        ndim = getattr(obj, "ndim", 0)
        return "array" if ndim == 1 else "matrix" if ndim == 2 else None
    return None


_SIZEOF_SAFE = (str, bytes, bytearray, list, tuple, dict, set, frozenset, int, float, complex,
                collections.deque)


def approx_size(obj: object) -> int | None:
    """Shallow size for exact built-in types only.

    sys.getsizeof() calls __sizeof__, which user classes may override with
    slow or side-effecting code, so other types report no size.
    """
    if type(obj) not in _SIZEOF_SAFE:
        return None
    return sys.getsizeof(obj)


__all__ = ["HeapEncoder", "viz_hint", "approx_size", "type_name", "USER_MODULES"]
