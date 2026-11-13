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
    # TensorFlow custom loops and optimizers (opt.step(), env.step() alike
    # change state on every call).
    "apply_gradients", "minimize", "assign_sub", "assign_add", "step",
}
# Names whose presence in a function's code means calling it trains a model
# (scanned from code objects of functions defined in earlier runs).
TRAINING_CODE_NAMES = {
    "fit", "fit_transform", "fit_predict", "partial_fit", "fit_resample",
    "train_on_batch", "fit_generator", "backward", "apply_gradients", "minimize",
}
IO_CODE_NAMES = {
    "open", "to_csv", "to_excel", "to_parquet", "to_json", "to_pickle", "to_feather",
    "savefig", "save_model", "unlink", "rmtree", "write_text", "write_bytes", "urlopen",
}
# Finding categories that may run in Live Mode; "input" only with a .in file.
LIVE_OK = ("load", "import")
LIVE_OK_WITH_INPUT = ("load", "import", "input")
# A helper's body decides what calling it means, most severe first.
_SEVERITY = ("training", "expensive", "io", "loop", "input")
EXPENSIVE_CALLS = {
    "GridSearchCV", "RandomizedSearchCV", "HalvingGridSearchCV",
    "HalvingRandomSearchCV", "cross_val_score", "cross_validate",
    "cross_val_predict", "learning_curve", "validation_curve",
    "permutation_importance", "train_test_split_and_fit",
    "_vrun_timeit",  # %timeit: repeats the statement for ~2 s
}
IO_METHOD_PREFIXES = ("to_",)
IO_METHODS = {"savefig", "save", "save_model", "load_model", "download", "urlopen"}
IO_FUNCTIONS = {"open", "breakpoint", "exec", "eval", "compile", "__import__"}
SIDE_EFFECT_MODULES = {
    "requests", "urllib", "httpx", "socket", "subprocess", "shutil", "pickle",
    "joblib", "webbrowser", "smtplib", "ftplib", "sqlite3", "multiprocessing",
}
OS_SIDE_EFFECTS = {
    "system", "remove", "unlink", "rmdir", "removedirs", "rename", "replace",
    "makedirs", "mkdir", "popen", "startfile", "kill",
}
HEAVY_IMPORTS = {"torch", "tensorflow", "keras", "jax", "transformers"}
# Fitting these is a cheap, deterministic transform of the data, not model
# training: Live Mode may redo `StandardScaler().fit_transform(X)` and a
# re-run needs no confirmation. Recognised by constructor name, for a chained
# call or a variable bound to the constructor in the same code.
CHEAP_PREPROCESSORS = {
    "StandardScaler", "MinMaxScaler", "MaxAbsScaler", "RobustScaler", "Normalizer",
    "Binarizer", "LabelEncoder", "LabelBinarizer", "OneHotEncoder", "OrdinalEncoder",
    "SimpleImputer", "PolynomialFeatures", "FunctionTransformer", "KBinsDiscretizer",
}
CHEAP_FIT_METHODS = {"fit", "fit_transform", "transform"}
# pathlib.Path(...).unlink() / .write_text(): file system changes by method.
PATH_SIDE_EFFECTS = {"unlink", "rmdir", "write_text", "write_bytes", "touch", "mkdir", "rmtree", "symlink_to", "hardlink_to"}
# Pandas/NumPy "to_*" methods that only convert in memory are harmless.
PURE_TO_METHODS = {
    "to_numpy", "to_list", "to_dict", "to_frame", "to_string", "to_period",
    "to_timestamp", "to_records", "to_datetime", "to_numeric", "to_timedelta",
    "to_series", "to_flat_index", "to_pydatetime", "to_markdown",
}


@dataclass
class Finding:
    line: int
    category: str  # "load" | "input" | "training" | "expensive" | "io" | "loop" | "import" | "marker"
    message: str


@dataclass
class StatementAnalysis:
    line: int
    end_line: int
    findings: list[Finding]

    @property
    def is_load(self) -> bool:
        return bool(self.findings) and all(f.category == "load" for f in self.findings)


def _call_name(func: ast.expr) -> tuple[str | None, str | None]:
    """Return (base, attr) for ``base.attr(...)`` or (None, name) for ``name(...)``.

    For a chained receiver, ``RandomForestClassifier(...).fit(...)``, base is
    the inner call's name; for any other receiver (``models["rf"].fit``) it is
    "<expr>". Either way it is a method call: missing it let chained training
    re-run on every keystroke in Live Mode.
    """
    if isinstance(func, ast.Name):
        return None, func.id
    if isinstance(func, ast.Attribute):
        base = func.value
        base_name: str | None
        if isinstance(base, ast.Name):
            base_name = base.id
        elif isinstance(base, ast.Attribute):
            base_name = base.attr
        elif isinstance(base, ast.Call):
            base_name = _call_name(base.func)[1] or "<expr>"
        else:
            base_name = "<expr>"
        return base_name, func.attr
    return None, None


def _risk_of(found: list[Finding]) -> tuple[str, str] | None:
    """What calling a helper with these body findings does, most severe first."""
    for category in _SEVERITY:
        hit = next((f for f in found if f.category == category), None)
        if hit is not None:
            return category, f"inside, {hit.message} (line {hit.line})"
    return None


def _ref_key(expr: ast.expr) -> str | None:
    """``train`` or ``trainer.run`` for a function passed as a value."""
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
        return f"{expr.value.id}.{expr.attr}"
    return None


class _Visitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.findings: list[Finding] = []
        self.imported_side_effect: set[str] = set()
        # Variables bound to a cheap preprocessor constructor in this code.
        self.cheap_objects: set[str] = set()
        # Functions, classes ("Trainer" when its __init__ trains),
        # "Class.method" and "obj.method" whose call trains or writes:
        # name -> (category, message). Filled from definitions in this code
        # and, by the kernel, from functions and classes defined earlier.
        self.risky_calls: dict[str, tuple[str, str]] = {}
        # Variables known (by the kernel) to hold a torch.nn.Module, whose
        # no-argument .train() only switches dropout / batch norm on.
        self.torch_modules: set[str] = set()

    def _visit_body(self, body: list[ast.stmt],
                    extra: dict[str, tuple[str, str]] | None = None) -> list[Finding]:
        """Findings of a function body, without reporting them here."""
        sub = _Visitor()
        sub.imported_side_effect = set(self.imported_side_effect)
        sub.cheap_objects = set(self.cheap_objects)
        sub.risky_calls = dict(self.risky_calls)
        sub.risky_calls.update(extra or {})
        sub.torch_modules = set(self.torch_modules)
        for stmt in body:
            sub.visit(stmt)
        return sub.findings

    def _define(self, name: str, body: list[ast.stmt], line: int) -> None:
        # Defining a helper is cheap and safe; *calling* it is what trains.
        # (Reporting the body blocked the definition and let every call run.)
        risk = _risk_of(self._visit_body(body))
        if risk is None:
            self.risky_calls.pop(name, None)
        else:
            self.risky_calls[name] = risk

    def _forget_members(self, name: str) -> None:
        prefix = name + "."
        for key in [k for k in self.risky_calls if k.startswith(prefix)]:
            del self.risky_calls[key]

    def _copy_members(self, source: str, target: str) -> None:
        prefix = source + "."
        for key, risk in list(self.risky_calls.items()):
            if key.startswith(prefix):
                self.risky_calls[target + "." + key[len(prefix):]] = risk

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        for d in node.decorator_list:
            self.visit(d)
        for default in node.args.defaults + node.args.kw_defaults:
            if default is not None:
                self.visit(default)
        self._define(node.name, node.body, node.lineno)

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        # The class body runs at definition time; its methods run when
        # called. They are recorded as "Class.method" so `Loop().run()` and,
        # after `t = Loop()`, `t.run()` or `map(t.run, folds)` count as
        # training (dropping them let class-based training loops run live).
        for d in node.decorator_list:
            self.visit(d)
        for b in node.bases:
            self.visit(b)
        for k in node.keywords:
            self.visit(k.value)
        name = node.name
        self._forget_members(name)
        for b in node.bases:
            if isinstance(b, ast.Name):
                self._copy_members(b.id, name)  # inherited methods
        methods = [s for s in node.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for stmt in node.body:
            if stmt in methods:
                for d in stmt.decorator_list:
                    self.visit(d)
                self.risky_calls.pop(f"{name}.{stmt.name}", None)  # overrides
            else:
                self.visit(stmt)
        # A method that calls a risky self.helper() is risky too: repeat
        # until the set stops growing.
        done: set[str] = set()
        for _ in range(len(methods) + 1):
            via_self = {f"self.{k[len(name) + 1:]}": v for k, v in self.risky_calls.items()
                        if k.startswith(name + ".")}
            grew = False
            for m in methods:
                if m.name in done:
                    continue
                risk = _risk_of(self._visit_body(m.body, via_self))
                if risk is not None:
                    self.risky_calls[f"{name}.{m.name}"] = risk
                    done.add(m.name)
                    grew = True
            if not grew:
                break
        init = self.risky_calls.get(f"{name}.__init__")
        if init is not None:
            self.risky_calls[name] = init  # constructing it trains
        else:
            self.risky_calls.pop(name, None)

    def visit_Assign(self, node: ast.Assign) -> None:
        ctor = node.value.func if isinstance(node.value, ast.Call) else None
        cheap = ctor is not None and _call_name(ctor)[1] in CHEAP_PREPROCESSORS
        for target in node.targets:
            if isinstance(target, ast.Name):
                if cheap:
                    self.cheap_objects.add(target.id)
                else:
                    self.cheap_objects.discard(target.id)
                self.torch_modules.discard(target.id)
                # Earlier "t.run" entries stay: `t = make_trainer()` may
                # return the same kind of object, and a stale entry only
                # stops Live too early.
                if isinstance(ctor, ast.Name):
                    self._copy_members(ctor.id, target.id)  # t = Trainer()
        self.generic_visit(node)

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
        risky = None
        if name:
            risky = self.risky_calls.get(name if base is None else f"{base}.{name}")
        if name:
            if risky is not None:
                category, message = risky
                shown = name if base is None else f"{base}.{name}"
                self._add(node, category, f"'{shown}()': {message}")
            elif name in CHEAP_FIT_METHODS and base is not None and (
                    base in CHEAP_PREPROCESSORS or base in self.cheap_objects):
                pass  # scaling / encoding: cheap and repeatable
            elif name == "train" and base in self.torch_modules and not node.args and not node.keywords:
                # torch model.train() switches dropout / batch norm on and
                # trains nothing; any other .train() (Hugging Face Trainer,
                # xgb) is training.
                pass
            elif name in TRAINING_METHODS and base is not None:
                self._add(node, "training", f"'.{name}()' trains or updates a model")
            elif base == "__import__" and name == "writefile":
                self._add(node, "io", "'%%writefile' writes a file")  # magics.rewrite output
            elif name in EXPENSIVE_CALLS:
                self._add(node, "expensive", f"'{name}()' runs repeated model fitting")
            elif (name == "input" and base is None) or (base == "stdin" and name in ("read", "readline", "readlines")):
                # Reads the program input (<script>.in): repeatable and cheap,
                # so Live Mode may re-run it when that input is provided.
                self._add(node, "input", f"'{name}()' reads program input")
            elif name in IO_FUNCTIONS and base is None:
                self._add(node, "io", f"'{name}()' performs I/O or dynamic execution")
            elif name == "read_clipboard":
                self._add(node, "io", "'read_clipboard()' reads from the system clipboard")
            elif base in ("np", "numpy") and name in ("load", "loadtxt", "genfromtxt", "fromfile"):
                self._add(node, "load", f"'{base}.{name}()' loads external data")
            elif base in SIDE_EFFECT_MODULES or base in self.imported_side_effect:
                self._add(node, "io", f"'{base}.{name}()' has external side effects")
            elif base is None and name in self.imported_side_effect:
                self._add(node, "io", f"'{name}()' has external side effects")
            elif base == "os" and name in OS_SIDE_EFFECTS:
                self._add(node, "io", f"'os.{name}()' changes the system")
            elif base is not None and name in PATH_SIDE_EFFECTS:
                self._add(node, "io", f"'.{name}()' changes files")
            elif name.startswith("read_"):
                self._add(node, "load", f"'{name}()' loads external data")
            elif base is not None and (
                name in IO_METHODS
                or (name.startswith(IO_METHOD_PREFIXES) and name not in PURE_TO_METHODS)
            ):
                self._add(node, "io", f"'.{name}()' reads or writes external data")
            elif base == "time" and name == "sleep":
                self._add(node, "expensive", "'time.sleep()' blocks execution")
        # A risky helper passed as a value is called by the callee:
        # map(train_fold, folds), Thread(target=train), pool.map(t.run, xs).
        for arg in [*node.args, *(k.value for k in node.keywords)]:
            key = _ref_key(arg)
            if key is not None and key in self.risky_calls:
                category, message = self.risky_calls[key]
                self._add(node, category, f"'{key}' is called by '{name or 'a call'}()': {message}")
        self.generic_visit(node)


def code_names(code: object) -> set[str]:
    """co_names of a code object and the functions / comprehensions nested in
    it: the globals and attributes it uses (``.backward``, ``.fit``)."""
    names: set[str] = set()
    stack = [(code, 0)]
    while stack:
        c, depth = stack.pop()
        names.update(n for n in getattr(c, "co_names", ()) if type(n) is str)
        if depth < 6:
            for k in getattr(c, "co_consts", ()):
                if type(k) is type(code):
                    stack.append((k, depth + 1))
    return names


def code_risk(code: object, _depth: int = 0) -> tuple[str, str] | None:
    """What calling a function with this code object does, from its names.

    Only the code object is read; nothing is called.
    """
    names = code_names(code)
    hit = sorted(names & TRAINING_CODE_NAMES)
    # Names cannot tell which object .fit belongs to, so only a helper whose
    # one training name is fit_transform next to a scaler counts as cheap;
    # `scaler.fit_transform(X); model.fit(X, y)` is training.
    if hit and not (hit == ["fit_transform"] and names & CHEAP_PREPROCESSORS):
        return "training", f"inside, '.{hit[0]}()' trains a model (defined in an earlier run)"
    hit = sorted(names & EXPENSIVE_CALLS)
    if hit:
        return "expensive", f"inside, '{hit[0]}()' fits many models (defined in an earlier run)"
    hit = sorted(names & IO_CODE_NAMES)
    if hit:
        return "io", f"inside, '{hit[0]}' reads or writes files (defined in an earlier run)"
    if "input" in names:
        return "input", "inside, 'input()' reads program input"
    return None


def analyze_tree(tree: ast.AST) -> list[Finding]:
    v = _Visitor()
    v.visit(tree)
    return v.findings


def analyze_statements(tree: ast.Module, cheap_objects: frozenset[str] = frozenset(),
                       risky_calls: dict[str, tuple[str, str]] | None = None,
                       torch_modules: frozenset[str] = frozenset()) -> list[StatementAnalysis]:
    """Analyze each top-level statement while retaining import-alias context."""
    visitor = _Visitor()
    visitor.cheap_objects.update(cheap_objects)
    visitor.risky_calls.update(risky_calls or {})
    visitor.torch_modules.update(torch_modules)
    result: list[StatementAnalysis] = []
    for statement in tree.body:
        start = len(visitor.findings)
        visitor.visit(statement)
        result.append(StatementAnalysis(
            line=statement.lineno,
            end_line=getattr(statement, "end_lineno", statement.lineno) or statement.lineno,
            findings=visitor.findings[start:],
        ))
    return result


def analyze_source(code: str, cheap_objects: frozenset[str] = frozenset(),
                   risky_calls: dict[str, tuple[str, str]] | None = None,
                   torch_modules: frozenset[str] = frozenset()) -> dict[str, object]:
    """cheap_objects: variables that already hold a cheap preprocessor
    (``scaler = StandardScaler()`` in an earlier cell). risky_calls: functions
    and classes defined earlier whose call trains or writes (see code_risk).
    torch_modules: variables that hold a torch.nn.Module."""
    findings: list[Finding] = []
    for i, line in enumerate(code.splitlines(), start=1):
        if "pylive: manual" in line and line.lstrip().startswith("#"):
            findings.append(Finding(i, "marker", "cell is marked '# pylive: manual'"))
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {"safe": False, "liveSafe": False, "syntaxError": True, "findings": [
            asdict(Finding(exc.lineno or 0, "syntax", exc.msg))]}
    statements = analyze_statements(tree, cheap_objects, risky_calls, torch_modules)
    findings.extend(f for statement in statements for f in statement.findings)
    return {
        "safe": not findings,
        # Imports never block: the kernel bounds them on their own and a
        # second import is free.
        "liveSafe": all(f.category in LIVE_OK for f in findings),
        # Safe for Live Mode only when program input is supplied.
        "liveSafeWithInput": all(f.category in LIVE_OK_WITH_INPUT for f in findings),
        "training": any(f.category in ("training", "expensive") for f in findings),
        "findings": [asdict(f) for f in findings[:50]],
        "statements": [
            {
                "line": statement.line,
                "endLine": statement.end_line,
                "load": statement.is_load,
                "findings": [asdict(f) for f in statement.findings],
            }
            for statement in statements
        ],
    }
