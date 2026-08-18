"""Reading ``interior-render.zip``.

Not in the milestone plan's test list, but ``package.py`` is the first thing
that runs on every render and its failures (a truncated zip, a renamed member,
a hand-edited manifest) are exactly the ones a user hits — so the error paths
are worth a few lines here rather than a stack trace inside Blender.
"""

from __future__ import annotations

import json
import zipfile

import pytest

from kprender import package as P

GLB_STUB = b"glTF\x02\x00\x00\x00stub-bytes"


def _write_zip(path, *, manifest, glb=GLB_STUB, design=None, skip=()):
    with zipfile.ZipFile(path, "w") as zf:
        if "manifest.json" not in skip:
            zf.writestr("manifest.json", json.dumps(manifest))
        if "scene.glb" not in skip:
            zf.writestr("scene.glb", glb)
        if "design.json" not in skip:
            zf.writestr("design.json", json.dumps(design if design is not None else {"version": 6}))
        zf.writestr("README.txt", "ignored")
    return path


def test_round_trip(tmp_path, golden_manifest):
    zip_path = _write_zip(tmp_path / "interior-render.zip", manifest=golden_manifest)
    pkg = P.open_package(zip_path)
    assert pkg.manifest["manifestVersion"] == 1
    assert pkg.glb_bytes == GLB_STUB
    assert pkg.glb_size == len(GLB_STUB)
    assert pkg.design == {"version": 6}
    assert pkg.path == zip_path.resolve()


def test_member_names_come_from_the_manifest(tmp_path, golden_manifest):
    """A future package may rename its payload files; the manifest says so."""
    manifest = dict(golden_manifest, files={"glb": "model.glb", "design": "plan.json"})
    zip_path = tmp_path / "renamed.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("model.glb", GLB_STUB)
        zf.writestr("plan.json", json.dumps({"version": 6}))
    pkg = P.open_package(zip_path)
    assert pkg.glb_bytes == GLB_STUB


def test_write_glb_temp(tmp_path, golden_manifest):
    zip_path = _write_zip(tmp_path / "p.zip", manifest=golden_manifest)
    pkg = P.open_package(zip_path)
    spilled = P.write_glb_temp(pkg, dest_dir=tmp_path)
    try:
        assert spilled.suffix == ".glb"
        assert spilled.read_bytes() == GLB_STUB
    finally:
        spilled.unlink(missing_ok=True)


class TestErrors:
    def test_missing_file(self, tmp_path):
        with pytest.raises(P.PackageError, match="not found"):
            P.open_package(tmp_path / "nope.zip")

    def test_not_a_zip(self, tmp_path):
        path = tmp_path / "plain.zip"
        path.write_text("this is not a zip")
        with pytest.raises(P.PackageError, match="not a zip"):
            P.open_package(path)

    def test_missing_manifest(self, tmp_path, golden_manifest):
        zip_path = _write_zip(
            tmp_path / "p.zip", manifest=golden_manifest, skip=("manifest.json",)
        )
        with pytest.raises(P.PackageError, match="manifest"):
            P.open_package(zip_path)

    def test_missing_glb_lists_the_members(self, tmp_path, golden_manifest):
        zip_path = _write_zip(tmp_path / "p.zip", manifest=golden_manifest, skip=("scene.glb",))
        with pytest.raises(P.PackageError) as exc:
            P.open_package(zip_path)
        assert "scene.glb" in str(exc.value)
        assert "design.json" in str(exc.value)  # the "Members:" listing

    def test_bad_json(self, tmp_path):
        zip_path = tmp_path / "p.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("manifest.json", "{not json")
        with pytest.raises(P.PackageError, match="valid JSON"):
            P.open_package(zip_path)

    def test_manifest_must_be_an_object(self, tmp_path):
        zip_path = tmp_path / "p.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("manifest.json", "[1, 2, 3]")
        with pytest.raises(P.PackageError, match="JSON object"):
            P.open_package(zip_path)
