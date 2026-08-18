"""Conventions: the axis map, colour, colour temperature, lamp power.

This is the module the whole worker's correctness rests on — a sign flip here
produces a render that looks plausible and is wrong — so the cases are
hand-computed rather than round-tripped through the code under test.
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path

import pytest

from kprender import convert as C

EXPECTED_PATH = Path(__file__).with_name("axis_probe_expected.json")
TOL = 1e-6


def approx(value, expected, tol=TOL):
    return value == pytest.approx(expected, abs=tol)


@pytest.fixture(scope="module")
def expected():
    """The hand-derived Blender-frame values (see the file's own _comment)."""
    with EXPECTED_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


# --------------------------------------------------------------------------
# the axis map
# --------------------------------------------------------------------------


class TestAxisMap:
    def test_hand_computed_triples(self):
        # (x, y_up, z) -> (x, -z, y)
        assert C.to_blender({"x": 1.0, "y": 2.0, "z": 3.0}) == (1.0, -3.0, 2.0)
        assert C.to_blender((0.0, 0.0, 0.0)) == (0.0, 0.0, 0.0)
        assert C.to_blender((-4.5, 0.25, 7.0)) == (-4.5, -7.0, 0.25)

    def test_basis_vectors(self):
        # glTF +x stays +X; glTF +y (up) becomes Blender +Z; glTF +z becomes -Y.
        assert C.to_blender((1, 0, 0)) == (1.0, 0.0, 0.0)
        assert C.to_blender((0, 1, 0)) == (0.0, 0.0, 1.0)
        assert C.to_blender((0, 0, 1)) == (0.0, -1.0, 0.0)

    def test_map_is_a_proper_rotation_not_a_mirror(self):
        """det = +1. A mirroring map would silently invert every normal and
        every yaw, and would still pass a naive spot-check on positions."""
        x = C.to_blender((1, 0, 0))
        y = C.to_blender((0, 1, 0))
        z = C.to_blender((0, 0, 1))
        det = (
            x[0] * (y[1] * z[2] - y[2] * z[1])
            - x[1] * (y[0] * z[2] - y[2] * z[0])
            + x[2] * (y[0] * z[1] - y[1] * z[0])
        )
        assert approx(det, 1.0)
        # ...and it preserves handedness pairwise: X × Y = Z in the image too.
        assert C.cross(x, y) == pytest.approx(z, abs=TOL)

    def test_end_to_end_plan_rule(self):
        """CLAUDE.md: plan (x, y) -> world (x, z) with y = height; composing
        with the glTF->Blender map gives plan (px, py) -> (px, -py, h)."""
        for px, py, h in ((0.0, 0.0, 0.0), (2.0, 1.5, 0.9), (-3.25, 4.0, 2.6)):
            assert C.plan_to_blender(px, py, h) == (px, -py, h)
            # same result via the two-step route the app actually takes
            assert C.to_blender((px, h, py)) == (px, -py, h)

    def test_directions_use_the_same_map(self):
        for v in ((0, -1, 0), (0.6, 0.0, -0.8), (1, 1, 1)):
            assert C.dir_to_blender(v) == C.to_blender(v)

    def test_accepts_dicts_sequences_and_objects(self):
        class Vec:
            x, y, z = 1.0, 2.0, 3.0

        assert C.to_blender({"x": 1, "y": 2, "z": 3}) == (1.0, -3.0, 2.0)
        assert C.to_blender([1, 2, 3]) == (1.0, -3.0, 2.0)
        assert C.to_blender(Vec()) == (1.0, -3.0, 2.0)

    def test_rejects_wrong_length(self):
        with pytest.raises(ValueError):
            C.to_blender((1.0, 2.0))


# --------------------------------------------------------------------------
# orientation
# --------------------------------------------------------------------------


class TestAimEuler:
    @staticmethod
    def _apply(euler):
        """Rotate (0, 0, -1) by an XYZ Euler, longhand — the inverse of the
        closed form aim_euler solves, so the two disagreeing means a bug."""
        rx, ry, rz = euler
        assert ry == 0.0
        # Rx then Rz, applied to the lamp's -Z axis
        v = (0.0, math.sin(rx), -math.cos(rx))
        return (
            v[0] * math.cos(rz) - v[1] * math.sin(rz),
            v[0] * math.sin(rz) + v[1] * math.cos(rz),
            v[2],
        )

    @pytest.mark.parametrize(
        "direction",
        [
            (0.0, 0.0, -1.0),  # straight down
            (0.0, 0.0, 1.0),  # straight up
            (1.0, 0.0, 0.0),
            (-0.098039, -0.098039, -0.990342),  # the golden manifest's spot
            (-0.579228, -0.579228, -0.573576),  # the golden manifest's sun
        ],
    )
    def test_round_trip(self, direction):
        aimed = self._apply(C.aim_euler(direction))
        assert aimed == pytest.approx(C.normalize(direction), abs=1e-6)

    def test_straight_down_is_pure_yaw(self):
        """A bar light hangs facing down, so its yaw is the whole rotation —
        and it is the manifest's yawRad with NO sign flip (see lighting.py)."""
        assert C.aim_euler((0.0, 0.0, -1.0), roll=0.75) == pytest.approx((0.0, 0.0, 0.75))

    def test_yaw_axis_survives_the_frame_change(self):
        """A rotation about glTF +Y by t equals a rotation about Blender +Z by
        the same t: the item's local +x lands in the same place either way."""
        for t in (0.0, 0.3, -1.2, math.pi / 2):
            gltf_x = (math.cos(t), 0.0, -math.sin(t))  # three: Ry(t) . (1,0,0)
            blender_x = (math.cos(t), math.sin(t), 0.0)  # Blender: Rz(t) . (1,0,0)
            assert C.to_blender(gltf_x) == pytest.approx(blender_x, abs=TOL)


class TestMatrixFromBasis:
    def test_rows_are_axis_components(self):
        m = C.matrix_from_basis((1, 0, 0), (0, 0, -1), (0, 1, 0), (2, 0.05, 1.55))
        assert m == (
            (1.0, 0.0, 0.0, 2.0),
            (0.0, 0.0, 1.0, 0.05),
            (0.0, -1.0, 0.0, 1.55),
            (0.0, 0.0, 0.0, 1.0),
        )

    def test_identity(self):
        m = C.matrix_from_basis((1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0))
        assert m == (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 1.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        )


def test_sun_rotation():
    """Bearing CCW from +X = azimuth - 90 (see convert.sun_rotation)."""
    assert approx(C.sun_rotation(90.0), 0.0)
    assert approx(C.sun_rotation(135.0), math.radians(45.0))
    assert approx(C.sun_rotation(0.0), math.radians(-90.0))
    assert approx(C.sun_rotation(360.0), math.radians(270.0))


# --------------------------------------------------------------------------
# colour
# --------------------------------------------------------------------------


class TestSrgb:
    def test_round_numbers(self):
        assert C.srgb_hex_to_linear("000000") == (0.0, 0.0, 0.0)
        assert C.srgb_hex_to_linear("ffffff") == pytest.approx((1.0, 1.0, 1.0), abs=1e-12)
        # 128/255 through the real EOTF, NOT 128/255 = 0.502.
        assert C.srgb_hex_to_linear("808080") == pytest.approx(
            (0.2158605, 0.2158605, 0.2158605), abs=1e-6
        )

    def test_leading_hash_and_case(self):
        assert C.srgb_hex_to_linear("#C9A87C") == C.srgb_hex_to_linear("c9a87c")

    def test_is_not_a_plain_divide(self):
        mid = C.srgb_hex_to_linear("808080")[0]
        assert mid < 128 / 255 / 2  # the whole point of the transfer function

    @pytest.mark.parametrize("bad", ["", "12345", "#12345", "zzzzzz", "1234567"])
    def test_rejects_malformed(self, bad):
        with pytest.raises(ValueError):
            C.srgb_hex_to_linear(bad)


class TestKelvin:
    def test_endpoints(self):
        """warmth 0 -> 8000 K, warmth 1 -> the reciprocal ramp's warm end.

        The milestone plan quotes "2200 K" as the nominal candle end; the exact
        value of 1e6/(125 + 330) is 2197.80 K. Both are asserted so neither the
        formula nor the intent can drift unnoticed.
        """
        assert C.kelvin_from_warmth(0.0) == pytest.approx(8000.0, abs=1e-9)
        assert C.kelvin_from_warmth(1.0) == pytest.approx(2197.802198, abs=1e-4)
        assert abs(C.kelvin_from_warmth(1.0) - 2200.0) < 3.0

    def test_monotonic_and_reciprocal(self):
        values = [C.kelvin_from_warmth(w / 10) for w in range(11)]
        assert values == sorted(values, reverse=True)
        # even in mireds (1e6/K), which is the point of the reciprocal ramp
        mireds = [1e6 / v for v in values]
        steps = [b - a for a, b in itertools.pairwise(mireds)]
        assert all(s == pytest.approx(steps[0], abs=1e-9) for s in steps)

    def test_blackbody_is_warm_at_the_warm_end(self):
        cool = C.kelvin_to_rgb(C.kelvin_from_warmth(0.0))
        warm = C.kelvin_to_rgb(C.kelvin_from_warmth(1.0))
        assert warm[0] > warm[2]  # candle: more red than blue
        assert cool[2] > warm[2]  # 8000 K is bluer than 2200 K
        for channel in (*cool, *warm):
            assert 0.0 <= channel <= 1.0

    def test_clamps_outside_the_fit_range(self):
        assert C.kelvin_to_rgb(10.0) == C.kelvin_to_rgb(1000.0)
        assert C.kelvin_to_rgb(1e9) == C.kelvin_to_rgb(40000.0)


# --------------------------------------------------------------------------
# photometry
# --------------------------------------------------------------------------


class TestWatts:
    @pytest.mark.parametrize(
        "kind,intensity,size_x,expected",
        [
            ("point", 0.0, None, 10.0),
            ("point", 1.0, None, 100.0),
            ("point", 0.7, None, 73.0),  # the golden manifest's pendant
            ("spot", 0.0, None, 15.0),
            ("spot", 1.0, None, 150.0),
            ("spot", 0.65, None, 102.75),  # the golden manifest's spot
            ("bar", 0.0, 1.0, 5.0),
            ("bar", 1.0, 1.0, 30.0),
            ("bar", 0.55, 1.2, 22.5),  # the golden manifest's LED strip
        ],
    )
    def test_table(self, kind, intensity, size_x, expected):
        assert C.watts_for(kind, intensity, 1.0, size_x) == pytest.approx(expected)

    def test_boost_scales_linearly_and_gates_at_zero(self):
        assert C.watts_for("point", 0.7, 0.0) == 0.0
        assert C.watts_for("point", 0.7, 2.0) == pytest.approx(146.0)

    @pytest.mark.parametrize("kind", ["point", "spot", "bar"])
    def test_monotonic_in_intensity(self, kind):
        values = [C.watts_for(kind, i / 10, 1.0, 1.0) for i in range(11)]
        assert values == sorted(values)
        assert values[0] < values[-1]

    def test_bar_scales_with_length(self):
        short = C.watts_for("bar", 0.5, 1.0, 0.5)
        long = C.watts_for("bar", 0.5, 1.0, 2.0)
        assert long == pytest.approx(short * 4)

    def test_unknown_kind(self):
        with pytest.raises(ValueError):
            C.watts_for("chandelier", 0.5, 1.0)


# --------------------------------------------------------------------------
# the golden axis probe
# --------------------------------------------------------------------------


class TestAxisProbeGolden:
    """Every Blender-frame number in axis_probe_expected.json, recomputed.

    This is the CI half of the axis safety net; ``render.sh --probe`` is the
    runtime half. Both read the same golden manifest the app's vitest suite
    compares against.
    """

    def test_camera(self, golden_manifest, expected):
        cam = golden_manifest["camera"]
        assert C.to_blender(cam["position"]) == pytest.approx(expected["camera"]["position"], abs=TOL)
        assert C.to_blender(cam["target"]) == pytest.approx(expected["camera"]["target"], abs=TOL)
        assert C.dir_to_blender(cam["up"]) == pytest.approx(expected["camera"]["up"], abs=TOL)
        assert cam["fovYDeg"] == expected["camera"]["fovYDeg"]

    def test_sun(self, golden_manifest, expected):
        sky = golden_manifest["sky"]
        want = expected["sun"]
        toward = C.dir_to_blender(sky["sunDirection"])
        travel = C.negate(toward)
        assert toward == pytest.approx(want["towardSun"], abs=TOL)
        assert travel == pytest.approx(want["travel"], abs=TOL)
        assert C.aim_euler(travel) == pytest.approx(want["rotationEuler"], abs=TOL)
        assert C.sun_rotation(sky["azimuthDeg"]) == pytest.approx(
            want["skyTextureRotation"], abs=TOL
        )
        assert math.radians(sky["elevationDeg"]) == pytest.approx(
            want["skyTextureElevation"], abs=TOL
        )
        # the Euler X term IS the zenith angle: 90 - elevation
        assert math.degrees(want["rotationEuler"][0]) == pytest.approx(
            90.0 - sky["elevationDeg"], abs=1e-4
        )

    def test_lights(self, golden_manifest, expected):
        lights = golden_manifest["lights"]
        assert len(lights) == len(expected["lights"])
        for light, want in zip(lights, expected["lights"], strict=True):
            assert light["itemId"] == want["itemId"]
            assert light["kind"] == want["kind"]
            assert light["on"] == want["on"]
            assert C.to_blender(light["position"]) == pytest.approx(want["position"], abs=TOL)
            direction = C.dir_to_blender(light["direction"])
            assert direction == pytest.approx(want["direction"], abs=TOL)
            roll = light["yawRad"] if light["kind"] == "bar" else 0.0
            assert C.aim_euler(direction, roll=roll) == pytest.approx(
                want["rotationEuler"], abs=TOL
            )
            assert C.watts_for(
                light["kind"], light["intensity"], 1.0, light.get("sizeX")
            ) == pytest.approx(want["wattsAtBoost1"], abs=1e-6)

    def test_portals(self, golden_manifest, expected):
        portals = golden_manifest["portals"]
        assert len(portals) == len(expected["portals"])
        for portal, want in zip(portals, expected["portals"], strict=True):
            assert portal["openingId"] == want["openingId"]
            normal = C.normalize(C.dir_to_blender(portal["normal"]))
            tangent = C.normalize(C.dir_to_blender(portal["tangent"]))
            z_axis = C.negate(normal)
            y_axis = C.normalize(C.cross(z_axis, tangent))
            assert C.to_blender(portal["center"]) == pytest.approx(want["center"], abs=TOL)
            assert normal == pytest.approx(want["normalInward"], abs=TOL)
            assert tangent == pytest.approx(want["tangent"], abs=TOL)
            assert tangent == pytest.approx(want["localX"], abs=TOL)
            assert y_axis == pytest.approx(want["localY"], abs=TOL)
            assert z_axis == pytest.approx(want["localZ"], abs=TOL)
            matrix = C.matrix_from_basis(
                tangent, y_axis, z_axis, C.to_blender(portal["center"])
            )
            for row, want_row in zip(matrix, want["matrixWorld"], strict=True):
                assert row == pytest.approx(want_row, abs=TOL)
            # the portal plane must be perpendicular to the wall normal
            assert sum(a * b for a, b in zip(tangent, normal, strict=True)) == pytest.approx(
                0.0, abs=TOL
            )
            assert max(portal["width"] - 0.10, 0.05) == pytest.approx(want["sizeX"])
            assert max(portal["height"] - 0.10, 0.05) == pytest.approx(want["sizeY"])
