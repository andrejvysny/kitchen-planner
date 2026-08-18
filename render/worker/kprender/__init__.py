"""Kitchen Planner Blender/Cycles render worker.

Two halves, deliberately separated:

* **bpy-free** (:mod:`~kprender.package`, :mod:`~kprender.manifest`,
  :mod:`~kprender.convert`, :mod:`~kprender.matnames`,
  :mod:`~kprender.openpbr_map`) — importable under any Python 3.11, and where
  every computation lives.  ``render/worker/tests`` pins these.
* **bpy** (:mod:`~kprender.device`, :mod:`~kprender.textures`,
  :mod:`~kprender.materials`, :mod:`~kprender.lighting`,
  :mod:`~kprender.camera`, :mod:`~kprender.scene`, :mod:`~kprender.render`,
  :mod:`~kprender.cli`) — thin wiring that only *applies* the numbers above.
  Importing any of them outside Blender raises ``ImportError``.

Nothing in this package may import a third-party module: at render time it runs
inside Blender's bundled interpreter, where there is no ``pip install``.

This ``__init__`` imports nothing on purpose, so ``import kprender.convert``
stays bpy-free.
"""

__all__: list[str] = []
__version__ = "0.1.0"
