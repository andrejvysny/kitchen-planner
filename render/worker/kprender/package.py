"""Reading ``interior-render.zip`` — the package the app's Export ▾ menu writes.

Layout (``src/model/renderPackage.ts``)::

    manifest.json   RenderManifest v1 (see kprender.manifest)
    scene.glb       the scene, closed-pose, canonical material names
    design.json     raw JSON.stringify(design) — provenance, not consumed yet
    README.txt      human note, ignored here

The two payload file names are read out of the manifest's ``files`` block
rather than hardcoded, so a future package can rename them without a worker
release; the constants below are only the fallback for a manifest that somehow
lacks the block.

Stdlib only — ``zipfile`` and ``json``.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = ["DESIGN_FILE", "GLB_FILE", "MANIFEST_FILE", "Package", "open_package", "write_glb_temp"]

MANIFEST_FILE = "manifest.json"
GLB_FILE = "scene.glb"
DESIGN_FILE = "design.json"


class PackageError(ValueError):
    """A zip that is not a render package (missing member, bad JSON, …)."""


@dataclass
class Package:
    """An opened package, fully in memory.

    ``manifest`` and ``design`` are the raw decoded JSON — :func:`kprender.
    manifest.load` turns the first into dataclasses; ``design`` stays a plain
    dict because nothing in the worker reads it yet (it travels for provenance
    and for future features such as per-room render framing).
    """

    path: Path
    manifest: dict[str, Any]
    glb_bytes: bytes
    design: dict[str, Any]

    @property
    def glb_size(self) -> int:
        return len(self.glb_bytes)


def _read_member(zf: zipfile.ZipFile, name: str, *, what: str) -> bytes:
    try:
        return zf.read(name)
    except KeyError as exc:
        members = ", ".join(sorted(zf.namelist())) or "(empty zip)"
        raise PackageError(
            f"render package is missing {what} ({name!r}). Members: {members}"
        ) from exc


def _read_json(zf: zipfile.ZipFile, name: str, *, what: str) -> dict[str, Any]:
    raw = _read_member(zf, name, what=what)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PackageError(f"render package: {name} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise PackageError(f"render package: {name} must contain a JSON object")
    return data


def open_package(path: str | Path) -> Package:
    """Open ``path`` (a ``.zip``) and read its three payload members."""
    zip_path = Path(path).expanduser().resolve()
    if not zip_path.is_file():
        raise PackageError(f"render package not found: {zip_path}")
    if not zipfile.is_zipfile(zip_path):
        raise PackageError(f"not a zip file: {zip_path}")

    with zipfile.ZipFile(zip_path) as zf:
        manifest = _read_json(zf, MANIFEST_FILE, what="its manifest")
        files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
        glb_name = files.get("glb", GLB_FILE) if isinstance(files, dict) else GLB_FILE
        design_name = files.get("design", DESIGN_FILE) if isinstance(files, dict) else DESIGN_FILE
        glb_bytes = _read_member(zf, str(glb_name), what="its scene GLB")
        design = _read_json(zf, str(design_name), what="its design JSON")

    return Package(path=zip_path, manifest=manifest, glb_bytes=glb_bytes, design=design)


def write_glb_temp(pkg: Package, dest_dir: str | Path | None = None) -> Path:
    """Spill the GLB to a real file so Blender's importer can open it.

    ``bpy.ops.import_scene.gltf`` only takes a path, never bytes.  The caller
    owns the returned file (``cli`` deletes it in a ``finally``); it is created
    with ``delete=False`` because the importer must be able to reopen it by
    name on every platform.
    """
    directory = Path(dest_dir) if dest_dir is not None else None
    with tempfile.NamedTemporaryFile(
        suffix=".glb", prefix="kprender-", dir=directory, delete=False
    ) as handle:
        handle.write(pkg.glb_bytes)
        return Path(handle.name)
