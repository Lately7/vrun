"""Regression tests for the captured-output review findings: collapsed
progress bars stay redraws, and output after a truncated run is delivered."""

from __future__ import annotations

import random
import time
from typing import Any

from conftest import KernelProc
from pylive_kernel import outbuf
from pylive_kernel.outbuf import TRUNCATED_MARK, OutputBuffer, collapse_carriage_returns


def _render(text: str) -> list[tuple[str, bool]]:
    """webview/terminal.ts reduced to \\r and \\n: (text, redrawn) per line.

    A line counts as redrawn once text is written over existing text, which
    is what turns a stderr progress bar from the error colour to normal.
    """
    lines: list[list[Any]] = [[[], False]]
    row = col = 0
    for ch in text:
        if ch == "\n":
            row += 1
            if row == len(lines):
                lines.append([[], False])
            col = 0
        elif ch == "\r":
            col = 0
        else:
            chars = lines[row][0]
            if col < len(chars):
                chars[col] = ch
                lines[row][1] = True
            else:
                chars.append(ch)
            col += 1
    return [("".join(c), r) for c, r in lines]


def test_collapsed_progress_line_still_counts_as_redrawn():
    collapsed = collapse_carriage_returns("\r1/3\r2/3\r3/3\n")
    # test/unit/terminal.test.ts feeds this exact string to the Terminal.
    assert collapsed == "\r3\r3/3\n"
    assert _render(collapsed) == [("3/3", True), ("", False)]
    # Text before the first '\r' already gets overwritten: nothing added.
    assert collapse_carriage_returns("a\r10%\r20%\r30%|xx\n") == "a\r30%|xx\n"
    # A single real frame was never a redraw and must not become one.
    assert _render(collapse_carriage_returns("\r\r\rdone\n")) == [("done", False), ("", False)]


def test_collapse_renders_like_the_raw_text_including_redrawn():
    rng = random.Random(1234)
    for _ in range(4000):
        raw = "".join(rng.choice("ab \r\r\n x") for _ in range(rng.randint(1, 30)))
        # Text already on the line from an earlier flush segment.
        prefix = rng.choice(["", "zz", "old line\n", "abc\r"])
        assert _render(prefix + collapse_carriage_returns(raw)) == _render(prefix + raw), (prefix, raw)


def _buffer() -> tuple[OutputBuffer, list[str]]:
    sent: list[str] = []
    return OutputBuffer(lambda msg: sent.append(msg["text"])), sent


def _overflow(buf: OutputBuffer) -> None:
    buf.write("stdout", 1, "x" * (outbuf.MAX_TOTAL - outbuf.TAIL_BYTES) + "END OF RUN\n")
    buf.flush()


def test_output_after_a_truncated_run_streams_without_a_second_marker():
    buf, sent = _buffer()
    _overflow(buf)
    assert buf.truncated
    buf.finish()
    assert "".join(sent).count(TRUNCATED_MARK) == 1 and "END OF RUN" in sent[-1]
    assert not buf.truncated and buf.used == 0
    sent.clear()
    buf.write("stdout", 1, "background line\n")
    buf.flush()
    assert sent == ["background line\n"]
    buf.finish()
    assert sent == ["background line\n"]


def test_reset_sends_a_held_tail_instead_of_dropping_it():
    buf, sent = _buffer()
    _overflow(buf)  # e.g. a background thread between two runs
    buf.write("stdout", 1, "held background line\n")
    buf.flush()
    assert "held background line" not in "".join(sent)
    buf.reset()  # worker.py: flush() then reset() at the start of an execute
    text = "".join(sent)
    assert text.count(TRUNCATED_MARK) == 1
    assert text.endswith("END OF RUN\nheld background line\n")
    assert not buf.truncated and buf.used == 0


def test_background_output_after_a_truncated_run_is_delivered(kernel: KernelProc):
    code = ("import threading, time\n"
            "def bg():\n"
            "    for i in range(3):\n"
            "        time.sleep(0.3)\n"
            "        print(f'background line {i}', flush=True)\n"
            "print('x' * 2_100_000)\n"
            "print('END OF RUN')\n"
            "threading.Thread(target=bg).start()\n")
    assert kernel.run(code)["outputTruncated"] is True
    deadline = time.time() + 10
    while time.time() < deadline and "background line 2" not in kernel.stream_text():
        time.sleep(0.05)
    # Streamed while the kernel is idle, not held until the next task.
    assert "background line 2" in kernel.stream_text()
    kernel.run("x = 1")
    kernel.call("variables.list")
    text = kernel.stream_text()
    assert text.count(TRUNCATED_MARK) == 1 and text.count("END OF RUN") == 1
    for i in range(3):
        assert text.count(f"background line {i}") == 1
