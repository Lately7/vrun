"""One ordered, bounded buffer behind the captured stdout and stderr.

* Order: both streams append to the same segment list, so a warning printed
  between two print() calls arrives between them (separate per-stream
  buffers flushed at different times reordered warnings, logging and
  tqdm.write output).
* Progress bars: text that a later carriage return on the same line
  overwrites is dropped before it is counted or sent (a 20-epoch tqdm run
  wrote 1.9 MB of frames that render as 1.6 KB).
* Budget: a run may send MAX_TOTAL bytes. Past the head budget, output goes to
  a bounded tail kept until the run ends; the learner then sees the start,
  a marker and the end (final epochs, test accuracy) instead of losing the
  end.
* Re-entrant: a ``__del__`` that prints while a write holds the lock (garbage
  collection can run anywhere) used to deadlock the kernel; an RLock lets
  the nested write through.
"""

from __future__ import annotations

import collections
import threading
import time
from typing import Any, Callable

MAX_TOTAL = 2 * 1024 * 1024  # UTF-8 bytes per run, head + tail
TAIL_BYTES = 256 * 1024
FLUSH_CHARS = 8192
FLUSH_SECONDS = 0.05
CHUNK_CHARS = 256 * 1024
TRUNCATED_MARK = "[vrun: output truncated]"


def collapse_carriage_returns(text: str) -> str:
    """Drop progress-bar frames that a later '\\r' on the same line overwrites.

    The result renders exactly like the input on a terminal: frames after the
    first '\\r' of a line are overlaid (a shorter frame keeps the old tail).
    Lines with backspaces or escape codes are left alone.
    """
    if "\r" not in text:
        return text
    out = []
    for piece in text.split("\n"):
        frames = piece.split("\r")
        if len(frames) <= 3 or "\x1b" in piece or "\b" in piece:
            out.append(piece)
            continue
        ends_with_cr = frames[-1] == ""
        body = frames[1:-1] if ends_with_cr else frames[1:]
        shown = ""
        for f in body:
            shown = f + shown[len(f):]
        # The webview colours a line as a progress bar only when text on it
        # is overwritten. With nothing before the first '\r', writing only the
        # final frame overwrites nothing, so one character is written and
        # overwritten first (otherwise a stderr bar shows as an error).
        redraw = shown[:1] + "\r" if not frames[0] and sum(1 for f in body if f) > 1 else ""
        out.append(frames[0] + "\r" + redraw + shown + ("\r" if ends_with_cr else ""))
    return "\n".join(out)


class OutputBuffer:
    def __init__(self, send: Callable[[dict[str, Any]], None]) -> None:
        self._send = send
        self._lock = threading.RLock()
        self._segments: list[list[Any]] = []  # [stream name, exec id, text]
        self._pending = 0
        self._last = time.monotonic()
        self._tail: collections.deque[list[Any]] = collections.deque()
        self._tail_bytes = 0
        self._skipped = 0
        self.used = 0
        self.truncated = False

    def reset(self) -> None:
        """Start the budget of a new run.

        Text still buffered or held in the tail (a background thread that
        printed past the budget between runs) belongs to the old budget and
        is sent first: replacing the tail used to drop it without a trace.
        """
        with self._lock:
            self.finish()

    def write(self, name: str, exec_id: Any, text: str) -> None:
        if not text:
            return
        with self._lock:
            last = self._segments[-1] if self._segments else None
            if last is not None and last[0] == name and last[1] == exec_id:
                last[2] += text
            else:
                # Never merge text of two streams or two executions.
                self._segments.append([name, exec_id, text])
            self._pending += len(text)
            if self._pending >= FLUSH_CHARS or time.monotonic() - self._last >= FLUSH_SECONDS:
                self._flush_locked()

    def flush(self) -> None:
        with self._lock:
            self._flush_locked()

    def soft_flush(self) -> None:
        """flush() called by user code (tqdm flushes after every frame).

        Sending at most every FLUSH_SECONDS keeps the text just as visible
        but lets frames of one line collapse; the kernel's flush thread and
        the end of the task send whatever is left.
        """
        with self._lock:
            if time.monotonic() - self._last >= FLUSH_SECONDS:
                self._flush_locked()

    def finish(self) -> None:
        """End of a task: flush, then send the kept tail after a marker.

        The budget then starts over. Callers read ``truncated`` before this;
        left set, it held back everything a background thread printed after
        the run until some later task ended, behind a second marker.
        """
        with self._lock:
            self._flush_locked()
            self.used = 0
            self.truncated = False
            if not self._tail:
                return
            tail = list(self._tail)
            skipped = self._skipped
            self._tail.clear()
            self._tail_bytes = 0
            self._skipped = 0
            what = f"{_size(skipped)} skipped, " if skipped else ""
            self._emit(tail[0][0], tail[0][1],
                       f"\n{TRUNCATED_MARK} {what}the end of the output follows:\n")
            for name, exec_id, text, _ in tail:
                self._emit(name, exec_id, text)

    def _flush_locked(self) -> None:
        segments = self._segments
        self._segments = []
        self._pending = 0
        self._last = time.monotonic()
        head_budget = MAX_TOTAL - TAIL_BYTES
        for name, exec_id, raw in segments:
            text = collapse_carriage_returns(raw)
            if self.truncated:
                self._keep_tail(name, exec_id, text)
                continue
            data = text.encode("utf-8", "surrogatepass")
            room = head_budget - self.used
            if len(data) <= room:
                self.used += len(data)
                self._emit(name, exec_id, text)
                continue
            head = data[:max(room, 0)].decode("utf-8", "ignore")
            self.used = head_budget
            self.truncated = True
            self._emit(name, exec_id, head)
            self._keep_tail(name, exec_id, text[len(head):])

    def _keep_tail(self, name: str, exec_id: Any, text: str) -> None:
        size = len(text.encode("utf-8", "surrogatepass"))
        if size > TAIL_BYTES:
            # Keep the end of one huge write; at most 4 bytes per character.
            cut = text[-(TAIL_BYTES // 4):]
            self._skipped += size - len(cut.encode("utf-8", "surrogatepass"))
            text = cut
            size = len(text.encode("utf-8", "surrogatepass"))
        last = self._tail[-1] if self._tail else None
        if last is not None and last[0] == name and last[1] == exec_id:
            last[2] += text
            last[3] += size
        else:
            self._tail.append([name, exec_id, text, size])
        self._tail_bytes += size
        while self._tail_bytes > TAIL_BYTES and len(self._tail) > 1:
            dropped = self._tail.popleft()
            self._tail_bytes -= dropped[3]
            self._skipped += dropped[3]
        if self._tail_bytes > TAIL_BYTES:
            only = self._tail[0]
            keep = only[2][-(TAIL_BYTES // 4):]
            kept = len(keep.encode("utf-8", "surrogatepass"))
            self._skipped += only[3] - kept
            only[2], only[3] = keep, kept
            self._tail_bytes = kept

    def _emit(self, name: str, exec_id: Any, text: str) -> None:
        # Chunks of <= CHUNK_CHARS keep every event far below the message
        # size limit (at most 4 bytes per character).
        for start in range(0, len(text), CHUNK_CHARS):
            self._send({"type": "event", "event": "stream", "name": name,
                        "text": text[start:start + CHUNK_CHARS], "execId": exec_id})


def _size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} bytes"
