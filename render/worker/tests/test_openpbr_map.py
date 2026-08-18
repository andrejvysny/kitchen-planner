"""The OpenPBR → Principled projection, checked against the real library.

The load-bearing assertion is :meth:`TestLibraryCoverage.
test_every_used_parameter_is_handled`: every OpenPBR parameter that appears
anywhere in ``render/materials/openpbr.materials.json`` must either have a
mapping entry or be on the explicit handled-specially list. Adding a parameter
to the library without teaching the worker about it is exactly the failure this
catches — the material would render, subtly wrong, with no warning.
"""

from __future__ import annotations

import json

import pytest

from kprender import openpbr_map as O


@pytest.fixture(scope="module")
def library(library_path):
    return O.load_library(library_path)


@pytest.fixture(scope="module")
def raw_library(library_path):
    with library_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


class TestLibraryCoverage:
    def test_every_used_parameter_is_handled(self, raw_library):
        used = set()
        for entry in raw_library["materials"]:
            used |= set(entry.get("openpbr") or {})
            texture_set = entry.get("textureSet")
            if texture_set:
                used |= set(texture_set.get("maps") or {})
        unhandled = sorted(k for k in used if k not in O.MAPPING and k not in O.HANDLED_SPECIALLY)
        assert unhandled == [], (
            f"openpbr.materials.json uses {unhandled} — add them to MAPPING or to "
            "HANDLED_SPECIALLY (and wire them up) in kprender/openpbr_map.py"
        )

    def test_unmapped_reports_exactly_the_gap(self):
        assert O.unmapped({"base_color": [1, 1, 1], "specular_roughness": 0.5}) == []
        assert O.unmapped({"geometry_normal": None, "base_weight": 1.0}) == []
        assert O.unmapped({"iridescence_weight": 0.4, "aardvark": 1}) == [
            "aardvark",
            "iridescence_weight",
        ]

    def test_handled_specially_is_the_documented_trio(self):
        assert set(O.HANDLED_SPECIALLY) == {
            "geometry_normal",
            "geometry_thin_walled",
            "base_weight",
        }

    def test_no_parameter_is_both_mapped_and_special_except_thin_wall(self):
        overlap = set(O.MAPPING) & O.HANDLED_SPECIALLY
        assert overlap == {"geometry_thin_walled"}


class TestPrincipledParams:
    def test_direct_scalars(self):
        out = O.principled_params({"specular_roughness": 0.46, "base_metalness": 0.02})
        assert out == {"Roughness": 0.46, "Metallic": 0.02}

    def test_colours_stay_three_tuples(self):
        out = O.principled_params({"base_color": [0.788, 0.659, 0.486]})
        assert out["Base Color"] == pytest.approx((0.788, 0.659, 0.486))
        assert len(out["Base Color"]) == 3  # the bpy layer pads to RGBA

    def test_specular_weight_is_halved(self):
        """OpenPBR's default 1.0 must land on Principled's neutral 0.5."""
        assert O.principled_params({"specular_weight": 1.0}) == {"Specular IOR Level": 0.5}
        assert O.principled_params({"specular_weight": 0.0}) == {"Specular IOR Level": 0.0}
        assert O.SCALE_FACTORS["specular_weight"] == 0.5

    def test_base_weight_folds_into_base_color(self):
        out = O.principled_params({"base_color": [0.8, 0.6, 0.4], "base_weight": 0.5})
        assert out["Base Color"] == pytest.approx((0.4, 0.3, 0.2))
        assert "base_weight" not in out
        assert "Base Weight" not in out

    def test_thin_walled_is_a_boolean(self):
        out = O.principled_params({"geometry_thin_walled": True})
        assert out == {"Thin Wall": True}

    def test_normal_map_is_not_a_socket_value(self):
        assert O.principled_params({"geometry_normal": "NormalGL"}) == {}

    def test_unknown_keys_are_dropped_not_crashed(self):
        assert O.principled_params({"aardvark": 1.0}) == {}

    def test_the_glass_entry_end_to_end(self, library):
        glass = library["glass"]
        out = O.principled_params(glass.openpbr)
        assert out["Transmission Weight"] == 1.0
        assert out["Roughness"] == 0.02
        assert out["Thin Wall"] is True
        assert out["Base Color"] == pytest.approx((0.737, 0.824, 0.847))

    def test_the_oak_entry_end_to_end(self, library):
        out = O.principled_params(library["oak"].openpbr)
        assert out == {
            "Base Color": pytest.approx((0.788, 0.659, 0.486)),
            "Metallic": 0.02,
            "Roughness": 0.46,
            "Coat Weight": 0.25,
            "Coat Roughness": 0.18,
        }


class TestLibraryLoad:
    def test_all_nineteen_entries(self, library, raw_library):
        assert len(library) == 19 == len(raw_library["materials"])
        assert set(library) == {entry["id"] for entry in raw_library["materials"]}

    def test_texture_sets(self, library):
        oak = library["oak"]
        assert oak.texture_set is not None
        assert oak.texture_set.ref == "ambientcg:Wood051"
        assert oak.texture_set.base_color_mode == "multiply"
        assert oak.texture_set.tint == pytest.approx((0.788, 0.659, 0.486))
        assert oak.texture_set.maps["geometry_normal"] == "NormalGL"
        assert oak.tile_meters == 1.0
        assert oak.tintable is False

    def test_entries_without_a_texture_set(self, library):
        for mat_id in ("glass", "plastic-matte", "plastic-gloss"):
            assert library[mat_id].texture_set is None
            assert library[mat_id].tile_meters is None

    def test_tintable_flags(self, library):
        tintable = {mat_id for mat_id, entry in library.items() if entry.tintable}
        assert tintable == {"plastic-matte", "plastic-gloss"}

    def test_base_color_modes_are_known(self, library):
        modes = {e.texture_set.base_color_mode for e in library.values() if e.texture_set}
        assert modes <= {"multiply", "asis", "replace"}

    def test_default_path_points_at_the_real_library(self):
        assert O.LIBRARY_PATH.name == "openpbr.materials.json"
        assert O.LIBRARY_PATH.is_file()
        assert len(O.load_library()) == 19


class TestTextureLockParity:
    """Every ``textureSet.ref`` must exist in the lock file, or the worker will
    silently fall back to flat parameters for that material."""

    def test_refs_resolve(self, library, library_path):
        lock_path = library_path.with_name("textures.lock.json")
        with lock_path.open("r", encoding="utf-8") as handle:
            lock = json.load(handle)
        known = {entry["ref"] for entry in lock["sets"]}
        refs = {e.texture_set.ref for e in library.values() if e.texture_set}
        assert refs <= known

    def test_every_map_name_exists_in_the_lock_files_block(self, library, library_path):
        lock_path = library_path.with_name("textures.lock.json")
        with lock_path.open("r", encoding="utf-8") as handle:
            lock = json.load(handle)
        files = {entry["ref"]: set(entry["files"]) for entry in lock["sets"]}
        for entry in library.values():
            if entry.texture_set is None:
                continue
            wanted = set(entry.texture_set.maps.values())
            assert wanted <= files[entry.texture_set.ref], entry.id
