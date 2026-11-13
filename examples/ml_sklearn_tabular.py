# vrun — practice: tabular classification with scikit-learn.
# Run a cell with Ctrl+Alt+C. Variables keep their values between cells, so
# each step builds on the previous one. Open the vrun panel to see them:
# the estimator rows show their hyperparameters and whether they are fitted.

# %% 1. Load the data (bundled with scikit-learn: no download)
import numpy as np
import pandas as pd
from sklearn.datasets import load_breast_cancer

SEED = 42
data = load_breast_cancer(as_frame=True)
df = data.frame                # 569 rows x 31 columns: open it in the DataFrame tab
df.head()

# %% [live] 2. Explore — Live Mode re-runs this cell as you type
target_share = df["target"].value_counts(normalize=True)
top_corr = df.corr()["target"].drop("target").abs().sort_values(ascending=False).head(8)
top_corr

# %% 3. Split and build a pipeline
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression

X = df.drop(columns="target")
y = df["target"]
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=SEED)
model = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000))

# %% 4. Train (never re-run by Live Mode)
model.fit(X_train, y_train)
model.score(X_test, y_test)

# %% 5. Evaluate
from sklearn.metrics import ConfusionMatrixDisplay, classification_report

y_pred = model.predict(X_test)
ConfusionMatrixDisplay.from_predictions(y_test, y_pred);
classification_report(y_test, y_pred, target_names=data.target_names)

# %% 6. Tune with cross-validation — try other values of C
from sklearn.model_selection import GridSearchCV

grid = GridSearchCV(model, {"logisticregression__C": np.logspace(-2, 2, 9)}, cv=5)
grid.fit(X_train, y_train)
scores = grid.cv_results_["mean_test_score"].tolist()   # "chart" in Variables plots it
grid.best_params_, grid.best_score_

# %% 7. Exercise: replace LogisticRegression with RandomForestClassifier
# and compare test accuracy. Which features matter most?
# from sklearn.ensemble import RandomForestClassifier
# forest = RandomForestClassifier(n_estimators=200, random_state=SEED).fit(X_train, y_train)
# pd.Series(forest.feature_importances_, index=X.columns).sort_values().tail(10).plot.barh();
