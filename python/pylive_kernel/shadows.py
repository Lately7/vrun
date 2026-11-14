"""Built-in names that a run of another file left in the shared namespace.

One kernel serves the whole window, so `input = sys.stdin.readline` in a
Codeforces file made input("Nhap n: ") fail in the next exercise, and
`max = 0` in one file made max(a) in another fail with "'int' object is not
callable". Each file worked with plain python. The kernel now remembers which
file bound such a name; before a run of a different file that does not bind
the name itself, the leftover is removed (with a note), so the built-in is
visible again. Later cells of the same file keep it: they may rely on
`input = sys.stdin.readline` from an earlier cell.
"""

from __future__ import annotations

import ast
import builtins
import sys
import types
from typing import Any

from .serialize import type_qualname

_MISSING = object()


def builtin_names() -> list[str]:
    # Read each time: vrun adds builtins.display when the kernel starts.
    return [n for n in vars(builtins) if not n.startswith("_")]


def top_level_bindings(nodes: list[ast.stmt]) -> set[str]:
    """Names the code binds in the module namespace (not inside functions,
    except names they declare global)."""
    names: set[str] = set()
    stack: list[ast.AST] = list(nodes)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            for inner in ast.walk(node):
                if isinstance(inner, ast.Global):
                    names.update(inner.names)
            continue
        if isinstance(node, ast.Lambda):
            continue
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            # `[max for max in xs]` binds max only inside the comprehension;
            # a walrus in it binds in the module.
            names.update(n.target.id for n in ast.walk(node)
                         if isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name))
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name != "*":
                    names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)  # case [first, *rest] / case str() as max
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
        stack.extend(ast.iter_child_nodes(node))
    return names


def _describe(value: object) -> str:
    """A short text for the note, without calling the object's own repr."""
    t = type(value)
    if value is None or t is bool:
        return str(value)
    if t is int:
        return int.__repr__(value) if value.bit_length() <= 64 else "<int>"  # type: ignore[attr-defined]
    if t is float:
        return float.__repr__(value)  # type: ignore[arg-type]
    if t is str:
        text = str.__repr__(value[:30])  # type: ignore[index]
        return text if len(value) <= 30 else text[:-1] + "...'"  # type: ignore[arg-type]
    if t is types.MethodType:
        func = value.__func__  # type: ignore[attr-defined]
        name = func.__name__ if type(func) is types.FunctionType else "?"
        # `input = sys.stdin.readline`, the competitive-programming idiom.
        return f"sys.stdin.{name}" if value.__self__ is sys.stdin else f"<method {name}>"  # type: ignore[attr-defined]
    if t in (types.FunctionType, types.BuiltinFunctionType):
        return f"<function {value.__name__}>"  # type: ignore[attr-defined]
    return f"<{type_qualname(t)} object>"


def _label(file: str) -> str:
    return file.replace("\\", "/").rsplit("/", 1)[-1] or file


class BuiltinLeftovers:
    def __init__(self) -> None:
        self._owner: dict[str, str] = {}  # name -> file that bound it last

    @staticmethod
    def snapshot(ns: dict[str, Any]) -> dict[str, object]:
        return {n: ns[n] for n in builtin_names() if n in ns}

    def remove(self, ns: dict[str, Any], file: str, nodes: list[ast.stmt]) -> list[str]:
        """Before a run of `file`: drop built-in names another file left."""
        if not self._owner:
            return []
        bound = top_level_bindings(nodes)
        removed: dict[str, list[tuple[str, object]]] = {}
        for name, owner in list(self._owner.items()):
            if owner == file or name in bound:
                continue  # same file: later cells may rely on it; this code rebinds it anyway
            del self._owner[name]
            value = ns.get(name, _MISSING)
            if value is _MISSING or value is getattr(builtins, name, _MISSING):
                continue
            del ns[name]
            removed.setdefault(owner, []).append((name, value))
        notes = []
        for owner, items in removed.items():
            if len(items) == 1:
                name, value = items[0]
                notes.append(f"removed {name} = {_describe(value)} left over from {_label(owner)}; "
                             f"it hid the built-in {name}")
            else:
                items.sort(key=lambda x: x[0])
                # Values help ("max = 9" is clearly someone's variable), but a
                # star import's dozen names would make the note unreadable.
                shown = ", ".join(f"{n} = {_describe(v)}" if len(items) <= 3 else n for n, v in items)
                notes.append(f"removed {shown} left over from {_label(owner)}; they hid the built-ins "
                             "of the same names")
        return notes

    def remember(self, ns: dict[str, Any], file: str, nodes: list[ast.stmt], before: dict[str, object]) -> None:
        """After a run of `file`: which built-in names it bound (by code, or
        a star import / globals() that the code does not show)."""
        bound = top_level_bindings(nodes)
        for name in builtin_names():
            value = ns.get(name, _MISSING)
            if value is _MISSING or value is getattr(builtins, name, _MISSING):
                self._owner.pop(name, None)
            elif name in bound or before.get(name, _MISSING) is not value:
                self._owner[name] = file
