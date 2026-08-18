"""Coordinate, colour and photometric conventions — the one place signs live.

Stdlib only, no ``bpy``: every number the render pipeline depends on is
computed here so it can be pinned by pytest without Blender.

Axis rule
=========

Three frames are involved, and exactly two conversions::

    plan space (src/plan2d)      x right, y DOWN on screen, metres
    glTF / three world           x right, y UP, z toward the viewer
    Blender world                x right, y INTO the screen, z UP

**App → glTF** is done by the app and baked into the manifest: the viewport
maps plan ``(x, y)`` to world ``(x, z)`` with ``y`` becoming height, i.e.
``plan (px, py) @ height h  →  glTF (px, h, py)`` (CLAUDE.md, "Coordinate
conventions").  Every vector in ``manifest.json`` is already in that glTF
frame — the manifest states so in its ``axis: "gltf-y-up"`` field.

**glTF → Blender** is this module's :func:`to_blender`::

    (x, y_up, z)  →  (x, −z, y_up)

Composing the two gives the end-to-end rule quoted by the milestone plan::

    plan (px, py) @ height h  →  Blender (px, −py, h)

The map is a *proper* rotation — it is exactly ``Rx(+90°)``, determinant +1 —
which matters twice over:

* directions transform with the same expression as positions
  (:func:`dir_to_blender`), because there is no translation and no mirroring;
* a rotation about glTF ``+Y`` by θ becomes a rotation about Blender ``+Z`` by
  *the same* θ (conjugating an axis-angle rotation by ``R`` maps its axis
  through ``R``, and ``Rx(90°)·(0,1,0) = (0,0,1)``).  That second fact is what
  lets :mod:`kprender.lighting` write a bar light's ``rotation_euler.z`` as the
  manifest's ``yawRad`` with no sign flip; see the derivation there.

A mirroring map (e.g. ``(x, z, y)``) would have flipped the handedness and
silently inverted every normal and every yaw — hence the explicit test
(``tests/test_convert.py``) that the basis images are right-handed.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

Vec3T = tuple[float, float, float]

__all__ = [
    "aim_euler",
    "cross",
    "dir_to_blender",
    "kelvin_from_warmth",
    "kelvin_to_rgb",
    "matrix_from_basis",
    "negate",
    "normalize",
    "plan_to_blender",
    "srgb_hex_to_linear",
    "sun_rotation",
    "to_blender",
    "watts_for",
]


# --------------------------------------------------------------------------
# vectors
# --------------------------------------------------------------------------


def _xyz(v: Any) -> Vec3T:
    """Accept a ``{x, y, z}`` dict, an ``(x, y, z)`` sequence, or any object
    carrying ``.x/.y/.z`` (``manifest.Vec3``)."""
    if isinstance(v, dict):
        return (float(v["x"]), float(v["y"]), float(v["z"]))
    if isinstance(v, Sequence) and not isinstance(v, str | bytes):
        if len(v) != 3:
            raise ValueError(f"expected a 3-component vector, got {len(v)}")
        return (float(v[0]), float(v[1]), float(v[2]))
    try:
        return (float(v.x), float(v.y), float(v.z))
    except AttributeError as exc:  # pragma: no cover - programmer error
        raise TypeError(f"not a vector: {v!r}") from exc


def to_blender(v: Any) -> Vec3T:
    """glTF/three world position ``(x, y_up, z)`` → Blender ``(x, −z, y_up)``."""
    x, y, z = _xyz(v)
    return (x, -z, y)


def dir_to_blender(v: Any) -> Vec3T:
    """Same linear map as :func:`to_blender`, for directions.

    Separate name on purpose: the map happens to be translation-free today, and
    a reader should not have to prove that before reusing it on a normal.
    """
    return to_blender(v)


def plan_to_blender(x: float, y: float, height: float = 0.0) -> Vec3T:
    """End-to-end convenience: plan metres ``(x, y)`` at ``height`` → Blender."""
    return (float(x), -float(y), float(height))


def negate(v: Any) -> Vec3T:
    x, y, z = _xyz(v)
    return (-x, -y, -z)


def cross(a: Any, b: Any) -> Vec3T:
    ax, ay, az = _xyz(a)
    bx, by, bz = _xyz(b)
    return (ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)


def normalize(v: Any, fallback: Vec3T = (0.0, 0.0, -1.0)) -> Vec3T:
    x, y, z = _xyz(v)
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-12:
        return fallback
    return (x / length, y / length, z / length)


# --------------------------------------------------------------------------
# orientation
# --------------------------------------------------------------------------


def aim_euler(direction: Any, roll: float = 0.0) -> Vec3T:
    """XYZ Euler angles aiming a lamp's local ``−Z`` along ``direction``.

    Blender lamps (SUN, SPOT, AREA) emit along their object-local ``−Z``.  With
    Blender's default ``XYZ`` Euler order a vector is transformed as
    ``v' = Rz·Ry·Rx·v``; fixing ``ry = 0`` and feeding in ``(0, 0, −1)``::

        Rx(a)·(0, 0, −1) = (0,  sin a,          −cos a)
        Rz(c)·that       = (−sin a·sin c,  sin a·cos c,  −cos a)

    Matching that against ``d = (dx, dy, dz)`` gives the closed form used
    below::

        a = acos(−dz)              (so sin a = √(1 − dz²) ≥ 0)
        c = atan2(−dx, dy)

    ``roll`` is added to ``c``.  For a lamp aiming straight down (``a = 0``) the
    lamp's local ``+Z`` coincides with world ``+Z``, so that extra term is
    exactly a spin about the lamp's own axis — which is what a rectangular bar
    light's yaw means.  For a tilted lamp it is a world-``Z`` spin instead; the
    manifest only ever yaws downward-facing bars, and spots pass ``roll = 0``.
    """
    dx, dy, dz = normalize(direction)
    a = math.acos(max(-1.0, min(1.0, -dz)))
    sin_a = math.hypot(dx, dy)
    c = math.atan2(-dx, dy) if sin_a > 1e-9 else 0.0
    return (a, 0.0, c + roll)


def matrix_from_basis(
    x_axis: Any, y_axis: Any, z_axis: Any, location: Any
) -> tuple[tuple[float, float, float, float], ...]:
    """A 4×4 world matrix, ROW-major (``mathutils.Matrix`` takes rows).

    The three axes are the images of the object's local X/Y/Z in world space —
    i.e. the *columns* of the rotation block — so row ``i`` is
    ``(x_axis[i], y_axis[i], z_axis[i], location[i])``.
    """
    ax = _xyz(x_axis)
    ay = _xyz(y_axis)
    az = _xyz(z_axis)
    loc = _xyz(location)
    return (
        *((ax[i], ay[i], az[i], loc[i]) for i in range(3)),
        (0.0, 0.0, 0.0, 1.0),
    )


def sun_rotation(azimuth_deg: float) -> float:
    """Sky-Texture ``sun_rotation`` (radians) for the app's ``sunAzimuth``.

    The app measures azimuth from glTF ``+z`` increasing toward ``+x``
    (src/model/sky.ts), so the sun's horizontal bearing there is
    ``(sin az, ·, cos az)``.  Converted with :func:`to_blender` that becomes
    ``(sin az, −cos az)`` in Blender's XY plane, whose CCW angle from ``+X`` is

        ``atan2(−cos az, sin az) = atan2(sin(az − 90°), cos(az − 90°)) = az − 90°``

    and Blender's Nishita ``sun_rotation`` is exactly that CCW-from-``+X``
    bearing.
    """
    return math.radians(azimuth_deg - 90.0)


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------


def _srgb_eotf(c: float) -> float:
    """sRGB electro-optical transfer function (IEC 61966-2-1), NOT ``x/255``."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb_hex_to_linear(hex6: str) -> Vec3T:
    """``"#c9a87c"`` / ``"c9a87c"`` → linear-light RGB in 0..1.

    Blender node ``default_value``s are linear; feeding raw ``byte/255`` there
    is the classic washed-out-render bug.
    """
    h = hex6.strip()
    if h.startswith("#"):
        h = h[1:]
    if len(h) != 6:
        raise ValueError(f"srgb_hex_to_linear: not a 6-digit hex colour: {hex6!r}")
    try:
        r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError as exc:
        raise ValueError(f"srgb_hex_to_linear: not a hex colour: {hex6!r}") from exc
    return (_srgb_eotf(r / 255.0), _srgb_eotf(g / 255.0), _srgb_eotf(b / 255.0))


def kelvin_from_warmth(warmth: float) -> float:
    """``LightProps.warmth`` (0 cool … 1 warm) → colour temperature in kelvin.

    ``1e6 / (125 + 330·w)``: ``w = 0`` → 8000 K (cool white), ``w = 1`` →
    ≈2197.8 K (the plan's nominal "2200 K" candle end).  A reciprocal ramp is
    the physically sane one — mireds, not kelvin, are perceptually even.
    """
    return 1.0e6 / (125.0 + 330.0 * float(warmth))


def kelvin_to_rgb(kelvin: float) -> Vec3T:
    """Blackbody colour at ``kelvin``, as LINEAR RGB in 0..1.

    Tanner Helland's piecewise fit to the Planckian locus
    (https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html,
    itself fitted to Mitchell Charity's blackbody table).  It is defined for
    1000–40000 K and produces *display* (sRGB-encoded) values, so the result is
    pushed back through the sRGB EOTF here — Blender wants linear.

    Chosen over Blender's own Blackbody shader node because the value is also
    needed for lamps whose colour is set as a plain RGB (and because a number
    computed here is a number pytest can pin).
    """
    temp = max(1000.0, min(40000.0, float(kelvin))) / 100.0

    red = 255.0 if temp <= 66.0 else 329.698727446 * ((temp - 60.0) ** -0.1332047592)

    if temp <= 66.0:
        green = 99.4708025861 * math.log(temp) - 161.1195681661
    else:
        green = 288.1221695283 * ((temp - 60.0) ** -0.0755148492)

    if temp >= 66.0:
        blue = 255.0
    elif temp <= 19.0:
        blue = 0.0
    else:
        blue = 138.5177312231 * math.log(temp - 10.0) - 305.0447927307

    clamp = lambda v: max(0.0, min(255.0, v)) / 255.0  # noqa: E731
    return (_srgb_eotf(clamp(red)), _srgb_eotf(clamp(green)), _srgb_eotf(clamp(blue)))


# --------------------------------------------------------------------------
# photometry
# --------------------------------------------------------------------------

#: Watts at ``intensity = 0`` and at ``intensity = 1``, per fixture kind. The
#: bar row is per METRE of emitter length (multiplied by ``sizeX``).
#: CALIBRATION CONSTANTS — the milestone plan's §7 table, deliberately
#: unmeasured; a later calibration session tunes them against real renders.
_WATTS: dict[str, tuple[float, float]] = {
    "point": (10.0, 90.0),
    "spot": (15.0, 135.0),
    "bar": (5.0, 25.0),
}


def watts_for(
    kind: str, intensity01: float, boost: float, size_x: float | None = None
) -> float:
    """Cycles lamp power in watts for a manifest fixture.

    ``boost`` is the manifest's ``sky.lampBoost`` — the same ``1.44 × (1 −
    daylight)`` gate the viewport applies in ``View3D.relight()``, so a lamp in
    a fully daylit scene contributes nothing here either (boost 0 ⇒ 0 W) and
    the render matches what the user framed.
    """
    try:
        base, span = _WATTS[kind]
    except KeyError as exc:
        raise ValueError(f"watts_for: unknown light kind {kind!r}") from exc
    watts = (base + span * float(intensity01)) * float(boost)
    if kind == "bar":
        watts *= float(size_x if size_x is not None else 1.0)
    return watts
