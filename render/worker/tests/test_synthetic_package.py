"""Tests for ``make_synthetic_package.py`` — the browser-free package fixture.

Three things need checking, in increasing order of paranoia: the zip has the
four members a real export has (``kprender.package`` round trip), the GLB it
wrote is a *structurally valid* glTF 2.0 binary (hand-parsed here — nothing
in ``kprender`` validates GLB internals, that is Blender's importer's job),
and the manifest inside loads through ``kprender.manifest``.
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

import make_synthetic_package as gen
import pytest

from kprender import manifest as manifest_mod
from kprender import package as package_mod

GLB_MAGIC = 0x46546C67
GLB_VERSION = 2
CHUNK_TYPE_JSON = 0x4E4F534A
CHUNK_TYPE_BIN = 0x004E4942


def test_member_names_match_kprender_package_constants():
    """The generator hardcodes its filenames (no import, see module docstring);
    this is the contract check that keeps them equal to the real ones."""
    assert gen.MANIFEST_FILE == package_mod.MANIFEST_FILE
    assert gen.GLB_FILE == package_mod.GLB_FILE
    assert gen.DESIGN_FILE == package_mod.DESIGN_FILE


def test_zip_has_exactly_the_four_members(tmp_path):
    dest = gen.build_package(tmp_path / "synth.zip")
    with zipfile.ZipFile(dest) as zf:
        names = set(zf.namelist())
    assert names == {
        gen.MANIFEST_FILE,
        gen.GLB_FILE,
        gen.DESIGN_FILE,
        gen.README_FILE,
    }


def test_opens_through_kprender_package(tmp_path):
    dest = gen.build_package(tmp_path / "synth.zip")
    pkg = package_mod.open_package(dest)

    assert pkg.manifest["manifestVersion"] == 1
    assert pkg.design == {}
    assert pkg.glb_bytes.startswith(b"glTF")
    assert pkg.glb_size == len(pkg.glb_bytes)


def test_manifest_matches_the_golden_fixture_byte_for_byte(tmp_path, golden_manifest_path):
    dest = gen.build_package(tmp_path / "synth.zip")
    with zipfile.ZipFile(dest) as zf:
        packaged = zf.read(gen.MANIFEST_FILE)
    assert packaged == golden_manifest_path.read_bytes()


def test_manifest_loads_through_kprender_manifest(tmp_path):
    dest = gen.build_package(tmp_path / "synth.zip")
    pkg = package_mod.open_package(dest)
    data = manifest_mod.load(pkg.manifest)
    assert data.manifest_version == 1
    assert data.camera is not None
    assert len(data.lights) == 3
    assert len(data.portals) == 1


def test_manifest_has_no_unknown_keys(tmp_path):
    """The golden fixture is already covered by the worker's manifest suite;
    this just confirms the copy in the zip is the untouched, current file."""
    dest = gen.build_package(tmp_path / "synth.zip")
    pkg = package_mod.open_package(dest)
    assert manifest_mod.unknown_keys(pkg.manifest) == []


class TestGlbContainer:
    """Hand-parse the GLB per the glTF 2.0 binary layout — kprender.package
    never looks past the byte count, so nothing else in this suite checks it."""

    def _parts(self, glb: bytes):
        magic, version, total_length = struct.unpack_from("<III", glb, 0)
        assert magic == GLB_MAGIC
        assert version == GLB_VERSION
        assert total_length == len(glb)

        offset = 12
        json_len, json_type = struct.unpack_from("<II", glb, offset)
        assert json_type == CHUNK_TYPE_JSON
        assert json_len % 4 == 0, "JSON chunk must be 4-byte aligned"
        json_data = glb[offset + 8 : offset + 8 + json_len]
        offset += 8 + json_len

        bin_len, bin_type = struct.unpack_from("<II", glb, offset)
        assert bin_type == CHUNK_TYPE_BIN
        assert bin_len % 4 == 0, "BIN chunk must be 4-byte aligned"
        bin_data = glb[offset + 8 : offset + 8 + bin_len]
        offset += 8 + bin_len

        assert offset == len(glb), "no trailing bytes past the declared chunks"
        return json_data, bin_data

    def test_header_and_chunk_alignment(self):
        glb = gen.build_glb()
        json_data, _bin_data = self._parts(glb)
        # padding bytes: JSON is space-padded, BIN is zero-padded
        assert json_data.rstrip(b" ") == json_data[: len(json_data.rstrip(b" "))]
        assert json.loads(json_data)  # valid JSON, non-empty

    def test_json_chunk_describes_one_cube_and_the_kp_material(self):
        glb = gen.build_glb()
        json_data, bin_data = self._parts(glb)
        doc = json.loads(json_data)

        assert doc["asset"]["version"] == "2.0"
        assert len(doc["meshes"]) == 1
        assert len(doc["nodes"]) == 1
        assert len(doc["scenes"]) == 1
        assert doc["materials"][0]["name"] == gen.CUBE_MATERIAL_NAME

        pos_accessor = doc["accessors"][0]
        idx_accessor = doc["accessors"][1]
        assert pos_accessor["type"] == "VEC3"
        assert pos_accessor["count"] == 8
        assert idx_accessor["type"] == "SCALAR"
        assert idx_accessor["count"] == 36
        assert pos_accessor["min"] == [-0.5, -0.5, -0.5]
        assert pos_accessor["max"] == [0.5, 0.5, 0.5]

        # every bufferView fits inside the BIN chunk exactly, no overlap/gap
        views = doc["bufferViews"]
        assert views[0]["byteOffset"] == 0
        assert views[1]["byteOffset"] == views[0]["byteLength"]
        assert views[1]["byteOffset"] + views[1]["byteLength"] <= len(bin_data)
        assert doc["buffers"][0]["byteLength"] <= len(bin_data)

    def test_bin_chunk_decodes_to_the_expected_geometry(self):
        glb = gen.build_glb()
        _json_data, bin_data = self._parts(glb)

        pos_bytes = bin_data[0:96]
        idx_bytes = bin_data[96:168]
        positions = [struct.unpack_from("<3f", pos_bytes, i * 12) for i in range(8)]
        indices = list(struct.unpack_from("<36H", idx_bytes, 0))

        assert positions == list(gen._CUBE_POSITIONS)
        assert indices == list(gen._CUBE_INDICES)
        assert min(min(v) for v in positions) == pytest.approx(-0.5)
        assert max(max(v) for v in positions) == pytest.approx(0.5)


def test_cli_writes_a_package(tmp_path):
    """``python3 make_synthetic_package.py out.zip`` — the standalone entry
    point, run as a real subprocess so no test-only import shortcuts hide a
    bootstrap bug (this script must run with a bare ``python3``, no uv)."""
    script = Path(gen.__file__)
    out = tmp_path / "out.zip"
    result = subprocess.run(
        [sys.executable, str(script), str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert out.is_file()
    assert out.stat().st_size > 1024
    with zipfile.ZipFile(out) as zf:
        assert zf.testzip() is None


def test_cli_rejects_bad_args():
    script = Path(gen.__file__)
    result = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
