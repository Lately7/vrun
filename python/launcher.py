"""Entry point spawned by the VS Code extension: ``python -u launcher.py``."""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
from pylive_kernel.worker import main  # noqa: E402

# Remove the extension directory again so it never shadows user modules, and
# put the working directory first, as a script run from there would have it.
while _HERE in sys.path:
    sys.path.remove(_HERE)
sys.path.insert(0, os.getcwd())

if __name__ == "__main__":
    main()
