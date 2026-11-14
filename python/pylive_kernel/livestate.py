"""What a Live run must not throw away: state that training built.

Live Mode re-runs the safe beginning of a cell on every edit. Re-running
`model = MLP()` after the learner trained `model` replaced the trained
network, its optimizer state and the loss history without a word. Two rules
make Live stop before such a statement:

* inside one cell (first_state_reset): a statement before the first
  training statement that rebinds something the skipped statements use;
* in any cell of any file (TrainedNames): names that training statements of
  earlier *manual* runs used, filled or produced, while they still hold the
  object training built; and, for state trained some other way, objects
  that inspection shows are trained (a fitted estimator, an optimizer or
  scheduler that has stepped, a network with gradients, a Keras model with a
  history).

Nothing here calls user code: types are recognised by module and qualname
through the MRO, and state is read from instance dicts.
"""

from __future__ import annotations

import ast
import sys
import types
import weakref
from dataclasses import dataclass
from typing import Any, Collection

from . import mlinspect, safety
from .heap import class_mro, in_package, instance_dict, is_class, is_tf_tensor, is_torch_tensor
from .serialize import type_module, type_qualname

_PLAIN_DATA = (int, float, complex, bool, str, bytes, type(None), range, list, dict, set, frozenset,
               types.ModuleType, types.FunctionType)
_MUTATING_METHODS = {
    "append", "extend", "insert", "pop", "remove", "clear", "update", "add", "discard",
    "setdefault", "popitem", "sort", "reverse", "appendleft", "extendleft", "popleft",
    "fill", "resize", "put", "put_nowait",
}
_CODE_VALUES = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType)
MAX_TORCH_MODULES = 2000
# "expensive" findings that fit nothing: an animation loop's time.sleep(),
# %timeit. Their loops' lists are not training state.
_NOT_FITTING = ("'time.sleep()'", "'_vrun_timeit()'")


def trains(findings: list[dict[str, Any]]) -> bool:
    """Whether a statement's safety findings say it trains or fits models."""
    for f in findings:
        if f["category"] == "training":
            return True
        if f["category"] == "expensive" and not str(f["message"]).startswith(_NOT_FITTING):
            return True
    return False


def target_names(target: ast.expr) -> set[str]:
    if isinstance(target, ast.Name):
        return {target.id}
    if isinstance(target, (ast.Tuple, ast.List)):
        names: set[str] = set()
        for item in target.elts:
            names.update(target_names(item))
        return names
    return set()


def is_plain_data(value: object) -> bool:
    """Values that re-running their assignment recreates as they were
    (data, arrays, frames). Models, optimizers and tensors are state that
    training built."""
    t = type(value)
    if t in _PLAIN_DATA or is_class(value):
        return True
    if t is tuple:
        return len(value) <= 100 and all(is_plain_data(v) for v in value)  # type: ignore[arg-type]
    module = type_module(t)
    # pandas 3 sets DataFrame.__module__ = "pandas" (2.x: "pandas.core.frame"):
    # a "pandas." prefix alone made every frame count as trained state, so Live
    # rewound to `df = pd.read_csv(...)` whenever a skipped line read df.
    return module in ("numpy", "collections") or in_package(module, ("pandas", "scipy.sparse"))


def base_name(node: ast.expr) -> str | None:
    while isinstance(node, (ast.Attribute, ast.Subscript)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def mutated_names(statements: list[ast.stmt]) -> set[str]:
    """Names whose value the statements change in place: `losses.append(x)`,
    `history["loss"] += [x]`, `count += 1`, `w[0] = 1`."""
    names: set[str] = set()
    for s in statements:
        for node in ast.walk(s):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and node.func.attr in _MUTATING_METHODS:
                base = base_name(node.func.value)
            elif isinstance(node, ast.AugAssign):
                base = base_name(node.target)
            elif isinstance(node, (ast.Assign, ast.Delete)):
                for t in node.targets:
                    if isinstance(t, (ast.Attribute, ast.Subscript)):
                        b = base_name(t)
                        if b is not None:
                            names.add(b)
                continue
            else:
                continue
            if base is not None:
                names.add(base)
    return names


def rebound_names(statement: ast.stmt) -> set[str]:
    """Names a statement assigns, outside function and class bodies."""
    names: set[str] = set()
    stack: list[ast.AST] = [statement]
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(node, ast.Assign):
            for target in node.targets:
                names |= target_names(target)
        elif isinstance(node, (ast.AnnAssign, ast.For, ast.AsyncFor, ast.NamedExpr)):
            names |= target_names(node.target)
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            names |= target_names(node.optional_vars)
        stack.extend(ast.iter_child_nodes(node))
    return names


def replaced_names(statement: ast.stmt) -> set[str]:
    """Names whose current object the statement would let go: assignments as
    in rebound_names, plus `del x`, `def x` / `class x` and `import ... as x`."""
    names = rebound_names(statement)
    if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        names.add(statement.name)
    elif isinstance(statement, (ast.Import, ast.ImportFrom)):
        for alias in statement.names:
            if alias.name != "*":
                names.add(alias.asname or alias.name.split(".")[0])
    stack: list[ast.AST] = [statement]
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(node, ast.Delete):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        stack.extend(ast.iter_child_nodes(node))
    return names


def _self_derived(statement: ast.stmt) -> set[str]:
    """`model = model.to(device)`, `net = net.eval()`: the new value comes from
    the object itself (torch returns the same module), so nothing is lost."""
    if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 \
            or not isinstance(statement.targets[0], ast.Name) or not isinstance(statement.value, ast.Call):
        return set()
    func = statement.value.func
    if isinstance(func, ast.Attribute) and base_name(func.value) == statement.targets[0].id:
        return {statement.targets[0].id}
    return set()


def first_state_reset(body: list[ast.stmt], stop: int, ns: dict[str, Any]) -> tuple[int, str] | None:
    """First statement before `stop` that would replace an object the
    skipped statements use: `model = LogisticRegression()` before
    `model.fit(...)`. Running it live threw the trained model away."""
    if stop > len(body):
        return None
    skipped = body[stop:]
    used = {n.id for s in skipped for n in ast.walk(s)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    mutated = mutated_names(skipped)
    used |= mutated  # `count += 1` reads count too
    for i in range(stop):
        for name in sorted(rebound_names(body[i]) & used):
            # Data is recreated as it was, unless the skipped loop fills it
            # (`losses = []` before `losses.append(loss)`).
            if name in ns and (name in mutated or not is_plain_data(ns[name])):
                return i, name
    return None


def is_cheap_preprocessor(t: type) -> bool:
    """A scikit-learn scaler / encoder: refitting it is a cheap transform."""
    return type_module(t).startswith("sklearn.") and type_qualname(t) in safety.CHEAP_PREPROCESSORS


# -- trained objects ----------------------------------------------------------
def _mro_has(t: type, packages: tuple[str, ...], names: tuple[str, ...]) -> bool:
    return any(type_qualname(k) in names and in_package(type_module(k), packages) for k in class_mro(t))


def model_kind(value: object) -> str | None:
    """"model", "estimator", "optimizer", "scheduler" or "history": objects
    whose state training builds. Data (frames, arrays, tensors, loaders) is
    None: re-running its assignment recreates it."""
    if is_class(value):
        return None
    kind = mlinspect.ml_kind(value)
    if kind in ("model", "estimator", "optimizer", "history"):
        return kind
    t = type(value)
    if "torch" in sys.modules and _mro_has(t, ("torch.optim",), ("LRScheduler", "_LRScheduler", "ReduceLROnPlateau")):
        return "scheduler"
    if in_package(type_module(t), ("xgboost", "lightgbm", "catboost")):
        return "model"  # Booster: xgb.train(...) returns it trained
    return None


def looks_trained(value: object, kind: str) -> bool:
    """Whether inspection shows training state; False when it cannot tell."""
    d = instance_dict(value) or {}
    if kind == "estimator":
        if is_cheap_preprocessor(type(value)):
            return False
        info: dict[str, Any] = {}
        try:
            mlinspect.describe_estimator(info, value)
        except Exception:  # noqa: BLE001 - a best-effort fallback must not fail a run
            return False
        return bool(info.get("fitted"))
    if kind == "optimizer":
        state = d.get("state")  # Adam / SGD with momentum keep per-tensor state once step() ran
        return issubclass(type(state), dict) and dict.__len__(state) > 0
    if kind == "scheduler":
        epoch = d.get("last_epoch")  # 0 after construction, counts step() calls
        return type(epoch) is int and epoch > 0
    if kind == "history":
        return True  # only Model.fit makes a History
    if kind == "model":
        if in_package(type_module(type(value)), ("xgboost", "lightgbm", "catboost")):
            return True
        if _is_torch_module(value):
            return _torch_walk(value, grads=True)
        # Keras: Model.fit sets model.history (the History callback).
        return model_kind(d.get("history")) == "history"
    return False


def _is_torch_module(value: object) -> bool:
    return "torch" in sys.modules and _mro_has(type(value), ("torch.nn",), ("Module",))


def _torch_walk(root: object, grads: bool) -> bool:
    """Whether a parameter exists (grads=False) or holds a gradient, i.e.
    backward() has run (grads=True). Walked through the modules' own dicts,
    as mlinspect does, so no user property runs."""
    seen: set[int] = set()
    stack = [root]
    while stack and len(seen) < MAX_TORCH_MODULES:
        m = stack.pop()
        if id(m) in seen:
            continue
        seen.add(id(m))
        d = instance_dict(m) or {}
        params = d.get("_parameters")
        if type(params) is dict:
            for p in params.values():
                if p is None:
                    continue
                if not grads:
                    return True
                if is_torch_tensor(type(p)) and p.grad is not None:
                    return True
        subs = d.get("_modules")
        if type(subs) is dict:
            stack.extend(s for s in subs.values() if s is not None)
    return False


_WHAT = {
    "model": "the trained model",
    "estimator": "the fitted model",
    "optimizer": "the optimizer",
    "scheduler": "the learning-rate scheduler",
    "history": "the training history",
}


@dataclass
class _Record:
    ident: int
    ref: Any  # weakref.ref, or None for objects without weak references (lists, dicts)
    how: str  # a kind from model_kind, "filled" or "changed"
    file: str
    line: int

    def holds(self, value: object) -> bool:
        if self.ref is not None:
            return self.ref() is value
        return id(value) == self.ident


def _short(file: str) -> str:
    return file.replace("\\", "/").rsplit("/", 1)[-1]


def _size(value: list[Any] | dict[Any, Any]) -> int:
    """Length, and for a dict also the lengths of its list and dict values:
    a helper filling hist['loss'] leaves len(hist) as it was."""
    if type(value) is list:
        return list.__len__(value)
    n = dict.__len__(value)  # type: ignore[arg-type]
    for count, v in enumerate(dict.values(value)):  # type: ignore[arg-type]
        if count >= 50:
            break
        if type(v) is list:
            n += list.__len__(v)
        elif type(v) is dict:
            n += dict.__len__(v)
    return n


def _recomputed_tensor(value: object) -> bool:
    """A torch tensor or a TensorFlow EagerTensor: `loss.backward()` puts
    gradients on the weights, not on `loss`, which the next forward pass
    recomputes. A tf.Variable (w.assign_sub(...)) is trained state."""
    t = type(value)
    return is_torch_tensor(t) or (is_tf_tensor(t) and type_qualname(t) == "EagerTensor")


class TrainedNames:
    """Names whose current object a manual run's training built or filled.

    Only an id or a weak reference is kept: remembering must not keep a
    replaced model (and its GPU memory) alive. A record counts while the name
    still holds that object, so Run Cell rebuilding the model ends it.
    """

    def __init__(self) -> None:
        self._records: dict[str, _Record] = {}

    @staticmethod
    def sizes(statement: ast.stmt, ns: dict[str, Any]) -> dict[str, tuple[int, int]]:
        """Before a training statement runs: (id, size) of the lists and dicts
        it reads. A helper called with them (`train_epoch(model, opt,
        losses)`, `hist['loss']`) fills them where the statement does not
        show it; growth tells. Exact types only, so nothing user-defined runs."""
        out: dict[str, tuple[int, int]] = {}
        try:
            for node in ast.walk(statement):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in out:
                    value = ns.get(node.id)
                    if type(value) in (list, dict):
                        out[node.id] = (id(value), _size(value))
                        if len(out) >= 200:
                            break
        except Exception:  # noqa: BLE001 - a thread resizing a dict meanwhile: bookkeeping must not fail the run
            pass
        return out

    def record(self, statement: ast.stmt, line: int, file: str, ns: dict[str, Any],
               risky: Collection[str] = (), sizes: dict[str, tuple[int, int]] | None = None) -> None:
        """After a manual run executed `statement`, a training statement;
        `sizes` are from sizes() before it ran."""
        grew = {name for name, (ident, size) in (sizes or {}).items()
                if name in ns and id(ns[name]) == ident and type(ns[name]) in (list, dict)
                and _size(ns[name]) > size}
        receivers: set[str] = set()
        loads: set[str] = set()
        for node in ast.walk(statement):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                loads.add(node.id)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                    and isinstance(node.func.value, ast.Name):
                base, attr = node.func.value.id, node.func.attr
                if attr in safety.TRAINING_METHODS or f"{base}.{attr}" in risky:
                    receivers.add(base)
        mutated = mutated_names([statement])
        bound = rebound_names(statement)
        for name in sorted(receivers | loads | mutated | bound):
            if name not in ns:
                continue
            value = ns[name]
            if is_class(value) or type(value) in _CODE_VALUES:
                continue
            how = model_kind(value)
            if how is not None:
                if how == "estimator" and is_cheap_preprocessor(type(value)):
                    continue
                if how == "model" and _is_torch_module(value) and not _torch_walk(value, grads=False):
                    continue  # nn.BCEWithLogitsLoss(), nn.ReLU(): nothing trained to lose
            elif name in bound:
                continue  # loop variables and per-batch values: `loss`, `logits`, `running = 0.0`
            elif name in mutated or name in grew:
                how = "filled"  # history["loss"].append(...), batch_losses.append(loss)
            elif name in receivers and not is_plain_data(value) and not _recomputed_tensor(value):
                how = "changed"  # w.assign_sub(...), a from-scratch Perceptron's p.fit(...)
            else:
                continue  # data the loop only reads: X_train, loaders, frames
            try:
                ref = weakref.ref(value)
            except TypeError:
                ref = None
            self._records[name] = _Record(id(value), ref, how, file, line)

    def prune(self, ns: dict[str, Any]) -> None:
        for name, rec in list(self._records.items()):
            if name not in ns or not rec.holds(ns[name]):
                del self._records[name]

    def first_replacement(self, body: list[ast.stmt], limit: int | None, ns: dict[str, Any],
                          file: str) -> tuple[int, str] | None:
        """(index, message) of the first statement before `limit` that would
        replace trained state, for a Live run of `body`."""
        end = len(body) if limit is None else min(limit, len(body))
        for i in range(end):
            for name in sorted(replaced_names(body[i]) - _self_derived(body[i])):
                if name in ns:
                    message = self._protects(name, ns[name], file)
                    if message is not None:
                        return i, message
        return None

    def _protects(self, name: str, value: object, file: str) -> str | None:
        kind = model_kind(value)
        rec = self._records.get(name)
        if rec is not None and not rec.holds(value):
            rec = None
        if kind == "estimator":
            # Fitted state is visible on an estimator: an unfitted one (a
            # cross_val_score argument) can be rebuilt freely.
            if not looks_trained(value, kind):
                return None
        elif rec is None and (kind is None or not looks_trained(value, kind)):
            return None
        if rec is None:
            return f"would replace {_WHAT[kind or 'model']} '{name}'"
        where = f"line {rec.line}" if rec.file == file else f"line {rec.line} of {_short(rec.file)}"
        if rec.how == "filled":
            return f"would reset '{name}', which training at {where} filled"
        if rec.how == "changed":
            return f"would replace '{name}', which training at {where} changed"
        if rec.how in ("optimizer", "scheduler"):
            return f"would reset {_WHAT[rec.how]} '{name}' and the state that training at {where} built"
        if rec.how == "history":
            return f"would replace {_WHAT[rec.how]} '{name}' (from {where})"
        verb = "fitted" if rec.how == "estimator" else "trained"
        return f"would replace {_WHAT[rec.how]} '{name}' ({verb} at {where})"
