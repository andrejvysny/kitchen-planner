"""Rebuilding every imported glTF material from its ``kp:`` identity.

The GLB carries baked, flattened materials: a colour and a roughness, no wood
grain, no tiling, no idea which library entry a surface came from.  What it
*does* carry is the name the app stamped on it (``src/model/materialName.ts``),
and that name is enough to rebuild the real thing here.

Per material::

    strip ".001"  →  matnames.parse  →  (library | plain | shell | product)
                          ↓ (name unparseable)
                     glTF extras "kp" custom property
                          ↓ (still nothing)
                     leave the imported material alone, count it as "kept"

Everything rebuilt gets a fresh node tree: one Principled BSDF, the OpenPBR
parameters projected onto it by :mod:`kprender.openpbr_map`, the texture chain
from :mod:`kprender.textures` when the entry has one, and a **Bevel node**
(1.5 mm, 4 samples) wired into ``Normal``.

Why a Bevel *node* and not a Bevel modifier: the geometry arrives from three.js
with split vertices, and cabinet fronts are extruded polygons with holes — a
modifier produces artefacts on both.  The shader-side bevel only rounds the
*shading* normal, which is all a 1.5 mm highlight needs to read as a real edge,
and it cannot break topology.  It is skipped on transmissive materials, where
a shading-only bevel on thin glass reads as a smear.

Nothing here derives geometry.  Anything geometric belongs upstream in the
app's panel list; anything cosmetic belongs here.
"""

from __future__ import annotations

from typing import Any

import bpy

from . import matnames
from .convert import srgb_hex_to_linear
from .manifest import Manifest, MaterialEntry
from .openpbr_map import LibraryEntry, principled_params, unmapped
from .textures import build_texture_nodes

__all__ = ["BEVEL_RADIUS", "BEVEL_SAMPLES", "rebuild_all"]

#: Shader-bevel radius in metres — a 1.5 mm eased edge, the scale of a real
#: sanded/postformed cabinet arris.
BEVEL_RADIUS = 0.0015
BEVEL_SAMPLES = 4

#: Flat-finish roughness for `kp:c:` materials, mirroring meshKit's matte()/wood().
PLAIN_ROUGHNESS = {"matte": 0.82, "wood": 0.62}

#: Room-shell roughness for `kp:s:` materials without a library entry. Walls are
#: the roughest (paint), ceilings marginally more so, floors slightly less.
SHELL_ROUGHNESS = {"wall": 0.94, "floor": 0.88, "ceiling": 0.95}

#: Bought products: fixed looks that never came from the material library.
#: Values are Principled socket names, so they land through the same
#: presence-checked applier as the mapped OpenPBR ones. ``None`` for Base Color
#: means "keep whatever colour the viewport/GLB had" — those items are already
#: art-directed in the app and re-inventing their palette here would drift.
PRODUCT_PARAMS: dict[str, dict[str, Any]] = {
    "steel": {"Metallic": 1.0, "Roughness": 0.35},
    "appliance-glass": {"Metallic": 0.0, "Roughness": 0.25, "Coat Weight": 0.2},
    "appliance-black": {"Metallic": 0.0, "Roughness": 0.5},
    "appliance-ring": {"Metallic": 0.2, "Roughness": 0.4},
    "handle": {"Metallic": 0.8, "Roughness": 0.3},
    "bulb": {"Roughness": 0.5, "Emission Strength": 5.0, "Emission Color": (1.0, 0.87, 0.72)},
    "window-glass": {"Metallic": 0.0, "Roughness": 0.02, "Transmission Weight": 1.0},
    "window-frame": {"Metallic": 0.0, "Roughness": 0.5},
    "door-leaf": {"Metallic": 0.0, "Roughness": 0.6},
    "door-knob": {"Metallic": 0.85, "Roughness": 0.25},
    "groove": {"Metallic": 0.0, "Roughness": 0.7},
    "ground": {"Metallic": 0.0, "Roughness": 0.95},
}

#: Products whose surface is transmissive — no shader bevel (see module docs).
_TRANSMISSIVE_PRODUCTS = frozenset({"window-glass", "appliance-glass"})


# --------------------------------------------------------------------------
# small bpy helpers, each guarding one thing that moved between releases
# --------------------------------------------------------------------------


def _socket_value(socket: Any, value: Any) -> Any:
    """Coerce ``value`` to what ``socket`` accepts (RGBA wants four floats)."""
    kind = getattr(socket, "type", "VALUE")
    if kind == "RGBA":
        rgb = tuple(float(c) for c in value)[:3]
        if len(rgb) == 1:
            rgb = (rgb[0], rgb[0], rgb[0])
        return (*rgb, 1.0)
    if kind == "VECTOR":
        return tuple(float(c) for c in value)[:3]
    if kind == "BOOLEAN":
        return bool(value)
    if isinstance(value, (tuple, list)):
        return float(value[0])
    return float(value)


def _apply(bsdf: Any, params: dict[str, Any], report: dict[str, Any]) -> None:
    """Assign ``{socket: value}``, recording sockets this build does not have.

    The presence check is the version guard: ``Thin Wall`` only exists on
    Blender ≥ 4.3, ``Diffuse Roughness`` on ≥ 4.0, and a build without one
    should render slightly differently, never crash.
    """
    for name, value in params.items():
        socket = bsdf.inputs.get(name)
        if socket is None:
            report["unmapped_inputs"].append(f"socket:{name}")
            continue
        try:
            socket.default_value = _socket_value(socket, value)
        except (TypeError, ValueError) as exc:  # pragma: no cover - bpy runtime
            report["unmapped_inputs"].append(f"socket:{name} ({exc})")


def _mix_multiply(node_tree: Any, texture_socket: Any, tint: tuple[float, float, float]) -> Any:
    """``texture × tint`` as a Mix node, returning the colour output socket.

    Sockets are found by TYPE, not by index: ``ShaderNodeMix`` exposes an
    ``A``/``B``/``Factor`` triple per data type, and their ordering has shifted
    between releases while the types have not.
    """
    mix = node_tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.location = (-260.0, 300.0)

    factor = next((s for s in mix.inputs if s.name == "Factor" and s.type == "VALUE"), None)
    if factor is not None:
        factor.default_value = 1.0
    colour_inputs = [s for s in mix.inputs if s.type == "RGBA"]
    result = next((s for s in mix.outputs if s.type == "RGBA"), mix.outputs[0])
    if len(colour_inputs) >= 2:
        node_tree.links.new(texture_socket, colour_inputs[0])
        colour_inputs[1].default_value = (*tint, 1.0)
    return result


def _add_bevel(node_tree: Any, bsdf: Any, normal_socket: Any | None) -> None:
    """Wire a Bevel node into ``Normal``, chaining a Normal Map when present."""
    bevel = node_tree.nodes.new("ShaderNodeBevel")
    bevel.location = (-260.0, -320.0)
    if hasattr(bevel, "samples"):
        bevel.samples = BEVEL_SAMPLES
    radius = bevel.inputs.get("Radius")
    if radius is not None:
        radius.default_value = BEVEL_RADIUS
    if normal_socket is not None:
        bevel_normal = bevel.inputs.get("Normal")
        if bevel_normal is not None:
            node_tree.links.new(normal_socket, bevel_normal)
    target = bsdf.inputs.get("Normal")
    if target is not None:
        node_tree.links.new(bevel.outputs["Normal"], target)


def _fresh_tree(mat: Any) -> tuple[Any, Any]:
    """Clear ``mat``'s nodes down to Principled → Material Output."""
    mat.use_nodes = True
    node_tree = mat.node_tree
    node_tree.nodes.clear()
    output = node_tree.nodes.new("ShaderNodeOutputMaterial")
    output.location = (300.0, 0.0)
    bsdf = node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0.0, 0.0)
    node_tree.links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return node_tree, bsdf


def _viewport_rgb(mat: Any) -> tuple[float, float, float]:
    """The imported material's display colour (already linear) as a fallback."""
    try:
        return tuple(float(c) for c in mat.diffuse_color[:3])  # type: ignore[return-value]
    except (AttributeError, TypeError):  # pragma: no cover - defensive
        return (0.8, 0.8, 0.8)


# --------------------------------------------------------------------------
# parameter synthesis
# --------------------------------------------------------------------------


def _base_rgb(
    desc: matnames.MatDesc, entry: MaterialEntry | None, mat: Any
) -> tuple[float, float, float]:
    """Final base colour: the name's hex wins, then the manifest's, then the
    colour the GLB shipped with."""
    for hex6 in (desc.hex6, entry.base_color_hex if entry else None):
        if hex6:
            try:
                return srgb_hex_to_linear(hex6)
            except ValueError:
                continue
    return _viewport_rgb(mat)


def _synth_params(
    desc: matnames.MatDesc,
    lib: LibraryEntry | None,
    entry: MaterialEntry | None,
    mat: Any,
    report: dict[str, Any],
) -> dict[str, Any]:
    """The Principled parameter dict for one material, before textures."""
    if lib is not None:
        params = principled_params(lib.openpbr)
        for key in unmapped(lib.openpbr):
            report["unmapped_inputs"].append(f"openpbr:{key}")
        # A tintable entry (the two plastics) is a white base the app colours
        # per instance, so the name's hex — not the library's — is the truth.
        if lib.tintable:
            params["Base Color"] = _base_rgb(desc, entry, mat)
        return params

    params: dict[str, Any] = {"Base Color": _base_rgb(desc, entry, mat)}
    if desc.kind == "plain":
        params["Roughness"] = PLAIN_ROUGHNESS.get(desc.fallback or "matte", 0.82)
    elif desc.kind == "shell":
        params["Roughness"] = SHELL_ROUGHNESS.get(desc.surface or "wall", 0.94)
    elif desc.kind == "product":
        params.update(PRODUCT_PARAMS.get(desc.product or "", {"Roughness": 0.5}))
    else:  # a library name whose entry is missing from the library file
        params["Roughness"] = 0.5
    return params


def _is_transmissive(desc: matnames.MatDesc, params: dict[str, Any]) -> bool:
    if desc.kind == "product" and desc.product in _TRANSMISSIVE_PRODUCTS:
        return True
    return float(params.get("Transmission Weight", 0.0) or 0.0) > 0.0


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def _collapse_duplicates(report: dict[str, Any]) -> dict[str, Any]:
    """One canonical material per stripped name; re-point every mesh slot.

    Blender appends ``.001`` on an import name collision, so a scene can carry
    several copies of ``kp:m:oak:c9a87c``.  Collapsing them first means the
    rebuild (and the texture image loads) happens once.
    """
    canonical: dict[str, Any] = {}
    replacement: dict[str, Any] = {}
    for mat in bpy.data.materials:
        stripped = matnames.strip_blender_suffix(mat.name)
        keeper = canonical.setdefault(stripped, mat)
        if keeper is not mat:
            replacement[mat.name] = keeper

    if replacement:
        for mesh in bpy.data.meshes:
            for index, slot_mat in enumerate(mesh.materials):
                if slot_mat is not None and slot_mat.name in replacement:
                    mesh.materials[index] = replacement[slot_mat.name]
        report["collapsed"] = len(replacement)
    return canonical


def rebuild_all(
    manifest: Manifest, library: dict[str, LibraryEntry], opts: Any = None
) -> dict[str, Any]:
    """Rebuild every recognisable material in the open blend file.

    ``opts`` is duck-typed (the CLI's option object): only ``uv_box`` is read.
    Returns — and prints — a report the CLI folds into its summary.
    """
    uv_box = bool(getattr(opts, "uv_box", False))
    report: dict[str, Any] = {
        "rebuilt": 0,
        "kept": 0,
        "collapsed": 0,
        "missing_textures": [],
        "unmapped_inputs": [],
    }
    entries = manifest.material_by_name()
    canonical = _collapse_duplicates(report)

    for stripped, mat in canonical.items():
        desc = matnames.parse(stripped)
        if desc is None:
            # The name is the contract, but glTF extras may have survived as an
            # ID custom property — free second chance.
            desc = matnames.from_extras(mat.get("kp"))
        if desc is None:
            report["kept"] += 1
            continue

        entry = entries.get(stripped)
        lib = library.get(desc.mat_id) if desc.mat_id else None
        fallback_rgb = _base_rgb(desc, entry, mat)

        node_tree, bsdf = _fresh_tree(mat)
        params = _synth_params(desc, lib, entry, mat, report)
        params.setdefault("Base Color", fallback_rgb)

        normal_socket = None
        if lib is not None and lib.texture_set is not None:
            tex = build_texture_nodes(
                node_tree, lib.texture_set, lib.tile_meters, desc.rot, uv_box=uv_box
            )
            if tex is None:
                report["missing_textures"].append(lib.texture_set.ref)
            else:
                normal_socket = tex.normal
                if tex.color is not None:
                    colour = tex.color
                    if lib.texture_set.base_color_mode == "multiply":
                        colour = _mix_multiply(node_tree, tex.color, lib.texture_set.tint)
                    target = bsdf.inputs.get("Base Color")
                    if target is not None:
                        node_tree.links.new(colour, target)
                        params.pop("Base Color", None)
                if tex.roughness is not None:
                    target = bsdf.inputs.get("Roughness")
                    if target is not None:
                        node_tree.links.new(tex.roughness, target)
                        params.pop("Roughness", None)

        transmissive = _is_transmissive(desc, params)
        if transmissive and "Thin Wall" not in bsdf.inputs:
            # No thin-wall mode on this build: a single-sided pane would
            # refract as if it were solid glass, so drop the IOR to air.
            params["IOR"] = 1.0
        _apply(bsdf, params, report)

        if transmissive:
            if normal_socket is not None:
                target = bsdf.inputs.get("Normal")
                if target is not None:
                    node_tree.links.new(normal_socket, target)
        else:
            _add_bevel(node_tree, bsdf, normal_socket)

        report["rebuilt"] += 1

    report["missing_textures"] = sorted(set(report["missing_textures"]))
    report["unmapped_inputs"] = sorted(set(report["unmapped_inputs"]))
    print(f"kprender/materials: {report}")
    return report


def hide_glass_shadows() -> int:
    """``visible_shadow = False`` on every window pane — the archviz classic.

    Window glass casts a slightly grey, slightly noisy shadow that no real
    window has, and it fights the light portals for the same photons.  Returns
    how many objects were changed.
    """
    changed = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        slots = [s.material for s in obj.material_slots if s.material is not None]
        if not any(_is_window_glass(m.name) for m in slots):
            continue
        # Blender 3.x kept these under obj.cycles.*; 4.x+ has them on the object.
        if hasattr(obj, "visible_shadow"):
            obj.visible_shadow = False
            changed += 1
        elif hasattr(obj, "cycles") and hasattr(obj.cycles, "cast_shadow"):  # pragma: no cover
            obj.cycles.cast_shadow = False
            changed += 1
    return changed


def _is_window_glass(name: str) -> bool:
    desc = matnames.parse(name)
    return desc is not None and desc.kind == "product" and desc.product == "window-glass"
