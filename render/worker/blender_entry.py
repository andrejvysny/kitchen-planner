#!/usr/bin/env python3
"""Bootstrap for ``blender -b --factory-startup -P blender_entry.py -- <args>``.

Blender runs a ``-P`` script with its own ``sys.argv``, so the worker's flags
have to be fished out from after the ``--`` separator, and the script's own
directory is *not* on ``sys.path`` — both are fixed here, and nothing else
happens in this file so that everything real stays testable.

Exit codes matter: a CI smoke test and ``render.sh`` both read them, and Blender
exits 0 unless the script raises or calls ``sys.exit``.  Any exception is
therefore caught, printed to stderr and turned into exit 1; a clean run
propagates ``kprender.cli.main``'s own return code.
"""

from __future__ import annotations

import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def worker_args(argv: list[str]) -> list[str]:
    """Everything after the first bare ``--``; ``[]`` when there is none.

    ``blender -b -P script.py -- a b`` gives ``sys.argv ==
    ['.../blender', '-b', '-P', 'script.py', '--', 'a', 'b']``.
    """
    if "--" not in argv:
        return []
    return argv[argv.index("--") + 1 :]


def main() -> int:
    from kprender.cli import main as cli_main

    return cli_main(worker_args(sys.argv))


if __name__ == "__main__":
    try:
        code = main()
    except SystemExit as exc:  # argparse --help / explicit exits
        code = exc.code if isinstance(exc.code, int) else 1
    except BaseException:  # a traceback here must never become exit code 0
        traceback.print_exc()
        code = 1
    sys.exit(code)
