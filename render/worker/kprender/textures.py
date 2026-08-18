"""Texture-set node subtrees (ambientCG CC0 sets, fetched by ``fetch_textures.py``).

A library entry's ``textureSet`` names a set (``ambientcg:Wood051``) and which
of its maps to use; ``render/materials/textures.lock.json`` says what the files
on disk are called.  This module turns that into the node chain::

    Texture Coordinate ──▶ Mapping ──┬──▶ Image Texture (Color,     sRGB)
                                     ├──▶ Image Texture (Roughness, Non-Color)
                                     └──▶ Image Texture (NormalGL,  Non-Color) ──▶ Normal Map

**Scale.**  The library's ``tileMeters`` mirrors the app's ``TILE_M``
(src/view3d/textures.ts): the photographed square covers that many metres, so
the Mapping node's scale is ``1 / tileMeters`` on X and Y.  A ``:r`` material
(the ``rot`` flag in the ``kp:`` name) adds a 90° turn about Z — the same
quarter turn the viewport applies, so a rotated worktop's grain runs the same
way in the render.

**Missing textures never fail a render.**  A set that was not fetched (no
network at ``setup.sh`` time, say) warns once and returns ``None``; the caller
falls back to the entry's flat OpenPBR parameters.  A render that is a little
plain beats a render that did not happen.

**UV vs box.**  Prism/ExtrudeGeometry UVs coming out of the app are unverified
(milestone plan §10), so ``--uv-box`` swaps the UV coordinate for object-space
box projection, which needs no UVs at all.  It is a diagnostic escape hatch,
not the default.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from math import pi
from pathlib import Path
from typing import Any

import bpy

from .openpbr_map import TextureSet

__all__ = ["TextureNodes", "build_texture_nodes", "load_lock", "resolve_set_dir"]

#: ``render/materials/`` — sibling of ``render/worker/``.
MATERIALS_DIR = Path(__file__).resolve().parents[2] / "materials"
LOCK_PATH = MATERIALS_DIR / "textures.lock.json"
TEXTURES_DIR = MATERIALS_DIR / "textures"

#: Box-projection blend (0..1): how softly the three planar projections cross
#: fade into each other on a corner. 0.2 is the usual archviz compromise.
BOX_BLEND = 0.2

_lock_cache: dict[str, dict[str, Any]] | None = None
_warned: set[str] = set()


def load_lock(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """``{ref: lock entry}`` from ``textures.lock.json`` (cached per process)."""
    global _lock_cache
    if _lock_cache is not None and path is None:
        return _lock_cache
    lock_path = path or LOCK_PATH
    try:
        with lock_path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"kprender/textures: cannot read {lock_path}: {exc}")
        data = {"sets": []}
    table = {str(entry["ref"]): entry for entry in data.get("sets", [])}
    if path is None:
        _lock_cache = table
    return table


def _warn_once(ref: str, message: str) -> None:
    if ref in _warned:
        return
    _warned.add(ref)
    print(f"kprender/textures: {message}")


def resolve_set_dir(ref: str) -> tuple[Path, dict[str, str]] | None:
    """``ref`` → (directory, ``{map name: filename}``), or ``None`` if unusable.

    ``None`` covers both "the lock file does not know this ref" and "the files
    were never fetched"; both warn exactly once per ref per process.
    """
    entry = load_lock().get(ref)
    if entry is None:
        _warn_once(ref, f"{ref} is not in textures.lock.json — using flat parameters")
        return None
    asset_id = str(entry.get("assetId") or ref.split(":")[-1])
    files = {str(k): str(v) for k, v in dict(entry.get("files") or {}).items()}
    directory = TEXTURES_DIR / asset_id
    missing = [name for name in files.values() if not (directory / name).is_file()]
    if missing or not files:
        _warn_once(
            ref,
            f"{ref}: {len(missing) or 'all'} map file(s) missing under {directory} — "
            "run render/materials/fetch_textures.py; using flat parameters",
        )
        return None
    return directory, files


@dataclass
class TextureNodes:
    """What :func:`build_texture_nodes` produced, as output sockets to link."""

    color: Any | None = None
    roughness: Any | None = None
    #: Output of a Normal Map node, ready to feed Principled ``Normal`` (or a
    #: Bevel node's ``Normal`` input).
    normal: Any | None = None
    nodes: list[Any] = field(default_factory=list)


def _load_image(path: Path, non_color: bool) -> Any | None:
    try:
        image = bpy.data.images.load(str(path), check_existing=True)
    except RuntimeError as exc:  # pragma: no cover - bpy runtime
        print(f"kprender/textures: cannot load {path}: {exc}")
        return None
    # colorspace_settings is a pointer that exists on every release we target,
    # but the *names* are build-dependent; assigning an unknown one raises.
    wanted = "Non-Color" if non_color else "sRGB"
    try:
        image.colorspace_settings.name = wanted
    except (AttributeError, TypeError):  # pragma: no cover - colour-mgmt drift
        print(f"kprender/textures: colour space {wanted!r} unavailable for {path.name}")
    return image


def build_texture_nodes(
    node_tree: Any,
    tex_set: TextureSet,
    tile_meters: float | None,
    rot: bool,
    *,
    uv_box: bool = False,
    origin: tuple[float, float] = (-900.0, 300.0),
) -> TextureNodes | None:
    """Create the coordinate → mapping → image chain for ``tex_set``.

    Returns ``None`` when the set is unavailable (caller falls back to flat
    parameters).  ``origin`` only positions the nodes for a readable
    ``--save-blend``.
    """
    resolved = resolve_set_dir(tex_set.ref)
    if resolved is None:
        return None
    directory, files = resolved

    nodes = node_tree.nodes
    links = node_tree.links
    x0, y0 = origin

    coord = nodes.new("ShaderNodeTexCoord")
    coord.location = (x0 - 400, y0)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (x0 - 200, y0)

    # Object coordinates are metres in object space, so the same 1/tileMeters
    # scale works for both projections; UV needs the mesh to actually carry
    # sane UVs, which is exactly what --uv-box exists to sidestep.
    links.new(coord.outputs["Object" if uv_box else "UV"], mapping.inputs["Vector"])

    tile = float(tile_meters) if tile_meters else 1.0
    scale = 1.0 / tile if tile else 1.0
    mapping.inputs["Scale"].default_value = (scale, scale, scale)
    if rot:
        mapping.inputs["Rotation"].default_value = (0.0, 0.0, pi / 2)

    out = TextureNodes(nodes=[coord, mapping])

    # map name in the library ("Color"/"Roughness"/"NormalGL") → the OpenPBR
    # parameter it feeds; iterate the library's own table so an entry that only
    # ships a colour map simply gets fewer nodes.
    slots = {v: k for k, v in tex_set.maps.items()}  # file-map name -> openpbr key
    row = 0
    for map_name, filename in files.items():
        openpbr_key = slots.get(map_name)
        if openpbr_key is None:
            continue
        non_color = openpbr_key != "base_color"
        image = _load_image(directory / filename, non_color)
        if image is None:
            continue
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.location = (x0, y0 - row * 280)
        tex.label = f"{tex_set.ref} {map_name}"
        if uv_box:
            tex.projection = "BOX"
            if hasattr(tex, "projection_blend"):
                tex.projection_blend = BOX_BLEND
        links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
        out.nodes.append(tex)
        row += 1

        if openpbr_key == "base_color":
            out.color = tex.outputs["Color"]
        elif openpbr_key == "specular_roughness":
            out.roughness = tex.outputs["Color"]
        elif openpbr_key == "geometry_normal":
            normal_map = nodes.new("ShaderNodeNormalMap")
            normal_map.location = (x0 + 220, y0 - (row - 1) * 280)
            links.new(tex.outputs["Color"], normal_map.inputs["Color"])
            out.nodes.append(normal_map)
            out.normal = normal_map.outputs["Normal"]

    if out.color is None and out.roughness is None and out.normal is None:
        _warn_once(tex_set.ref, f"{tex_set.ref}: no usable maps — using flat parameters")
        for node in out.nodes:
            nodes.remove(node)
        return None
    return out
