"""Reload the learner's own modules after they are saved.

A module stays in sys.modules for the whole kernel session, so after fixing
a bug in hinh_hoc.py and saving, Run Cell kept running the old code (7
instead of 14) and only Restart Kernel helped, at the price of every
variable. Before each manual run and each Visualize, a module whose file
changed since it was imported is reloaded, in dependency order, and the names
that still point to its old functions and classes (`from hinh_hoc import
dien_tich`) are pointed at the new ones. An edited class keeps its identity
(the old class object takes the new body), so objects created before the
edit run the fixed code and isinstance() still holds for them.

When the working folder moves to a lesson folder with its own copy of a
module (utils.py in each lesson), `import utils` loads that folder's copy;
the other copy is set aside and comes back with its folder (follow_folder).

Only the learner's own files count: .py files under the folders vrun runs
files from (and folders the learner's code put on sys.path), never the
standard library, site-packages or vrun itself. A module that trains, loops
forever or reads program input at import is not reloaded behind the
learner's back: the note says so instead.
"""

from __future__ import annotations

import ast
import importlib
import importlib.machinery
import importlib.util
import os
import sys
import sysconfig
import tempfile
import tokenize
import types
from dataclasses import dataclass
from typing import Any

from . import safety
from .heap import class_ns, instance_dict, is_class

_MODULE_DICT = types.ModuleType.__dict__["__dict__"]
_SKIP = {"__main__", "__mp_main__", "__pylive_trace__"}
_PATCHABLE = (types.FunctionType, staticmethod, classmethod, property)
# Top-level findings that make an automatic reload unsafe or surprising.
_NO_RELOAD = ("training", "expensive", "loop", "input")
_MISSING = object()


def _key(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def _under(path_key: str, folder_key: str) -> bool:
    return path_key == folder_key or path_key.startswith(folder_key.rstrip("\\/") + os.sep)


def _library_dirs() -> tuple[str, ...]:
    dirs = {sys.prefix, sys.base_prefix, sys.exec_prefix, getattr(sys, "base_exec_prefix", sys.prefix)}
    for name in ("stdlib", "platstdlib", "purelib", "platlib"):
        try:
            dirs.add(sysconfig.get_path(name))
        except (KeyError, OSError, ValueError):
            pass
    return tuple(_key(d) for d in dirs if d)


_LIBRARY_DIRS = _library_dirs()
_VRUN_DIR = _key(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # launcher.py + pylive_kernel
_TEMP_DIR = _key(tempfile.gettempdir())


def _module_dict(mod: object) -> dict[str, Any] | None:
    if not issubclass(type(mod), types.ModuleType):
        return None
    d = _MODULE_DICT.__get__(mod, types.ModuleType)  # no module __getattr__ runs
    return d if type(d) is dict else None


def _stamp(path: str) -> tuple[int, int] | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size


_CHANGED = (-1, -1)  # a stamp no file has: the next manual run reloads the module


def _import_stamp(mod: object, path: str, since: float | None) -> tuple[int, int] | None:
    """The file's stamp as the module was imported, as far as we can tell.

    Modules are first seen after the run that imported them; an edit saved
    while that run was still going (a long training) would otherwise count
    as the imported version. The import validated (or wrote) the .pyc, whose
    header holds the source's mtime and size at that moment. Without a .pyc
    (PYTHONDONTWRITEBYTECODE), a file modified after the run started counts
    as changed: at worst one reload too many.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    now = (st.st_mtime_ns, st.st_size)
    d = _module_dict(mod) or {}
    cached = d.get("__cached__")
    head = b""
    if type(cached) is str:
        try:
            with open(cached, "rb") as f:
                head = f.read(16)
        except OSError:
            pass
    if len(head) == 16 and head[:4] == importlib.util.MAGIC_NUMBER and int.from_bytes(head[4:8], "little") == 0:
        compiled = (int.from_bytes(head[8:12], "little"), int.from_bytes(head[12:16], "little"))
        return now if compiled == (int(st.st_mtime) & 0xFFFFFFFF, st.st_size & 0xFFFFFFFF) else _CHANGED
    if since is not None and st.st_mtime > since:
        return _CHANGED
    return now


def _is_library(path_key: str) -> bool:
    if _under(path_key, _VRUN_DIR) or any(_under(path_key, d) for d in _LIBRARY_DIRS):
        return True
    parts = path_key.replace("\\", "/").split("/")
    return "site-packages" in parts or "dist-packages" in parts


@dataclass
class _Entry:
    ident: int
    file: str | None  # the learner's .py file; None for any other module
    stamp: tuple[int, int] | None
    # A reload of this file version failed: retried only after the next
    # save, since each try re-ran the module's top-level code and its prints.
    failed: tuple[int, int] | None = None
    told: tuple[int, int] | None = None  # the version Live already said is not loaded


@dataclass
class _Parked:
    """A module set aside when another folder's file of the same name took
    over `import name`; it comes back as it was when its folder does."""
    modules: dict[str, types.ModuleType]  # the module and its submodules
    entries: dict[str, _Entry]


class ModuleReloader:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._parked: dict[str, _Parked] = {}  # by _key(file)
        self._roots: list[str] = []
        self._last_roots: tuple[str, ...] = ()
        # Entries on sys.path at start come from the interpreter, site and
        # .pth files (editable installs); later ones the learner's code added.
        self._startup_path = {p for p in sys.path if type(p) is str}

    # -- which modules are the learner's -----------------------------------
    def add_folder(self, folder: str | None) -> None:
        """A folder the learner runs files from (a script's or working folder)."""
        if not folder or not os.path.isabs(folder):
            return
        key = _key(folder)
        if key not in self._roots and not _is_library(key):
            self._roots.append(key)

    def _current_roots(self) -> tuple[str, ...]:
        roots = list(self._roots)
        for p in list(sys.path):
            if type(p) is str and p and p not in self._startup_path and os.path.isabs(p):
                key = _key(p)
                if key not in roots and not _is_library(key):
                    roots.append(key)
        return tuple(roots)

    def _own_file(self, mod: object, roots: tuple[str, ...]) -> str | None:
        d = _module_dict(mod)
        if d is None:
            return None
        f = d.get("__file__")
        if type(f) is not str or not f.endswith(".py") or not os.path.isabs(f):
            return None
        key = _key(f)
        if _is_library(key):
            return None
        for root in roots:
            # A workspace in the home folder must not claim the temp folder,
            # where torch.compile and friends write generated modules.
            if _under(key, root) and (not _under(key, _TEMP_DIR) or _under(root, _TEMP_DIR)):
                return f
        return None

    def scan(self, since: float | None = None) -> None:
        """Note newly imported modules and the file stamp they were imported
        with; `since` is when the run that may have imported them started
        (time.time())."""
        roots = self._current_roots()
        if roots != self._last_roots:
            # Modules classified as not ours may now be under a new folder.
            self._entries = {k: e for k, e in self._entries.items() if e.file is not None}
            self._last_roots = roots
        for name, mod in list(sys.modules.items()):
            if type(name) is not str or name in _SKIP:
                continue
            entry = self._entries.get(name)
            if entry is not None and entry.ident == id(mod):
                continue
            f = self._own_file(mod, roots)
            self._entries[name] = _Entry(id(mod), f, _import_stamp(mod, f, since) if f is not None else None)
        if len(self._entries) > len(sys.modules) + 200:
            self._entries = {k: e for k, e in self._entries.items() if k in sys.modules}

    def _changed(self) -> list[str]:
        out = []
        for name, entry in self._entries.items():
            if entry.file is None or id(sys.modules.get(name)) != entry.ident:
                continue
            now = _stamp(entry.file)
            if now is not None and now != entry.stamp and now != entry.failed:
                out.append(name)
        return sorted(out)

    # -- reloading ------------------------------------------------------------
    def changed_notes(self) -> list[str]:
        """For Live runs, which never reload: say that old code is running,
        once per save (Live runs on every keystroke)."""
        self.scan()
        notes = []
        for n in self._changed():
            entry = self._entries[n]
            now = _stamp(entry.file) if entry.file is not None else None
            if now is None or now == entry.told:
                continue
            entry.told = now
            notes.append(f"{_short(entry.file)} changed on disk; Live keeps running the old code "
                         "until you run a cell (Ctrl+Alt+C) or Visualize")
        return notes

    def follow_folder(self, folder: str, main_ns: dict[str, Any]) -> list[str]:
        """The working folder (and sys.path[0]) just moved to `folder`.

        Each lesson folder may have its own utils.py: `import utils` in lesson
        2 kept returning lesson 1's module, which stayed in sys.modules. A
        learner's module that a fresh `import name` would now load from
        another file is set aside, so the next import finds this folder's
        copy; a copy set aside earlier comes back as it was (no top-level code
        runs again), and names in __main__ that pointed into the module of the
        other folder point into it again.
        """
        self.scan()
        notes: list[str] = []
        for name in sorted(self._entries):
            entry = self._entries.get(name)
            if entry is None or entry.file is None or "." in name:
                continue
            mod = sys.modules.get(name)
            if mod is None or id(mod) != entry.ident:
                continue
            here = _module_file_in(folder, name)
            if here is None or _key(here) == _key(entry.file) or not _import_finds(name, here):
                continue  # e.g. the learner's own sys.path.insert(0, '../common') comes first
            prefix = name + "."
            group = {n: m for n, m in list(sys.modules.items())
                     if type(n) is str and (n == name or n.startswith(prefix))}
            self._parked[_key(entry.file)] = _Parked(
                group, {n: self._entries[n] for n in group if n in self._entries})
            for n in group:
                sys.modules.pop(n, None)
                self._entries.pop(n, None)
            back = self._parked.pop(_key(here), None)
            if back is not None and not any(n in sys.modules for n in back.modules):
                sys.modules.update(back.modules)
                self._entries.update(back.entries)
                restored = back.modules.get(name)
                if restored is not None:
                    _rebind(main_ns, _swap_pairs(mod, restored, name))
            notes.append(f"import {name} now loads {_where(here)} (this folder's), not {_where(entry.file)}")
        return notes

    def reload_changed(self, main_ns: dict[str, Any]) -> list[str]:
        """Reload changed modules; returns the notes for the run."""
        self.scan()
        changed = self._changed()
        if not changed:
            return []
        notes: list[str] = []
        for name in _dependency_order(changed):
            mod = sys.modules.get(name)
            entry = self._entries[name]
            if mod is None or id(mod) != entry.ident or entry.file is None:
                continue
            note = self._reload_one(name, mod, entry, main_ns)
            if note:
                notes.append(note)
        return notes

    def _reload_one(self, name: str, mod: types.ModuleType, entry: _Entry, main_ns: dict[str, Any]) -> str | None:
        file = entry.file
        assert file is not None
        shown = _short(file)
        stamp = _stamp(file)  # before reloading: an edit during the reload counts next time
        risk = _import_risk(file)
        if risk is not None:
            entry.stamp = stamp  # say it once per edit, not on every run
            return (f"{shown} changed on disk, but vrun did not reload it: importing it {risk}. "
                    f"Run importlib.reload({name}) yourself, or vrun: Restart Kernel")
        d = _module_dict(mod)
        if d is None:
            return None
        old = dict(d)
        # importlib.reload finds a top-level module by name on sys.path, whose
        # first entry follows the working folder: run from lesson 6, the edit
        # of lesson 5's helpers.py loaded lesson 6's helpers.py into it (or
        # failed on every run when lesson 6 had none). The module's own
        # folder goes first for the reload.
        root = _search_root(name, file)
        first = sys.path[0] if sys.path else None
        if root is not None and type(first) is str and _key(first) == _key(root):
            root = None
        if root is not None:
            sys.path.insert(0, root)
        try:
            importlib.reload(mod)
            loaded = d.get("__file__")
            if type(loaded) is not str or _key(loaded) != _key(file):
                raise ImportError(f"Python found {_where(loaded) if type(loaded) is str else 'another file'} "
                                  f"first")
        except BaseException as exc:  # noqa: BLE001 - a broken edit must not end the run
            # reload executes into the same dict: restore the old module whole
            # rather than leave half of the new code in it.
            d.clear()
            d.update(old)
            sys.modules[name] = mod
            if isinstance(exc, KeyboardInterrupt):
                raise  # stopped, not broken: the next run tries again
            entry.failed = stamp
            return f"could not reload {shown} ({_describe_error(exc)}); the kernel still runs its old code"
        finally:
            if root is not None:
                _remove_path_entry(root)
        entry.stamp = stamp
        entry.failed = None
        pairs: dict[int, tuple[object, object]] = {}
        classes: list[tuple[str, type, type]] = []
        for attr, before in old.items():
            after = d.get(attr, _MISSING)
            if after is _MISSING or after is before or not _rebindable(before, name) \
                    or type(after) is not type(before):
                continue
            if is_class(before) and type(before) is type and type(after) is type:
                classes.append((attr, before, after))  # type: ignore[arg-type]
            else:
                pairs[id(before)] = (before, after)
        # A class keeps its identity where it can: pointing the names at the
        # new class left objects made before the edit (and their links, a
        # linked list's next nodes) instances of the old one, so
        # isinstance(head.nxt, Node) turned False without a word.
        kept = _classes_to_keep(classes)
        for attr, before, after in classes:
            if id(after) in kept:
                _adopt_class(before, after)
                d[attr] = before
            else:  # metaclass, bases or __slots__ changed: a new class is needed
                _patch_class(before, after)
                pairs[id(before)] = (before, after)
        if kept:
            _fold_kept(d, kept)
        if pairs:
            for ns in [main_ns, *self._own_namespaces(skip=name)]:
                _rebind(ns, pairs)
        return f"reloaded {shown} (changed on disk)"

    def _own_namespaces(self, skip: str) -> list[dict[str, Any]]:
        out = []
        for name, entry in self._entries.items():
            if entry.file is None or name == skip:
                continue
            d = _module_dict(sys.modules.get(name))
            if d is not None:
                out.append(d)
        return out


def _short(file: str | None) -> str:
    return os.path.basename(file or "?")


def _where(file: str) -> str:
    r"""`l2\utils.py`, `l2\pkg`: enough to tell two lessons' copies apart."""
    folder, base = os.path.split(os.path.abspath(file))
    if base == "__init__.py":
        folder, base = os.path.split(folder)
    return os.path.join(os.path.basename(folder), base)


def _search_root(name: str, file: str) -> str | None:
    """The sys.path folder from which `import name` loads `file`; None for a
    submodule, which its package's __path__ finds."""
    if "." in name:
        return None
    folder, base = os.path.split(file)
    if os.path.normcase(base) == os.path.normcase(name + ".py"):
        return folder
    if os.path.normcase(base) == "__init__.py" and \
            os.path.normcase(os.path.basename(folder)) == os.path.normcase(name):
        return os.path.dirname(folder)
    return None


def _remove_path_entry(entry: str) -> None:
    # By identity: the module's code may have added an equal entry of its own.
    for i, p in enumerate(sys.path):
        if p is entry:
            del sys.path[i]
            return


def _module_file_in(folder: str, name: str) -> str | None:
    """The file `import name` loads from `folder`, if it has one."""
    for candidate in (os.path.join(folder, name, "__init__.py"), os.path.join(folder, name + ".py")):
        if os.path.isfile(candidate):
            return candidate
    return None


def _import_finds(name: str, file: str) -> bool:
    """Whether a fresh `import name` would load `file` (sys.path order, as
    PathFinder searches it; finding runs no module code)."""
    try:
        spec = importlib.machinery.PathFinder.find_spec(name)
    except Exception:  # noqa: BLE001 - a broken sys.path entry: leave the module alone
        return False
    origin = getattr(spec, "origin", None) if spec is not None else None
    return type(origin) is str and _key(origin) == _key(file)


def _swap_pairs(old: types.ModuleType, new: types.ModuleType, name: str) -> dict[int, tuple[object, object]]:
    """old module -> new module, and the functions and classes old defined ->
    new's of the same names (`from utils import greet`)."""
    pairs: dict[int, tuple[object, object]] = {id(old): (old, new)}
    od, nd = _module_dict(old) or {}, _module_dict(new) or {}
    for attr, value in list(od.items()):
        other = nd.get(attr, _MISSING)
        if other is not _MISSING and type(other) is type(value) and _rebindable(value, name) \
                and _rebindable(other, name):
            pairs[id(value)] = (value, other)
    return pairs


# Entries of a class's own dict that belong to its layout or identity, not
# to what the learner wrote in the class body.
_TYPE_MANAGED = {"__dict__", "__weakref__", "__module__", "__qualname__", "__slots__", "__type_params__"}


def _classes_to_keep(classes: list[tuple[str, type, type]]) -> dict[int, type]:
    """id(new class) -> old class, for classes whose old object can take the
    new body: same metaclass (plain type, checked by the caller), same
    bases (a base kept itself counts as the same) and no __slots__, so old
    objects keep a valid layout."""
    keep = {id(new): old for _, old, new in classes
            if "__slots__" not in class_ns(old) and "__slots__" not in class_ns(new)}
    changed = True
    while changed:
        changed = False
        for _, old, new in classes:
            if id(new) not in keep:
                continue
            bases = tuple(keep.get(id(b), b) for b in new.__bases__)
            if len(bases) != len(old.__bases__) or any(a is not b for a, b in zip(bases, old.__bases__)):
                del keep[id(new)]
                changed = True
    return keep


def _adopt_class(old: type, new: type) -> None:
    """Give the old class object the new class body: methods, properties and
    plain class attributes; what the edit removed goes."""
    new_ns = class_ns(new)
    for attr in list(class_ns(old)):
        if attr not in new_ns and attr not in _TYPE_MANAGED:
            try:
                type.__delattr__(old, attr)
            except (TypeError, AttributeError):
                pass
    for attr, value in list(new_ns.items()):
        if attr in _TYPE_MANAGED or type(value) in (types.MemberDescriptorType, types.GetSetDescriptorType):
            continue
        _retarget_class_cell(value, new, old)
        try:
            type.__setattr__(old, attr, value)
        except (TypeError, AttributeError):
            pass


def _retarget_class_cell(value: object, new: type, old: type) -> None:
    """Zero-argument super() reads the method's __class__ cell, which holds
    the class the body created; methods moved to the old class need it to
    say the old one."""
    if type(value) in (staticmethod, classmethod):
        funcs: tuple[object, ...] = (value.__func__,)  # type: ignore[attr-defined]
    elif type(value) is property:
        funcs = (value.fget, value.fset, value.fdel)
    else:
        funcs = (value,)
    for fn in funcs:
        if type(fn) is not types.FunctionType or fn.__closure__ is None:
            continue
        free = fn.__code__.co_freevars
        if "__class__" in free:
            cell = fn.__closure__[free.index("__class__")]
            try:
                if cell.cell_contents is new:
                    cell.cell_contents = old
            except ValueError:  # an empty cell
                pass


def _fold_kept(d: dict[str, Any], kept: dict[int, type]) -> None:
    """What the module's top-level code made from a class that is now folded
    into the old one: an alias the edit added (`Nut = Node`) and objects
    (`EMPTY = Node(None)`, `ROOTS = [Node(1)]`)."""
    def retype(value: object) -> None:
        old = kept.get(id(type(value)))
        if old is not None:
            try:
                object.__setattr__(value, "__class__", old)
            except TypeError:
                pass

    for attr, value in list(d.items()):
        t = type(value)
        if t is type and id(value) in kept:
            d[attr] = kept[id(value)]
        elif t in (list, tuple, set, frozenset):
            for item in list(value)[:1000]:  # type: ignore[call-overload]
                retype(item)
        elif t is dict:
            for item in list(dict.values(value))[:1000]:  # type: ignore[arg-type]
                retype(item)
        else:
            retype(value)


def _describe_error(exc: BaseException) -> str:
    if type(exc) in (SyntaxError, IndentationError, TabError):
        return f"{type(exc).__name__}: {exc.msg} at line {exc.lineno}"  # type: ignore[attr-defined]
    try:
        text = str(exc)
    except Exception:  # noqa: BLE001
        text = ""
    return f"{type(exc).__name__}: {text[:200]}" if text else type(exc).__name__


def _import_risk(file: str) -> str | None:
    """What importing the file does at top level that a reload must not repeat."""
    try:
        with tokenize.open(file) as f:
            source = f.read(2_000_000)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None  # importlib.reload reports it
    try:
        tree = ast.parse(source)
        # `if __name__ == "__main__":` does not run on import: a module's own
        # test code there (train(), input()) must not block the reload.
        body = [s for s in tree.body if not _is_main_guard(s)]
        statements = safety.analyze_statements(ast.Module(body=body, type_ignores=[]))
    except (SyntaxError, RecursionError, MemoryError, ValueError):
        return None  # importlib.reload reports a syntax error
    for st in statements:
        for finding in st.findings:
            if finding.category in _NO_RELOAD:
                return f"{finding.message} (line {finding.line})"
    return None


def _is_main_guard(statement: ast.stmt) -> bool:
    if not isinstance(statement, ast.If) or not isinstance(statement.test, ast.Compare):
        return False
    test = statement.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq):
        return False
    sides = [test.left, test.comparators[0]]
    return any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides) \
        and any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)


def _defined_in(value: object) -> str | None:
    if type(value) is types.FunctionType:
        module = value.__module__
    elif is_class(value):
        module = class_ns(value).get("__module__")  # type: ignore[arg-type]
    else:
        d = instance_dict(value)  # functools.lru_cache / wraps wrappers
        wrapped = d.get("__wrapped__") if d is not None else None
        return _defined_in(wrapped) if type(wrapped) is types.FunctionType else None
    return module if type(module) is str else None


def _rebindable(value: object, module: str) -> bool:
    """Functions and classes the module itself defined (not `import numpy as np`;
    never ints or strings, whose identity says nothing about where they came from)."""
    return _defined_in(value) == module


def _rebind(ns: dict[str, Any], pairs: dict[int, tuple[object, object]]) -> None:
    for name, value in list(ns.items()):
        hit = pairs.get(id(value))
        if hit is not None and hit[0] is value:
            ns[name] = hit[1]


def _patch_class(old: type, new: type) -> None:
    """Give an old class the new methods, for objects created before the edit.

    Methods using zero-argument super() or __class__ are bound to the new
    class and would fail on old objects, so they stay as they were.
    """
    for attr, value in list(class_ns(new).items()):
        if type(value) not in _PATCHABLE:
            continue
        fn = value.__func__ if type(value) in (staticmethod, classmethod) else value
        if type(fn) is types.FunctionType and "__class__" in fn.__code__.co_freevars:
            continue
        if type(value) is property and any(
                type(f) is types.FunctionType and "__class__" in f.__code__.co_freevars
                for f in (value.fget, value.fset, value.fdel)):
            continue
        try:
            type.__setattr__(old, attr, value)
        except (TypeError, AttributeError):
            pass


def _dependency_order(names: list[str]) -> list[str]:
    """Modules another changed module imports from come first."""
    mods = {n: sys.modules[n] for n in names if n in sys.modules}
    by_id = {id(m): n for n, m in mods.items()}
    deps: dict[str, set[str]] = {}
    for n, m in mods.items():
        d = _module_dict(m) or {}
        found: set[str] = set()
        for value in list(d.values())[:5000]:
            hit = by_id.get(id(value))
            if hit is None:
                origin = _defined_in(value)
                hit = origin if origin in mods else None
            if hit is not None and hit != n:
                found.add(hit)
        deps[n] = found
    order: list[str] = []
    pending = sorted(mods)
    while pending:
        ready = [n for n in pending if not (deps[n] - set(order))]
        if not ready:
            ready = pending[:1]  # an import cycle: any order works as well as Python's
        for n in ready:
            order.append(n)
            pending.remove(n)
    return order
