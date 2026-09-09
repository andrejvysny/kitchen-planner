"""The golden manifest, through the worker's own parser.

``render/manifest/examples/kitchen-min.json`` is loaded by BOTH the app's
``renderManifest.test.ts`` (as the golden the builder must reproduce) and this
file, so a field added on one side and forgotten on the other shows up as a red
test rather than as a silently ignored value in a render.
"""

from __future__ import annotations

import copy

import pytest

from kprender import manifest as M


@pytest.fixture()
def data(golden_manifest):
    return copy.deepcopy(golden_manifest)


# --------------------------------------------------------------------------
# version gate
# --------------------------------------------------------------------------


class TestVersionGate:
    def test_accepts_v1(self, data):
        assert M.require_version(data) == 1
        assert M.load(data).manifest_version == 1

    @pytest.mark.parametrize("version", [0, 2, "1", None, 1.0])
    def test_refuses_everything_else(self, data, version):
        data["manifestVersion"] = version
        with pytest.raises(M.ManifestError) as exc:
            M.load(data)
        assert "manifestVersion" in str(exc.value)

    def test_refuses_a_non_object(self):
        with pytest.raises(M.ManifestError):
            M.load([1, 2, 3])


# --------------------------------------------------------------------------
# structure
# --------------------------------------------------------------------------


class TestGoldenStructure:
    def test_scalars(self, golden_manifest):
        m = M.load(golden_manifest)
        assert m.design_version == 8
        assert m.app_version == "0.0.0-golden"
        assert m.exported_at == "2026-08-18T00:00:00.000Z"
        assert m.units == "m"
        assert m.axis == "gltf-y-up"
        assert (m.files.glb, m.files.design) == ("scene.glb", "design.json")

    def test_camera(self, golden_manifest):
        cam = M.load(golden_manifest).camera
        assert isinstance(cam.position, M.Vec3)
        assert cam.position.as_tuple() == (5.2, 1.65, 4.8)
        assert cam.target.as_tuple() == (2.0, 1.1, 1.5)
        assert cam.up.as_tuple() == (0.0, 1.0, 0.0)
        assert cam.fov_y_deg == 50.0
        assert cam.near_m == 0.05
        assert cam.far_m == 120.0
        assert all(isinstance(v, float) for v in (cam.fov_y_deg, cam.near_m, cam.far_m))

    def test_sky(self, golden_manifest):
        sky = M.load(golden_manifest).sky
        assert (sky.azimuth_deg, sky.elevation_deg) == (135.0, 35.0)
        assert sky.night is False
        assert sky.brightness == 1.0
        assert sky.daylight == 1.0
        assert sky.lamp_boost == 0.0
        assert sky.sun_direction.as_tuple() == (0.579228, 0.573576, -0.579228)
        assert sky.viewport.sun_intensity == pytest.approx(1.4083333333333334)
        assert sky.viewport.background == "#e6e4df"

    def test_light_counts_and_shapes(self, golden_manifest):
        lights = M.load(golden_manifest).lights
        assert len(lights) == len(golden_manifest["lights"]) == 3
        assert [light.kind for light in lights] == ["point", "spot", "bar"]
        assert [light.on for light in lights] == [True, True, False]

        point, spot, bar = lights
        # optional fields are None exactly where the JSON omits them
        assert (point.color_hex, point.cone_angle_rad, point.size_x) == (None, None, None)
        assert spot.color_hex == "#ffd9a8"
        assert spot.cone_angle_rad == 1.5
        assert spot.cone_blend == 0.45
        assert spot.yaw_rad == pytest.approx(-0.785398)
        assert (bar.size_x, bar.size_y) == (1.2, 0.06)

    def test_portal_counts_and_shapes(self, golden_manifest):
        portals = M.load(golden_manifest).portals
        assert len(portals) == len(golden_manifest["portals"]) == 1
        portal = portals[0]
        assert portal.type == "window"
        assert portal.interior is False
        assert (portal.width, portal.height) == (1.4, 1.2)
        assert portal.normal.as_tuple() == (0.0, 0.0, 1.0)
        assert portal.tangent.as_tuple() == (1.0, 0.0, 0.0)
        assert portal.wall_thickness == 0.115
        assert portal.sill == 0.95

    def test_materials(self, golden_manifest):
        materials = M.load(golden_manifest).materials
        assert len(materials) == len(golden_manifest["materials"]) == 2
        by_name = M.load(golden_manifest).material_by_name()
        assert set(by_name) == {"kp:m:oak:c9a87c", "kp:s:wall:f4f1ea"}
        oak = by_name["kp:m:oak:c9a87c"]
        assert (oak.kind, oak.mat_id, oak.base_color_hex, oak.rot) == (
            "library",
            "oak",
            "#c9a87c",
            False,
        )
        assert oak.mesh_count == 12 and isinstance(oak.mesh_count, int)
        wall = by_name["kp:s:wall:f4f1ea"]
        assert (wall.kind, wall.surface, wall.mat_id) == ("shell", "wall", None)

    def test_render_and_rooms(self, golden_manifest):
        m = M.load(golden_manifest)
        assert (m.render.width_px, m.render.height_px) == (1920, 1080)
        assert m.render.tier == "final"
        assert m.render.sensor_fit == "vertical"
        assert len(m.rooms) == 1
        room = m.rooms[0]
        assert (room.id, room.name) == ("room-kitchen", "Kitchen")
        assert (room.wall_height, room.wall_thickness) == (2.6, 0.115)
        assert room.floor_area_m2 == 12.0
        assert room.centroid.as_tuple() == (2.0, 0.0, 1.5)


# --------------------------------------------------------------------------
# nothing silently dropped
# --------------------------------------------------------------------------


def test_every_golden_key_is_consumed(golden_manifest):
    """The anti-drift assertion: if the app grows a manifest field, the worker
    must grow a dataclass field for it (or explicitly allow extras)."""
    assert M.unknown_keys(golden_manifest) == []


def test_unknown_keys_reports_dotted_paths(data):
    data["surpriseTopLevel"] = 1
    data["camera"]["surpriseNested"] = 2
    data["lights"][1]["surpriseInList"] = 3
    data["portals"][0]["center"]["w"] = 4
    assert sorted(M.unknown_keys(data)) == [
        "camera.surpriseNested",
        "lights[1].surpriseInList",
        "portals[0].center.w",
        "surpriseTopLevel",
    ]


def test_unknown_keys_are_tolerated_by_load(data):
    """Forward compatibility: a newer manifest still renders."""
    data["futureField"] = {"anything": True}
    data["sky"]["viewport"]["newDiagnostic"] = 0.5
    assert M.load(data).sky.viewport.sun_intensity == pytest.approx(1.4083333333333334)


def test_viewport_allows_extras_by_design(data):
    data["sky"]["viewport"]["newDiagnostic"] = 0.5
    assert M.unknown_keys(data) == []


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


class TestValidation:
    def test_missing_required_field(self, data):
        del data["camera"]["fovYDeg"]
        with pytest.raises(M.ManifestError) as exc:
            M.load(data)
        assert "fovYDeg" in str(exc.value)

    def test_missing_required_block(self, data):
        del data["sky"]
        with pytest.raises(M.ManifestError) as exc:
            M.load(data)
        assert "sky" in str(exc.value)

    def test_wrong_type(self, data):
        data["camera"]["fovYDeg"] = "fifty"
        with pytest.raises(M.ManifestError) as exc:
            M.load(data)
        assert "fovYDeg" in str(exc.value)

    def test_booleans_are_not_numbers(self, data):
        data["camera"]["nearM"] = True
        with pytest.raises(M.ManifestError):
            M.load(data)

    def test_enum_violations(self, data):
        data["lights"][0]["kind"] = "laser"
        with pytest.raises(M.ManifestError) as exc:
            M.load(data)
        assert "light.kind" in str(exc.value)

    def test_axis_is_pinned(self, data):
        data["axis"] = "blender-z-up"
        with pytest.raises(M.ManifestError):
            M.load(data)

    def test_tier_is_pinned(self, data):
        data["render"]["tier"] = "ultra"
        with pytest.raises(M.ManifestError):
            M.load(data)

    def test_vec3_must_be_an_object(self, data):
        data["camera"]["position"] = [1, 2, 3]
        with pytest.raises(M.ManifestError):
            M.load(data)

    def test_empty_collections_are_fine(self, data):
        data["lights"] = []
        data["portals"] = []
        data["rooms"] = []
        m = M.load(data)
        assert (m.lights, m.portals, m.rooms) == ([], [], [])
