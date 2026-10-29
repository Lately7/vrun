"""Program input (stdin) for judge-style exercises.

Learners solving DSA problems write ``n = int(input())``. The host passes
the text of ``<script>.in`` (if that file exists next to the script); this
module serves it line by line to ``input()`` and ``sys.stdin`` for one run.
"""

from __future__ import annotations

import io
import sys
from typing import Any

NO_INPUT_HINT = (
    "input() needs program input: put it in a file named like your script with "
    "the .in extension (e.g. solution.in next to solution.py), or run "
    "'PyLive: Edit Program Input'"
)


class _BinaryView:
    """``sys.stdin.buffer`` for fast-IO idioms (``sys.stdin.buffer.read()``).

    Reads consume the same text stream, so mixing input() and buffer reads
    behaves like one file.
    """

    def __init__(self, text: io.StringIO) -> None:
        self._text = text

    def read(self, size: int = -1) -> bytes:
        return self._text.read(size).encode("utf-8")

    def readline(self, size: int = -1) -> bytes:
        return self._text.readline(size).encode("utf-8")

    def readlines(self) -> list[bytes]:
        return [line.encode("utf-8") for line in self._text.readlines()]

    def __iter__(self) -> Any:
        return iter(self.readlines())


class InputStream(io.StringIO):
    """Text stream of the program input, with a binary ``buffer`` view."""

    @property
    def buffer(self) -> _BinaryView:  # type: ignore[override]
        return _BinaryView(self)


class ProgramInput:
    def __init__(self, text: str | None) -> None:
        self.provided = text is not None
        self.stream = InputStream(text if text is not None else "")

    def input(self, prompt: object = "") -> str:
        if not self.provided:
            raise EOFError(NO_INPUT_HINT)
        if prompt:
            # Like CPython with redirected stdin: the prompt is printed, the
            # consumed line is not echoed.
            sys.stdout.write(str(prompt))
        line = self.stream.readline()
        if not line:
            raise EOFError("EOF when reading a line (no more lines in the .in file)")
        return line[:-1] if line.endswith("\n") else line


class StdinSwap:
    """Temporarily point sys.stdin at the program input (restored on exit)."""

    def __init__(self, program_input: ProgramInput) -> None:
        self.program_input = program_input
        self.saved: Any = None

    def __enter__(self) -> ProgramInput:
        self.saved = sys.stdin
        sys.stdin = self.program_input.stream  # type: ignore[assignment]
        return self.program_input

    def __exit__(self, *exc: object) -> None:
        sys.stdin = self.saved
