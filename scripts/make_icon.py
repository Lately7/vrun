"""Generate media/icon.png (128x128): the vrun logo.

A white play mark with rounded corners and a short cursor bar ("run" at a
prompt) on a black rounded square. Standard library only.
"""

import math
import os
import struct
import zlib

SIZE = 128
SS = 4  # supersampling per axis for smooth (anti-aliased) edges

# The triangle is drawn inset and then grown by ROUND, which rounds its corners.
TRIANGLE = ((32.0, 40.0), (32.0, 88.0), (73.0, 64.0))
ROUND = 6.0
BAR = (82.0, 86.0, 98.0, 86.0)  # a line segment, drawn with half-width BAR_R
BAR_R = 5.0


def coverage(x: float, y: float) -> tuple[bool, bool]:
    """(inside the black square, white mark) for one sample point."""
    r = 26.0
    cx = min(max(x, r), SIZE - r)
    cy = min(max(y, r), SIZE - r)
    inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    if not inside:
        return False, False
    return True, _triangle_dist(x, y) <= ROUND or _segment_dist(x, y, *BAR) <= BAR_R


def _segment_dist(x: float, y: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length2))
    return math.hypot(x - (ax + t * dx), y - (ay + t * dy))


def _triangle_dist(x: float, y: float) -> float:
    (ax, ay), (bx, by), (cx, cy) = TRIANGLE

    def side(px: float, py: float, qx: float, qy: float) -> float:
        return (qx - px) * (y - py) - (qy - py) * (x - px)

    s1, s2, s3 = side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)
    if (s1 >= 0 and s2 >= 0 and s3 >= 0) or (s1 <= 0 and s2 <= 0 and s3 <= 0):
        return 0.0
    return min(_segment_dist(x, y, ax, ay, bx, by), _segment_dist(x, y, bx, by, cx, cy),
               _segment_dist(x, y, cx, cy, ax, ay))


def pixel(px: int, py: int) -> tuple[int, int, int, int]:
    inside = white = 0
    for sy in range(SS):
        for sx in range(SS):
            i, w = coverage(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
            inside += i
            white += w
    n = SS * SS
    alpha = round(255 * inside / n)
    if inside == 0:
        return 0, 0, 0, 0
    level = round(255 * white / inside)
    return level, level, level, alpha


def main() -> None:
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            raw += bytes(pixel(x, y))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "icon.png")
    with open(out, "wb") as f:
        f.write(png)
    print("wrote", out)


if __name__ == "__main__":
    main()
