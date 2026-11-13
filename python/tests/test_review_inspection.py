"""Regression tests for the inspection findings of the ML review: exact
library types, BaseExceptions during a describe, image layouts and scaling,
chart data, sklearn / XGBoost / Keras metadata."""

from __future__ import annotations

import base64
import math
import random
import sys
import tracemalloc
import types
import zlib
from typing import Any

import pytest

from conftest import KernelProc
from pylive_kernel import heap, images, inspector, mlinspect, series
from pylive_kernel.heap import HeapEncoder, in_package, viz_hint

np = pytest.importorskip("numpy")


@pytest.fixture(autouse=True)
def _usable_recursion_limit():
    # An in-process trace in test_review_fixes leaves the limit at 80, and
    # importing sklearn for the first time needs more.
    old = sys.getrecursionlimit()
    sys.setrecursionlimit(max(old, 1000))
    yield
    sys.setrecursionlimit(old)


def _gray_levels(out: dict[str, Any]) -> list[int]:
    png = base64.b64decode(out["png"])
    raw = zlib.decompress(png[png.index(b"IDAT") + 4: png.index(b"IEND") - 8])
    stride = out["width"] * out["channels"] + 1
    return sorted({b for i, b in enumerate(raw) if i % stride != 0})


def _user_class(module: str, name: str, ns: dict[str, Any] | None = None, bases: tuple[type, ...] = (object,)) -> type:
    return type(name, bases, {"__module__": module, "__qualname__": name, **(ns or {})})


# -- 13: BaseExceptions raised while describing -------------------------------
@pytest.mark.parametrize("exc", [SystemExit(0), GeneratorExit(), SystemExit("bye")])
def test_describe_reports_base_exceptions_instead_of_raising(monkeypatch, exc):
    def boom(*_a: Any) -> None:
        raise exc

    monkeypatch.setattr(inspector, "_fill", boom)
    info = inspector.describe("x", [1, 2])
    assert info["error"] == type(exc).__name__ and info["kind"] == "list"
    listing = inspector.list_variables({"x": [1, 2], "y": 3})
    assert [v["name"] for v in listing["variables"]] == ["x", "y"]


def test_describe_still_lets_keyboard_interrupt_through(monkeypatch):
    def stop(*_a: Any) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(inspector, "_fill", stop)
    with pytest.raises(KeyboardInterrupt):
        inspector.describe("x", [1])


def test_describe_survives_a_failing_kind_check(monkeypatch):
    def bad_kind(_v: object) -> str:
        raise SystemExit(3)

    monkeypatch.setattr(inspector, "_kind", bad_kind)
    info = inspector.describe("x", 1)
    assert info["error"] == "SystemExit" and info["kind"] == "object"


# -- 14: library types by exact package, not by name prefix --------------------
def test_in_package_matches_whole_package_names():
    assert in_package("torch", ("torch",)) and in_package("torch.nn.modules", ("torch",))
    assert not in_package("torchutils", ("torch",)) and not in_package("torch_scratch.engine", ("torch",))
    assert not in_package("keras_helpers", ("keras", "tf_keras")) and in_package("tf_keras.src", ("keras", "tf_keras"))


def test_look_alike_user_classes_are_plain_objects(monkeypatch):
    calls: list[str] = []

    def spy(name: str) -> property:
        return property(lambda self: calls.append(name))

    def getattr_spy(self: object, name: str) -> Any:
        calls.append(f"__getattr__({name})")
        raise AttributeError(name)

    def count_params(self: object) -> int:
        calls.append("count_params")
        raise SystemExit("bye")

    # A loaded "torch" makes the old name check reachable for tensors.
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    fakes = {
        "tensor": _user_class("torch_scratch.engine", "Tensor", {"shape": spy("shape"), "__getattr__": getattr_spy}),
        "param": _user_class("torchutils", "Parameter", {"shape": spy("shape"), "__getattr__": getattr_spy}),
        "tf": _user_class("tensorflow_scratch", "EagerTensor", {"shape": spy("shape"), "__getattr__": getattr_spy}),
        "frame": _user_class("pandas_helpers", "DataFrame", {"shape": spy("shape"), "dtypes": spy("dtypes")}),
        "series": _user_class("pandas_helpers", "Series", {"shape": spy("shape"), "dtype": spy("dtype")}),
    }
    keras_model = _user_class("keras_scratch", "Model", {"count_params": count_params})
    fakes["model"] = _user_class("__main__", "Net", bases=(keras_model,))
    fakes["history"] = _user_class("keras_helpers.callbacks", "History", {"__getattr__": getattr_spy})
    for kind, cls in fakes.items():
        value = cls()
        if kind == "model":
            value.built = True  # type: ignore[attr-defined]
        info = inspector.describe(kind, value)
        assert info["kind"] == "object", (kind, info)
        assert "error" not in info, (kind, info)
        assert images.array_shape(value) is None
        with pytest.raises(series.NotASeries):
            series.chart(value)
    assert calls == []


def test_user_module_named_like_keras_does_not_end_the_kernel(tmp_path):
    (tmp_path / "keras_scratch.py").write_text(
        "CALLS = []\n"
        "class Model:\n"
        "    def __init__(self):\n"
        "        self.built = True\n"
        "    def count_params(self):\n"
        "        CALLS.append('ran')\n"
        "        raise SystemExit('bye')\n", encoding="utf-8")
    k = KernelProc(cwd=str(tmp_path))
    try:
        k.run("from keras_scratch import Model, CALLS\nnet = Model()")
        out = k.call("variables.list", timeout=20)
        assert out["ok"], out
        row = [v for v in out["result"]["variables"] if v["name"] == "net"][0]
        assert row["kind"] == "object"
        assert k.run("len(CALLS)")["value"]["repr"] == "0"
    finally:
        k.close()


# -- 15: square 2-D arrays are one picture ------------------------------------
@pytest.mark.parametrize("side", [16, 64, 100, 256])
def test_square_matrices_are_single_images(side):
    layout = images.image_layout((side, side))
    assert layout is not None and layout["count"] == 1 and layout["order"] == "hw"
    info = inspector.describe("pic", np.zeros((side, side), dtype=np.float32))
    assert info["image"] == {"count": 1, "layout": "hw"}
    out = images.preview(np.zeros((side, side), dtype=np.uint8))
    assert out["tile"] == [side, side] and out["shown"] == 1


def test_flattened_image_tables_stay_flat():
    for shape in ((1797, 64), (5, 784), (1000, 784)):
        layout = images.image_layout(shape)
        assert layout is not None and layout["order"] == "flat" and layout["count"] == shape[0]


# -- 16: large photos are downscaled to fit the message limit ------------------
def test_phone_photo_preview_fits_the_message_limit():
    rng = np.random.default_rng(0)
    photo = rng.integers(0, 256, (3000, 4000, 3), dtype=np.uint8)  # noise: no PNG compression
    out = images.preview(photo)
    assert len(out["png"]) < 8 * 1024 * 1024 - 64 * 1024
    assert out["tile"] == [3000, 4000] and out["scale"] > 1
    assert out["width"] == math.ceil(4000 / out["scale"]) and out["height"] == math.ceil(3000 / out["scale"])
    small = images.preview(np.zeros((28, 28), dtype=np.uint8))
    assert small["scale"] == 1 and small["width"] == 28


def test_large_batches_and_flat_rows_are_downscaled_too():
    out = images.preview(np.zeros((16, 3, 512, 512), dtype=np.float32))
    assert out["layout"] == "chw" and out["scale"] >= 2 and len(out["png"]) < 6_000_000
    assert out["width"] > 0 and out["tile"] == [512, 512]


# -- 17: charts of large arrays stay in NumPy ---------------------------------
def test_chart_of_a_large_array_does_not_build_python_lists():
    arr = np.random.default_rng(1).random(2_000_000)
    tracemalloc.start()
    try:
        out = series.chart(arr, 800)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    s = out["series"][0]
    assert s["len"] == 2_000_000 and len(s["y"]) <= 800 and out["downsampled"]
    assert peak < 4_000_000, peak  # tolist() of 2M values alone was ~64 MB
    assert s["x"][0] == 0 and s["x"][-1] == 2_000_000 - 1


def test_array_downsampling_keeps_spikes_and_gaps():
    arr = np.zeros(10_000)
    arr[1234] = 50.0
    arr[5000:6000] = np.nan
    arr[7000] = np.inf
    xs, ys = series._downsample(arr, 200)
    assert 50.0 in ys and None in ys and len(ys) <= 200
    assert all(y is None or math.isfinite(y) for y in ys)
    with pytest.raises(series.NotASeries):
        series.chart(np.full(5000, np.nan))


def test_huge_lists_do_not_offer_a_chart_they_cannot_draw():
    info = inspector.describe("big", [0.5] * (series.MAX_LEN + 1))
    assert "chart" not in info
    assert inspector.describe("ok", [0.5] * 1000)["chart"] is True


# -- 19: the last (and first) value is always drawn ---------------------------
@pytest.mark.parametrize("as_array", [False, True])
def test_downsampling_keeps_first_and_last_points(as_array):
    for n in list(range(801, 1700, 7)) + [2999, 3000, 12_345, 100_003]:
        y = [float(i) for i in range(n)]
        xs, ys = series._downsample(np.array(y) if as_array else y, 800)
        assert len(xs) == len(ys) <= 800, n
        assert xs[0] == 0 and xs[-1] == n - 1 and ys[-1] == float(n - 1), n
        assert xs == sorted(set(xs)), n


def test_legend_value_is_the_real_final_loss():
    random.seed(0)
    loss = [2.0 * 0.999 ** i + random.uniform(-0.05, 0.05) for i in range(3000)]
    s = series.chart(loss, 800)["series"][0]
    assert s["x"][-1] == 2999 and s["y"][-1] == loss[-1]


# -- 20: NumPy scalars (and one-element tensors) count as numbers --------------
def test_lists_of_numpy_scalars_are_chartable():
    rmse = [np.float64(1.0 / (i + 1)) for i in range(20)]
    assert inspector.describe("rmse", rmse)["chart"] is True
    mixed = [np.float32(0.5), 0.4, np.int64(1)]
    assert inspector.describe("mixed", mixed)["chart"] is True
    hist = {"loss": [np.float32(0.5), np.float32(0.4), np.float32(0.3)], "val_loss": [0.6, 0.5, 0.45]}
    info = inspector.describe("hist", hist)
    assert info["viz"] == "series" and info["chart"] is True
    assert [x["name"] for x in series.chart(hist)["series"]] == ["loss", "val_loss"]


def test_number_check_runs_no_user_code():
    calls: list[str] = []

    class Num:
        def __float__(self) -> float:
            calls.append("float")
            return 1.0

    class MyFloat(float):
        pass

    assert not heap.is_number_sequence([Num(), Num(), Num()])
    assert not heap.is_number_sequence([MyFloat(1), MyFloat(2), MyFloat(3)])
    assert not heap.is_number_sequence([np.bool_(True), np.bool_(False)])
    assert not heap.is_number_sequence([np.int64(1), np.int64(2), np.int64(3)])  # counts, not a curve
    assert calls == []


def test_one_element_tensors_are_chartable():
    torch = pytest.importorskip("torch")
    w = torch.ones(1, requires_grad=True)
    losses = [((w * i) ** 2).sum() for i in range(5)]
    info = inspector.describe("losses", losses)
    assert info["chart"] is True
    assert series.chart(losses)["notes"]


# -- 21: Pipeline fitted state ------------------------------------------------
def test_pipelines_ending_in_a_pipeline_or_passthrough_are_fitted():
    pytest.importorskip("sklearn")
    from sklearn.datasets import load_iris
    from sklearn.decomposition import PCA
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline, make_pipeline
    from sklearn.preprocessing import StandardScaler

    X, y = load_iris(return_X_y=True)

    def build() -> dict[str, Any]:
        return {
            "nested": Pipeline([("prep", StandardScaler()), ("inner", make_pipeline(PCA(2), LogisticRegression()))]),
            "tail": Pipeline([("scale", StandardScaler()), ("out", "passthrough")]),
            "none_tail": Pipeline([("scale", StandardScaler()), ("out", None)]),
        }

    for name, pipe in build().items():
        assert inspector.describe(name, pipe)["fitted"] is False, name
    for name, pipe in build().items():
        pipe.fit(X, y)
        assert inspector.describe(name, pipe)["fitted"] is True, name
    only = Pipeline([("a", "passthrough")])
    assert inspector.describe("only", only)["fitted"] is True  # sklearn agrees


# -- 22: dok matrices are sparse matrices, not empty dicts ---------------------
def test_dok_matrices_are_sparse():
    sp = pytest.importorskip("scipy.sparse")
    makers = [lambda: sp.random(100, 100, density=0.05, format="dok", random_state=0)]
    if hasattr(sp, "dok_array"):
        makers.append(lambda: sp.dok_array(sp.random(50, 40, density=0.1, format="csr", random_state=0)))
    for make in makers:
        dok = make()
        info = inspector.describe("dok", dok)
        assert info["kind"] == "sparse" and info["nnz"] == dok.nnz and info["format"] == "dok"
        assert viz_hint(dok) is None
        enc = HeapEncoder()
        root = enc.encode([dok])
        node = enc.heap[str(root["ref"])]
        assert type(node["items"][0]) is dict and "ref" not in node["items"][0]  # not expanded as a dict
    pytest.importorskip("sklearn")
    from sklearn.utils import Bunch

    assert inspector.describe("bunch", Bunch(a=1))["kind"] == "dict"  # other library dict subclasses still are


# -- 23: **kwargs estimators compare against their base class defaults --------
def test_kwargs_estimators_do_not_report_defaults_as_changed():
    pytest.importorskip("sklearn")
    from sklearn.base import BaseEstimator

    class XModel(BaseEstimator):
        def __init__(self, max_depth: int | None = None, missing: float = float("nan"),
                     enable_categorical: bool = True, n_jobs: int | None = None) -> None:
            self.max_depth = max_depth
            self.missing = missing
            self.enable_categorical = enable_categorical
            self.n_jobs = n_jobs

    class XClassifier(XModel):
        def __init__(self, *, objective: str = "binary:logistic", **kwargs: Any) -> None:
            super().__init__(**kwargs)
            self.objective = objective

    assert mlinspect._changed_params(XClassifier, vars(XClassifier())) == {}
    changed = mlinspect._changed_params(XClassifier, vars(XClassifier(max_depth=2, enable_categorical=False)))
    assert changed == {"max_depth": 2, "enable_categorical": False}


def test_xgboost_defaults_are_not_listed():
    xgb = pytest.importorskip("xgboost")
    assert "params" not in inspector.describe("m", xgb.XGBClassifier())
    assert inspector.describe("m", xgb.XGBClassifier(n_estimators=5, max_depth=2))["params"] == {
        "n_estimators": 5, "max_depth": 2}


# -- 24: Keras parameter counts without the `weights` property -----------------
def _fake_keras() -> tuple[type, type, type]:
    model = _user_class("keras.src.models.model", "Model")
    layer = _user_class("keras.src.layers.layer", "Layer")
    variable = _user_class("keras.src.backend", "Variable")
    return model, layer, variable


def _keras_obj(cls: type, **state: Any) -> Any:
    obj = cls.__new__(cls)
    obj.__dict__.update(state)
    return obj


def test_keras_param_count_reads_layer_state_not_properties():
    model_cls, layer_cls, var_cls = _fake_keras()
    calls: list[str] = []

    def weights(self: object) -> list[Any]:
        calls.append("weights")
        raise SystemExit(0)

    def count_params(self: object) -> int:
        calls.append("count_params")
        return -1

    spy = _user_class("__main__", "Spy", {"weights": property(weights), "count_params": count_params},
                      bases=(model_cls,))
    w1, b1, w2 = (_keras_obj(var_cls, _shape=s) for s in ((3, 4), (4,), (4, 2)))
    dense1 = _keras_obj(layer_cls, _layers=[], _trainable_variables=[w1, b1], _non_trainable_variables=[])
    dense2 = _keras_obj(layer_cls, _layers=[], _trainable_variables=[w2], _non_trainable_variables=[w2])
    tracked = type("TrackedList", (list,), {"__iter__": lambda self: calls.append("__iter__") or iter(())})
    net = _keras_obj(spy, built=True, _layers=tracked([dense1, dense2, dense1]), _trainable_variables=[],
                     _non_trainable_variables=[])
    info = inspector.describe("net", net)
    assert info["kind"] == "model" and info["built"] is True
    assert info["paramCount"] == 3 * 4 + 4 + 4 * 2  # shared layers and variables count once
    assert calls == []


def test_unknown_keras_layouts_get_no_count_instead_of_running_code():
    model_cls, _, _ = _fake_keras()
    net = _keras_obj(model_cls, built=True, _self_tracked_trackables=[])  # Keras 2 internals
    info = inspector.describe("net", net)
    assert info["kind"] == "model" and "paramCount" not in info and "error" not in info
    odd = _keras_obj(model_cls, built=True, _layers=[], _trainable_variables=[object()], _non_trainable_variables=[])
    assert "paramCount" not in inspector.describe("odd", odd)


def test_real_keras_counts_match_count_params():
    keras = pytest.importorskip("keras")
    m = keras.Sequential([keras.Input((3,)), keras.layers.Dense(4), keras.layers.BatchNormalization(),
                          keras.layers.Dense(2)])
    assert inspector.describe("m", m)["paramCount"] == m.count_params()


# -- 25: NumPy bytes scalars --------------------------------------------------
def test_numpy_bytes_scalar_shows_its_bytes():
    label = np.array([b"cat", b"dog"])[0]
    info = inspector.describe("label", label)
    assert info["kind"] == "scalar" and info["value"] == {"$t": "bytes", "v": "636174", "len": 3}
    s = inspector.describe("s", np.str_("cat"))
    assert s["kind"] == "str" and s["value"] == "cat"


# -- 26: label masks are stretched ---------------------------------------------
@pytest.mark.parametrize("dtype", [np.int64, np.uint8, np.float64])
def test_label_masks_use_the_full_gray_range(dtype):
    mask = np.zeros((32, 32), dtype=dtype)
    mask[8:16] = 1
    mask[16:24] = 2
    assert _gray_levels(images.preview(mask)) == [0, 127, 255]


def test_images_with_a_full_range_keep_their_gray_levels():
    ramp = np.tile(np.arange(256, dtype=np.uint8)[:, None], (1, 20))  # 256 x 20: one picture
    assert _gray_levels(images.preview(ramp)) == list(range(256))
    assert _gray_levels(images.preview(np.full((16, 16), 200, dtype=np.uint8))) == [200]
    rgb = np.zeros((16, 16, 3), dtype=np.uint8)
    rgb[..., 0] = 2  # colour images are never stretched
    assert _gray_levels(images.preview(rgb)) == [0, 2]


# -- bf16 tensors (18) and exact torch types (14) ------------------------------
def test_bfloat16_tensors_describe_without_error():
    torch = pytest.importorskip("torch")
    pytest.importorskip("pandas")
    for dt in (torch.bfloat16, torch.float16):
        info = inspector.describe("w", torch.zeros(4, 4).to(dt))
        assert "error" not in info and info["shape"] == [4, 4]
    assert "table" not in inspector.describe("w", torch.zeros(4, 4, dtype=torch.bfloat16))
    assert inspector.describe("t", torch.zeros(3, 3))["kind"] == "tensor"
    assert inspector.describe("p", torch.nn.Parameter(torch.zeros(2)))["kind"] == "tensor"


# -- non-str keys in the namespace ----------------------------------------------
def test_non_string_namespace_keys_are_skipped():
    out = inspector.list_variables({1: "one", (2, 3): "pair", "x": 5})  # type: ignore[dict-item]
    assert [v["name"] for v in out["variables"]] == ["x"]


def test_variables_list_after_globals_gets_an_int_key(kernel):
    kernel.run("globals()[1] = 'one'\nvalue = 2")
    out = kernel.call("variables.list")
    assert out["ok"], out
    assert "value" in [v["name"] for v in out["result"]["variables"]]
