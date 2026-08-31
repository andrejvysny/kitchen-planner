"""Parity with ``src/model/materialName.ts``.

The cases are ported from ``test/unit/materialName.test.ts`` — same ids, same
round trips, same rejection list — because the two parsers are a contract
across a language boundary with no shared code to keep them honest. A change on
either side that is not mirrored fails here.

The 20 library ids are read out of ``render/materials/openpbr.materials.json``
rather than re-typed, so an id renamed in the library sweeps through this test
automatically (renaming one is forbidden anyway — the id is persisted in user
designs — but the sweep is free).
"""

from __future__ import annotations

import json

import pytest

from kprender.matnames import (
    MATERIAL_NAME_MAX,
    PRODUCT_SLUGS,
    MatDesc,
    from_extras,
    parse,
    strip_blender_suffix,
)

SURFACES = ("wall", "floor", "ceiling")
FALLBACKS = ("matte", "wood")

# The exhaustive slug list, spelled out here exactly as materialName.ts spells
# it — a slug quietly dropped from one side must not silently pass.
EXPECTED_SLUGS = {
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


@pytest.fixture(scope="module")
def library_ids(library_path):
    with library_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return [entry["id"] for entry in data["materials"]]


def test_product_slug_set_matches_the_ts_union():
    assert set(PRODUCT_SLUGS) == EXPECTED_SLUGS


def test_name_cap_matches_the_ts_constant():
    assert MATERIAL_NAME_MAX == 50


class TestLibrary:
    def test_every_library_id_times_rot(self, library_ids):
        assert len(library_ids) == 20
        for mat_id in library_ids:
            assert parse(f"kp:m:{mat_id}:c9a87c") == MatDesc(
                kind="library", mat_id=mat_id, hex6="c9a87c", rot=False
            )
            assert parse(f"kp:m:{mat_id}:c9a87c:r") == MatDesc(
                kind="library", mat_id=mat_id, hex6="c9a87c", rot=True
            )

    def test_names_stay_within_the_cap(self, library_ids):
        for mat_id in library_ids:
            assert len(f"kp:m:{mat_id}:aabbcc:r") <= MATERIAL_NAME_MAX


class TestPlain:
    @pytest.mark.parametrize("fallback", FALLBACKS)
    def test_both_fallbacks(self, fallback):
        assert parse(f"kp:c:e6dfd0:{fallback}") == MatDesc(
            kind="plain", hex6="e6dfd0", fallback=fallback
        )


class TestShell:
    @pytest.mark.parametrize("surface", SURFACES)
    def test_three_shapes_per_surface(self, surface):
        assert parse(f"kp:s:{surface}:c9a87c") == MatDesc(
            kind="shell", surface=surface, hex6="c9a87c", mat_id=None, rot=False
        )
        assert parse(f"kp:s:{surface}:c9a87c:floor-walnut") == MatDesc(
            kind="shell", surface=surface, hex6="c9a87c", mat_id="floor-walnut", rot=False
        )
        assert parse(f"kp:s:{surface}:c9a87c:floor-walnut:r") == MatDesc(
            kind="shell", surface=surface, hex6="c9a87c", mat_id="floor-walnut", rot=True
        )
        assert parse(f"kp:s:{surface}:c9a87c:r") == MatDesc(
            kind="shell", surface=surface, hex6="c9a87c", mat_id=None, rot=True
        )

    def test_longest_shell_name_fits(self):
        assert len("kp:s:ceiling:aabbcc:tiles-terracotta:r") <= MATERIAL_NAME_MAX


class TestProduct:
    @pytest.mark.parametrize("product", sorted(EXPECTED_SLUGS))
    def test_every_slug(self, product):
        assert parse(f"kp:p:{product}") == MatDesc(kind="product", product=product)
        assert len(f"kp:p:{product}") <= MATERIAL_NAME_MAX


class TestBlenderDuplicateSuffix:
    def test_strips_a_three_digit_suffix(self):
        base = "kp:m:oak:c9a87c:r"
        assert parse(f"{base}.001") == parse(base)
        assert parse(f"{base}.123") == parse(base)
        assert strip_blender_suffix(f"{base}.001") == base

    def test_does_not_strip_other_trailing_dot_groups(self):
        base = "kp:c:e6dfd0:matte"
        assert parse(f"{base}.1") is None
        assert parse(f"{base}.abc") is None
        assert parse(f"{base}.0001") is None
        assert strip_blender_suffix(f"{base}.1") == f"{base}.1"


class TestRejections:
    @pytest.mark.parametrize(
        "name",
        [
            "Material",
            "Material.001",
            "kp:z:oak:aabbcc",  # unknown kind letter
            "kp:m:oak:xyz123",  # bad hex
            "kp:p:unknown-slug",  # unknown product slug
            "",
            "kp:m:oak",  # missing hex
            "kp:c:aabbcc:glossy",  # unknown fallback
            "kp:s:attic:aabbcc",  # unknown surface
            "kp:m::aabbcc",  # empty matId
            "kp:m:oak:aabbcc:x",  # bad rotation token
            "kp:m:oak:aabbcc:r:extra",  # too many parts
            "kp:s:wall:aabbcc:oak:extra:r",  # too many parts
            "kp:p:steel:extra",
            "kp",
            "kp:m",
            "kp:m:oak:AABBCC",  # uppercase hex is not what the app emits
        ],
    )
    def test_rejected(self, name):
        assert parse(name) is None


class TestFromExtras:
    """The glTF ``extras.kp`` fallback, used only when the NAME failed."""

    def test_each_kind(self):
        assert from_extras({"kind": "library", "matId": "oak", "hex6": "c9a87c", "rot": True}) == (
            MatDesc(kind="library", mat_id="oak", hex6="c9a87c", rot=True)
        )
        assert from_extras({"kind": "plain", "hex6": "e6dfd0", "fallback": "wood"}) == MatDesc(
            kind="plain", hex6="e6dfd0", fallback="wood"
        )
        assert from_extras(
            {"kind": "shell", "surface": "floor", "hex6": "c9a87c", "matId": "floor-oak"}
        ) == MatDesc(kind="shell", surface="floor", hex6="c9a87c", mat_id="floor-oak", rot=False)
        assert from_extras({"kind": "product", "product": "steel"}) == MatDesc(
            kind="product", product="steel"
        )

    @pytest.mark.parametrize(
        "extras",
        [None, {}, {"kind": "nonsense"}, {"kind": "library"}, {"kind": "product", "product": 7}, 42],
    )
    def test_bad_payloads_return_none(self, extras):
        assert from_extras(extras) is None
