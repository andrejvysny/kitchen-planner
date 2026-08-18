"""RenderManifest v1 — the Python twin of ``src/model/renderManifest.ts``.

The manifest is everything glTF cannot carry: the framed camera, the sun/sky
state, every fixture light in world space, the window apertures (light portals)
and the semantic identity of every material in the GLB.  ``render/manifest/
manifest.schema.json`` is the JSON-Schema twin of the same shape; the golden
fixture ``render/manifest/examples/kitchen-min.json`` is loaded by *both* the
app's vitest suite and this module's pytest, so the two sides cannot drift.

Design notes
------------

* **Structural validation without a dependency.**  The worker runs on Blender's
  bundled Python, so ``jsonschema`` is not available.  Each dataclass therefore
  declares its own ``FIELDS`` table (JSON key → attribute + converter), which
  is simultaneously the parser, the type check and the input to
  :func:`unknown_keys`.  One table, no drift.
* **Unknown keys are reported, not fatal.**  :func:`unknown_keys` returns dotted
  paths for anything the dataclasses would silently drop; ``tests/
  test_manifest.py`` asserts it is empty for the golden file, while a future
  manifest that grows a field still renders instead of crashing.
* **Vectors stay in the glTF frame.**  Nothing here converts anything —
  :mod:`kprender.convert` owns every sign.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import MISSING, dataclass, field, fields
from typing import Any, ClassVar

__all__ = [
    "MANIFEST_VERSION",
    "Camera",
    "Files",
    "Light",
    "Manifest",
    "ManifestError",
    "MaterialEntry",
    "Portal",
    "RenderSettings",
    "Room",
    "Sky",
    "Vec3",
    "Viewport",
    "load",
    "require_version",
    "unknown_keys",
]

#: The only ``manifestVersion`` this worker understands.
MANIFEST_VERSION = 1


class ManifestError(ValueError):
    """A manifest that cannot be understood — always raised with the offending
    dotted path, because a stack trace inside Blender is nearly unreadable."""


# --------------------------------------------------------------------------
# tiny schema machinery
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class _F:
    """One JSON key: where it lands, how it converts, and what lives inside."""

    attr: str
    conv: Callable[[Any], Any]
    child: type | None = None  # nested node class, for unknown_keys traversal
    many: bool = False  # child repeated in a list


def _num(v: Any) -> float:
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise ManifestError(f"expected a number, got {type(v).__name__}")
    return float(v)


def _int(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ManifestError(f"expected an integer, got {type(v).__name__}")
    return int(v)


def _str(v: Any) -> str:
    if not isinstance(v, str):
        raise ManifestError(f"expected a string, got {type(v).__name__}")
    return v


def _bool(v: Any) -> bool:
    if not isinstance(v, bool):
        raise ManifestError(f"expected a boolean, got {type(v).__name__}")
    return v


def _seq(v: Any) -> Sequence[Any]:
    if not isinstance(v, list):
        raise ManifestError(f"expected an array, got {type(v).__name__}")
    return v


def _one_of(name: str, allowed: frozenset[str]) -> Callable[[Any], str]:
    def conv(v: Any) -> str:
        s = _str(v)
        if s not in allowed:
            raise ManifestError(f"{name}: {s!r} is not one of {sorted(allowed)}")
        return s

    return conv


class _Node:
    """Base for every manifest dataclass: generic ``from_dict`` driven by
    ``FIELDS``.  Subclasses are plain frozen dataclasses otherwise."""

    FIELDS: ClassVar[dict[str, _F]] = {}
    #: Set on nodes whose schema deliberately allows extra properties.
    ALLOW_EXTRA: ClassVar[bool] = False

    @classmethod
    def from_dict(cls, data: Any, path: str = "") -> Any:
        if not isinstance(data, dict):
            raise ManifestError(f"{path or cls.__name__}: expected an object")
        defaults = {f.name: f for f in fields(cls)}  # type: ignore[arg-type]
        kwargs: dict[str, Any] = {}
        for key, spec in cls.FIELDS.items():
            value = data.get(key)
            if value is None:
                fld = defaults[spec.attr]
                if fld.default is MISSING and fld.default_factory is MISSING:
                    raise ManifestError(f"{path}{key}: required field is missing")
                continue
            try:
                kwargs[spec.attr] = spec.conv(value)
            except ManifestError as exc:
                raise ManifestError(f"{path}{key}: {exc}") from None
        return cls(**kwargs)  # type: ignore[call-arg]


def _node(cls: type) -> Callable[[Any], Any]:
    return lambda v: cls.from_dict(v)


def _list_of(cls: type) -> Callable[[Any], list[Any]]:
    return lambda v: [cls.from_dict(e, f"[{i}].") for i, e in enumerate(_seq(v))]


# --------------------------------------------------------------------------
# leaf types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Vec3(_Node):
    """A vector in the glTF/three world frame (x right, y UP, z toward the
    viewer).  Convert with :func:`kprender.convert.to_blender`."""

    x: float
    y: float
    z: float

    FIELDS: ClassVar[dict[str, _F]] = {
        "x": _F("x", _num),
        "y": _F("y", _num),
        "z": _F("z", _num),
    }

    def as_tuple(self) -> tuple[float, float, float]:
        return (self.x, self.y, self.z)


@dataclass(frozen=True)
class Files(_Node):
    glb: str
    design: str

    FIELDS: ClassVar[dict[str, _F]] = {
        "glb": _F("glb", _str),
        "design": _F("design", _str),
    }


@dataclass(frozen=True)
class Camera(_Node):
    position: Vec3
    target: Vec3
    up: Vec3
    fov_y_deg: float
    viewport_aspect: float
    near_m: float
    far_m: float

    FIELDS: ClassVar[dict[str, _F]] = {
        "position": _F("position", _node(Vec3), Vec3),
        "target": _F("target", _node(Vec3), Vec3),
        "up": _F("up", _node(Vec3), Vec3),
        "fovYDeg": _F("fov_y_deg", _num),
        "viewportAspect": _F("viewport_aspect", _num),
        "nearM": _F("near_m", _num),
        "farM": _F("far_m", _num),
    }


@dataclass(frozen=True)
class Viewport(_Node):
    """``skyState()`` diagnostics — what the *viewport* showed.  The worker uses
    only ``sun_intensity`` (sun lamp power) and ``background`` (night world
    colour); the rest is there so a human can compare the render to the app.

    Extra keys are legal here (the JSON Schema says ``additionalProperties:
    true``) so ``SkyState`` can grow without breaking old workers.
    """

    sun_color: str
    sun_intensity: float
    ambient_color: str
    ambient_intensity: float
    background: str

    ALLOW_EXTRA: ClassVar[bool] = True
    FIELDS: ClassVar[dict[str, _F]] = {
        "sunColor": _F("sun_color", _str),
        "sunIntensity": _F("sun_intensity", _num),
        "ambientColor": _F("ambient_color", _str),
        "ambientIntensity": _F("ambient_intensity", _num),
        "background": _F("background", _str),
    }


@dataclass(frozen=True)
class Sky(_Node):
    azimuth_deg: float
    elevation_deg: float
    night: bool
    brightness: float
    sun_direction: Vec3
    daylight: float
    lamp_boost: float
    viewport: Viewport

    FIELDS: ClassVar[dict[str, _F]] = {
        "azimuthDeg": _F("azimuth_deg", _num),
        "elevationDeg": _F("elevation_deg", _num),
        "night": _F("night", _bool),
        "brightness": _F("brightness", _num),
        "sunDirection": _F("sun_direction", _node(Vec3), Vec3),
        "daylight": _F("daylight", _num),
        "lampBoost": _F("lamp_boost", _num),
        "viewport": _F("viewport", _node(Viewport), Viewport),
    }


LIGHT_KINDS = frozenset({"point", "spot", "bar"})


@dataclass(frozen=True)
class Light(_Node):
    """One fixture.  ``position``/``direction`` are world-frame glTF vectors;
    ``on == False`` fixtures are still listed so the worker can report them."""

    item_id: str
    def_id: str
    kind: str
    on: bool
    intensity: float
    warmth: float
    position: Vec3
    direction: Vec3
    yaw_rad: float
    color_hex: str | None = None
    cone_angle_rad: float | None = None
    cone_blend: float | None = None
    size_x: float | None = None
    size_y: float | None = None

    FIELDS: ClassVar[dict[str, _F]] = {
        "itemId": _F("item_id", _str),
        "defId": _F("def_id", _str),
        "kind": _F("kind", _one_of("light.kind", LIGHT_KINDS)),
        "on": _F("on", _bool),
        "intensity": _F("intensity", _num),
        "warmth": _F("warmth", _num),
        "colorHex": _F("color_hex", _str),
        "position": _F("position", _node(Vec3), Vec3),
        "direction": _F("direction", _node(Vec3), Vec3),
        "coneAngleRad": _F("cone_angle_rad", _num),
        "coneBlend": _F("cone_blend", _num),
        "sizeX": _F("size_x", _num),
        "sizeY": _F("size_y", _num),
        "yawRad": _F("yaw_rad", _num),
    }


PORTAL_TYPES = frozenset({"door", "window"})


@dataclass(frozen=True)
class Portal(_Node):
    """A wall aperture.  ``center`` sits on the wall's mid-thickness plane;
    ``width``/``height`` are the RAW aperture (the worker insets its own frame
    allowance).  ``interior`` marks a shared partition — no daylight there."""

    opening_id: str
    wall_id: str
    room_id: str
    type: str
    center: Vec3
    width: float
    height: float
    normal: Vec3
    tangent: Vec3
    wall_thickness: float
    sill: float
    interior: bool

    FIELDS: ClassVar[dict[str, _F]] = {
        "openingId": _F("opening_id", _str),
        "wallId": _F("wall_id", _str),
        "roomId": _F("room_id", _str),
        "type": _F("type", _one_of("portal.type", PORTAL_TYPES)),
        "center": _F("center", _node(Vec3), Vec3),
        "width": _F("width", _num),
        "height": _F("height", _num),
        "normal": _F("normal", _node(Vec3), Vec3),
        "tangent": _F("tangent", _node(Vec3), Vec3),
        "wallThickness": _F("wall_thickness", _num),
        "sill": _F("sill", _num),
        "interior": _F("interior", _bool),
    }


MATERIAL_KINDS = frozenset({"library", "plain", "shell", "product"})


@dataclass(frozen=True)
class MaterialEntry(_Node):
    """One canonical glTF material, as the app classified it.  The GLB's
    material *names* remain the contract (:mod:`kprender.matnames`); this table
    is the cross-check and the source of ``baseColorHex`` when a name has been
    mangled beyond recognition."""

    name: str
    kind: str
    base_color_hex: str
    rot: bool
    mesh_count: int
    mat_id: str | None = None
    fallback: str | None = None
    surface: str | None = None
    product: str | None = None

    FIELDS: ClassVar[dict[str, _F]] = {
        "name": _F("name", _str),
        "kind": _F("kind", _one_of("material.kind", MATERIAL_KINDS)),
        "matId": _F("mat_id", _str),
        "baseColorHex": _F("base_color_hex", _str),
        "rot": _F("rot", _bool),
        "fallback": _F("fallback", _str),
        "surface": _F("surface", _str),
        "product": _F("product", _str),
        "meshCount": _F("mesh_count", _int),
    }


RENDER_TIERS = frozenset({"preview", "final"})


@dataclass(frozen=True)
class RenderSettings(_Node):
    width_px: int
    height_px: int
    tier: str
    sensor_fit: str

    FIELDS: ClassVar[dict[str, _F]] = {
        "widthPx": _F("width_px", _int),
        "heightPx": _F("height_px", _int),
        "tier": _F("tier", _one_of("render.tier", RENDER_TIERS)),
        "sensorFit": _F("sensor_fit", _one_of("render.sensorFit", frozenset({"vertical"}))),
    }


@dataclass(frozen=True)
class Room(_Node):
    id: str
    name: str
    wall_height: float
    wall_thickness: float
    floor_area_m2: float
    centroid: Vec3

    FIELDS: ClassVar[dict[str, _F]] = {
        "id": _F("id", _str),
        "name": _F("name", _str),
        "wallHeight": _F("wall_height", _num),
        "wallThickness": _F("wall_thickness", _num),
        "floorAreaM2": _F("floor_area_m2", _num),
        "centroid": _F("centroid", _node(Vec3), Vec3),
    }


# --------------------------------------------------------------------------
# root
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Manifest(_Node):
    manifest_version: int
    design_version: int
    app_version: str
    exported_at: str
    units: str
    axis: str
    files: Files
    camera: Camera
    sky: Sky
    render: RenderSettings
    lights: list[Light] = field(default_factory=list)
    portals: list[Portal] = field(default_factory=list)
    materials: list[MaterialEntry] = field(default_factory=list)
    rooms: list[Room] = field(default_factory=list)

    FIELDS: ClassVar[dict[str, _F]] = {
        "manifestVersion": _F("manifest_version", _int),
        "designVersion": _F("design_version", _int),
        "appVersion": _F("app_version", _str),
        "exportedAt": _F("exported_at", _str),
        "units": _F("units", _one_of("units", frozenset({"m"}))),
        "axis": _F("axis", _one_of("axis", frozenset({"gltf-y-up"}))),
        "files": _F("files", _node(Files), Files),
        "camera": _F("camera", _node(Camera), Camera),
        "sky": _F("sky", _node(Sky), Sky),
        "lights": _F("lights", _list_of(Light), Light, many=True),
        "portals": _F("portals", _list_of(Portal), Portal, many=True),
        "materials": _F("materials", _list_of(MaterialEntry), MaterialEntry, many=True),
        "render": _F("render", _node(RenderSettings), RenderSettings),
        "rooms": _F("rooms", _list_of(Room), Room, many=True),
    }

    def material_by_name(self) -> dict[str, MaterialEntry]:
        """Name → entry.  Duplicate names cannot occur (the app canonicalises
        one material per name before export), but last-wins is harmless."""
        return {m.name: m for m in self.materials}


def require_version(data: Any) -> int:
    """Gate on ``manifestVersion``.  Anything but 1 is refused loudly — a
    silently mis-parsed manifest renders a plausible but wrong picture, which
    is far worse than a stop."""
    if not isinstance(data, dict):
        raise ManifestError("manifest: expected a JSON object at the top level")
    version = data.get("manifestVersion")
    if version != MANIFEST_VERSION:
        raise ManifestError(
            f"manifest: unsupported manifestVersion {version!r} — "
            f"this worker understands version {MANIFEST_VERSION} only. "
            "Re-export the render package from a matching app build."
        )
    return MANIFEST_VERSION


def load(data: Any) -> Manifest:
    """Validate + parse a decoded ``manifest.json``."""
    require_version(data)
    return Manifest.from_dict(data)


def unknown_keys(data: Any, node_cls: type = Manifest, path: str = "") -> list[str]:
    """Dotted paths of every key no dataclass field consumes.

    Not an error by itself (forward compatibility), but ``tests/
    test_manifest.py`` asserts the golden manifest yields an empty list, so a
    field added on the TypeScript side cannot land unnoticed here.
    """
    out: list[str] = []
    if not isinstance(data, dict):
        return out
    spec_table: dict[str, _F] = getattr(node_cls, "FIELDS", {})
    allow_extra: bool = getattr(node_cls, "ALLOW_EXTRA", False)
    for key, value in data.items():
        spec = spec_table.get(key)
        if spec is None:
            if not allow_extra:
                out.append(f"{path}{key}")
            continue
        if spec.child is None:
            continue
        if spec.many:
            if isinstance(value, list):
                for i, element in enumerate(value):
                    out.extend(unknown_keys(element, spec.child, f"{path}{key}[{i}]."))
        else:
            out.extend(unknown_keys(value, spec.child, f"{path}{key}."))
    return out
