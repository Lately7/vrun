"""The kernel's working folder follows the file being run (interface C1).

The kernel used to stay in the folder it started in, so in lesson 2 (another
folder) `pd.read_csv("data.csv")` failed although the file sits next to the
script. The host now sends the document's folder with each execute and
trace; the kernel moves there, as `python script.py` run from that folder
would, unless the learner's own code chose a folder with os.chdir.

os.chdir is process-wide, which is safe here: the worker runs execute and
trace tasks one at a time on its main thread (manual runs, Live runs and
traces share one queue), so a run never sees the folder change under it.
Background threads the learner started see the new folder from the next run.
"""

from __future__ import annotations

import importlib
import os
import sys


def same_folder(a: str, b: str) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _getcwd() -> str | None:
    try:
        return os.getcwd()
    except OSError:  # the folder was deleted
        return None


class WorkingFolder:
    def __init__(self) -> None:
        start = _getcwd()
        # The folder vrun chose last; initially the one the host started us in.
        self.chosen = start
        # launcher.py put the startup folder first on sys.path, as Python does
        # for a script's folder; that entry follows the working folder.
        self.path_entry = start if start is not None and sys.path and sys.path[0] == start else None
        self._told_stay: str | None = None
        self._at_start: str | None = start  # the folder as the current run started
        self._mover: str | None = None  # the file whose own code last changed the folder

    def apply(self, folder: str | None, file: str | None = None) -> tuple[bool, str | None]:
        """Move to `folder` (the folder of `file`, the running document) if
        vrun still owns the working folder. Returns (moved, the note for the
        run or None)."""
        try:
            return self._apply(folder, file)
        finally:
            self._at_start = _getcwd()

    def ran(self, file: str) -> None:
        """After a run of `file`: remember it if its code changed the folder."""
        now = _getcwd()
        if now is not None and (self._at_start is None or not same_folder(now, self._at_start)):
            self._mover = file

    def _apply(self, folder: str | None, file: str | None) -> tuple[bool, str | None]:
        if folder is None or self.chosen is None or not os.path.isabs(folder):
            return False, None
        current = _getcwd()
        if current is not None and same_folder(current, folder):
            return False, None
        if current is not None and not same_folder(current, self.chosen):
            # The learner's os.chdir wins. Said once, to another file:
            # otherwise a beginner running lesson 1 sees open('data.csv') fail
            # with no reason. The next cell of the file whose code moved needs
            # no note: that code said where it went.
            if (file is not None and file == self._mover) or (
                    self._told_stay is not None and same_folder(self._told_stay, current)):
                return False, None
            self._told_stay = current
            return False, f"working folder stays at {current} (your code changed it with os.chdir)"
        if not os.path.isdir(folder):
            return False, None
        os.chdir(folder)
        self._move_path_entry(folder)
        self.chosen = folder
        self._told_stay = None
        # Finders cache folder listings; a module created a moment ago in the
        # new folder must be importable at once.
        importlib.invalidate_caches()
        return True, f"working folder: {folder}"

    def _move_path_entry(self, folder: str) -> None:
        old = self.path_entry
        self.path_entry = folder
        if old is not None:
            for i, entry in enumerate(sys.path):
                if type(entry) is str and entry == old:
                    sys.path[i] = folder
                    return
        # The entry is gone (the learner edited sys.path): put the script's
        # folder first again, as a fresh `python script.py` would have it.
        sys.path.insert(0, folder)
