"""Builds a minimal but VALID ``interior-render.zip`` without the browser.

The app's own export path (``src/model/renderPackage.ts`` → fflate → a real
GLTFExporter GLB) is the only way to produce a *real* package today, which
means neither CI nor a from-scratch dev machine can smoke-test the worker
without first driving a browser. This module closes that gap: it hand-builds
a byte-valid glTF 2.0 binary (one 1×1×1 m cube, one ``kp:`` material) plus the
other three package members, entirely from the standard library.

Package layout (mirrors ``kprender.package.MANIFEST_FILE/GLB_FILE/
DESIGN_FILE``, hardcoded here rather than imported so this module has zero
dependencies of its own — see the module docstring note below)::

    manifest.json   a byte-for-byte copy of render/manifest/examples/kitchen-min.json
    scene.glb       one cube, one material named "kp:c:aabbcc:matte"
    design.json     {} — the worker never parses this file
    README.txt      what this zip is and how it was made

Usable two ways:

    python3 make_synthetic_package.py out.zip      # CLI
    build_package(Path("out.zip"))                  # imported (pytest, CI)

Stdlib only: ``json``, ``struct``, ``sys``, ``zipfile``, ``pathlib``. No
``kprender`` import — the generator must run standalone (a plain ``python3``,
no ``uv run``, no Blender), so it does not lean on this repo's own import
bootstrap.
"""

from __future__ import annotations

import json
import struct
import sys
import zipfile
from pathlib import Path

__all__ = [
    "CUBE_MATERIAL_NAME",
    "DESIGN_FILE",
    "GLB_FILE",
    "MANIFEST_FILE",
    "README_FILE",
    "build_design_json",
    "build_glb",
    "build_package",
    "build_readme",
]

# Package member names — kept as plain literals (see module docstring) but
# equal to kprender.package.{MANIFEST,GLB,DESIGN}_FILE by contract; the
# pytest suite checks that equality directly.
MANIFEST_FILE = "manifest.json"
GLB_FILE = "scene.glb"
DESIGN_FILE = "design.json"
README_FILE = "README.txt"

#: The one material the cube carries — "plain" grammar (kp:c:<hex6>:<matte|wood>),
#: see src/model/materialName.ts / render/worker/kprender/matnames.py.
CUBE_MATERIAL_NAME = "kp:c:aabbcc:matte"

_KITCHEN_MIN = Path(__file__).resolve().parents[2] / "manifest" / "examples" / "kitchen-min.json"

# --------------------------------------------------------------------------
# glTF 2.0 binary (.glb) container
# --------------------------------------------------------------------------
#
#   12-byte header:  magic(u32) version(u32) length(u32)          — all LE
#   JSON chunk:      chunkLength(u32) chunkType(u32) chunkData    — space-padded to 4 bytes
#   BIN chunk:       chunkLength(u32) chunkType(u32) chunkData    — zero-padded to 4 bytes
#
# https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout

_GLB_MAGIC = 0x46546C67  # "glTF"
_GLB_VERSION = 2
_CHUNK_TYPE_JSON = 0x4E4F534A  # "JSON"
_CHUNK_TYPE_BIN = 0x004E4942  # "BIN\0"

_COMPONENT_TYPE_FLOAT = 5126
_COMPONENT_TYPE_USHORT = 5123
_TARGET_ARRAY_BUFFER = 34962
_TARGET_ELEMENT_ARRAY_BUFFER = 34963

# A unit cube (1x1x1 m) centred on the origin: 8 shared vertices, 12
# triangles (2 per face). Winding/normals are not asserted by anything that
# consumes this fixture — validity of the container is the point, not shading.
_CUBE_POSITIONS: tuple[tuple[float, float, float], ...] = (
    (-0.5, -0.5, -0.5),
    (0.5, -0.5, -0.5),
    (0.5, 0.5, -0.5),
    (-0.5, 0.5, -0.5),
    (-0.5, -0.5, 0.5),
    (0.5, -0.5, 0.5),
    (0.5, 0.5, 0.5),
    (-0.5, 0.5, 0.5),
)
_CUBE_INDICES: tuple[int, ...] = (
    0, 1, 2, 0, 2, 3,  # -Z
    4, 5, 6, 4, 6, 7,  # +Z
    0, 4, 5, 0, 5, 1,  # -Y
    3, 2, 6, 3, 6, 7,  # +Y
    0, 3, 7, 0, 7, 4,  # -X
    1, 5, 6, 1, 6, 2,  # +X
)  # fmt: skip


def _pack_chunk(data: bytes, chunk_type: int, pad_byte: bytes) -> bytes:
    """One GLB chunk: 8-byte header + data padded to a 4-byte boundary."""
    padding = (-len(data)) % 4
    padded = data + pad_byte * padding
    return struct.pack("<II", len(padded), chunk_type) + padded


def _hex6_to_rgb(hex6: str) -> tuple[float, float, float]:
    return (
        int(hex6[0:2], 16) / 255.0,
        int(hex6[2:4], 16) / 255.0,
        int(hex6[4:6], 16) / 255.0,
    )


def build_glb() -> bytes:
    """A byte-valid glTF 2.0 binary: one mesh/node/scene, one material."""
    pos_bytes = b"".join(struct.pack("<3f", *v) for v in _CUBE_POSITIONS)
    idx_bytes = b"".join(struct.pack("<H", i) for i in _CUBE_INDICES)
    bin_bytes = pos_bytes + idx_bytes

    xs = [v[0] for v in _CUBE_POSITIONS]
    ys = [v[1] for v in _CUBE_POSITIONS]
    zs = [v[2] for v in _CUBE_POSITIONS]
    r, g, b = _hex6_to_rgb(CUBE_MATERIAL_NAME.split(":")[2])

    gltf: dict = {
        "asset": {"version": "2.0", "generator": "kitchen-planner make_synthetic_package.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "SyntheticCube", "mesh": 0}],
        "meshes": [
            {
                "name": "Cube",
                "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}],
            }
        ],
        "materials": [
            {
                "name": CUBE_MATERIAL_NAME,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [round(r, 6), round(g, 6), round(b, 6), 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.82,
                },
            }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": _COMPONENT_TYPE_FLOAT,
                "count": len(_CUBE_POSITIONS),
                "type": "VEC3",
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            },
            {
                "bufferView": 1,
                "componentType": _COMPONENT_TYPE_USHORT,
                "count": len(_CUBE_INDICES),
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": len(pos_bytes),
                "target": _TARGET_ARRAY_BUFFER,
            },
            {
                "buffer": 0,
                "byteOffset": len(pos_bytes),
                "byteLength": len(idx_bytes),
                "target": _TARGET_ELEMENT_ARRAY_BUFFER,
            },
        ],
        "buffers": [{"byteLength": len(bin_bytes)}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_chunk = _pack_chunk(json_bytes, _CHUNK_TYPE_JSON, b" ")
    bin_chunk = _pack_chunk(bin_bytes, _CHUNK_TYPE_BIN, b"\x00")

    total_length = 12 + len(json_chunk) + len(bin_chunk)
    header = struct.pack("<III", _GLB_MAGIC, _GLB_VERSION, total_length)
    return header + json_chunk + bin_chunk


# --------------------------------------------------------------------------
# the other three package members
# --------------------------------------------------------------------------


def build_manifest_json() -> bytes:
    """Raw bytes of the golden manifest — a byte-for-byte copy, not a re-dump
    (re-serialising would still be valid JSON, but "a copy" means the exact
    checked-in bytes)."""
    return _KITCHEN_MIN.read_bytes()


def build_design_json() -> str:
    """Minimal valid JSON the worker never parses (kprender.package only
    requires it to decode to a JSON object)."""
    return "{}\n"


def build_readme() -> str:
    return (
        "Synthetic render package\n"
        "=========================\n"
        "\n"
        "Generated by render/worker/tests/make_synthetic_package.py for smoke\n"
        "testing render.sh / kprender without the browser export path. NOT a\n"
        "real design export.\n"
        "\n"
        f"  {MANIFEST_FILE}   a copy of render/manifest/examples/kitchen-min.json\n"
        f"  {GLB_FILE}       one 1x1x1 m cube, one material ({CUBE_MATERIAL_NAME})\n"
        f"  {DESIGN_FILE}     {{}} (unparsed by the worker)\n"
    )


def build_package(dest: str | Path) -> Path:
    """Write a complete ``interior-render.zip`` at ``dest`` and return the path."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_FILE, build_manifest_json())
        zf.writestr(GLB_FILE, build_glb())
        zf.writestr(DESIGN_FILE, build_design_json())
        zf.writestr(README_FILE, build_readme())
    return dest


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: make_synthetic_package.py OUT.zip", file=sys.stderr)
        return 2
    dest = build_package(argv[0])
    print(f"wrote {dest} ({dest.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
