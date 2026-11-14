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
import math
import sys
import types
from itertools import chain, islice, repeat
from operator import is_
from typing import Any

from .serialize import MAX_SAFE_INT, encode_scalar, type_module, type_name, type_qualname


def is_class(obj: object) -> bool:
    # issubclass on type(obj) avoids isinstance's __class__ fallback, which
    # can run a user-defined property.
    return issubclass(type(obj), type)


def is_ndarray(t: type) -> bool:
    return type_module(t) == "numpy" and type_qualname(t) == "ndarray"


def in_package(module: str, packages: tuple[str, ...]) -> bool:
    """module is one of packages or inside one: "torchutils" is not "torch"."""
    return any(module == p or module.startswith(p + ".") for p in packages)


_MODULE_DICT = types.ModuleType.__dict__["__dict__"]


def library_class(module: str, name: str) -> Any:
    """Class `name` of an already-imported module, or None.

    Read from the module's own dict: a user object placed in sys.modules
    never gets an attribute lookup it could intercept.
    """
    m = sys.modules.get(module)
    if m is None or not issubclass(type(m), types.ModuleType):
        return None
    k = _MODULE_DICT.__get__(m, types.ModuleType).get(name)
    return k if is_class(k) else None


def is_torch_tensor(t: type) -> bool:
    """Exactly torch.Tensor or torch.nn.Parameter.

    Identity, not names: a learner's own autograd engine (torch_scratch.Tensor)
    has the same qualname, and its properties would run.
    """
    if "torch" not in sys.modules:
        return False
    return t is library_class("torch", "Tensor") or t is library_class("torch.nn.parameter", "Parameter")


def is_tf_tensor(t: type) -> bool:
    if "tensorflow" not in sys.modules:
        return False
    return (t is library_class("tensorflow.python.framework.ops", "EagerTensor")
            or t is library_class("tensorflow.python.ops.resource_variable_ops", "ResourceVariable"))


def reads_as_dict(t: type) -> bool:
    """dict subclasses whose items live in the dict itself.

    scipy's dok_matrix subclasses dict but keeps its entries elsewhere, so
    dict.items() would show a full matrix as empty.
    """
    return issubclass(t, dict) and not in_package(type_module(t), ("scipy.sparse",))

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
# The descriptor itself: getattr(v, "__self__") could reach user code.
_BUILTIN_SELF = types.BuiltinFunctionType.__dict__["__self__"]
_NONE = type(None)
# Sets up to this size are sorted when they hold only plain values, so a cut
# keeps a coherent prefix (row-major (r, c) cells) instead of hash order.
SORT_LIMIT = 10_000
# Smaller nodes are rebuilt on every step: remembering them costs about as
# much as encoding them again.
_CACHE_MIN = 8
# A cut container up to this size gets a fingerprint of what it does not
# show (HeapEncoder.hidden); a larger one makes the step blind.
HIDE_LIMIT = 10_000
_FUNCTION_CLOSURE = types.FunctionType.__dict__["__closure__"]


def _plain(x: object) -> bool:
    """An immutable value that encodes the same way every time.

    Identity checks on the exact type: `type(x) in (...)` would fall back to
    ==, which a user metaclass may define.
    """
    t = type(x)
    return t is int or t is str or t is float or t is bool or t is _NONE or t is complex or t is bytes


def _plain_or_tuple(x: object) -> bool:
    return _plain(x) or (type(x) is tuple and all(map(_plain, x)))  # type: ignore[call-overload]


def _all_plain(items: list[Any]) -> bool:
    """Every item hashes by value at C level: plain values or tuples of them
    (type checks at C speed for the common one-type lists)."""
    if not items:
        return True
    t = type(items[0])
    if all(map(is_, map(type, items), repeat(t))):
        if t is int or t is float or t is str or t is bool or t is _NONE:
            return True
        if t is tuple:  # (r, c) cells, (dist, node) entries
            flat = list(chain.from_iterable(items))
            if not flat:
                return True
            u = type(flat[0])
            return ((u is int or u is float or u is str) and all(map(is_, map(type, flat), repeat(u)))) \
                or all(map(_plain, flat))
    return all(map(_plain_or_tuple, items))


def _fp_item(x: object) -> Any:
    """A field of an object the trace does not expand, for HeapEncoder.hidden."""
    return x if _plain(x) else id(x)


_CELL_CONTENTS = types.CellType.__dict__["cell_contents"]
_EMPTY_CELL = ("empty cell",)  # _fp_item never returns a tuple


def _cell_fp(cell: Any) -> Any:
    try:
        return _fp_item(_CELL_CONTENTS.__get__(cell))
    except ValueError:  # not assigned yet
        return _EMPTY_CELL


def _sort_scalar(t: type) -> bool:
    return t is int or t is float or t is str


def _sorted_plain(items: Any) -> list[Any] | None:
    """items sorted when all are plain numbers/strings or tuples of them.

    Exact types only: comparing user objects would run their __lt__.
    """
    if not all(_sort_scalar(type(x)) for x in items) and not all(
            type(x) is tuple and all(_sort_scalar(type(y)) for y in x) for x in items):
        return None
    try:
        return sorted(items)
    except TypeError:  # 1 < "a"
        return None


def expands(obj: object) -> bool:
    """obj is a heap node (container, user object, array), not a tag."""
    t = type(obj)
    if t in _SEQ_KINDS or reads_as_dict(t):
        return True
    if type_module(t) in USER_MODULES and not is_class(obj):
        return True
    return is_ndarray(t)


def shown_as_tag(obj: object) -> bool:
    """obj encodes as a tag that does not show its state: a class, a
    module, a function, or an object of a type the encoder does not expand
    (setting `C.n` or `linked.k` changes nothing the trace shows)."""
    t = type(obj)
    if _plain(obj) or t is tuple:
        return False
    return not expands(obj)


class HeapMemo:
    """What the encoders of one trace's steps share.

    A trace encodes everything its frames reach on every step, so a BFS's
    visited set of 400 (r, c) tuples or a DP table was encoded again item by
    item each time. ``nodes`` keeps, by heap id, a container's node with a
    snapshot of the identities of the items it shows (the items are kept
    alive, so an id is never reused): while the snapshot matches, the node is
    reused. ``frozen`` holds tuples of plain values the webview already has:
    a tuple cannot change, so it is neither encoded nor counted again.
    """

    def __init__(self) -> None:
        # heap id -> (kind, snapshot, node, children to visit, kept alive, cut,
        # what the node's own items added to HeapEncoder.hidden)
        self.nodes: dict[int, tuple[str, Any, dict[str, Any], list[Any], Any, bool, list[Any]]] = {}
        self.frozen: set[int] = set()
        self.refs: dict[int, dict[str, int]] = {}
        # heap id of a cut container -> (ids of its unshown items, those
        # items, their value hash): see HeapEncoder._hide_cut.
        self.hide: dict[int, tuple[tuple[int, ...], list[Any], int]] = {}
        # id(type) -> (type, (__dict__ descriptor or None, slot descriptors,
        # qualname)). By id: hashing a class would ask its metaclass.
        self.types: dict[int, tuple[type, tuple[Any, list[tuple[str, Any]], str]]] = {}
        self.expand: dict[int, tuple[type, bool]] = {}  # id(type) -> (type, expands())


class HeapEncoder:
    """Encodes values into a shared heap with small stable ids.

    ``ids`` may be shared between encoders (e.g. across trace steps) so the
    same Python object keeps the same id in every snapshot; ``keepalive``
    prevents ``id()`` reuse while the mapping is alive. ``memo`` (with
    ``ids``) lets the steps of a delta-encoded trace reuse unchanged nodes;
    tuples in ``memo.frozen`` are then left out of ``heap`` (the receiver
    has them). ``max_matrix`` caps both sides of a 2-D array separately.

    With a ``hidden`` list (the tracer's endless-loop check), state that
    the encoding does not show is fingerprinted into it: which object an
    ``obj`` or ``fn`` tag is (and its plain fields or closure), a long int
    or string cut to a tag, the unshown items of a cut container. What
    cannot be fingerprinted (a node over the cap, a big array) counts in
    ``blind``. Neither changes the encoding.
    """

    def __init__(
        self,
        max_nodes: int = 200,
        max_items: int = 64,
        max_str: int = 80,
        ids: dict[int, int] | None = None,
        keepalive: list[object] | None = None,
        memo: HeapMemo | None = None,
        max_matrix: int | None = None,
        hidden: list[Any] | None = None,
    ) -> None:
        self.max_nodes = max_nodes
        self.max_items = max_items
        self.max_str = max_str
        self.max_matrix = max_items if max_matrix is None else max_matrix
        self.heap: dict[str, Any] = {}
        self.truncated = False
        # Something was shown in part (a container over max_items, a node
        # over the cap): it may change without the encoding changing.
        self.cut = False
        self._ids = ids if ids is not None else {}
        self._keepalive = keepalive if keepalive is not None else []
        self._memo = memo
        self._pending: list[tuple[int, object]] = []
        # Ids referenced but not encoded (node cap): a delta-encoded trace
        # must drop their older copies, or a stale node would show as current.
        self.missing: set[int] = set()
        self._n_missing = 0
        # Tuples of plain values encoded here: frozen once the receiver has them.
        self.new_frozen: list[int] = []
        self.hidden = hidden
        self.blind = 0

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
        memo = self._memo
        if memo is None:
            return expands(obj)
        t = type(obj)  # expands() depends on the type only: looked up once per trace
        hit = memo.expand.get(id(t))
        if hit is None or hit[0] is not t:
            hit = memo.expand[id(t)] = (t, expands(obj))
        return hit[1]

    def _ref(self, oid: int) -> dict[str, int]:
        memo = self._memo
        if memo is None:
            return {"ref": oid}
        # One dict per id for the whole trace: refs are never modified, and
        # a reused node is only reused if its refs are the same objects.
        r = memo.refs.get(oid)
        if r is None:
            r = memo.refs[oid] = {"ref": oid}
        return r

    def _value(self, v: object) -> Any:
        t = type(v)
        if t is tuple and self._memo is not None:
            known = self._ids.get(id(v))
            if known is not None and known in self._memo.frozen:
                return self._ref(known)
        if t in _SCALAR_TYPES or not self._expandable(v):
            if is_class(v):
                return {"$t": "cls", "v": type_qualname(v)}  # type: ignore[arg-type]
            if t is types.FunctionType:
                if self.hidden is not None:
                    # Every make_adder(k) has the same name: which one, and its cells.
                    cells = _FUNCTION_CLOSURE.__get__(v)
                    self.hidden.append((id(v), tuple(_cell_fp(c) for c in cells) if cells else ()))
                return {"$t": "fn", "v": v.__qualname__}  # type: ignore[attr-defined]
            if t is types.BuiltinFunctionType:
                fn: dict[str, Any] = {"$t": "fn", "v": v.__name__}  # type: ignore[attr-defined]
                # `walk(tree, out.append)`: the callee changes `out` through
                # the method, so the list must stay reachable from it.
                owner = _BUILTIN_SELF.__get__(v)
                if type(owner) not in _SCALAR_TYPES and self._expandable(owner):
                    fn["of"] = self._value(owner)
                return fn
            out = encode_scalar(v, self.max_str)
            if self.hidden is not None and type(out) is dict:
                self._hide_tag(v, t, out)
            return out
        oid = self._object_id(v)
        key = str(oid)
        if key not in self.heap:
            if len(self.heap) >= self.max_nodes:
                self.truncated = True
                self.cut = True
                self.blind += 1
                self.missing.add(oid)
                self._n_missing += 1
                return {"ref": oid, "missing": True}
            self.heap[key] = None  # reserve; filled by _drain
            self._pending.append((oid, v))
        return self._ref(oid)

    # -- what the encoding does not show (the tracer's loop check) ----------
    def _hide_tag(self, v: Any, t: type, tag: dict[str, Any]) -> None:
        """Fingerprint of a value encode_scalar showed as a tag, at C level."""
        hidden = self.hidden
        if hidden is None:
            return
        kind = tag.get("$t")
        try:
            if kind == "obj":
                # An object of another module's class (`from linked import
                # Node`) has no identity in its tag: walking a list of them
                # looked like standing still.
                hidden.append((id(v), self._shallow(v, t)))
            elif kind == "int" and "bits" in tag:
                hidden.append(hash(v if t is int else int.__int__(v)))
            elif kind == "str":
                hidden.append(hash(v if t is str else str.__str__(v)))
            elif kind == "bytes" and tag.get("len", 0) > 32:
                if t is bytes:
                    hidden.append(hash(v))
                elif t is bytearray:
                    hidden.append(hash(bytes(v)))
                else:
                    self.blind += 1
        except (TypeError, ValueError):
            self.blind += 1

    def _shallow(self, v: Any, t: type) -> tuple[Any, ...]:
        """The plain fields of an object shown only as a tag (instance dict
        read through the built-in descriptor, as _user_object does)."""
        desc = self._type_info(t)[0]
        d = _read_dict(desc, v, t)
        if d is None:
            return ()
        parts: list[Any] = [len(d)]
        for k, x in islice(d.items(), 64):
            parts.append(k if type(k) is str else id(k))
            parts.append(_fp_item(x))
        return tuple(parts)

    def _hide_cut(self, oid: int, kind: str, obj: Any) -> None:
        """What a cut container does not show: its value when the unshown
        items are plain, else the step is blind.

        By value, not identity: `a[600] += 1` may put the new int where an
        older one was freed. The value hash is kept with the items it was
        computed from (alive, so their ids are theirs): an unchanged
        container costs one identity snapshot per step.
        """
        if self.hidden is None:
            return
        mi = self.max_items
        rest: Any = None
        split = 0
        if kind == "dict":
            if dict.__len__(obj) <= HIDE_LIMIT:
                keys = list(islice(dict.keys(obj), mi, None))
                split = len(keys)
                rest = keys + list(islice(dict.values(obj), mi, None))
        elif len(obj) <= HIDE_LIMIT:
            if kind == "set":
                rest = list(obj)  # the shown part is a sorted prefix: hash all, in no order
            elif type(obj) is list:
                rest = obj[mi:]
            else:
                rest = list(islice(obj, mi, None))
        if rest is None:
            self.blind += 1
            return
        ids = tuple(map(id, rest))
        memo = self._memo
        hit = memo.hide.get(oid) if memo is not None else None
        if hit is not None and hit[0] == ids:
            self.hidden.append(hit[2])
            return
        plain = _all_plain(rest[:split]) and _all_plain(rest[split:]) if split else _all_plain(rest)
        if not plain:
            self.blind += 1
            return
        fp = hash(frozenset(rest)) if kind == "set" else hash(tuple(rest))
        if memo is not None:
            memo.hide[oid] = (ids, rest, fp)
        self.hidden.append(fp)

    def _drain(self) -> None:
        # Breadth-first so a node cap keeps the nodes nearest to the roots
        # (an index, not pop(0): that was quadratic in the number of nodes).
        pending = self._pending
        i = 0
        while i < len(pending):
            oid, obj = pending[i]
            i += 1
            self.heap[str(oid)] = self._node(oid, obj)
        pending.clear()

    def _node(self, oid: int, obj: object) -> dict[str, Any]:
        memo = self._memo
        if memo is not None:
            hit = memo.nodes.get(oid)
            if hit is not None:
                node = self._reuse(oid, obj, hit)
                if node is not None:
                    return node
        t = type(obj)
        if reads_as_dict(t):
            return self._dict(oid, obj, t)  # type: ignore[arg-type]
        kind = _SEQ_KINDS.get(t)
        if kind is not None:
            return self._seq(oid, obj, t, kind)
        if is_ndarray(t):
            return self._ndarray(obj)
        return self._user_object(oid, obj)

    # -- reusing the node of an unchanged container ------------------------
    def _snapshot(self, kind: str, obj: Any) -> Any:
        """Identities of what a node of this kind shows (C-speed, no user code)."""
        t = type(obj)
        mi = self.max_items
        if kind == "seq":
            return (t, len(obj), tuple(map(id, islice(obj, mi))))
        if kind == "set":  # a sorted prefix depends on every member
            return (t, len(obj), tuple(map(id, obj)))
        if kind == "obj":  # every field, also the __dunder__ ones the node leaves out
            desc, slots, _name = self._type_info(t)
            d = _read_dict(desc, obj, t)
            fields = None if d is None else (tuple(map(id, d.keys())), tuple(map(id, d.values())))
            return (t, fields, tuple(map(id, _slot_values(slots, obj, t))) if slots else ())
        return (t, dict.__len__(obj), tuple(map(id, islice(dict.keys(obj), mi))),
                tuple(map(id, islice(dict.values(obj), mi))))

    def _reuse(self, oid: int, obj: object,
               hit: tuple[str, Any, dict[str, Any], list[Any], Any, bool, list[Any]]) -> Any:
        kind, snap, node, children, _alive, cut, hid = hit
        if type(obj) is not snap[0] or self._snapshot(kind, obj) != snap:
            return None
        # The node holds refs to these: they are visited (and may have
        # changed) like on a full encode, in the same order.
        before = self._n_missing
        for child in children:
            self._value(child)
        if self._n_missing != before:
            return None  # a ref is over the node cap now: encode it as missing
        if self.hidden is not None and hid:
            self.hidden.extend(hid)  # the same items: the same long ints and strings
        if cut:
            self.cut = True
            self._hide_cut(oid, kind, obj)  # the unshown part may have changed
        return node

    def _remember(self, oid: int, kind: str, obj: Any, node: dict[str, Any], shown: list[Any],
                  alive: Any, cut: bool, before: int, hid: list[Any], min_items: int = _CACHE_MIN) -> None:
        """Keep the node for later steps when reusing it is exact."""
        memo = self._memo
        if memo is None or len(shown) < min_items or self._n_missing != before:
            return
        ids, frozen = self._ids, memo.frozen
        # Frozen tuples stay frozen (they are never over the node cap), so a
        # reused node need not visit them: a visited set of 400 cells costs
        # one identity snapshot per step instead of 400 visits.
        children = [x for x in shown if not _plain(x) and not (type(x) is tuple and ids.get(id(x)) in frozen)]
        # Functions and opaque objects are tags whose text may change.
        if all(map(self._expandable, children)):
            memo.nodes[oid] = (kind, self._snapshot(kind, obj), node, children, alive, cut, hid)

    def _mark(self) -> int:
        return len(self.hidden) if self.hidden is not None else 0

    def _since(self, mark: int) -> list[Any]:
        return self.hidden[mark:] if self.hidden is not None else []

    def _values(self, seq: Any) -> list[Any]:
        """[_value(x) for x in seq], with frozen tuples looked up inline."""
        memo = self._memo
        if memo is None:
            return [self._value(x) for x in seq]
        ids, frozen, refs, value = self._ids, memo.frozen, memo.refs, self._value
        out = []
        for x in seq:
            if type(x) is tuple:
                o = ids.get(id(x))
                if o is not None and o in frozen:
                    out.append(refs.get(o) or self._ref(o))
                    continue
            out.append(value(x))
        return out

    # -- containers ---------------------------------------------------------
    def _scalars(self, items: Any) -> list[Any] | None:
        """The items themselves when they all are one plain type that JSON
        carries unchanged: a copy at C speed instead of a _value per item."""
        if not items:
            return []
        t = type(items[0])
        if all(map(is_, map(type, items), repeat(t))):
            if t is int:
                if min(items) < -MAX_SAFE_INT or max(items) > MAX_SAFE_INT:
                    return None  # large ints are tags
            elif t is float:
                if not all(map(math.isfinite, items)):
                    return None  # nan / inf are tags
            elif t is str:
                if max(map(len, items)) > self.max_str:
                    return None  # long strings are cut
            elif t is not bool and t is not _NONE:
                return None
        elif (t is int or t is float) and all(type(x) is int or type(x) is float for x in items):
            try:
                if not all(map(math.isfinite, items)):
                    return None
            except OverflowError:  # an int too large for a float
                return None
            if min(items) < -MAX_SAFE_INT or max(items) > MAX_SAFE_INT:
                return None  # (a large float would be fine: the slow path decides)
        else:
            return None
        # Our own slice or islice copy (a tuple slice may be the tuple itself).
        return items if type(items) is list else list(items)

    def _seq(self, oid: int, obj: Any, t: type, kind: str) -> dict[str, Any]:
        n = len(obj)
        src = obj
        if kind == "set" and n <= SORT_LIMIT:
            src = _sorted_plain(obj) or obj
        shown = obj[: self.max_items] if src is obj and (t is list or t is tuple) \
            else list(islice(src, self.max_items))
        before = self._n_missing
        mark = self._mark()
        items = self._scalars(shown)
        plain = items is not None
        if items is None:
            items = self._values(shown)
        hid = self._since(mark)
        node = {"kind": kind, "items": items, "len": n}
        cut = n > len(shown)
        if cut:
            self.cut = True
            self._hide_cut(oid, "set" if kind == "set" else "seq", obj)
        if t is tuple and not cut and (plain or all(map(_plain, shown))):
            self.new_frozen.append(oid)
        elif kind != "set":
            self._remember(oid, "seq", obj, node, shown, shown, cut, before, hid)
        elif n <= SORT_LIMIT:
            self._remember(oid, "set", obj, node, shown, list(obj) if src is obj else src, cut, before, hid)
        return node

    def _dict(self, oid: int, d: dict[Any, Any], t: type) -> dict[str, Any]:
        # Subclasses too (sklearn's Bunch from load_iris): read with dict's
        # own C methods, so no overridden method ever runs.
        keys = list(islice(dict.keys(d), self.max_items))
        vals = list(islice(dict.values(d), self.max_items))
        before = self._n_missing
        mark = self._mark()
        ks = self._scalars(keys)
        vs = self._scalars(vals)
        # Plain keys or values need no visit, so the visits (and the node
        # cap) keep the order key, value, key, value of a full encode.
        if ks is not None and vs is not None:
            entries = [[k, v] for k, v in zip(ks, vs)]
        elif vs is not None:
            entries = [[k, v] for k, v in zip(self._values(keys), vs)]
        elif ks is not None:
            entries = [[k, v] for k, v in zip(ks, self._values(vals))]
        else:
            entries = [[self._value(k), self._value(v)] for k, v in zip(keys, vals)]
        hid = self._since(mark)
        n = dict.__len__(d)
        node = {"kind": "dict", "entries": entries, "len": n}
        if t not in DICT_TYPES:
            node["type"] = type_qualname(t)
        cut = n > len(keys)
        if cut:
            self.cut = True
            self._hide_cut(oid, "dict", d)
        if self._memo is not None:
            shown = [x for pair in zip(keys, vals) for x in pair]  # in the order encoded
            self._remember(oid, "dict", d, node, shown, (keys, vals), cut, before, hid)
        return node

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

        if arr.ndim > 2 or (arr.ndim == 1 and shape[0] > self.max_items) or (
                arr.ndim == 2 and max(shape) > self.max_matrix):
            self.cut = True
            self.blind += 1
        if arr.ndim == 0:
            node["value"] = enc(arr.item())
        elif arr.ndim == 1:
            node["items"] = [enc(x) for x in arr[: self.max_items].tolist()]
        elif arr.ndim == 2:
            rows = arr[: self.max_matrix, : self.max_matrix].tolist()
            node["rows"] = [[enc(x) for x in r] for r in rows]
        return node

    def _type_info(self, t: type) -> tuple[Any, list[tuple[str, Any]], str]:
        """The __dict__ descriptor, slots and name of a user class, looked up
        once per trace (walking the MRO for every node was most of the cost
        of a linked list or tree)."""
        memo = self._memo
        hit = memo.types.get(id(t)) if memo is not None else None
        if hit is not None and hit[0] is t:
            return hit[1]
        info = (_dict_descriptor(t), _slot_descriptors(t), type_qualname(t))
        if memo is not None:
            memo.types[id(t)] = (t, info)  # the type is kept: its id stays its own
        return info

    def _user_object(self, oid: int, obj: object) -> dict[str, Any]:
        fields: list[list[Any]] = []
        t = type(obj)
        desc, slots, qualname = self._type_info(t)
        d = _read_dict(desc, obj, t)
        before = self._n_missing
        mark = self._mark()
        shown: list[Any] = []
        cut = False
        if d is not None:
            for i, (k, val) in enumerate(d.items()):
                if i >= self.max_items:
                    self.cut = cut = True
                    self.blind += 1
                    break
                # Exact str: a str subclass may override startswith.
                if type(k) is str and not k.startswith("__"):
                    fields.append([k, self._value(val)])
                    shown.append(val)
        for slot, val in zip((s for s, _ in slots), _slot_values(slots, obj, t)):
            if val is not _NO_SLOT:
                fields.append([slot, self._value(val)])
                shown.append(val)
        node = {"kind": "object", "type": qualname, "fields": fields}
        if not cut and self._memo is not None:
            # A list of 1000 nodes was encoded (and compared) again on every
            # step. Kept alive: every field, so a snapshot's ids stay theirs.
            alive = ([*d.values()] if d is not None else []) + _slot_values(slots, obj, t)
            self._remember(oid, "obj", obj, node, shown, alive, False, before, self._since(mark), min_items=0)
        return node


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


def _dict_descriptor(t: type) -> Any:
    """The built-in __dict__ descriptor of instances of t, or None."""
    for klass in class_mro(t):
        desc = class_ns(klass).get("__dict__")
        if desc is None:
            continue
        # Shadowed by user code: treat the object as opaque.
        return desc if type(desc) is _GETSET else None
    return None


def _read_dict(desc: Any, obj: object, t: type) -> dict[str, Any] | None:
    if desc is None:
        return None
    try:
        d = desc.__get__(obj, t)
    except (AttributeError, TypeError):
        return None
    return d if type(d) is dict else None


def instance_dict(obj: object) -> dict[str, Any] | None:
    """The instance __dict__ via the built-in descriptor only.

    object.__getattribute__(obj, "__dict__") would run a class-level
    ``__dict__`` property defined by the user; this never does.
    """
    t = type(obj)
    return _read_dict(_dict_descriptor(t), obj, t)


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


_NO_SLOT = object()  # a slot that was never assigned


def _slot_values(slots: list[tuple[str, Any]], obj: object, t: type) -> list[Any]:
    out = []
    for _name, sd in slots:
        try:
            out.append(sd.__get__(obj, t))
        except AttributeError:
            out.append(_NO_SLOT)
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


def _number_kind(x: object) -> str | None:
    """Kind ("int" / "float") of a number a training loop appends, else None.

    Besides plain numbers: exact NumPy scalars (rmse.append(np.sqrt(mse)))
    and one-element torch tensors (losses.append(loss)). Type checks are
    exact and only the tensor's own C methods run.
    """
    t = type(x)
    if t is float:
        return "float"
    if t is int:
        return "int"
    np = sys.modules.get("numpy")
    if np is not None and type_module(t) == "numpy":
        if issubclass(t, np.floating):
            return "float"
        if issubclass(t, np.integer):
            return "int"
        return None
    if is_torch_tensor(t):
        v: Any = x
        if v.numel() != 1 or v.is_complex():
            return None
        return "float" if v.is_floating_point() else "int"
    return None


def is_number_sequence(v: object, min_len: int = 2) -> bool:
    """An exact list/tuple of numbers, judged on its first 50 items."""
    if type(v) not in (list, tuple):
        return False
    seq: Any = v
    if len(seq) < min_len:
        return False
    kinds = [_number_kind(x) for x in seq[:50]]
    return None not in kinds and "float" in kinds


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
    if reads_as_dict(t):
        d: dict[Any, Any] = obj  # type: ignore[assignment]
        vals = list(dict.values(d))[:20]
        # {"loss": [...], "val_loss": [...]} is a training history, not a
        # graph whose vertices would be the float values.
        if vals and all(is_number_sequence(v) for v in vals):
            return "series"
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


__all__ = ["HeapEncoder", "HeapMemo", "viz_hint", "approx_size", "type_name", "USER_MODULES"]
