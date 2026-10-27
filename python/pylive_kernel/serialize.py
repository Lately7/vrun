"""Bounded, defensive conversion of Python values into JSON-safe data.

Rules:
* Never call ``repr``/``str`` on objects of unknown types (custom ``__repr__``
  may be slow or have side effects). Unknown objects become a type tag.
* JSON-native values pass through when they round-trip exactly.
* Everything else is a tagged dict ``{"$t": <kind>, "v": <text>}``.

The webview formats tagged values (see ``webview/format.ts``).
"""

from __future__ import annotations

import datetime as _dt
import decimal
import math
from typing import Any

MAX_SAFE_INT = 2**53 - 1
DEFAULT_MAX_STR = 200

JsonValue = Any


def type_name(obj: object) -> str:
    t = type(obj)
    module = t.__module__
    if module in ("builtins", "__main__", None):
        return t.__qualname__
    return f"{module}.{t.__qualname__}"


def short_type_name(obj: object) -> str:
    return type(obj).__qualname__


def _tag(kind: str, value: str | None = None, **extra: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"$t": kind}
    if value is not None:
        out["v"] = value
    out.update(extra)
    return out


def encode_str(s: str, max_len: int = DEFAULT_MAX_STR) -> JsonValue:
    if len(s) <= max_len:
        return s
    return _tag("str", s[:max_len], len=len(s))


def encode_float(f: float) -> JsonValue:
    if math.isnan(f):
        return _tag("nan")
    if math.isinf(f):
        return _tag("inf" if f > 0 else "-inf")
    return f


def encode_int(i: int) -> JsonValue:
    if -MAX_SAFE_INT <= i <= MAX_SAFE_INT:
        return i
    # Very large ints: str() of a huge int is O(n^2) and capped by
    # sys.int_info.str_digits_check_threshold, so bound by bit length first.
    if i.bit_length() > 3000:
        return _tag("int", None, bits=i.bit_length(), sign=-1 if i < 0 else 1)
    return _tag("int", str(i))


def _is_pandas(t: type) -> bool:
    return t.__module__.startswith("pandas")


def _is_numpy(t: type) -> bool:
    return t.__module__ == "numpy" or t.__module__.startswith("numpy.")


def encode_scalar(v: object, max_str: int = DEFAULT_MAX_STR) -> JsonValue:
    """Encode a scalar-like value. Containers and unknown objects become tags."""
    if v is None:
        return None
    t = type(v)
    if t is bool:
        return v
    if t is int:
        return encode_int(v)  # type: ignore[arg-type]
    if t is float:
        return encode_float(v)  # type: ignore[arg-type]
    if t is str:
        return encode_str(v, max_str)  # type: ignore[arg-type]

    if _is_numpy(t):
        return _encode_numpy_scalar(v, max_str)
    if _is_pandas(t):
        return _encode_pandas_scalar(v)

    if isinstance(v, bool):
        return bool(v)
    if isinstance(v, int):
        return encode_int(int(v))
    if isinstance(v, float):
        return encode_float(float(v))
    if isinstance(v, str):
        return encode_str(str.__str__(v), max_str)
    if isinstance(v, complex):
        return _tag("complex", f"{v.real!r}{v.imag:+}j")
    if isinstance(v, _dt.datetime):
        return _tag("dt", v.isoformat())
    if isinstance(v, _dt.date):
        return _tag("date", v.isoformat())
    if isinstance(v, _dt.time):
        return _tag("time", v.isoformat())
    if isinstance(v, _dt.timedelta):
        return _tag("td", str(v))
    if isinstance(v, decimal.Decimal):
        return _tag("dec", str(v)[:max_str])
    if isinstance(v, (bytes, bytearray)):
        head = bytes(v[:32]).hex()
        return _tag("bytes", head, len=len(v))
    return _tag("obj", None, type=type_name(v))


def _encode_numpy_scalar(v: Any, max_str: int) -> JsonValue:
    import numpy as np  # already imported by the user if we got a numpy value

    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, np.integer):
        return encode_int(int(v))
    if isinstance(v, np.floating):
        return encode_float(float(v))
    if isinstance(v, np.complexfloating):
        c = complex(v)
        return _tag("complex", f"{c.real!r}{c.imag:+}j")
    if isinstance(v, np.datetime64):
        if np.isnat(v):
            return _tag("nat")
        return _tag("dt", str(v))
    if isinstance(v, np.timedelta64):
        if np.isnat(v):
            return _tag("nat")
        return _tag("td", str(v))
    if isinstance(v, np.str_):
        return encode_str(str(v), max_str)
    if isinstance(v, np.bytes_):
        return _tag("bytes", bytes(v[:32]).hex(), len=len(v))
    if isinstance(v, np.ndarray):
        return _tag("obj", None, type="numpy.ndarray", shape=list(v.shape))
    return _tag("obj", None, type=type_name(v))


def _encode_pandas_scalar(v: Any) -> JsonValue:
    import pandas as pd

    if v is pd.NaT:
        return _tag("nat")
    if v is pd.NA:
        return _tag("na")
    if isinstance(v, pd.Timestamp):
        return _tag("dt", v.isoformat())
    if isinstance(v, pd.Timedelta):
        return _tag("td", str(v))
    if isinstance(v, pd.Period):
        return _tag("period", str(v))
    if isinstance(v, pd.Interval):
        return _tag("interval", f"{v.left}..{v.right}")
    return _tag("obj", None, type=type_name(v))


def encode_label(label: object) -> str:
    """Human-readable label for DataFrame index/column labels (bounded)."""
    if isinstance(label, str):
        return label[:200]
    if isinstance(label, (int, float, bool)) or label is None:
        return str(label)
    if isinstance(label, tuple):
        return "(" + ", ".join(encode_label(x) for x in label[:8]) + ")"
    enc = encode_scalar(label)
    if isinstance(enc, dict):
        return str(enc.get("v", enc.get("type", "?")))
    return str(enc)


SAFE_REPR_TYPES = (int, float, bool, complex, str, bytes, type(None))


def safe_repr(value: object, limit: int = 2000) -> str:
    """repr() of a value the *user* evaluated, truncated.

    Only used for results of code the user explicitly executed, where calling
    repr is part of the expected REPL semantics.
    """
    try:
        text = repr(value)
    except BaseException as exc:  # noqa: BLE001 - user repr may raise anything
        if isinstance(exc, KeyboardInterrupt):
            raise
        return f"<repr failed: {type(exc).__name__}>"
    if len(text) > limit:
        return text[:limit] + f"… ({len(text) - limit} more chars)"
    return text
