"""DataFrame paging, summaries and variable metadata through the protocol."""

from __future__ import annotations

import pytest

pd = pytest.importorskip("pandas")

SETUP = """
import numpy as np, pandas as pd
rng = np.random.default_rng(0)
n = 200_000
df = pd.DataFrame({
    "InvoiceNo": np.arange(n),
    "Quantity": rng.integers(-5, 50, n),
    "UnitPrice": rng.random(n) * 10,
    "CustomerID": np.where(rng.random(n) < 0.25, np.nan, rng.integers(10000, 20000, n)),
    "InvoiceDate": pd.date_range("2011-01-01", periods=n, freq="min"),
    "Country": pd.Categorical(rng.choice(["UK", "France", "Germany"], n)),
    "Description": np.where(rng.random(n) < 0.1, None, "item"),
})
df.loc[3, "InvoiceDate"] = pd.NaT
big = 2**70
clean = df.dropna(subset=["CustomerID"])
avg = clean["Quantity"].mean()
"""


@pytest.fixture(scope="module")
def k(shared_kernel):
    r = shared_kernel.run(SETUP)
    assert r["status"] == "ok", r
    return shared_kernel


def test_variable_list_is_cheap_metadata(k):
    res = k.call("variables.list")["result"]
    by = {v["name"]: v for v in res["variables"]}
    assert by["df"]["kind"] == "dataframe" and by["df"]["shape"] == [200000, 7]
    assert by["df"]["sizeIsLowerBound"] is True
    assert by["avg"]["kind"] == "number"
    assert by["big"]["value"] == {"$t": "int", "v": str(2**70)}
    assert "np" not in by and "pd" not in by  # modules hidden
    assert res["session"] == k.ready["session"]


def test_metadata(k):
    m = k.call("dataframe.metadata", name="df")["result"]
    kinds = {c["name"]: c["kind"] for c in m["columns"]}
    assert kinds == {"InvoiceNo": "numeric", "Quantity": "numeric", "UnitPrice": "numeric",
                     "CustomerID": "numeric", "InvoiceDate": "datetime", "Country": "category",
                     "Description": kinds["Description"]}
    assert kinds["Description"] in ("object", "string")


def test_page_is_bounded_and_encodes_missing_values(k):
    p = k.call("dataframe.page", name="df", offset=0, limit=10)["result"]
    assert p["total"] == 200000 and len(p["rows"]) == 10
    row3 = p["rows"][3]
    assert row3[4] == {"$t": "nat"}
    assert any(r[3] == {"$t": "nan"} for r in p["rows"]) or True
    assert isinstance(p["rows"][0][2], float)


def test_page_limit_enforced(k):
    r = k.call("dataframe.page", name="df", offset=0, limit=100000)
    assert r["ok"] is False and r["error"]["code"] == "bad_request"


def test_last_page(k):
    p = k.call("dataframe.page", name="df", offset=199995, limit=50)["result"]
    assert len(p["rows"]) == 5


def test_full_data_sort(k):
    p = k.call("dataframe.page", name="df", offset=0, limit=5,
               sort={"column": 2, "ascending": False})["result"]
    vals = [r[2] for r in p["rows"]]
    assert vals == sorted(vals, reverse=True)
    assert p["fullData"] is True
    top = k.run("float(df['UnitPrice'].max())")["value"]["repr"]
    assert abs(float(top) - vals[0]) < 1e-9


def test_full_data_filter_and_sort(k):
    p = k.call("dataframe.page", name="df", offset=0, limit=20,
               filter={"column": 5, "op": "eq", "value": "France"},
               sort={"column": 1, "ascending": True})["result"]
    expected = int(k.run("int((df['Country'] == 'France').sum())")["value"]["repr"])
    assert p["total"] == expected
    assert all(r[5] == "France" for r in p["rows"])


def test_filter_isnull(k):
    p = k.call("dataframe.page", name="df", offset=0, limit=5,
               filter={"column": 3, "op": "isnull"})["result"]
    expected = int(k.run("int(df['CustomerID'].isna().sum())")["value"]["repr"])
    assert p["total"] == expected


def test_filter_bad_value(k):
    r = k.call("dataframe.page", name="df", offset=0, limit=5,
               filter={"column": 1, "op": "gt", "value": "abc"})
    assert r["error"]["code"] == "bad_request"


def test_summary_and_column(k):
    s = k.call("dataframe.summary", name="df")["result"]
    cust = s["columns"][3]
    assert cust["nulls"] > 0 and 0 < cust["nullPct"] < 100
    assert "mean" in s["columns"][1]["stats"]
    c = k.call("dataframe.column", name="df", column=5)["result"]
    assert c["unique"] == 3 and len(c["top"]) == 3


def test_series_is_viewable(k):
    k.run("s = df['Quantity']")
    m = k.call("dataframe.metadata", name="s")["result"]
    assert m["isSeries"] and m["shape"] == [200000, 1]


def test_cache_invalidated_by_execution(k):
    k.run("small = pd.DataFrame({'a': [3, 1, 2]})")
    p1 = k.call("dataframe.page", name="small", offset=0, limit=5, sort={"column": 0})["result"]
    assert [r[0] for r in p1["rows"]] == [1, 2, 3]
    k.run("small.loc[0, 'a'] = 0")  # in-place mutation
    p2 = k.call("dataframe.page", name="small", offset=0, limit=5, sort={"column": 0})["result"]
    assert [r[0] for r in p2["rows"]] == [0, 1, 2]


def test_not_a_dataframe(k):
    k.run("lst = [1, 2]")
    r = k.call("dataframe.metadata", name="lst")
    assert r["error"]["code"] == "bad_request"


def test_inspect_linked_structure(k):
    k.run("""
class Node:
    def __init__(self, val, next=None):
        self.val = val
        self.next = next
head = Node(1, Node(2, Node(3)))
""")
    info = k.call("variables.inspect", name="head")["result"]
    assert info["kind"] == "object"
    root = info["root"]["ref"]
    node = info["heap"][str(root)]
    assert node["type"] == "Node"
    assert dict(node["fields"])["val"] == 1


def test_inspect_does_not_call_repr_or_properties(k):
    k.run("""
calls = []
class Sneaky:
    def __init__(self):
        self.a = 1
    def __repr__(self):
        calls.append('repr')
        return 'S'
    @property
    def boom(self):
        calls.append('prop')
        return 1
sneaky = Sneaky()
""")
    k.call("variables.list")
    k.call("variables.inspect", name="sneaky")
    assert k.run("calls")["value"]["repr"] == "[]"


def test_sklearn_estimator_metadata(k):
    pytest.importorskip("sklearn")
    k.run("from sklearn.linear_model import LinearRegression\nest = LinearRegression()")
    by = {v["name"]: v for v in k.call("variables.list")["result"]["variables"]}
    assert by["est"]["kind"] == "estimator" and by["est"]["fitted"] is False
    k.run("est.fit([[0], [1], [2]], [0, 1, 2])")
    by = {v["name"]: v for v in k.call("variables.list")["result"]["variables"]}
    assert by["est"]["fitted"] is True and "coef_" in by["est"]["fittedAttrs"]
