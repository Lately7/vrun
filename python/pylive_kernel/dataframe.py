"""DataFrame metadata, paging, full-data sort/filter and on-demand summaries.

The frame never leaves the kernel. Pages are bounded by ``MAX_PAGE_ROWS`` x
``MAX_PAGE_COLS``. Sort/filter orderings are cached per execution count only,
because any execution may mutate the frame in place (ADR-004).
"""

from __future__ import annotations

import decimal
from typing import Any

from .heap import in_package, is_torch_tensor
from .serialize import encode_label, encode_scalar, type_module, type_qualname

MAX_PAGE_ROWS = 500
MAX_PAGE_COLS = 200
MAX_META_COLS = 2000
FILTER_OPS = {"eq", "ne", "lt", "le", "gt", "ge", "contains", "isnull", "notnull"}


class BadRequest(ValueError):
    pass


def table_source(value: Any) -> Any:
    """A 1-D / 2-D NumPy array (or CPU tensor) the viewer can page, else None.

    X_train, predict_proba output and confusion matrices are arrays; they get
    paging, sort, filter and statistics through a zero-copy DataFrame view.
    Only when pandas is already loaded (it is never imported here).
    """
    import sys

    if "pandas" not in sys.modules:
        return None
    t = type(value)
    if is_torch_tensor(t):
        if value.device.type != "cpu" or value.is_complex() or value.layout != sys.modules["torch"].strided \
                or value.dim() not in (1, 2):
            return None
        try:
            value = value.detach().numpy()  # shares memory with the tensor
        except (TypeError, RuntimeError):
            return None  # bfloat16 / float8 have no NumPy dtype
        t = type(value)
    mod, name = type_module(t), type_qualname(t)
    if mod == "numpy" and name == "ndarray" and value.ndim in (1, 2) and value.dtype.fields is None \
            and value.size > 0:
        return value
    return None


def _frame(value: Any) -> Any:
    """Return a DataFrame view for DataFrame or Series values (or arrays)."""
    t = type(value)
    pandas_type = in_package(type_module(t), ("pandas",))
    arr = table_source(value) if not pandas_type else None
    if arr is not None:
        import pandas as pd

        return pd.DataFrame(arr if arr.ndim == 2 else arr.reshape(-1, 1), copy=False)
    if not pandas_type:
        raise BadRequest("variable is not a pandas DataFrame or Series")
    if type_qualname(t) == "Series":
        return value.to_frame(name=value.name if value.name is not None else "value")
    if type_qualname(t) != "DataFrame":
        raise BadRequest("variable is not a pandas DataFrame or Series")
    return value


def _column_kind(dtype: Any) -> str:
    import pandas.api.types as pt

    if pt.is_bool_dtype(dtype):
        return "bool"
    if pt.is_numeric_dtype(dtype):
        return "numeric"
    if pt.is_datetime64_any_dtype(dtype):
        return "datetime"
    if pt.is_timedelta64_dtype(dtype):
        return "timedelta"
    if isinstance(dtype, __import__("pandas").CategoricalDtype):
        return "category"
    if pt.is_string_dtype(dtype):
        return "string"
    return "object"


def metadata(value: Any) -> dict[str, Any]:
    df = _frame(value)
    rows, cols = df.shape
    columns = []
    for i, (label, dtype) in enumerate(zip(df.columns[:MAX_META_COLS], df.dtypes.tolist()[:MAX_META_COLS])):
        columns.append({"index": i, "name": encode_label(label), "dtype": str(dtype),
                        "kind": _column_kind(dtype)})
    mem = df.memory_usage(index=True, deep=False)
    return {
        "isSeries": type(value).__name__ == "Series",
        "shape": [int(rows), int(cols)],
        "columns": columns,
        "columnsTruncated": cols > MAX_META_COLS,
        "index": {"type": type(df.index).__name__, "name": encode_label(df.index.name)
                  if df.index.name is not None else None},
        "memory": int(mem.sum()),
        "memoryIsLowerBound": any(c["kind"] in ("object", "string") for c in columns),
    }


def _check_col(df: Any, col: Any) -> int:
    if type(col) is not int or not (0 <= col < df.shape[1]):
        raise BadRequest("column index out of range")
    return col


def _filter_mask(series: Any, op: str, value: Any) -> Any:
    import pandas as pd
    import pandas.api.types as pt

    if op == "isnull":
        return series.isna().to_numpy()
    if op == "notnull":
        return series.notna().to_numpy()
    if value is None or (type(value) is str and len(value) > 1000):
        raise BadRequest("filter value missing or too long")
    if op == "contains":
        return series.astype("string").str.contains(str(value), case=False, regex=False, na=False).to_numpy()
    dtype = series.dtype
    target: Any = value
    try:
        if pt.is_bool_dtype(dtype):
            token = str(value).strip().lower()
            if token in ("1", "true", "yes", "t"):
                target = True
            elif token in ("0", "false", "no", "f"):
                target = False
            else:
                raise ValueError("expected true/false")
        elif pt.is_integer_dtype(dtype):
            # Exact arithmetic: float() would merge integers above 2**53, so
            # parse as Decimal and turn the comparison into an integer one.
            dec = decimal.Decimal(str(value).strip())
            if not dec.is_finite():
                raise ValueError("not a finite number")
            # Out-of-range targets ("1e999999999") are answered without ever
            # building the huge int, which could stall the kernel in C code.
            import numpy as np

            bounds = np.iinfo(getattr(dtype, "numpy_dtype", dtype))
            if dec > bounds.max or dec < bounds.min:
                notna = series.notna().to_numpy()
                none = notna & False
                above = dec > bounds.max
                if op in ("lt", "le"):
                    return notna if above else none
                if op in ("gt", "ge"):
                    return none if above else notna
                return notna if op == "ne" else none
            if dec == dec.to_integral_value():
                target = int(dec)
            else:
                floor = int(dec.to_integral_value(rounding=decimal.ROUND_FLOOR))
                if op == "eq":
                    return series.notna().to_numpy() & False
                if op == "ne":
                    return series.notna().to_numpy()
                # x < 2.5  <=>  x <= 2 ;  x > 2.5  <=>  x >= 3
                op, target = {"lt": ("le", floor), "le": ("le", floor),
                              "gt": ("ge", floor + 1), "ge": ("ge", floor + 1)}[op]
        elif pt.is_numeric_dtype(dtype):
            target = float(value)
        elif pt.is_datetime64_any_dtype(dtype):
            target = pd.Timestamp(str(value))
            if getattr(dtype, "tz", None) is not None and target.tzinfo is None:
                target = target.tz_localize(dtype.tz)
        else:
            target = str(value)
    except (TypeError, ValueError, ArithmeticError) as exc:
        raise BadRequest(f"cannot compare column ({dtype}) with {value!r}: {exc}") from None
    ops = {"eq": "__eq__", "ne": "__ne__", "lt": "__lt__", "le": "__le__", "gt": "__gt__", "ge": "__ge__"}
    try:
        if isinstance(target, str):
            # Compare as text so object/category columns with mixed values do not raise.
            series = series.astype("string")
        result = getattr(series, ops[op])(target)
        return result.fillna(False).to_numpy(dtype=bool)
    except BadRequest:
        raise
    except TypeError as exc:
        raise BadRequest(f"filter not supported for this column: {exc}") from None


class PageCache:
    """Positions after sort/filter, valid for a single execution count."""

    def __init__(self) -> None:
        self._key: tuple[Any, ...] | None = None
        self._positions: Any = None

    def clear(self) -> None:
        self._key = None
        self._positions = None

    def positions(self, key: tuple[Any, ...], compute: Any) -> Any:
        if self._key != key:
            self._positions = compute()
            self._key = key
        return self._positions


def page(value: Any, offset: int, limit: int, col_offset: int, col_limit: int,
         sort: dict[str, Any] | None, flt: dict[str, Any] | None,
         cache: PageCache, cache_key: tuple[Any, ...]) -> dict[str, Any]:
    import numpy as np

    df = _frame(value)
    nrows, ncols = df.shape
    if offset < 0 or limit < 1 or limit > MAX_PAGE_ROWS:
        raise BadRequest(f"limit must be 1..{MAX_PAGE_ROWS} and offset >= 0")
    if col_offset < 0 or col_limit < 1 or col_limit > MAX_PAGE_COLS:
        raise BadRequest(f"column window must be 1..{MAX_PAGE_COLS}")

    positions = None
    if sort or flt:
        if flt is not None:
            _check_col(df, flt.get("column"))
            if flt.get("op") not in FILTER_OPS:
                raise BadRequest("unknown filter op")
        if sort is not None:
            _check_col(df, sort.get("column"))

        def compute() -> Any:
            pos = np.arange(nrows)
            if flt is not None:
                mask = _filter_mask(df.iloc[:, flt["column"]], flt["op"], flt.get("value"))
                pos = np.flatnonzero(mask)
            if sort is not None:
                col = df.iloc[:, sort["column"]]
                sub = col.iloc[pos].reset_index(drop=True)
                try:
                    order = sub.sort_values(ascending=bool(sort.get("ascending", True)),
                                            na_position="last", kind="stable").index.to_numpy()
                except TypeError as exc:
                    raise BadRequest(f"column cannot be sorted (mixed types): {exc}") from None
                pos = pos[order]
            return pos

        key = (cache_key, repr(sort), repr(flt))
        positions = cache.positions(key, compute)
        total = int(len(positions))
        sel = positions[offset:offset + limit]
        window = df.iloc[sel, col_offset:col_offset + col_limit]
        row_positions = sel.tolist()
    else:
        total = nrows
        window = df.iloc[offset:offset + limit, col_offset:col_offset + col_limit]
        row_positions = list(range(offset, min(offset + limit, nrows)))

    columns_data = []
    for j in range(window.shape[1]):
        col = window.iloc[:, j]
        columns_data.append([encode_scalar(v, 300) for v in col.tolist()])
    rows = [list(r) for r in zip(*columns_data)] if columns_data else [[] for _ in row_positions]
    index = [encode_scalar(v, 100) if not isinstance(v, tuple) else encode_label(v)
             for v in window.index.tolist()]
    return {
        "offset": offset,
        "total": total,
        "rows": rows,
        "index": index,
        "positions": row_positions,
        "colOffset": col_offset,
        "columns": [encode_label(c) for c in window.columns],
        "fullData": bool(sort or flt),
    }


def summary(value: Any) -> dict[str, Any]:
    """Null counts and numeric statistics for every column (full scan)."""
    import pandas.api.types as pt

    df = _frame(value)
    n = df.shape[0]
    nulls = df.isna().sum()
    cols = []
    for i, label in enumerate(df.columns[:MAX_META_COLS]):
        col = df.iloc[:, i]
        nn = int(nulls.iloc[i])
        item: dict[str, Any] = {"index": i, "name": encode_label(label), "nulls": nn,
                                "nullPct": (nn / n * 100.0) if n else 0.0}
        if pt.is_numeric_dtype(col.dtype) and not pt.is_bool_dtype(col.dtype):
            d = col.describe()
            item["stats"] = {k: encode_scalar(d.get(k)) for k in
                             ("mean", "std", "min", "25%", "50%", "75%", "max")}
        elif pt.is_datetime64_any_dtype(col.dtype):
            item["stats"] = {"min": encode_scalar(col.min()), "max": encode_scalar(col.max())}
        cols.append(item)
    return {"rows": int(n), "columns": cols}


def column_detail(value: Any, column: int, top: int = 10) -> dict[str, Any]:
    """Selected-column inspection: counts, uniques, top values (full scan)."""
    df = _frame(value)
    _check_col(df, column)
    col = df.iloc[:, column]
    vc = col.value_counts(dropna=True)
    return {
        "index": column,
        "name": encode_label(df.columns[column]),
        "dtype": str(col.dtype),
        "count": int(col.count()),
        "nulls": int(col.isna().sum()),
        "unique": int(len(vc)),
        "top": [[encode_scalar(k, 120), int(v)] for k, v in vc.head(top).items()],
    }
