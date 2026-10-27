"""Generate media/icon.png (128x128) with the standard library only."""

import os
import struct
import zlib

SIZE = 128
BG = (30, 64, 120)
BAR = (120, 200, 255)
PTR = (255, 180, 60)


def pixel(x: int, y: int) -> tuple[int, int, int]:
    # Rounded square background
    r = 22
    cx = min(max(x, r), SIZE - 1 - r)
    cy = min(max(y, r), SIZE - 1 - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return (0, 0, 0)
    # Five bars of an "array" being sorted
    heights = [40, 70, 55, 85, 30]
    for i, h in enumerate(heights):
        x0 = 18 + i * 19
        if x0 <= x < x0 + 14 and 100 - h <= y < 100:
            return PTR if i == 3 else BAR
    # Pointer triangle under the highlighted bar
    if 104 <= y < 116 and abs(x - (18 + 3 * 19 + 7)) <= (y - 104) // 2 + 1:
        return PTR
    return BG


def main() -> None:
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            r, g, b = pixel(x, y)
            alpha = 0 if (r, g, b) == (0, 0, 0) else 255
            raw += bytes((r, g, b, alpha))

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
