"""``kp:…`` material-name grammar — the Python mirror of ``src/model/materialName.ts``.

The app stamps every material it mints with a name encoding *what that material
is* (library entry + tint, flat colour, room shell, bought product), because
glTF carries a material's baked *shape* but not its identity.  This module
decodes those names so :mod:`kprender.materials` can rebuild the real OpenPBR
material instead of inheriting a flattened one.

Kept byte-for-byte in step with the TypeScript original — same accepted
patterns, same rejections, same ``.001`` tolerance.  ``tests/test_matnames.py``
ports the cases from ``test/unit/materialName.test.ts``; if the grammar ever
changes, both sides move together.

Grammar::

    library   kp:m:<matId>:<hex6>[:r]
    plain     kp:c:<hex6>:<matte|wood>
    shell     kp:s:<wall|floor|ceiling>:<hex6>[:<matId>][:r]
    product   kp:p:<slug>
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

__all__ = [
    "MATERIAL_NAME_MAX",
    "PRODUCT_SLUGS",
    "MatDesc",
    "from_extras",
    "parse",
    "strip_blender_suffix",
]

#: Blender ID cap (63 bytes) minus headroom for its own ``.001``-style suffix.
MATERIAL_NAME_MAX = 50

#: ``src/model/materialName.ts`` ``ProductSlug`` — keep the two lists identical.
PRODUCT_SLUGS: frozenset[str] = frozenset(
    {
        "steel",
        "appliance-glass",
        "appliance-black",
        "appliance-ring",
        "handle",
        "bulb",
        "window-glass",
        "window-frame",
        "door-leaf",
        "door-knob",
        "groove",
        "ground",
    }
)

_SURFACES = frozenset({"wall", "floor", "ceiling"})
_FALLBACKS = frozenset({"matte", "wood"})

_HEX6_RE = re.compile(r"^[0-9a-f]{6}$")
#: Blender's mechanical duplicate suffix on a colliding import/append.
_DUP_SUFFIX_RE = re.compile(r"\.\d{3}$")


@dataclass(frozen=True)
class MatDesc:
    """A decoded ``kp:`` name.  ``kind`` is the discriminator; the rest are the
    fields that kind carries (``None`` elsewhere), mirroring the TS union."""

    kind: str  # 'library' | 'plain' | 'shell' | 'product'
    mat_id: str | None = None
    hex6: str | None = None
    rot: bool = False
    fallback: str | None = None  # plain
    surface: str | None = None  # shell
    product: str | None = None  # product


def strip_blender_suffix(name: str) -> str:
    """Drop a trailing ``.001``/``.002``/… duplicate suffix.

    Exactly three digits, exactly as the TS side (``/\\.\\d{3}$/``): ``foo.1``
    and ``foo.abc`` are NOT suffixes, they are different names.
    """
    return _DUP_SUFFIX_RE.sub("", name)


def parse(name: str) -> MatDesc | None:
    """Decode a material name, or ``None`` for anything foreign/malformed.

    ``None`` is a normal outcome, not an error: a material Blender or a third
    party named keeps whatever the glTF import gave it (graceful degradation).
    """
    parts = strip_blender_suffix(name).split(":")
    if len(parts) < 3 or parts[0] != "kp":
        return None
    kind = parts[1]

    if kind == "m":
        if not 4 <= len(parts) <= 5:
            return None
        mat_id, hex6 = parts[2], parts[3]
        if not mat_id or not _HEX6_RE.match(hex6):
            return None
        if len(parts) == 5 and parts[4] != "r":
            return None
        return MatDesc(kind="library", mat_id=mat_id, hex6=hex6, rot=len(parts) == 5)

    if kind == "c":
        if len(parts) != 4:
            return None
        hex6, fallback = parts[2], parts[3]
        if not _HEX6_RE.match(hex6) or fallback not in _FALLBACKS:
            return None
        return MatDesc(kind="plain", hex6=hex6, fallback=fallback)

    if kind == "s":
        if not 4 <= len(parts) <= 6:
            return None
        surface, hex6 = parts[2], parts[3]
        if surface not in _SURFACES or not _HEX6_RE.match(hex6):
            return None
        rest = list(parts[4:])
        rot = False
        if rest and rest[-1] == "r":
            rot = True
            rest.pop()
        if len(rest) > 1:
            return None
        mat_id = rest[0] if rest else None
        if mat_id == "":
            return None
        return MatDesc(kind="shell", surface=surface, hex6=hex6, mat_id=mat_id, rot=rot)

    if kind == "p":
        if len(parts) != 3:
            return None
        product = parts[2]
        if product not in PRODUCT_SLUGS:
            return None
        return MatDesc(kind="product", product=product)

    return None


def from_extras(extras: Any) -> MatDesc | None:
    """Rebuild a :class:`MatDesc` from the glTF ``extras.kp`` payload.

    The app also writes the descriptor object to ``material.userData.kp``, which
    the exporter emits as glTF ``extras`` and Blender's importer *may* keep as
    an ID custom property.  That path is a bonus, not the contract (the name is
    the contract) — hence the defensive shape checks and the ``None`` return
    for anything unexpected.
    """
    if extras is None:
        return None
    # Blender hands ID properties back as IDPropertyGroup, not dict; anything
    # with .get()/subscript access works, so normalise through a dict copy.
    try:
        data = dict(extras)
    except (TypeError, ValueError):
        return None
    kind = data.get("kind")
    if kind == "library":
        mat_id, hex6 = data.get("matId"), data.get("hex6")
        if not isinstance(mat_id, str) or not isinstance(hex6, str):
            return None
        return parse(f"kp:m:{mat_id}:{hex6}{':r' if data.get('rot') else ''}")
    if kind == "plain":
        hex6, fallback = data.get("hex6"), data.get("fallback")
        if not isinstance(hex6, str) or not isinstance(fallback, str):
            return None
        return parse(f"kp:c:{hex6}:{fallback}")
    if kind == "shell":
        surface, hex6 = data.get("surface"), data.get("hex6")
        if not isinstance(surface, str) or not isinstance(hex6, str):
            return None
        tail = ""
        mat_id = data.get("matId")
        if isinstance(mat_id, str) and mat_id:
            tail += f":{mat_id}"
        if data.get("rot"):
            tail += ":r"
        return parse(f"kp:s:{surface}:{hex6}{tail}")
    if kind == "product":
        product = data.get("product")
        if not isinstance(product, str):
            return None
        return parse(f"kp:p:{product}")
    return None
