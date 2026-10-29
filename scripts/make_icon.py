"""Generate media/icon.png (128x128): the black-and-white Veil logo.

A white sparkle (a large four-pointed star and a small one) on a black
rounded square. Standard library only.
"""

import os
import struct
import zlib

SIZE = 128
SS = 4  # supersampling per axis for smooth (anti-aliased) edges


def coverage(x: float, y: float) -> tuple[bool, bool]:
    """(inside the black square, white mark) for one sample point."""
    r = 26.0
    cx = min(max(x, r), SIZE - r)
    cy = min(max(y, r), SIZE - r)
    inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    if not inside:
        return False, False
    # Sparkles: astroid-shaped four-pointed stars (concave sides).
    return True, _sparkle(x, y, 56, 70, 40) or _sparkle(x, y, 94, 32, 15)


def _sparkle(x: float, y: float, cx: float, cy: float, radius: float) -> bool:
    dx = abs(x - cx) / radius
    dy = abs(y - cy) / radius
    return dx ** (2 / 3) + dy ** (2 / 3) <= 1.0


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
