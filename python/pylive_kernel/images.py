"""Image previews of arrays: MNIST digits, CIFAR batches, photos, masks.

Learners practising computer vision hold images as NumPy arrays or tensors
((H, W), (H, W, 3), (N, 28, 28), (N, 3, 32, 32) ...) and otherwise only see
a shape. The kernel encodes a small PNG grid itself with zlib (no Pillow
needed) so the panel can show the pixels.

Only exact library types are converted (numpy.ndarray, torch.Tensor and
Parameter, TensorFlow eager tensors, PIL images) through their own C-level
conversions; nothing defined by user code runs.
"""

from __future__ import annotations

import base64
import math
import struct
import sys
import zlib
from typing import Any

from .heap import is_tf_tensor, is_torch_tensor
from .serialize import type_module, type_qualname

MAX_IMAGES = 64
MAX_PIXELS = 4_000_000  # per preview grid at full size: limits how many images
# Raw bytes of the grid that is encoded: a photo that does not compress stays
# well under the 8 MiB message limit after base64. Larger images are shown
# with every k-th pixel.
MAX_GRID_BYTES = 3_000_000
MAX_SIDE = 16384
GAP = 1


class NotAnImage(ValueError):
    pass


def _array_kind(value: object) -> str | None:
    t = type(value)
    mod = type_module(t)
    name = type_qualname(t)
    if mod == "numpy" and name == "ndarray":
        return "numpy"
    if is_torch_tensor(t):
        return "torch"
    if is_tf_tensor(t):
        return "tf"
    if mod.startswith("PIL.") and name.endswith("ImageFile") or (mod == "PIL.Image" and name == "Image"):
        return "pil"
    return None


def array_shape(value: object) -> tuple[int, ...] | None:
    """Shape of an array-like value without converting it, or None."""
    kind = _array_kind(value)
    if kind is None or "numpy" not in sys.modules:
        return None
    v: Any = value
    if kind == "pil":
        w, h = v.size
        bands = len(v.getbands())
        return (int(h), int(w)) if bands == 1 else (int(h), int(w), int(bands))
    try:
        return tuple(int(s) for s in v.shape)
    except (TypeError, ValueError):
        return None  # symbolic dimensions


def to_numpy(value: object, index: tuple[slice, ...] = ()) -> Any:
    """value[index] as a NumPy array (slicing first: a GPU batch is not
    copied whole to the CPU just to show 16 images, nor a photo to show
    every 4th pixel)."""
    np = sys.modules["numpy"]
    kind = _array_kind(value)
    v: Any = value
    if kind == "pil":
        return np.asarray(v)[index] if index else np.asarray(v)
    part = v[index] if index else v
    if kind == "numpy":
        return part
    if kind == "torch":
        torch = sys.modules["torch"]
        if part.is_complex() or part.layout != torch.strided:
            raise NotAnImage("sparse or complex tensors cannot be shown as images")
        part = part.detach().to("cpu")
        if part.dtype in (torch.bfloat16, torch.float16):
            part = part.float()
        return part.numpy()
    if kind == "tf":
        return part.numpy()
    raise NotAnImage("not an array or tensor")


def image_layout(shape: tuple[int, ...]) -> dict[str, Any] | None:
    """Guess how a shape holds images. None if it does not look like any.

    Returns {"count", "height", "width", "channels", "order"} where order is
    "hw", "hwc" or "chw" for each image, after an optional leading batch axis.
    """
    def single(dims: tuple[int, ...]) -> dict[str, Any] | None:
        if len(dims) == 2 and min(dims) >= 2:
            return {"height": dims[0], "width": dims[1], "channels": 1, "order": "hw"}
        if len(dims) == 3:
            h, w, c = dims
            if c in (1, 3, 4) and min(h, w) >= 2:
                return {"height": h, "width": w, "channels": c, "order": "hwc"}
            c, h, w = dims
            if c in (1, 3, 4) and min(h, w) >= 2:
                return {"height": h, "width": w, "channels": c, "order": "chw"}
        return None

    if len(shape) == 2 and shape[0] >= 2 and shape[1] >= 16 and shape[0] != shape[1]:
        # A table of flattened square images (load_digits: 1797 x 64,
        # flattened MNIST: n x 784) is offered too; a plain matrix wins
        # when the row length is not a square. A square matrix (a 64 x 64
        # face, a 256 x 256 scan, a correlation matrix) is one picture.
        side = math.isqrt(shape[1])
        if side * side == shape[1]:
            return {"count": shape[0], "height": side, "width": side, "channels": 1,
                    "order": "flat", "alsoMatrix": True}
    one = single(shape)
    if one is not None:
        # (N, H, W) with few channels-like N is ambiguous; (3, H, W) is RGB.
        return {"count": 1, **one}
    if len(shape) in (3, 4) and shape[0] >= 1:
        inner = single(shape[1:])
        if inner is not None:
            return {"count": shape[0], **inner}
    return None


# Single-channel data spanning fewer levels than this is stretched to the full
# gray range: a segmentation mask with classes 0, 1, 2 would otherwise be
# three shades of black on the 0..255 scale. A constant image keeps its gray.
SMALL_RANGE = 64


def _to_uint8(np: Any, a: Any) -> Any:
    """(n, h, w, c) array -> uint8."""
    if a.dtype == np.bool_:
        return a.astype(np.uint8) * 255
    gray = a.shape[-1] == 1
    if a.dtype == np.uint8 and not (gray and a.size and 0 < int(a.max()) - int(a.min()) < SMALL_RANGE):
        return a
    floating = a.dtype.kind == "f"
    a = a.astype(np.float64, copy=False)
    finite = np.isfinite(a)
    if not finite.any():
        return np.zeros(a.shape, dtype=np.uint8)
    lo = float(a[finite].min())
    hi = float(a[finite].max())
    if floating and lo >= 0 and hi <= 1:
        lo, hi = 0.0, 1.0  # 0..1 floats (ToTensor, /255)
    elif gray and 0 < hi - lo < SMALL_RANGE:
        pass  # label mask / class map: min-max, as matplotlib's imshow does
    elif lo >= 0 and hi <= 255 and hi > 1:
        lo, hi = 0.0, 255.0  # 0..255 stored as int/float
    span = hi - lo or 1.0
    out = np.clip((np.where(finite, a, lo) - lo) * (255.0 / span), 0, 255)
    return out.astype(np.uint8)


def _png(width: int, height: int, channels: int, rows: bytes) -> bytes:
    color_type = {1: 0, 3: 2, 4: 6}[channels]

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")


def preview(value: object, start: int = 0, max_images: int = 16) -> dict[str, Any]:
    """A PNG grid of images from an array-like value."""
    np = sys.modules.get("numpy")
    shape = array_shape(value)
    if np is None or shape is None:
        raise NotAnImage("not an array or tensor")
    layout = image_layout(shape)
    if layout is None:
        raise NotAnImage(f"shape {shape} does not look like an image")
    count, h, w, c = layout["count"], layout["height"], layout["width"], layout["channels"]
    if h > MAX_SIDE or w > MAX_SIDE:
        raise NotAnImage(f"an image of {h} x {w} pixels is too large to preview")
    max_images = max(1, min(int(max_images), MAX_IMAGES, max(1, MAX_PIXELS // (h * w))))
    start = max(0, min(int(start), count - 1))
    n = min(max_images, count - start)
    order = layout["order"]
    batched = not (count == 1 and len(shape) == (2 if order == "hw" else 3))
    # A 12 MP photo is 36 MB raw: show every step-th pixel instead.
    step = 1
    while n * -(-h // step) * -(-w // step) * c > MAX_GRID_BYTES:
        step += 1
    every = slice(None, None, step)
    spatial: tuple[slice, ...] = ()
    if step > 1 and order != "flat":  # flat rows are strided after the reshape
        spatial = (slice(None), every, every) if order == "chw" else (every, every)
    arr = to_numpy(value, ((slice(start, start + n),) if batched else ()) + spatial)
    if arr.dtype.kind not in "biuf":
        raise NotAnImage(f"dtype {arr.dtype} cannot be shown as an image")
    if order == "flat":
        imgs = arr.reshape(n, h, w)[:, ::step, ::step]
    elif not batched:
        imgs = arr[None, ...]
    else:
        imgs = arr
    if order == "chw":
        imgs = np.moveaxis(imgs, 1, -1)
    if imgs.ndim == 3:
        imgs = imgs[..., None]
    imgs = _to_uint8(np, np.ascontiguousarray(imgs))
    th, tw = int(imgs.shape[1]), int(imgs.shape[2])
    cols = max(1, min(n, math.ceil(math.sqrt(n * 1.6))))
    grid_rows = math.ceil(n / cols)
    gw = cols * tw + (cols - 1) * GAP
    gh = grid_rows * th + (grid_rows - 1) * GAP
    canvas = np.full((gh, gw, c), 0 if c == 4 else 128, dtype=np.uint8)
    for k in range(n):
        r, q = divmod(k, cols)
        canvas[r * (th + GAP):r * (th + GAP) + th, q * (tw + GAP):q * (tw + GAP) + tw] = imgs[k]
    rows = b"".join(b"\x00" + canvas[y].tobytes() for y in range(gh))
    return {
        "png": base64.b64encode(_png(gw, gh, c, rows)).decode("ascii"),
        # tile is the real image size; with scale k every k-th pixel is shown.
        "width": gw, "height": gh, "tile": [h, w], "scale": step, "columns": cols,
        "start": start, "shown": n, "count": count, "channels": c,
        "layout": order, "dtype": str(arr.dtype), "shape": list(shape),
    }
