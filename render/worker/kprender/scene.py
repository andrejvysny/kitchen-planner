"""Scene bootstrap: empty the factory startup file, import the GLB.

``--factory-startup`` still gives us the default cube, lamp and camera, and the
manifest supplies its own camera and lights — so everything is cleared before
the import rather than merged around.  Orphan data-blocks are purged too: a
leftover mesh in ``bpy.data`` would ride along into a ``--save-blend``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import bpy

__all__ = ["clean", "drop_ceiling", "import_glb"]


def clean(scene: Any = None) -> None:
    """Remove every object and purge orphaned data-blocks."""
    scene = scene or bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.images,
        bpy.data.curves,
    ):
        for block in list(collection):
            if getattr(block, "users", 0) == 0:
                collection.remove(block)


def import_glb(path: str | Path) -> int:
    """Import ``path`` and return how many objects it added.

    The operator moved namespaces once before (``import_scene.gltf`` is the
    long-standing id; newer builds also register ``wm.gltf_import``), so both
    are probed.
    """
    before = set(bpy.data.objects.keys())
    filepath = str(Path(path))

    if hasattr(bpy.ops.import_scene, "gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif hasattr(bpy.ops.wm, "gltf_import"):  # pragma: no cover - future-proofing
        bpy.ops.wm.gltf_import(filepath=filepath)
    else:  # pragma: no cover - a build without the glTF addon
        raise SystemExit(
            "kprender/scene: this Blender build has no glTF importer "
            "(neither import_scene.gltf nor wm.gltf_import)"
        )

    added = len(set(bpy.data.objects.keys()) - before)
    print(f"kprender/scene: imported {added} object(s) from {Path(filepath).name}")
    return added


def drop_ceiling(prefix: str = "Ceiling") -> int:
    """Delete ceiling slabs so an overhead render can see into the room.

    Matches on the object name the app gives them; a mesh the user renamed
    simply stays, which is the safe failure direction.
    """
    victims = [obj for obj in bpy.data.objects if obj.name.startswith(prefix)]
    for obj in victims:
        bpy.data.objects.remove(obj, do_unlink=True)
    if victims:
        print(f"kprender/scene: removed {len(victims)} ceiling object(s)")
    return len(victims)
