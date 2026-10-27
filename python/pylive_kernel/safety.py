"""AST heuristics that decide whether code may be re-run automatically.

These are heuristics, not guarantees: aliases, dynamic dispatch and hidden
side effects in called functions cannot be detected statically. Live runs are
additionally bounded by a time budget enforced with a real interrupt.
"""

from __future__ import annotations

import ast
from dataclasses import asdict, dataclass

TRAINING_METHODS = {
    "fit", "fit_transform", "fit_predict", "partial_fit", "fit_resample",
    "train", "train_on_batch", "fit_generator", "backward",
}
EXPENSIVE_CALLS = {
    "GridSearchCV", "RandomizedSearchCV", "HalvingGridSearchCV",
    "HalvingRandomSearchCV", "cross_val_score", "cross_validate",
    "cross_val_predict", "learning_curve", "validation_curve",
    "permutation_importance", "train_test_split_and_fit",
}
IO_METHOD_PREFIXES = ("read_", "to_")
IO_METHODS = {"savefig", "save", "save_model", "load_model", "download", "urlopen"}
IO_FUNCTIONS = {"open", "input", "breakpoint", "exec", "eval", "compile", "__import__"}
SIDE_EFFECT_MODULES = {
    "requests", "urllib", "httpx", "socket", "subprocess", "shutil", "pickle",
    "joblib", "webbrowser", "smtplib", "ftplib", "sqlite3", "multiprocessing",
}
OS_SIDE_EFFECTS = {
    "system", "remove", "unlink", "rmdir", "removedirs", "rename", "replace",
    "makedirs", "mkdir", "popen", "startfile", "kill",
}
HEAVY_IMPORTS = {"torch", "tensorflow", "keras", "jax", "transformers"}
# Pandas/NumPy "to_*" methods that only convert in memory are harmless.
PURE_TO_METHODS = {
    "to_numpy", "to_list", "to_dict", "to_frame", "to_string", "to_period",
    "to_timestamp", "to_records", "to_datetime", "to_numeric", "to_timedelta",
    "to_series", "to_flat_index", "to_pydatetime", "to_markdown",
}


@dataclass
class Finding:
    line: int
    category: str  # "training" | "expensive" | "io" | "loop" | "import" | "marker"
    message: str


def _call_name(func: ast.expr) -> tuple[str | None, str | None]:
    """Return (base, attr) for ``base.attr(...)`` or (None, name) for ``name(...)``."""
    if isinstance(func, ast.Name):
        return None, func.id
    if isinstance(func, ast.Attribute):
        base = func.value
        base_name = None
        if isinstance(base, ast.Name):
            base_name = base.id
        elif isinstance(base, ast.Attribute):
            base_name = base.attr
        return base_name, func.attr
    return None, None


class _Visitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.findings: list[Finding] = []
        self.imported_side_effect: set[str] = set()

    def _add(self, node: ast.AST, category: str, message: str) -> None:
        self.findings.append(Finding(getattr(node, "lineno", 0), category, message))

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root in HEAVY_IMPORTS:
                self._add(node, "import", f"imports heavy library '{root}'")
            if root in SIDE_EFFECT_MODULES:
                self.imported_side_effect.add(alias.asname or root)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        root = (node.module or "").split(".")[0]
        if root in HEAVY_IMPORTS:
            self._add(node, "import", f"imports heavy library '{root}'")
        if root in SIDE_EFFECT_MODULES:
            for alias in node.names:
                self.imported_side_effect.add(alias.asname or alias.name)
        self.generic_visit(node)

    def visit_While(self, node: ast.While) -> None:
        test = node.test
        if isinstance(test, ast.Constant) and bool(test.value):
            self._add(node, "loop", "'while True' loop may never finish")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        base, name = _call_name(node.func)
        if name:
            if name in TRAINING_METHODS and base is not None:
                self._add(node, "training", f"'.{name}()' trains or updates a model")
            elif name in EXPENSIVE_CALLS:
                self._add(node, "expensive", f"'{name}()' runs repeated model fitting")
            elif name in IO_FUNCTIONS and base is None:
                self._add(node, "io", f"'{name}()' performs I/O or dynamic execution")
            elif base is not None and (
                name in IO_METHODS
                or (name.startswith(IO_METHOD_PREFIXES) and name not in PURE_TO_METHODS)
            ):
                self._add(node, "io", f"'.{name}()' reads or writes external data")
            elif base in SIDE_EFFECT_MODULES or base in self.imported_side_effect:
                self._add(node, "io", f"'{base}.{name}()' has external side effects")
            elif base is None and name in self.imported_side_effect:
                self._add(node, "io", f"'{name}()' has external side effects")
            elif base == "os" and name in OS_SIDE_EFFECTS:
                self._add(node, "io", f"'os.{name}()' changes the system")
            elif base == "time" and name == "sleep":
                self._add(node, "expensive", "'time.sleep()' blocks execution")
        self.generic_visit(node)


def analyze_tree(tree: ast.AST) -> list[Finding]:
    v = _Visitor()
    v.visit(tree)
    return v.findings


def analyze_source(code: str) -> dict[str, object]:
    findings: list[Finding] = []
    for i, line in enumerate(code.splitlines(), start=1):
        if "pylive: manual" in line and line.lstrip().startswith("#"):
            findings.append(Finding(i, "marker", "cell is marked '# pylive: manual'"))
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {"safe": False, "syntaxError": True, "findings": [
            asdict(Finding(exc.lineno or 0, "syntax", exc.msg))]}
    findings.extend(analyze_tree(tree))
    return {
        "safe": not findings,
        "training": any(f.category in ("training", "expensive") for f in findings),
        "findings": [asdict(f) for f in findings[:50]],
    }
