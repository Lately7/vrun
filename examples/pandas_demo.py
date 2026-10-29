# vrun — pandas workflow demo.
# Run the first cell once (Ctrl+Alt+C). The DataFrame stays in the kernel;
# the following cells reuse it without reloading anything.

# %% Load once (replace with pd.read_excel("Online Retail.xlsx") for the real dataset)
import numpy as np
import pandas as pd

rng = np.random.default_rng(0)
n = 541_909
df = pd.DataFrame({
    "InvoiceNo": rng.integers(536365, 581587, n),
    "StockCode": rng.choice(["85123A", "71053", "84406B", "22423"], n),
    "Description": np.where(rng.random(n) < 0.003, None, "WHITE HANGING HEART T-LIGHT HOLDER"),
    "Quantity": rng.integers(-10, 50, n),
    "InvoiceDate": pd.date_range("2010-12-01 08:26", periods=n, freq="min"),
    "UnitPrice": np.round(rng.random(n) * 10, 2),
    "CustomerID": np.where(rng.random(n) < 0.25, np.nan, rng.integers(12346, 18287, n).astype(float)),
    "Country": pd.Categorical(rng.choice(["United Kingdom", "France", "Germany", "EIRE"], n)),
})

# %% [live] Cheap expressions — re-run automatically in Live Mode
missing = df.isna().sum()
clean = df.dropna(subset=["CustomerID"])
average_quantity = clean["Quantity"].mean()
df["Quantity"].median()

# %% Model training — never re-run by Live Mode, asks before re-training
from sklearn.linear_model import LinearRegression

X = clean[["UnitPrice"]].to_numpy()[:50_000]
y = clean["Quantity"].to_numpy()[:50_000]
model = LinearRegression().fit(X, y)
model.coef_
