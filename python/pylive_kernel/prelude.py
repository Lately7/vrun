"""Definitions from the cells above a traced cell (Visualize on one cell).

A trace runs in a fresh namespace, so a cell that used a function, an import
or data from an earlier cell stopped with a bare NameError. The host sends
the text above the cell. Of it, only statements that are safe to run again
are kept: definitions, imports of the standard library or of modules
already imported (a first import of the learner's trainer.py would run
it), and assignments (or container updates and
simple ``for`` loops) whose expressions are plain values, a few pure
built-ins, pure standard-library modules, or calls of functions and classes
defined in those cells whose bodies follow the same whitelist (and pass the
Live Mode heuristics of ``safety``). Calls that could load data, train, read
input or write files never run.
Of these, only the statements the traced cell needs (directly or through
what they use) run, untraced, under their own file name, with their output
discarded and within a share of the trace's time budget.

This is no sandbox: the code is the learner's own, which Run Cell runs
anyway. The whitelist only makes sure Visualize never repeats, by accident,
the slow or outside-world work of the cells above.
"""

from __future__ import annotations

import ast
import builtins
import re
import symtable
import sys
import time
import types
from dataclasses import dataclass, field
from typing import Any

from . import magics, safety

PRELUDE_FILE = "<pylive-trace-prelude>"
# The rest of the trace keeps at least this share of its time budget.
PRELUDE_SHARE = 0.5

_CELL_MARK = re.compile(r"^\s*#\s*%%")

SAFE_BUILTINS = frozenset({
    "abs", "all", "any", "bin", "bool", "bytes", "chr", "complex", "dict", "divmod", "enumerate",
    "filter", "float", "format", "frozenset", "hash", "hex", "int", "isinstance", "issubclass", "len",
    "list", "map", "max", "min", "object", "oct", "ord", "pow", "print", "range", "repr", "reversed",
    "round", "set", "slice", "sorted", "str", "sum", "tuple", "type", "zip",
    "property", "staticmethod", "classmethod", "super", "iter", "next", "callable", "id", "hasattr",
    "ascii", "bytearray",
})
_BUILTIN_NAMES = frozenset(dir(builtins))
# raise ValueError(...) in a helper, class MyError(Exception).
_BUILTIN_EXCEPTIONS = frozenset(
    n for n in _BUILTIN_NAMES
    if isinstance(getattr(builtins, n), type) and issubclass(getattr(builtins, n), BaseException))
_BUILTIN_CONSTANTS = frozenset({"None", "True", "False", "Ellipsis", "NotImplemented", "__name__", "__doc__",
                                "__debug__"})
# Attributes that reach the interpreter's internals (f.__globals__, frames).
_INTROSPECTION = frozenset({
    "__globals__", "__builtins__", "__subclasses__", "__code__", "__closure__", "__self__", "__func__",
    "__import__", "__loader__", "__spec__", "__traceback__", "f_globals", "f_builtins", "f_locals",
    "f_back", "tb_frame", "gi_frame", "cr_frame", "ag_frame",
})
# Standard-library modules whose functions only compute or build containers.
SAFE_MODULES = frozenset({
    "collections", "heapq", "math", "cmath", "bisect", "itertools", "functools", "operator", "string",
    "random", "statistics", "fractions", "decimal", "copy", "dataclasses", "typing", "enum", "array",
    "re", "numbers", "abc",
})
# sys is imported for these in DSA setup cells; nothing else of it is called.
SAFE_MODULE_CALLS = frozenset({"sys.setrecursionlimit", "sys.getrecursionlimit"})
# Values (not calls) of other modules that setup cells use: INF = sys.maxsize,
# input = sys.stdin.readline (the trace's stdin is the program input).
SAFE_MODULE_VALUES = frozenset({"sys.maxsize", "sys.float_info", "sys.version_info", "sys.stdin.readline"})
SAFE_METHODS = frozenset({
    "append", "appendleft", "extend", "extendleft", "insert", "add", "update", "setdefault", "pop",
    "popleft", "popitem", "remove", "discard", "clear", "copy", "get", "items", "keys", "values",
    "index", "count", "sort", "reverse", "split", "rsplit", "splitlines", "join", "strip", "lstrip",
    "rstrip", "lower", "upper", "title", "capitalize", "replace", "startswith", "endswith", "find",
    "rfind", "format", "isdigit", "isalpha", "isalnum", "isspace", "zfill", "center", "ljust",
    "rjust", "union", "intersection", "difference", "symmetric_difference", "issubset",
    "issuperset", "most_common", "elements", "subtract", "fromkeys", "bit_length", "rotate",
    "isupper", "islower", "isnumeric", "isdecimal", "isascii", "istitle", "swapcase", "casefold",
    "partition", "rpartition", "removeprefix", "removesuffix", "rindex", "expandtabs", "encode",
    "decode", "translate", "maketrans", "format_map", "isdisjoint", "intersection_update",
    "difference_update", "symmetric_difference_update", "move_to_end", "total", "bit_count",
    "is_integer", "as_integer_ratio", "conjugate", "limit_denominator", "match", "fullmatch",
    "search", "findall", "finditer", "sub", "randint", "random", "randrange", "choice", "choices",
    "shuffle", "sample", "uniform", "gauss", "seed",
    "__init__",  # super().__init__(...), Base.__init__(self)
    "setter", "getter", "deleter",  # @area.setter
})


@dataclass
class _Stmt:
    node: ast.stmt
    line: int
    text: str  # first line, for notes
    stores: set[str] = field(default_factory=set)  # names (re)bound
    roots: set[str] = field(default_factory=set)  # names whose objects it changes
    args: set[str] = field(default_factory=set)  # names passed to a call (it may change them)
    reads: set[str] = field(default_factory=set)  # names it needs from before
    star: bool = False  # from m import *
    unsafe: str | None = None  # why it is never run
    # The budget (seconds) it did not finish in, kept with the analysis of
    # the same text above: Live Mode traces on every edit of the cell below,
    # and a slow setup call would take its share of the budget each time.
    too_slow: float = 0.0


@dataclass
class Result:
    notes: list[str] = field(default_factory=list)
    ran: int = 0
    seconds: float = 0.0
    # What ran (the helpers' code lives in these): the trace keeps the
    # cell's calls of them within its limits (tracer._Stopper).
    codes: list[types.CodeType] = field(default_factory=list)


class _Timeout(BaseException):
    """The cells above used up their share of the time budget."""


# -- what the traced code needs ---------------------------------------------

def _global_reads(table: symtable.SymbolTable) -> set[str]:
    """Globals read by the functions and classes nested in a scope."""
    out: set[str] = set()
    for child in table.get_children():
        for sym in child.get_symbols():
            if sym.is_global() and sym.is_referenced():
                out.add(sym.get_name())
        out |= _global_reads(child)
    return out


def _target_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}


class _Flow:
    """Names module-level code reads before it binds them itself, in the
    order it runs.

    `head = reverse(head)`, `nums = sorted(nums)` and `print(nums); nums = []`
    read the name from above although the cell binds it later; the
    insertion sort's `j = i - 1 ... j -= 1` does not. A name bound inside
    if / for / while / try counts as bound after it only when every way
    through binds it. Function and lambda bodies run later (free_names).
    """

    def __init__(self) -> None:
        self.needed: set[str] = set()

    def block(self, body: list[ast.stmt], bound: set[str]) -> set[str]:
        """Walks body with bound (updated in place) and returns it."""
        for st in body:
            self.stmt(st, bound)
        return bound

    def read(self, name: str, bound: set[str]) -> None:
        if name not in bound:
            self.needed.add(name)

    def target(self, t: ast.expr, bound: set[str]) -> None:
        if isinstance(t, ast.Name):
            bound.add(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                self.target(e, bound)
        elif isinstance(t, ast.Starred):
            self.target(t.value, bound)
        else:
            self.expr(t, bound)  # a[i] = v, node.next = v: reads a, i, node

    def arguments(self, a: ast.arguments, bound: set[str]) -> None:
        for d in [*a.defaults, *a.kw_defaults]:
            self.expr(d, bound)
        for arg in [*a.posonlyargs, *a.args, *a.kwonlyargs, a.vararg, a.kwarg]:
            if arg is not None:
                self.expr(arg.annotation, bound)  # evaluated at the def

    def expr(self, node: ast.AST | None, bound: set[str], local: frozenset[str] = frozenset()) -> None:
        """Reads of node, in evaluation order; local: comprehension names."""
        if node is None:
            return
        if isinstance(node, ast.Name):
            if not isinstance(node.ctx, ast.Store) and node.id not in local:
                self.read(node.id, bound)
            return
        if isinstance(node, ast.Lambda):
            self.arguments(node.args, bound)
            return
        if isinstance(node, ast.GeneratorExp):
            self.expr(node.generators[0].iter, bound, local)  # the rest runs when consumed
            return
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp)):
            inner = set(local)
            for i, g in enumerate(node.generators):
                self.expr(g.iter, bound, frozenset(inner) if i else local)
                inner |= _target_names(g.target)
                for cond in g.ifs:
                    self.expr(cond, bound, frozenset(inner))
            parts = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
            for p in parts:
                self.expr(p, bound, frozenset(inner))
            return
        if isinstance(node, ast.NamedExpr):
            self.expr(node.value, bound, local)
            if not local:  # (inside a comprehension it may never run)
                bound.add(node.target.id)
            return
        if isinstance(node, ast.BoolOp):
            self.expr(node.values[0], bound, local)
            for v in node.values[1:]:
                self.expr(v, set(bound), local)  # may not run: binds nothing after it
            return
        if isinstance(node, ast.IfExp):
            self.expr(node.test, bound, local)
            self.expr(node.body, set(bound), local)
            self.expr(node.orelse, set(bound), local)
            return
        for child in ast.iter_child_nodes(node):
            self.expr(child, bound, local)

    def _pattern(self, pattern: ast.AST, bound: set[str]) -> set[str]:
        captured = set()
        for p in ast.walk(pattern):
            if isinstance(p, ast.MatchValue):
                self.expr(p.value, bound)
            elif isinstance(p, ast.MatchClass):
                self.expr(p.cls, bound)
            elif isinstance(p, (ast.MatchAs, ast.MatchStar)) and p.name:
                captured.add(p.name)
            elif isinstance(p, ast.MatchMapping) and p.rest:
                captured.add(p.rest)
        return captured

    def stmt(self, st: ast.stmt, bound: set[str]) -> None:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in st.decorator_list:
                self.expr(d, bound)
            self.arguments(st.args, bound)
            self.expr(st.returns, bound)
            bound.add(st.name)
        elif isinstance(st, ast.ClassDef):
            for e in [*st.decorator_list, *st.bases, *(k.value for k in st.keywords)]:
                self.expr(e, bound)
            self.block(st.body, set(bound))  # the class body's names stay in the class
            bound.add(st.name)
        elif isinstance(st, ast.Import):
            bound.update(a.asname or a.name.split(".")[0] for a in st.names)
        elif isinstance(st, ast.ImportFrom):
            bound.update(a.asname or a.name for a in st.names if a.name != "*")
        elif isinstance(st, ast.Assign):
            self.expr(st.value, bound)
            for t in st.targets:
                self.target(t, bound)
        elif isinstance(st, ast.AugAssign):
            if isinstance(st.target, ast.Name):
                self.read(st.target.id, bound)  # total += 1 reads total
            self.expr(st.value, bound)
            self.target(st.target, bound)
        elif isinstance(st, ast.AnnAssign):
            self.expr(st.annotation, bound)
            if st.value is not None:
                self.expr(st.value, bound)
                self.target(st.target, bound)
        elif isinstance(st, (ast.For, ast.AsyncFor)):
            self.expr(st.iter, bound)
            inner = set(bound)
            self.target(st.target, inner)
            self.block(st.body, inner)
            self.block(st.orelse, set(bound))  # the loop may not have run
        elif isinstance(st, ast.While):
            self.expr(st.test, bound)
            self.block(st.body, set(bound))
            self.block(st.orelse, set(bound))
        elif isinstance(st, ast.If):
            self.expr(st.test, bound)
            yes = self.block(st.body, set(bound))
            no = self.block(st.orelse, set(bound))
            bound |= yes & no
        elif isinstance(st, (ast.With, ast.AsyncWith)):
            for item in st.items:
                self.expr(item.context_expr, bound)
                if item.optional_vars is not None:
                    self.target(item.optional_vars, bound)
            self.block(st.body, bound)
        elif isinstance(st, (ast.Try, ast.TryStar)):
            # Every way out: the body and else, or one of the handlers.
            paths = [self.block(st.orelse, self.block(st.body, set(bound)))]
            for h in st.handlers:
                hb = set(bound)
                self.expr(h.type, hb)
                if h.name:
                    hb.add(h.name)
                paths.append(self.block(h.body, hb))
            after = set.intersection(*paths) if st.handlers else paths[0]
            bound |= self.block(st.finalbody, after | bound)
        elif isinstance(st, ast.Match):
            self.expr(st.subject, bound)
            for case in st.cases:
                cb = set(bound)
                cb |= self._pattern(case.pattern, cb)
                self.expr(case.guard, cb)
                self.block(case.body, cb)
        elif isinstance(st, ast.Delete):
            for t in st.targets:
                self.expr(t, bound)
                if isinstance(t, ast.Name):
                    bound.discard(t.id)
        else:  # expression statements, raise, assert, return, pass, global
            for child in ast.iter_child_nodes(st):
                self.expr(child, bound)


def free_names(source: str, tree: ast.Module) -> set[str]:
    """Names the code reads before binding them itself: at module level in
    the order it runs (_Flow), and in its functions, which run later, the
    globals it never binds at all."""
    table = symtable.symtable(source, "<free>", "exec")
    anywhere = {s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_imported()}
    flow = _Flow()
    flow.block(tree.body, set())
    return flow.needed | (_global_reads(table) - anywhere)


# -- the statements above ----------------------------------------------------

def _python(text: str) -> str:
    """Notebook lines (%time, %matplotlib) as Run Cell rewrites them; line
    numbers are kept. A shell command (!pip) leaves the text as it is."""
    try:
        return magics.rewrite(text)[0]
    except magics.MagicError:
        return text


def _parse(prelude: str, notes: list[str]) -> list[ast.stmt]:
    try:
        return ast.parse(_python(prelude), PRELUDE_FILE).body
    except SyntaxError:
        pass
    # A cell above that does not parse (it is being edited) must not hide
    # the others: parse cell by cell, keeping file line numbers.
    lines = prelude.splitlines(keepends=True)
    starts = [0] + [i for i, ln in enumerate(lines) if _CELL_MARK.match(ln) and i > 0]
    body: list[ast.stmt] = []
    for a, b in zip(starts, starts[1:] + [len(lines)]):
        chunk = "\n" * a + "".join(lines[a:b])
        try:
            body.extend(ast.parse(_python(chunk), PRELUDE_FILE).body)
        except SyntaxError as exc:
            notes.append(f"the cell at line {a + 1} above has a syntax error (line {exc.lineno}); "
                         "it was not used")
    return body


def _root(node: ast.expr) -> str | None:
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Starred)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _targets(node: ast.expr, stores: set[str], roots: set[str]) -> None:
    if isinstance(node, ast.Name):
        stores.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            _targets(e, stores, roots)
    elif isinstance(node, ast.Starred):
        _targets(node.value, stores, roots)
    else:
        r = _root(node)
        if r is not None:
            roots.add(r)


def _effects(stmt: ast.stmt, s: _Stmt) -> None:
    """Names a statement binds, and names whose objects it changes."""
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        s.stores.add(stmt.name)
    elif isinstance(stmt, ast.Import):
        for a in stmt.names:
            s.stores.add(a.asname or a.name.split(".")[0])
    elif isinstance(stmt, ast.ImportFrom):
        for a in stmt.names:
            if a.name == "*":
                s.star = True
            else:
                s.stores.add(a.asname or a.name)
    elif isinstance(stmt, ast.Assign):
        for t in stmt.targets:
            _targets(t, s.stores, s.roots)
    elif isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
        _targets(stmt.target, s.stores, s.roots)
    elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        call = stmt.value
        if isinstance(call.func, ast.Attribute):
            r = _root(call.func)  # graph.add_edge(1, 2), random.seed(1)
            if r is not None:
                s.roots.add(r)
        if not (isinstance(call.func, ast.Name) and call.func.id == "print"):
            for a in [*call.args, *(k.value for k in call.keywords)]:
                if isinstance(a, ast.Name):
                    s.args.add(a.id)  # heapq.heappush(h, x), add_edge(g, 1, 2)
    else:
        # for / while / if / with / try: what their bodies bind and change
        # (a skipped `while queue:` that fills dist must not leave the
        # initial dist looking like the result).
        if isinstance(stmt, (ast.For, ast.AsyncFor)):
            _targets(stmt.target, s.stores, s.roots)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            for item in stmt.items:
                if item.optional_vars is not None:
                    _targets(item.optional_vars, s.stores, s.roots)
        for name in ("body", "orelse", "finalbody", "handlers"):
            for sub in getattr(stmt, name, None) or []:
                if isinstance(sub, ast.ExceptHandler):
                    if sub.name:
                        s.stores.add(sub.name)
                    for sub2 in sub.body:
                        _effects(sub2, s)
                elif isinstance(sub, ast.stmt):
                    _effects(sub, s)


_Def = ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef


def _bound_in(node: ast.AST) -> set[str]:
    """Every name bound anywhere in node: targets, parameters, nested
    definitions, imports. More than Python's scopes, which only matters
    for code written to get around the check."""
    out: set[str] = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and not isinstance(n.ctx, ast.Load):
            out.add(n.id)
        elif isinstance(n, ast.arg):
            out.add(n.arg)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
        elif isinstance(n, ast.alias) and n.name != "*":
            out.add(n.asname or n.name.split(".")[0])
        elif isinstance(n, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and n.name:
            out.add(n.name)
    return out


def _which(why: str) -> str:
    """'it calls open()' as the end of 'it calls load(), which calls open()'."""
    return why[3:] if why.startswith("it ") else why


_MODULE_DICT = types.ModuleType.__dict__["__dict__"]
# Standard-library modules whose import does something (opens a browser).
_NO_IMPORT = frozenset({"antigravity"})


def _module_why(name: str) -> str | None:
    """Why `import name` may run code that has not run yet: a module that is
    not imported yet runs its top level (the learner's trainer.py writes
    files; a package may download). Standard-library modules are fine."""
    root = name.split(".")[0]
    if root in SAFE_MODULES or name in sys.modules:
        return None
    if root in sys.stdlib_module_names and root not in _NO_IMPORT and root not in safety.HEAVY_IMPORTS:
        return None
    return f"it imports {name}, which is not imported yet (run the cell above first)"


def _import_why(st: ast.Import | ast.ImportFrom) -> str | None:
    if isinstance(st, ast.Import):
        return next((w for w in (_module_why(a.name) for a in st.names) if w), None)
    module = st.module or ""
    if st.level:
        return f"it imports from {'.' * st.level}{module}"
    why = _module_why(module)
    if why or module.split(".")[0] in sys.stdlib_module_names or module.split(".")[0] in SAFE_MODULES:
        return why
    # `from mypkg import sub` imports mypkg.sub if mypkg does not have it yet.
    loaded = sys.modules.get(module)
    d = _MODULE_DICT.__get__(loaded, types.ModuleType) if type(loaded) is types.ModuleType else None
    for a in st.names:
        if a.name != "*" and (type(d) is not dict or a.name not in d) and f"{module}.{a.name}" not in sys.modules:
            return _module_why(f"{module}.{a.name}")
    return None


class _Checker:
    """Structural whitelist: which calls and statements may run again.

    Only values from the whitelist can exist while the statements above run
    (built-ins and modules that only compute, and functions and classes
    whose bodies pass this check), so a helper may call its parameters and
    the methods of what it is given.
    """

    def __init__(self, stmts: list[ast.stmt]) -> None:
        self.functions: set[str] = set()  # defined above by def / class
        self.methods: set[str] = set()  # method names of classes defined above
        self.modules: dict[str, str] = {}  # alias -> imported module
        self.from_safe: set[str] = set()  # names imported from a safe module
        self.defs: dict[str, list[_Def]] = {}  # name -> its definitions above
        self.unsafe_imports: set[str] = set()  # np, pd, os, read_csv: other modules' names
        self.bound: set[str] = set()  # names the statements above bind (they shadow built-ins)
        self.local: set[str] = set()  # names bound in the statement or function being checked
        self.local_unsafe: set[str] = set()  # other modules a function imports itself
        self.in_body = False  # checking a function body (yield, calling parameters)
        self.annotation = False  # an annotation: evaluated (maybe), never called
        for st in stmts:
            self.bound |= _bound_in(st) if not isinstance(st, _Def) else {st.name}
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.add(st.name)
                self.defs.setdefault(st.name, []).append(st)
            elif isinstance(st, ast.ClassDef):
                self.functions.add(st.name)
                self.defs.setdefault(st.name, []).append(st)
            elif isinstance(st, ast.Import):
                for a in st.names:
                    root = a.name.split(".")[0]
                    alias = a.asname or root
                    self.modules[alias] = a.name if a.asname else root
                    if root not in SAFE_MODULES:
                        self.unsafe_imports.add(alias)
            elif isinstance(st, ast.ImportFrom):
                names = {a.asname or a.name for a in st.names if a.name != "*"}
                if st.level == 0 and (st.module or "").split(".")[0] in SAFE_MODULES:
                    self.from_safe |= names
                else:
                    self.unsafe_imports |= names
        # Methods of every class, also of classes inside functions: an object
        # of a class whose methods fail the check is never made (_definition).
        for node in ast.walk(ast.Module(body=stmts, type_ignores=[])):
            if isinstance(node, ast.ClassDef):
                self.methods |= {m.name for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))}
        self.why_not: dict[str, str | None] = {name: None for name in self.defs}
        self._check_definitions()

    # -- functions and classes above ------------------------------------------
    def _check_definitions(self) -> None:
        """Which functions and classes above the statements may call: those
        whose bodies pass the same checks. Assumed fine until shown not to be,
        so recursion and helpers calling each other are fine."""
        changed = True
        while changed:
            changed = False
            for name, defs in self.defs.items():
                if self.why_not[name] is None:
                    why = next((w for w in map(self._definition, defs) if w), None)
                    if why:
                        self.why_not[name] = why
                        changed = True

    def _definition(self, d: _Def) -> str | None:
        # A decorator's wrapper is what a call runs (@memo); a base class
        # brings its methods.
        why = self._decorators(d)
        if why:
            return why
        if isinstance(d, ast.ClassDef):
            why = self._exprs([*d.bases, *(k.value for k in d.keywords)])
            if why:
                return why
            # Constructing it runs __init__; printing, sorting or comparing
            # its objects runs other methods: all of them must pass.
            for m in d.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    why = self._function(m)
                    if why:
                        return f"it has a method {m.name}() that {_which(why)}"
            return None
        return self._function(d)

    def _function(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> str | None:
        """Why calling fn may do more than compute (its decorators and
        defaults run where it is defined and are checked there)."""
        modules, from_safe, unsafe = dict(self.modules), set(self.from_safe), set()
        for node in ast.walk(fn):
            if isinstance(node, ast.Import):
                for a in node.names:
                    root = a.name.split(".")[0]
                    if _module_why(a.name):
                        return f"it imports {a.name}"  # a first import runs that module
                    alias = a.asname or root
                    modules[alias] = a.name if a.asname else root
                    if root not in SAFE_MODULES:
                        unsafe.add(alias)
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                names = {a.asname or a.name for a in node.names if a.name != "*"}
                if node.level == 0 and module.split(".")[0] in SAFE_MODULES:
                    from_safe |= names
                elif node.level or _import_why(node):
                    return f"it imports from {'.' * node.level}{module}"
                else:
                    unsafe |= names
        saved = (self.modules, self.from_safe, self.local, self.local_unsafe, self.in_body)
        self.modules, self.from_safe, self.local, self.local_unsafe, self.in_body = (
            modules, from_safe, _bound_in(fn), unsafe, True)
        try:
            return self._block(fn.body)
        finally:
            self.modules, self.from_safe, self.local, self.local_unsafe, self.in_body = saved

    def _block(self, body: list[ast.stmt]) -> str | None:
        return next((w for w in map(self._any, body) if w), None)

    def _any(self, st: ast.stmt) -> str | None:
        """A statement of a function body: any kind, with the same calls."""
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return self._decorators(st) or self.args(st.args) or self._annotate(st.returns) \
                or self._block(st.body)
        if isinstance(st, ast.ClassDef):
            return self._decorators(st) or self._exprs([*st.bases, *(k.value for k in st.keywords)]) \
                or self._block(st.body)
        if isinstance(st, ast.AnnAssign):  # a local annotation is not evaluated
            return self.expr(st.target) or self.expr(st.value)
        for child in ast.iter_child_nodes(st):
            if isinstance(child, ast.expr):
                why = self.expr(child)
            elif isinstance(child, ast.stmt):
                why = self._any(child)
            elif isinstance(child, ast.ExceptHandler):
                why = self.expr(child.type) or self._block(child.body)
            elif isinstance(child, ast.withitem):
                why = self.expr(child.context_expr) or self.expr(child.optional_vars)
            elif isinstance(child, ast.match_case):
                why = self.expr(child.guard) or self._block(child.body)
            else:
                why = None  # imports (checked with the function), match patterns
            if why:
                return why
        return None

    def _decorators(self, d: _Def) -> str | None:
        # @memo calls memo with the function; @lru_cache(None) is a call
        # whose result is called.
        return next((w for w in (self.expr(x) if isinstance(x, ast.Call) else self._call_ok(x)
                                 for x in d.decorator_list) if w), None)

    def _exprs(self, nodes: list[ast.expr]) -> str | None:
        return next((w for w in map(self.expr, nodes) if w), None)

    def _annotate(self, node: ast.expr | None) -> str | None:
        """An annotation (np.ndarray) is read, not called: only calls count."""
        saved, self.annotation = self.annotation, True
        try:
            return self.expr(node)
        finally:
            self.annotation = saved

    # -- expressions ------------------------------------------------------------
    def _name(self, n: str) -> str | None:
        """A name used as a value: map(open, files) calls open."""
        if self.annotation:
            return None
        if n == "__builtins__" or n in self.local_unsafe:
            return f"it uses {n}"
        if n in self.local:
            return None
        if n in self.unsafe_imports:
            return f"it uses {n}"
        if n in self.defs:
            why = self.why_not.get(n)
            return None if why is None else f"it uses {n}, which {_which(why)}"
        if n in self.bound or n in self.from_safe or n not in _BUILTIN_NAMES:
            return None
        if n in SAFE_BUILTINS or n in _BUILTIN_EXCEPTIONS or n in _BUILTIN_CONSTANTS:
            return None
        return f"it uses {n}"

    def _module_value(self, node: ast.Attribute) -> str | None:
        """For np.pi or sys.stdin.readline: '' when fine, why not, or None
        when node is not an attribute of a module."""
        chain = []
        root: ast.expr = node
        while isinstance(root, ast.Attribute):
            chain.append(root.attr)
            root = root.value
        if not isinstance(root, ast.Name) or root.id not in self.modules:
            return None
        module = self.modules[root.id]
        dotted = ".".join([module, *reversed(chain)])
        if (self.annotation or module.split(".")[0] in SAFE_MODULES
                or any(dotted == v or dotted.startswith(v + ".") for v in SAFE_MODULE_VALUES)):
            return ""
        return f"it uses {root.id}.{'.'.join(reversed(chain))}"

    def _call_ok(self, func: ast.expr) -> str | None:
        """None when this callee may run, else why not."""
        if isinstance(func, ast.Name):
            name = func.id
            if name in self.defs:
                why = self.why_not.get(name)
                return None if why is None else f"it calls {name}(), which {_which(why)}"
            if name in self.from_safe:
                return None
            if name in SAFE_BUILTINS and name not in self.modules:
                return None
            if name in _BUILTIN_EXCEPTIONS and name not in self.bound:
                return None  # raise ValueError("...")
            if self.in_body and name in self.local and name not in self.local_unsafe:
                return None  # a parameter or a closure (see the class docstring)
            return f"it calls {name}()"
        if isinstance(func, ast.Attribute):
            chain = []
            node: ast.expr = func
            while isinstance(node, ast.Attribute):
                chain.append(node.attr)
                node = node.value
            if isinstance(node, ast.Name) and node.id in self.modules:
                module = self.modules[node.id]
                dotted = ".".join([module, *reversed(chain)])
                if module.split(".")[0] in SAFE_MODULES or dotted in SAFE_MODULE_CALLS:
                    return None
                return f"it calls {node.id}.{'.'.join(reversed(chain))}()"
            # The receiver first: open(path, "w").write(s) is about open().
            receiver = self.expr(func.value)
            if receiver or func.attr in SAFE_METHODS or func.attr in self.methods:
                return receiver
            return f"it calls .{func.attr}()"
        return self.expr(func)

    def expr(self, node: ast.expr | None) -> str | None:
        if node is None or isinstance(node, ast.Constant):
            return None
        if isinstance(node, ast.Name):
            return self._name(node.id) if isinstance(node.ctx, ast.Load) else None
        if isinstance(node, ast.Attribute):
            if node.attr in _INTROSPECTION and not self.annotation:
                return f"it uses .{node.attr}"
            why = self._module_value(node)
            if why is not None:
                return why or None
            return self.expr(node.value)
        if isinstance(node, ast.Call):
            why = self._call_ok(node.func)
            if why:
                return why
            for a in [*node.args, *(k.value for k in node.keywords)]:
                why = self.expr(a)
                if why:
                    return why
            return None
        if isinstance(node, (ast.Await, ast.Yield, ast.YieldFrom)):
            # In a generator or coroutine body: only what it yields counts.
            return self.expr(node.value) if self.in_body else "it is not a plain value"
        if isinstance(node, ast.Lambda):
            return self.args(node.args) or self.expr(node.body)
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            parts: list[ast.expr] = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
            for g in node.generators:
                parts += [g.iter, *g.ifs]
            return next((w for w in map(self.expr, parts) if w), None)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                why = self.expr(child)
                if why:
                    return why
        return None

    def args(self, a: ast.arguments) -> str | None:
        notes = [arg.annotation for arg in [*a.posonlyargs, *a.args, *a.kwonlyargs, a.vararg, a.kwarg]
                 if arg is not None and arg.annotation is not None]
        return self._exprs([*a.defaults, *(d for d in a.kw_defaults if d is not None)]) \
            or next((w for w in map(self._annotate, notes) if w), None)

    def check(self, st: ast.stmt) -> str | None:
        """None when a top-level statement above may run again, else why not."""
        self.local = _bound_in(st)
        try:
            return self.stmt(st)
        finally:
            self.local = set()

    def stmt(self, st: ast.stmt, top: bool = True) -> str | None:
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return self._decorators(st) or self._annotate(st.returns) or self.args(st.args)
        if isinstance(st, ast.ClassDef):
            why = self._decorators(st) or self._exprs([*st.bases, *(k.value for k in st.keywords)])
            if why:
                return why
            for sub in st.body:  # the class body runs when the class is defined
                if isinstance(sub, ast.Expr) and isinstance(sub.value, ast.Constant):
                    continue
                if isinstance(sub, (ast.Pass, ast.FunctionDef, ast.AsyncFunctionDef, ast.Assign, ast.AnnAssign)):
                    why = self.stmt(sub, top=False)
                    if why:
                        return why
                else:
                    return "its class body runs other code"
            return None
        if isinstance(st, (ast.Import, ast.ImportFrom)):
            return _import_why(st)
        if isinstance(st, ast.Assign):
            return self.expr(st.value) or next((w for w in map(self.expr, st.targets) if w), None)
        if isinstance(st, ast.AnnAssign):
            return None if st.value is None else self.expr(st.value) or self.expr(st.target)
        if isinstance(st, ast.AugAssign):
            return self.expr(st.value) or self.expr(st.target)
        if isinstance(st, ast.Expr):
            return self.expr(st.value) if isinstance(st.value, ast.Call) else "it is not needed"
        if isinstance(st, ast.For) and not isinstance(st, ast.AsyncFor):
            return self.expr(st.iter) or self._body([*st.body, *st.orelse])
        if isinstance(st, ast.If) and not top:
            return self.expr(st.test) or self._body([*st.body, *st.orelse])
        if isinstance(st, (ast.Pass, ast.Break, ast.Continue)) and not top:
            return None
        return "Visualize runs only definitions, imports and plain assignments from the cells above"

    def _body(self, body: list[ast.stmt]) -> str | None:
        return next((w for w in (self.stmt(s, top=False) for s in body) if w), None)


def _analyze(stmts: list[ast.stmt], prelude: str) -> list[_Stmt]:
    checker = _Checker(stmts)
    # The Live Mode heuristics see the whole text, so a helper that trains
    # or writes files makes every call of it unsafe.
    findings = safety.analyze_statements(ast.Module(body=stmts, type_ignores=[]))
    out = []
    lines = prelude.splitlines()
    for st, found in zip(stmts, findings):
        line = st.decorator_list[0].lineno if getattr(st, "decorator_list", None) else st.lineno  # type: ignore[attr-defined]
        text = lines[line - 1].strip() if 0 < line <= len(lines) else ""
        s = _Stmt(st, line, text[:60] + ("…" if len(text) > 60 else ""))
        _effects(st, s)
        s.unsafe = checker.check(st)
        for f in found.findings:
            if f.category == "import" and isinstance(st, (ast.Import, ast.ImportFrom)) and _loaded(st):
                continue  # already imported: importing again is free
            s.unsafe = s.unsafe or f.message
        if not isinstance(st, (ast.Import, ast.ImportFrom)):
            src = ast.unparse(st)
            try:
                s.reads = free_names(src, ast.Module(body=[st], type_ignores=[]))
            except SyntaxError:  # e.g. `nonlocal` cannot stand alone
                s.reads = set()
        out.append(s)
    return out


_last: tuple[Any, list[str], list[_Stmt]] | None = None


def _analyzed(prelude: str, notes: list[str]) -> list[_Stmt]:
    """_analyze of the cells above, kept for the next trace: Live Mode traces
    on every edit of the cell below, with the same text above it."""
    global _last
    key = (prelude, tuple(m for m in sorted(safety.HEAVY_IMPORTS) if m in sys.modules))
    if _last is None or _last[0] != key:
        syntax: list[str] = []
        _last = (key, syntax, _analyze(_parse(prelude, syntax), prelude))
    notes.extend(_last[1])
    return _last[2]


def _loaded(st: ast.Import | ast.ImportFrom) -> bool:
    roots = [a.name.split(".")[0] for a in st.names] if isinstance(st, ast.Import) else [(st.module or "").split(".")[0]]
    return all(r in sys.modules for r in roots)


def _select(stmts: list[_Stmt], needed: set[str], known: set[str]) -> tuple[list[bool], set[str]]:
    """Which statements the traced code needs, directly or through others.

    known: names that need nothing from above (built-ins, ns).
    """
    last_change: dict[str, int] = {}
    for i, s in enumerate(stmts):
        for name in s.stores | s.roots:
            last_change[name] = i
    provided = set(last_change)
    # A name last bound or changed by a statement that cannot run is left
    # unbound (with a note) rather than given an older value the kernel no
    # longer has.
    unavailable = {n for n, i in last_change.items() if stmts[i].unsafe}
    needed = set(needed)
    wanted = [False] * len(stmts)
    changed = True
    while changed:  # until stable: a function may use one defined below it
        changed = False
        for i in range(len(stmts) - 1, -1, -1):
            s = stmts[i]
            if wanted[i]:
                continue
            if s.unsafe:  # wanted only for the note: it is why a name is missing
                hit = (s.stores | s.roots) & needed & unavailable
            elif s.star:  # only for a name nothing else provides
                hit = needed - provided - known
            else:
                hit = (s.stores | s.roots | s.args) & needed - unavailable
            if hit:
                wanted[i] = True
                changed = True
                if not s.unsafe:
                    needed |= s.reads | s.roots | s.args
    return wanted, unavailable


_TYPE_NAME = type.__dict__["__name__"]


def _exc_text(exc: BaseException) -> str:
    name = _TYPE_NAME.__get__(type(exc))
    try:
        # The learner's own exception class may define __str__. It runs
        # under the time guard, so it may also be stopped (_Timeout).
        msg = str(exc)
    except KeyboardInterrupt:
        raise
    except BaseException:  # noqa: BLE001
        msg = ""
    return f"{name}: {msg[:80]}" if type(msg) is str and msg else name


def _names(names: list[str], limit: int = 8) -> str:
    shown = ", ".join(names[:limit])
    return shown + (f" and {len(names) - limit} more" if len(names) > limit else "")


def run(prelude: str, source: str, tree: ast.Module, ns: dict[str, Any], seconds: float,
        stopper: Any = None) -> Result:
    """Run what the traced code needs from the cells above, in ns.

    Must be called with sys.stdout / sys.stdin already redirected; nothing
    of the prelude itself is traced. stopper(codes, exc) keeps raising exc
    on every line of those code objects until closed (tracer._Stopper).
    """
    res = Result()
    started = time.perf_counter()
    try:
        direct = free_names(source, tree)
    except SyntaxError:
        return res
    syntax_notes: list[str] = []
    stmts = _analyzed(prelude, syntax_notes)
    builtins_ns = ns.get("__builtins__")
    known = (set(builtins_ns) if type(builtins_ns) is dict else set()) | set(ns)
    wanted, unavailable = _select(stmts, direct, known)
    provided = set().union(*(s.stores for s in stmts)) if stmts else set()
    if direct - known - provided:
        # A name the cell needs may be defined in the cell that does not parse.
        res.notes.extend(syntax_notes)
    if not any(wanted):
        return res
    needed = set(direct)
    for s, w in zip(stmts, wanted):
        if w and not s.unsafe:
            needed |= s.reads | s.roots | s.args
    budget_end = started + seconds
    # Once the budget is used up, a later statement still gets a moment: the
    # definitions after one slow call are cheap and still wanted.
    grace_end = budget_end + min(1.0, seconds / 2)
    deadline = budget_end
    skipped: list[str] = []
    failed: list[str] = []
    slow: list[str] = []
    from_star: list[str] = []
    compiled = res.codes  # the helpers defined so far live in these
    stopping: list[Any] = []

    def guard(frame: types.FrameType, event: str, arg: Any) -> Any:
        if frame.f_code.co_filename != PRELUDE_FILE:
            return None  # library code (an import) is never interrupted half-way
        if time.perf_counter() > deadline:
            # A bare `except:` in a helper would catch this once, and the
            # trace function is then gone from that frame.
            if stopper is not None and not stopping:
                stopping.append(stopper(compiled, _Timeout))
            raise _Timeout
        return guard

    for s, want in zip(stmts, wanted):
        if not want:
            continue
        if s.unsafe:
            names = sorted((s.stores | s.roots) & needed & unavailable)
            skipped.append(f"line {s.line} `{s.text}`: {s.unsafe}, so {_names(names, 4)} "
                           f"{'is' if len(names) == 1 else 'are'} not defined here")
            continue
        now = time.perf_counter()
        if now >= grace_end or (s.too_slow and seconds <= s.too_slow):
            slow.append(f"line {s.line} `{s.text}`")
            continue
        deadline = budget_end if now < budget_end else min(grace_end, now + 0.05)
        code = compile(ast.Module(body=[s.node], type_ignores=[]), PRELUDE_FILE, "exec")
        compiled.append(code)
        # `from pylab import *` would bring a thousand names into the traced
        # frame (encoded on every step): only the needed ones are kept.
        target = {"__builtins__": builtins_ns, "__name__": ns.get("__name__")} if s.star else ns
        sys.settrace(guard)
        try:
            exec(code, target)  # noqa: S102 - the learner's own definitions
            res.ran += 1
            if s.star:
                for n in sorted(needed - known):
                    if n in target and n not in ns:
                        ns[n] = target[n]
                        from_star.append(n)
        except _Timeout:
            slow.append(f"line {s.line} `{s.text}`")
            if deadline == budget_end and budget_end - now >= seconds / 2:  # most of the budget
                s.too_slow = max(s.too_slow, seconds)
        except KeyboardInterrupt:
            raise
        except BaseException as exc:  # noqa: BLE001 - reported, the trace still runs
            failed.append(f"line {s.line} `{s.text}` failed: {_exc_text(exc)}")
        finally:
            sys.settrace(None)
            while stopping:
                stopping.pop().close()
    res.seconds = time.perf_counter() - started
    used = [n for s, w in zip(stmts, wanted) if w and not s.unsafe
            for n in sorted(s.stores) if n in direct and n in ns]
    used = list(dict.fromkeys(used + [n for n in from_star if n in direct]))
    if used:
        res.notes.append(f"using from the cells above: {_names(used)}")
        hidden = [n for n in used if type(ns.get(n)) is types.FunctionType
                  and ns[n].__code__.co_filename == PRELUDE_FILE]
        if hidden:
            one = len(hidden) == 1
            res.notes.append(f"steps inside {_names([h + '()' for h in hidden], 4)} are not shown: "
                             f"{'it is' if one else 'they are'} defined in a cell above "
                             f"(Visualize File steps into {'it' if one else 'them'})")
    for text in skipped[:3]:
        res.notes.append(f"not run from the cells above: {text}")
    if len(skipped) > 3:
        res.notes.append(f"not run from the cells above: {len(skipped) - 3} more statement(s)")
    res.notes.extend(failed[:3])
    if slow:
        more = f" and {len(slow) - 2} more" if len(slow) > 2 else ""
        res.notes.append(f"the cells above took more than {seconds:.1f} s, so Visualize stopped "
                         f"{', '.join(slow[:2])}{more}")
    return res
