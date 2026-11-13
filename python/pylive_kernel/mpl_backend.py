"""Matplotlib backend of the kernel: Agg drawing, and ``plt.show()`` hands the
open figures to the Output tab right away.

With plain Agg, ``plt.show()`` did nothing: in a loop such as
``for col in cols: plt.hist(df[col]); plt.show()`` every histogram landed on
one figure. Here ``show()`` renders each open figure (in order) and closes
it, as notebooks do. A non-blocking show (``plt.pause()``,
``show(block=False)``, ``show()`` after ``plt.ion()``) is a live-update loop
that keeps drawing on the same figure, so it only marks the figures as shown
and they are rendered in their final state. Matplotlib imports this module
only when user code imports pyplot, so the kernel itself stays stdlib-only.
"""

from __future__ import annotations

import sys
from typing import Any

from matplotlib.backends.backend_agg import FigureCanvasAgg

from . import executor


def _show(block: bool | None) -> None:
    if block is None:
        mpl = sys.modules.get("matplotlib")
        try:
            # As in matplotlib: interactive mode makes show() non-blocking.
            block = not (mpl is not None and mpl.is_interactive())
        except Exception:  # noqa: BLE001
            block = True
    if block:
        executor.show_figures()
    else:
        executor.hold_figures()


try:
    from matplotlib.backend_bases import _Backend
    from matplotlib.backends.backend_agg import _BackendAgg

    @_Backend.export
    class _BackendVrun(_BackendAgg):  # type: ignore[misc, valid-type]
        @staticmethod
        def show(*args: Any, block: bool | None = None, **kwargs: Any) -> None:
            _show(block)

except ImportError:  # very old or very new matplotlib: the plain module API
    FigureCanvas = FigureCanvasAgg

    def show(*args: Any, block: bool | None = None, **kwargs: Any) -> None:
        _show(block)
