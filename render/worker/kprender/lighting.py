"""Sun, sky, fixture lamps and window portals.

Everything in this module is a thin application of numbers computed in
:mod:`kprender.convert`; the derivations that are easy to get wrong are spelled
out below so a future reader can check them without a render.

Sun
===

The manifest's ``sky.sunDirection`` points **from the scene toward the sun**.
Light travels the other way, and a Blender lamp emits along its local ``−Z``, so
the sun object is aimed with ``aim_euler(−sunDirection_blender)``.  Substituting
the app's azimuth/elevation into that closed form yields
``rotation_euler = (zenith_angle, 0, azimuth)`` — i.e. Blender's Z Euler term
*is* the app's azimuth in radians, and the X term is 90° − elevation.  (Worked
through in ``convert.aim_euler``'s docstring; ``tests/test_convert.py`` pins the
golden manifest's numbers.)

The Sky Texture gets ``sun_rotation = radians(az − 90)`` instead — a different
number for a different convention (bearing CCW from ``+X`` versus a lamp's Euler
Z), which is exactly why both live in :mod:`kprender.convert` with their
derivations attached.  ``sun_disc`` is switched **off**: the Sun lamp already
provides a crisp disc with real shadow softness, and doubling it up would both
double-count the direct light and turn any azimuth-convention slip into a
visible second sun.

Bar (LED strip) yaw
===================

The manifest's ``yawRad`` is the item group's rotation about glTF ``+Y``
(``View3D.placeItem`` sets ``group.rotation.y = −item.rotation``).  Converting
the frame with ``Rx(+90°)`` maps that axis to Blender ``+Z``:
``Rx(90°)·(0,1,0) = (0,0,1)``, and conjugating a rotation by a rotation
preserves its angle.  So the Blender yaw is ``+yawRad`` — **no sign flip**.

Checked component-wise as well: the item's local ``+x`` (its width axis) lands
at glTF ``(cos θ, 0, −sin θ)`` under three's Y rotation, which
:func:`kprender.convert.to_blender` sends to ``(cos θ, sin θ, 0)`` — precisely
where Blender's ``Rz(θ)`` puts local ``+X``.  A bar aims straight down, so
:func:`kprender.convert.aim_euler` returns ``(0, 0, yaw)`` and the rectangle's
local ``+X`` (its ``size`` axis) runs along the strip.

Window portals
==============

A portal is a rectangular area light lying **in the wall aperture**, marked
``cycles.is_portal``.  It emits nothing; it tells Cycles where the useful
incoming light is, which is what makes an interior converge in minutes instead
of hours.

Orientation is built as an explicit basis rather than Euler angles, because all
three axes are already known:

* local ``+X`` = the wall tangent (so the light's ``size`` is the aperture width);
* local ``−Z`` = the room-inward normal (an area light emits along ``−Z``, and a
  portal must face into the room);
* local ``+Y`` = ``Z × X``, which for a vertical aperture comes out ±world-down.
  Either sign is fine: the rectangle is centred, so flipping it in Y is the same
  rectangle, and only the plane and the X axis carry meaning.

The 0.05 m inset per side keeps the portal just inside the reveal so it does not
poke through the wall slab — a portal intersecting geometry leaks.
"""

from __future__ import annotations

from contextlib import suppress
from math import radians
from typing import Any

import bpy

from . import materials as materials_mod
from .convert import (
    aim_euler,
    cross,
    dir_to_blender,
    kelvin_from_warmth,
    kelvin_to_rgb,
    matrix_from_basis,
    negate,
    normalize,
    srgb_hex_to_linear,
    sun_rotation,
    to_blender,
    watts_for,
)
from .manifest import Light, Manifest, Portal

__all__ = ["PORTAL_INSET", "SUN_ANGLE_DEG", "SUN_W", "apply"]

#: CALIBRATION CONSTANT. Converts the viewport's arbitrary "sun intensity"
#: slider into Cycles watts/m². Marked for the light-unit calibration session
#: the milestone plan defers; nothing else in the pipeline depends on its value.
SUN_W = 3.0

#: Angular diameter of the sun's disc. The real sun is 0.53°; a touch wider
#: softens contact shadows just enough to look photographic rather than CG.
SUN_ANGLE_DEG = 0.9

#: Portal inset per side (m) — keeps the light plane clear of the wall slab.
PORTAL_INSET = 0.05

#: World strength for the flat night sky.
NIGHT_WORLD_STRENGTH = 0.15


def _enum_ids(rna_owner: Any, prop: str) -> list[str]:
    """Identifiers of an enum property on this Blender build, or ``[]``."""
    try:
        return [item.identifier for item in rna_owner.bl_rna.properties[prop].enum_items]
    except (AttributeError, KeyError):  # pragma: no cover - defensive
        return []


def _new_object(name: str, data: Any, scene: Any) -> Any:
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------------------
# sun + world
# --------------------------------------------------------------------------


def _add_sun(manifest: Manifest, scene: Any) -> tuple[Any, float]:
    sky = manifest.sky
    data = bpy.data.lights.new("KP Sun", type="SUN")
    data.angle = radians(SUN_ANGLE_DEG)
    energy = sky.viewport.sun_intensity * sky.brightness * SUN_W
    data.energy = energy
    with suppress(ValueError):  # a malformed hex just leaves the lamp white
        data.color = srgb_hex_to_linear(sky.viewport.sun_color)
    obj = _new_object("KP Sun", data, scene)
    obj.rotation_euler = aim_euler(negate(dir_to_blender(sky.sun_direction)))
    return obj, energy


def _build_world(manifest: Manifest, scene: Any) -> str:
    """Nishita sky by day, flat dark colour at night.  Returns a log note."""
    sky = manifest.sky
    world = bpy.data.worlds.new("KP World")
    scene.world = world
    world.use_nodes = True
    node_tree = world.node_tree
    node_tree.nodes.clear()
    output = node_tree.nodes.new("ShaderNodeOutputWorld")
    output.location = (300.0, 0.0)
    background = node_tree.nodes.new("ShaderNodeBackground")
    background.location = (0.0, 0.0)
    node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])

    if sky.night:
        background.inputs["Color"].default_value = (
            *srgb_hex_to_linear(sky.viewport.background),
            1.0,
        )
        background.inputs["Strength"].default_value = NIGHT_WORLD_STRENGTH
        return "night: flat world"

    node = node_tree.nodes.new("ShaderNodeTexSky")
    node.location = (-300.0, 0.0)
    types = _enum_ids(node, "sky_type")
    if "NISHITA" in types:
        node.sky_type = "NISHITA"
    elif types:  # pragma: no cover - very old build
        print(f"kprender/lighting: no NISHITA sky on this build (has {types}); keeping default")
    if hasattr(node, "sun_disc"):
        node.sun_disc = False
    if hasattr(node, "sun_elevation"):
        node.sun_elevation = radians(sky.elevation_deg)
    if hasattr(node, "sun_rotation"):
        node.sun_rotation = sun_rotation(sky.azimuth_deg)
    node_tree.links.new(node.outputs["Color"], background.inputs["Color"])
    background.inputs["Strength"].default_value = sky.brightness
    return f"day: {getattr(node, 'sky_type', '?')} sky"


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def _light_colour(light: Light) -> tuple[float, float, float]:
    if light.color_hex:
        try:
            return srgb_hex_to_linear(light.color_hex)
        except ValueError:  # pragma: no cover - manifest already validated
            pass
    return kelvin_to_rgb(kelvin_from_warmth(light.warmth))


def _add_fixture(light: Light, boost: float, scene: Any) -> Any | None:
    blender_type = {"point": "POINT", "spot": "SPOT", "bar": "AREA"}[light.kind]
    data = bpy.data.lights.new(f"KP {light.kind} {light.item_id}", type=blender_type)
    data.color = _light_colour(light)
    data.energy = watts_for(light.kind, light.intensity, boost, light.size_x)

    direction = dir_to_blender(light.direction)
    if light.kind == "point":
        data.shadow_soft_size = 0.03
        rotation = (0.0, 0.0, 0.0)
    elif light.kind == "spot":
        if light.cone_angle_rad is not None:
            data.spot_size = light.cone_angle_rad
        if light.cone_blend is not None:
            data.spot_blend = light.cone_blend
        data.shadow_soft_size = 0.02
        rotation = aim_euler(direction)
    else:  # bar
        data.shape = "RECTANGLE"
        data.size = max(float(light.size_x or 0.02), 0.001)
        data.size_y = max(float(light.size_y or 0.06), 0.001)
        rotation = aim_euler(direction, roll=light.yaw_rad)

    obj = _new_object(f"KP {light.kind} {light.item_id}", data, scene)
    obj.location = to_blender(light.position)
    obj.rotation_euler = rotation
    return obj


# --------------------------------------------------------------------------
# portals
# --------------------------------------------------------------------------


def _add_portal(portal: Portal, scene: Any) -> Any | None:
    from mathutils import Matrix  # Blender-bundled; import late to keep the top bpy-only

    width = max(portal.width - 2 * PORTAL_INSET, 0.05)
    height = max(portal.height - 2 * PORTAL_INSET, 0.05)

    data = bpy.data.lights.new(f"KP portal {portal.opening_id}", type="AREA")
    data.shape = "RECTANGLE"
    data.size = width
    data.size_y = height
    data.energy = 0.0  # a portal emits nothing; it only guides sampling
    # `is_portal` lives on the Cycles property group; probe the light itself too
    # in case a future release promotes it, and bail cleanly if neither exists —
    # an AREA light with is_portal unset would EMIT, which is far worse than
    # having no portal at all.
    cycles = getattr(data, "cycles", None)
    if cycles is not None and hasattr(cycles, "is_portal"):
        cycles.is_portal = True
    elif hasattr(data, "is_portal"):  # pragma: no cover - future API
        data.is_portal = True
    else:  # pragma: no cover - no Cycles portal support on this build
        print("kprender/lighting: this build has no light.cycles.is_portal; skipping portal")
        bpy.data.lights.remove(data)
        return None

    normal = normalize(dir_to_blender(portal.normal))
    tangent = normalize(dir_to_blender(portal.tangent))
    z_axis = negate(normal)  # local −Z must face into the room
    y_axis = normalize(cross(z_axis, tangent))

    obj = _new_object(f"KP portal {portal.opening_id}", data, scene)
    obj.matrix_world = Matrix(matrix_from_basis(tangent, y_axis, z_axis, to_blender(portal.center)))
    return obj


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def apply(manifest: Manifest, opts: Any = None, scene: Any = None) -> dict[str, Any]:
    """Build sun, world, fixtures and portals.  Returns a report dict.

    ``opts`` is duck-typed: only ``no_portals`` is read.
    """
    scene = scene or bpy.context.scene
    no_portals = bool(getattr(opts, "no_portals", False))
    boost = manifest.sky.lamp_boost

    _, sun_watts = _add_sun(manifest, scene)
    world_note = _build_world(manifest, scene)

    fixtures = 0
    skipped_off = 0
    for light in manifest.lights:
        if not light.on:
            skipped_off += 1
            continue
        if _add_fixture(light, boost, scene) is not None:
            fixtures += 1

    if fixtures and boost == 0.0:
        # Not a bug: the viewport gates fixture lamps by 1.44 x (1 - daylight)
        # too, so a fully daylit scene shows none of them. Said out loud
        # because "my pendant is dark" is otherwise a confusing render.
        print(
            f"kprender/lighting: {fixtures} fixture(s) at 0 W — sky.lampBoost is 0 "
            "(full daylight). Lower the sun or switch to night in the app to see them."
        )

    portals = 0
    portals_skipped = 0
    for portal in manifest.portals:
        if no_portals or portal.interior or portal.type != "window":
            portals_skipped += 1
            continue
        if _add_portal(portal, scene) is not None:
            portals += 1

    glass = materials_mod.hide_glass_shadows()

    report = {
        "sun_watts": round(sun_watts, 4),
        "world": world_note,
        "lamp_boost": boost,
        "fixtures": fixtures,
        "fixtures_off": skipped_off,
        "portals": portals,
        "portals_skipped": portals_skipped,
        "glass_shadow_off": glass,
    }
    print(f"kprender/lighting: {report}")
    return report
