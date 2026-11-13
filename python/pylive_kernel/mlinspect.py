"""Variables-panel metadata for ML objects: tensors, models, estimators.

Without this a PyTorch tensor showed as ``<Tensor>`` and a network as
``<Net>``: the two things a learner checks most (shape/dtype/device, and
how many parameters) were invisible. The same rule as the rest of the
inspector applies: no ``repr``/``str``, no properties or methods that user
code can override. Tensors are only described when their type is exactly the
library's; models are walked through their instance dicts.
"""

from __future__ import annotations

import inspect
import math
import sys
import types
from typing import Any

from .heap import class_mro, class_ns, in_package, instance_dict, is_class, is_tf_tensor, is_torch_tensor
from .serialize import encode_scalar, type_module, type_qualname

_SCALARS = (int, float, str, bool, type(None))
MAX_MODULES = 5000


_KERAS = ("keras", "tf_keras", "tensorflow")


def _mro_has(t: type, packages: tuple[str, ...], names: tuple[str, ...]) -> bool:
    return any(type_qualname(k) in names and in_package(type_module(k), packages) for k in class_mro(t))


# -- kinds ------------------------------------------------------------------
def ml_kind(value: object) -> str | None:
    if is_class(value):
        return None
    t = type(value)
    mod = type_module(t)
    name = type_qualname(t)
    if is_torch_tensor(t) or is_tf_tensor(t):
        return "tensor"
    if "torch" in sys.modules and _mro_has(t, ("torch.nn",), ("Module",)):
        return "model"
    if _mro_has(t, _KERAS, ("Model",)):
        return "model"
    if _mro_has(t, ("sklearn",), ("BaseEstimator",)):
        return "estimator"
    if _mro_has(t, _KERAS, ("History",)):
        return "history"
    if in_package(mod, ("scipy.sparse",)) and name.split("_")[0] in ("csr", "csc", "coo", "lil", "dok", "bsr", "dia"):
        return "sparse"
    if "torch" in sys.modules:
        if _mro_has(t, ("torch.optim",), ("Optimizer",)):
            return "optimizer"
        if _mro_has(t, ("torch.utils.data",), ("DataLoader",)):
            return "dataloader"
        if mod == "torch" and name in ("Size", "device", "dtype"):
            return "torchinfo"
    return None


def describe_other(kind: str, info: dict[str, Any], value: Any) -> None:
    """Sparse matrices, optimizers, data loaders, torch.Size / device / dtype."""
    d = instance_dict(value) or {}
    if kind == "sparse":
        rows, cols = (int(x) for x in value.shape)
        nnz = int(value.nnz)
        info["shape"] = [rows, cols]
        info["dtype"] = str(value.dtype)
        info["nnz"] = nnz
        info["format"] = str(value.format)
        info["density"] = nnz / (rows * cols) if rows and cols else 0.0
        size = 0
        for part in ("data", "indices", "indptr", "row", "col"):
            arr = d.get(part)
            if type_module(type(arr)) == "numpy" and type_qualname(type(arr)) == "ndarray":
                size += int(arr.nbytes)
        info["size"] = size or None
    elif kind == "optimizer":
        groups = d.get("param_groups")
        if type(groups) is list and groups and type(groups[0]) is dict:
            g = groups[0]
            hyper = {k: encode_scalar(v, 30) for k, v in g.items()
                     if k in ("lr", "momentum", "weight_decay", "betas", "eps", "nesterov")
                     and (type(v) in _SCALARS or (type(v) is tuple and all(type(x) in _SCALARS for x in v)))}
            if "betas" in hyper and type(g.get("betas")) is tuple:
                hyper["betas"] = ", ".join(str(x) for x in g["betas"])  # type: ignore[assignment]
            info["params"] = hyper
            info["groups"] = len(groups)
            info["tensors"] = sum(len(x.get("params", [])) for x in groups if type(x) is dict)
        state = d.get("state")
        if issubclass(type(state), dict):
            # Adam / SGD-momentum keep per-tensor state once step() has run.
            info["stepped"] = dict.__len__(state) > 0
    elif kind == "dataloader":
        for key in ("batch_size", "num_workers", "drop_last", "pin_memory"):
            v = d.get(key)
            if type(v) in _SCALARS:
                info.setdefault("params", {})[key] = v
        ds = d.get("dataset")
        if ds is not None:
            info["dataset"] = type_qualname(type(ds))
            dd = instance_dict(ds) or {}
            tensors = dd.get("tensors")  # TensorDataset: len of the first tensor, no user __len__
            if type(tensors) is tuple and tensors and is_torch_tensor(type(tensors[0])):
                info["samples"] = int(tensors[0].shape[0])
        info["shuffle"] = type_qualname(type(d.get("sampler"))) == "RandomSampler"
    elif kind == "torchinfo":
        name = type_qualname(type(value))
        if name == "Size":
            info["value"] = "torch.Size([" + ", ".join(str(int(x)) for x in value) + "])"
            info["shape"] = [int(x) for x in value]
        else:
            info["value"] = encode_scalar(str(value), 40)


# -- tensors ----------------------------------------------------------------
def describe_tensor(info: dict[str, Any], value: Any) -> None:
    t = type(value)
    if is_torch_tensor(t):
        info["shape"] = [int(s) for s in value.shape]
        info["dtype"] = str(value.dtype).removeprefix("torch.")
        info["device"] = str(value.device)
        info["requiresGrad"] = bool(value.requires_grad)
        info["hasGradFn"] = value.grad_fn is not None
        numel = int(value.numel())
        info["size"] = numel * int(value.element_size())
        if numel == 1 and not value.is_complex():
            # A loss: show its number, not just "0-d tensor".
            info["value"] = encode_scalar(value.detach().reshape(()).item())
        elif value.dim() == 1 and numel <= 8 and not value.is_complex():
            info["preview"] = [encode_scalar(x, 40) for x in value.detach().to("cpu").tolist()]
    else:  # TensorFlow eager tensor / variable
        dims = value.shape.as_list() if hasattr(value.shape, "as_list") else list(value.shape)
        info["shape"] = [int(d) if d is not None else -1 for d in dims]
        info["dtype"] = str(value.dtype.name)
        info["device"] = str(value.device).rsplit("device:", 1)[-1] or "CPU:0"
        if type_qualname(t) == "ResourceVariable":
            info["trainable"] = bool(value.trainable)
        numel = 1
        for d in info["shape"]:
            numel *= max(d, 0)
        if numel == 1:
            info["value"] = encode_scalar(value.numpy().reshape(()).item())
    from .images import image_layout

    layout = image_layout(tuple(info["shape"])) if info["shape"] and min(info["shape"]) >= 0 else None
    if layout is not None and _likely_image(layout):
        info["image"] = {"count": layout["count"], "layout": layout["order"]}


def _likely_image(layout: dict[str, Any]) -> bool:
    """Images worth a preview button: batches, colour images, real pictures.

    A plain matrix (a 30 x 3 table) is an "image" only geometrically; it
    gets the button when both sides are at least 8 pixels and the aspect
    is not extreme (correlation matrices and confusion matrices qualify).
    """
    h, w = layout["height"], layout["width"]
    if layout["order"] == "flat":
        return h >= 8
    if layout["order"] != "hw" or layout["count"] > 1:
        return h >= 4 and w >= 4
    return min(h, w) >= 8 and max(h, w) <= 8 * min(h, w)


def ndarray_image(info: dict[str, Any], value: Any) -> None:
    from .images import image_layout

    if value.dtype.kind not in "biuf" or value.size == 0:
        return
    layout = image_layout(tuple(int(s) for s in value.shape))
    if layout is not None and _likely_image(layout):
        info["image"] = {"count": layout["count"], "layout": layout["order"]}


# -- models -------------------------------------------------------------------
def describe_model(info: dict[str, Any], value: Any) -> None:
    t = type(value)
    if "torch" in sys.modules and _mro_has(t, ("torch.nn",), ("Module",)):
        _torch_model(info, value)
    else:
        _keras_model(info, value)


def _torch_model(info: dict[str, Any], root: Any) -> None:
    seen_modules: set[int] = set()
    seen_params: set[int] = set()
    total = trainable = 0
    device = None
    layers = 0
    lazy = 0
    stack = [root]
    while stack and len(seen_modules) < MAX_MODULES:
        m = stack.pop()
        if id(m) in seen_modules:
            continue
        seen_modules.add(id(m))
        d = instance_dict(m) or {}
        params = d.get("_parameters")
        if type(params) is dict:
            for p in params.values():
                if p is None or id(p) in seen_params or not in_package(type_module(type(p)), ("torch",)):
                    continue
                seen_params.add(id(p))  # shared (tied) weights count once
                if type_qualname(type(p)).startswith("Uninitialized"):
                    lazy += 1  # LazyLinear before its first forward pass
                    continue
                n = int(p.numel())
                total += n
                if p.requires_grad:
                    trainable += n
                if device is None:
                    device = str(p.device)
        subs = d.get("_modules")
        if type(subs) is dict:
            children = [s for s in subs.values() if s is not None]
            if not children:
                layers += 1
            stack.extend(reversed(children))
    info["paramCount"] = total
    info["trainableParams"] = trainable
    if lazy:
        info["lazyParams"] = lazy
    info["layers"] = max(0, layers - (1 if total == 0 and layers == 1 else 0))
    if device is not None:
        info["device"] = device
    training = (instance_dict(root) or {}).get("training")
    if type(training) is bool:
        info["training"] = training


def _keras_model(info: dict[str, Any], value: Any) -> None:
    d = instance_dict(value) or {}
    built = d.get("built")
    if built is None:
        built = d.get("_built")
    info["built"] = bool(built)
    if built:
        count = _keras_param_count(value)
        if count is not None:
            info["paramCount"] = count


def _list_items(v: object) -> list[Any] | None:
    # Keras 3 keeps sublayers in a TrackedList (a list subclass); list's own
    # iterator reads the storage without running an overridden __iter__.
    if not issubclass(type(v), list):
        return None
    return list(list.__iter__(v))  # type: ignore[arg-type]


def _keras_param_count(root: Any) -> int | None:
    """What Keras 3's count_params() returns, read from the layers' own lists.

    count_params() goes through the `weights` property of the model and of
    every sublayer, which user subclasses can override. Each layer keeps its
    variables in _trainable_variables / _non_trainable_variables and its
    sublayers in _layers; a variable's shape is its _shape tuple. Anything
    else (Keras 2 / tf_keras internals) gives None: no count rather than
    running user code.
    """
    seen_layers: set[int] = set()
    seen_vars: set[int] = set()
    total = 0
    stack = [root]
    while stack:
        layer = stack.pop()
        if id(layer) in seen_layers:
            continue
        if len(seen_layers) >= MAX_MODULES:
            return None
        seen_layers.add(id(layer))
        d = instance_dict(layer)
        if d is None:
            return None
        sub = _list_items(d.get("_layers"))
        own = [_list_items(d.get("_trainable_variables")), _list_items(d.get("_non_trainable_variables"))]
        if sub is None or own[0] is None or own[1] is None:
            return None
        for var in own[0] + own[1]:
            if id(var) in seen_vars:
                continue
            seen_vars.add(id(var))
            if not _mro_has(type(var), ("keras",), ("Variable",)):
                return None
            shape = (instance_dict(var) or {}).get("_shape")
            if type(shape) is not tuple or not all(type(n) is int for n in shape):
                return None
            total += math.prod(shape)
        stack.extend(sub)
    return total


# -- scikit-learn estimators -----------------------------------------------
def describe_estimator(info: dict[str, Any], value: Any) -> None:
    state = instance_dict(value) or {}
    fitted = _fitted_attrs(state)
    info["fitted"] = bool(fitted)
    info["fittedAttrs"] = fitted[:12]
    params = _changed_params(type(value), state)
    if params:
        info["params"] = params
    steps = state.get("steps")
    if type(steps) is list and steps and all(type(s) is tuple and len(s) >= 2 for s in steps[:50]):
        info["steps"] = [[s[0] if type(s[0]) is str else "?", type_qualname(type(s[1]))] for s in steps[:20]]
        # A Pipeline keeps its fitted state in its steps, not in itself.
        info["fitted"] = info["fitted"] or _steps_fitted(steps)
    facts: dict[str, Any] = {}
    for key in ("best_score_", "n_features_in_", "n_iter_", "inertia_", "explained_variance_ratio_"):
        v = state.get(key)
        if type(v) in (int, float) or _is_numpy_scalar(v):
            facts[key] = encode_scalar(v)
        elif _is_small_ndarray(v):
            facts[key] = [encode_scalar(x, 20) for x in v.tolist()[:8]]
    classes = state.get("classes_")
    if _is_small_ndarray(classes, 1000):
        facts["classes_"] = [encode_scalar(x, 20) for x in classes.tolist()[:10]]
        facts["n_classes"] = int(classes.shape[0])
    best = state.get("best_params_")
    if type(best) is dict and len(best) <= 20:
        # Grids are often np.logspace / np.arange: numpy scalars count too,
        # and an estimator value shows as its class name.
        facts["best_params_"] = {k: (encode_scalar(v, 40) if type(v) in _SCALARS or _is_numpy_scalar(v)
                                     else {"$t": "obj", "type": type_qualname(type(v))})
                                 for k, v in best.items() if type(k) is str}
    if facts:
        info["facts"] = facts


def _fitted_attrs(state: dict[str, Any]) -> list[str]:
    return [k for k in state if k.endswith("_") and not k.startswith("_") and not k.endswith("__")]


def _steps_fitted(steps: list[Any], depth: int = 0) -> bool:
    """Pipeline.__sklearn_is_fitted__ without calling it: the last step that
    is not 'passthrough' / None decides, and a nested Pipeline is asked the
    same way (it has no fitted attributes of its own)."""
    for step in reversed(steps):
        if type(step) is not tuple or len(step) < 2:
            return False
        est = step[1]
        if est is None or (type(est) is str and est == "passthrough"):
            continue
        if type(est) is str or is_class(est):
            return False
        state = instance_dict(est) or {}
        inner = state.get("steps")
        if type(inner) is list and inner and depth < 20 and _mro_has(type(est), ("sklearn",), ("Pipeline",)):
            return _steps_fitted(inner, depth + 1)
        return bool(_fitted_attrs(state))
    return True  # only passthrough steps: sklearn calls that fitted


def _same(a: object, b: object) -> bool:
    if type(a) is float and type(b) is float and a != a and b != b:
        return True  # nan defaults (error_score=np.nan)
    return type(a) is type(b) and a == b


def _changed_params(t: type, state: dict[str, Any]) -> dict[str, Any]:
    """Hyperparameters that differ from their defaults (scalars only).

    sklearn stores each __init__ argument as an attribute of the same name;
    comparing only plain scalars means no user __eq__ ever runs.
    """
    inits = _init_signatures(t)
    if not inits:
        return {}
    sig = inits[0]
    out: dict[str, Any] = {}
    named = set()
    for name, p in sig.parameters.items():
        named.add(name)
        if name == "self" or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) or name not in state:
            continue
        v = state[name]
        if _is_numpy_scalar(v):
            v = v.item()  # type: ignore[attr-defined]  # C-level, exact numpy type
        if type(v) not in _SCALARS or type(p.default) not in _SCALARS or _same(v, p.default):
            continue
        out[name] = encode_scalar(v, 40)
        if len(out) >= 8:
            return out
    if any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
        # XGBoost / LightGBM wrappers take most parameters as **kwargs and
        # store unset ones as None; the base class __init__ (XGBModel) holds
        # the real defaults (missing=nan, enable_categorical=True).
        defaults: dict[str, Any] = {}
        for base in inits[1:]:
            for name, p in base.parameters.items():
                if p.default is not p.empty:
                    defaults.setdefault(name, p.default)
        for name, v in state.items():
            if name in named or name.startswith("_") or name.endswith("_") or type(v) not in _SCALARS or v is None:
                continue
            if name in defaults and _same(v, defaults[name]):
                continue
            out[name] = encode_scalar(v, 40)
            if len(out) >= 8:
                break
    return out


def _init_signatures(t: type) -> list[inspect.Signature]:
    """Signatures of the plain-function __init__s in the MRO, nearest first.

    Read from the class dicts: t.__init__ would go through a metaclass, and
    only Python functions are introspected (nothing is called).
    """
    out: list[inspect.Signature] = []
    for klass in class_mro(t):
        init = class_ns(klass).get("__init__")
        if init is None:
            continue
        if type(init) is not types.FunctionType:
            if not out:
                return []  # the __init__ that runs is not Python: no defaults to read
            continue
        try:
            out.append(inspect.signature(init))
        except (TypeError, ValueError):
            continue
    return out


def _is_numpy_scalar(v: object) -> bool:
    np = sys.modules.get("numpy")
    return np is not None and issubclass(type(v), np.generic) and type_module(type(v)) == "numpy"


def _is_small_ndarray(v: object, limit: int = 64) -> bool:
    t = type(v)
    return type_module(t) == "numpy" and type_qualname(t) == "ndarray" and v.ndim == 1 and v.size <= limit  # type: ignore[attr-defined]
