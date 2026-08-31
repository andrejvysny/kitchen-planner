"""OpenPBR 1.1 → Blender Principled BSDF, as data.

Blender 5.2 has no native OpenPBR shader node yet (the implementation is WIP
upstream), so the material library in ``render/materials/openpbr.materials.json``
— which *is* written in OpenPBR terms, because that is the format that will
outlive this workaround — has to be projected onto the Principled BSDF's
inputs.  Keeping that projection as a **table in one bpy-free module** means the
eventual swap to a real OpenPBR node is a single-file change, and that the
projection itself is unit-testable without Blender.

This module never touches ``bpy``: :func:`principled_params` returns a plain
``{socket name: value}`` dict and :mod:`kprender.materials` applies it with a
presence check, logging anything a given Blender build does not expose.

Handled outside the value table
-------------------------------

``geometry_normal``
    A *map*, not a value — wired by :mod:`kprender.textures` into a Normal Map
    node (and then through the Bevel node) rather than assigned to a socket.
``geometry_thin_walled``
    Maps to the ``Thin Wall`` socket, which only exists on Blender ≥ 4.3;
    :mod:`kprender.materials` guards on its presence and falls back to leaving
    the surface thick.
``base_weight``
    OpenPBR scales the diffuse albedo by it; Principled has no equivalent
    socket, so :func:`principled_params` folds it into ``Base Color``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "COLOR_KEYS",
    "HANDLED_SPECIALLY",
    "LIBRARY_PATH",
    "MAPPING",
    "SCALE_FACTORS",
    "LibraryEntry",
    "TextureSet",
    "load_library",
    "principled_params",
    "unmapped",
]

#: OpenPBR parameter → Principled BSDF input socket name (Blender 4.x/5.x).
#: Only parameters with a genuine Principled counterpart appear; the rest are
#: reported by :func:`unmapped` so a library edit that outruns this table is
#: visible in the render log instead of silently ignored.
MAPPING: dict[str, str] = {
    # base
    "base_color": "Base Color",
    "base_metalness": "Metallic",
    "base_diffuse_roughness": "Diffuse Roughness",
    # specular
    "specular_roughness": "Roughness",
    "specular_ior": "IOR",
    "specular_weight": "Specular IOR Level",  # scaled, see SCALE_FACTORS
    "specular_color": "Specular Tint",
    # transmission
    "transmission_weight": "Transmission Weight",
    # coat
    "coat_weight": "Coat Weight",
    "coat_roughness": "Coat Roughness",
    "coat_ior": "Coat IOR",
    "coat_color": "Coat Tint",
    # fuzz → sheen
    "fuzz_weight": "Sheen Weight",
    "fuzz_roughness": "Sheen Roughness",
    "fuzz_color": "Sheen Tint",
    # subsurface
    "subsurface_weight": "Subsurface Weight",
    # emission
    "emission_color": "Emission Color",
    "emission_luminance": "Emission Strength",
    # geometry
    "geometry_opacity": "Alpha",
    "geometry_thin_walled": "Thin Wall",
}

#: Unit conversions between the two parameterisations.  OpenPBR's
#: ``specular_weight`` is a 0..1 multiplier whose *default is 1*, while
#: Principled's ``Specular IOR Level`` is a 0..1 dial whose *default is 0.5*
#: means "no boost" — so the two agree at ``weight × 0.5``.
SCALE_FACTORS: dict[str, float] = {
    "specular_weight": 0.5,
}

#: Parameters consumed elsewhere in the pipeline (see the module docstring).
HANDLED_SPECIALLY: frozenset[str] = frozenset(
    {
        "geometry_normal",
        "geometry_thin_walled",
        "base_weight",
    }
)

#: Parameters whose value is an RGB triple rather than a scalar.
COLOR_KEYS: frozenset[str] = frozenset(
    {
        "base_color",
        "specular_color",
        "transmission_color",
        "coat_color",
        "fuzz_color",
        "subsurface_color",
        "emission_color",
    }
)

#: ``render/materials/openpbr.materials.json`` — the app's 20 MaterialDefs in
#: OpenPBR terms.  Resolved relative to this file so ``render.sh`` works from
#: any cwd.
LIBRARY_PATH = Path(__file__).resolve().parents[2] / "materials" / "openpbr.materials.json"


def unmapped(params: Mapping[str, Any]) -> list[str]:
    """OpenPBR keys this table would drop on the floor, sorted."""
    return sorted(k for k in params if k not in MAPPING and k not in HANDLED_SPECIALLY)


def principled_params(params: Mapping[str, Any]) -> dict[str, Any]:
    """Project OpenPBR parameters onto ``{Principled socket: value}``.

    Values pass through unchanged apart from :data:`SCALE_FACTORS` and
    ``base_weight`` (folded into ``Base Color``).  Colours stay 3-tuples; the
    bpy layer pads them to RGBA, because that is a Blender socket detail and
    not a material-model one.
    """
    out: dict[str, Any] = {}
    base_weight = params.get("base_weight")

    for key, value in params.items():
        if key in ("base_weight", "geometry_normal"):
            continue
        socket = MAPPING.get(key)
        if socket is None:
            continue
        if key in COLOR_KEYS:
            rgb = tuple(float(c) for c in value)
            if key == "base_color" and base_weight is not None:
                rgb = tuple(c * float(base_weight) for c in rgb)
            out[socket] = rgb
        elif socket == "Thin Wall":
            out[socket] = bool(value)
        else:
            scale = SCALE_FACTORS.get(key, 1.0)
            out[socket] = float(value) * scale

    return out


# --------------------------------------------------------------------------
# the library file
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class TextureSet:
    """Which photographed set backs a library entry, and how it is combined.

    ``base_color_mode``:

    ``multiply``
        the sampled colour is multiplied by ``tint`` — several wood species
        share one grain/roughness/normal set and land on their own hue.
    ``asis``
        the texture's own colour is used unmodified (``tint`` is ``[1,1,1]``).
    ``replace``
        reserved; no entry uses it yet.
    """

    ref: str
    maps: dict[str, str]
    base_color_mode: str
    tint: tuple[float, float, float]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TextureSet:
        tint = data.get("tint") or [1.0, 1.0, 1.0]
        return cls(
            ref=str(data["ref"]),
            maps={str(k): str(v) for k, v in dict(data.get("maps") or {}).items()},
            base_color_mode=str(data.get("baseColorMode", "asis")),
            tint=(float(tint[0]), float(tint[1]), float(tint[2])),
        )


@dataclass(frozen=True)
class LibraryEntry:
    """One of the app's 20 ``MaterialDef``s, in OpenPBR terms."""

    id: str
    label: str
    app_color: str
    tintable: bool
    tile_meters: float | None
    openpbr: dict[str, Any]
    texture_set: TextureSet | None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> LibraryEntry:
        raw_set = data.get("textureSet")
        tile = data.get("tileMeters")
        return cls(
            id=str(data["id"]),
            label=str(data.get("label", data["id"])),
            app_color=str(data.get("appColor", "#ffffff")),
            tintable=bool(data.get("tintable", False)),
            tile_meters=None if tile is None else float(tile),
            openpbr=dict(data.get("openpbr") or {}),
            texture_set=TextureSet.from_dict(raw_set) if isinstance(raw_set, dict) else None,
        )


def load_library(path: str | Path | None = None) -> dict[str, LibraryEntry]:
    """Read ``openpbr.materials.json`` into ``{matId: LibraryEntry}``.

    A missing library is not fatal for the caller to *decide*, but it is
    certainly a broken checkout, so this raises rather than returning ``{}``.
    """
    lib_path = Path(path) if path is not None else LIBRARY_PATH
    with lib_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    entries = [LibraryEntry.from_dict(e) for e in data.get("materials", [])]
    return {e.id: e for e in entries}
