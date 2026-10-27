"""Scalar serialization unit tests."""

from __future__ import annotations

import datetime as dt
import decimal
import json
import math

import pytest

from pylive_kernel.serialize import encode_label, encode_scalar


@pytest.mark.parametrize("value,expected", [
    (None, None), (True, True), (3, 3), (1.5, 1.5), ("hi", "hi"),
    (math.nan, {"$t": "nan"}), (math.inf, {"$t": "inf"}), (-math.inf, {"$t": "-inf"}),
    (2**60, {"$t": "int", "v": str(2**60)}),
    (dt.date(2020, 1, 2), {"$t": "date", "v": "2020-01-02"}),
    (decimal.Decimal("1.10"), {"$t": "dec", "v": "1.10"}),
])
def test_builtin_scalars(value, expected):
    assert encode_scalar(value) == expected


def test_all_outputs_are_strict_json():
    np = pytest.importorskip("numpy")
    pd = pytest.importorskip("pandas")
    values = [np.int64(5), np.float32(1.5), np.float64("nan"), np.bool_(True),
              np.datetime64("NaT"), np.datetime64("2020-01-01"), pd.NaT, pd.NA,
              pd.Timestamp("2020-01-01 10:00", tz="UTC"), pd.Timedelta("1h"),
              pd.Period("2020-01", "M"), complex(1, 2), b"\x00\x01", 10**5000,
              "x" * 1000, object(), [1, 2]]
    for v in values:
        json.dumps(encode_scalar(v), allow_nan=False)


def test_numpy_and_pandas_tags():
    np = pytest.importorskip("numpy")
    pd = pytest.importorskip("pandas")
    assert encode_scalar(np.int64(7)) == 7
    assert encode_scalar(np.float64("nan")) == {"$t": "nan"}
    assert encode_scalar(pd.NaT) == {"$t": "nat"}
    assert encode_scalar(pd.NA) == {"$t": "na"}
    assert encode_scalar(pd.Timestamp("2011-12-09 12:50"))["$t"] == "dt"


def test_long_string_is_truncated():
    out = encode_scalar("a" * 500, 10)
    assert out == {"$t": "str", "v": "a" * 10, "len": 500}


def test_huge_int_does_not_stringify():
    out = encode_scalar(10**5000)
    assert out["$t"] == "int" and "v" not in out and out["bits"] > 3000


def test_unknown_object_never_repr():
    class Bad:
        def __repr__(self):
            raise AssertionError("repr must not be called")

        __str__ = __repr__

    assert encode_scalar(Bad())["$t"] == "obj"


def test_labels():
    assert encode_label(("a", 1)) == "(a, 1)"
    assert encode_label(5) == "5"
