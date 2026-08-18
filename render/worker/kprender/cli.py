"""Command line: ``render.sh package.zip out.png [flags]``.

Flow::

    open package  →  manifest.load  →  clean scene  →  import GLB
                  →  device.configure  →  materials.rebuild_all
                  →  lighting.apply  →  camera.setup
                  →  --probe? dump transforms and stop
                  →  render.configure  →  render  →  summary

Structural validation is the dataclass layer in :mod:`kprender.manifest` (no
``jsonschema`` inside Blender's Python), and it runs *before* anything touches
``bpy`` — a bad package fails in a millisecond with a dotted path, not
halfway through an import.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import manifest as manifest_mod
from . import package as package_mod

__all__ = ["Options", "build_parser", "main"]


@dataclass(frozen=True)
class Options:
    """Parsed flags.  Passed by duck typing to the bpy modules, which read only
    the fields they need (``uv_box``, ``no_portals``, ``denoise_cpu``)."""

    package: Path
    out: Path
    tier: str
    device: str
    denoise_cpu: bool
    no_portals: bool
    no_ceiling: bool
    save_blend: bool
    uv_box: bool
    probe: bool


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="render.sh",
        description="Render a Kitchen Planner render package (interior-render.zip) with Cycles.",
    )
    parser.add_argument("package", type=Path, help="the render package (.zip) exported by the app")
    parser.add_argument(
        "--out", type=Path, default=Path("out.png"), help="output PNG path (default: out.png)"
    )
    parser.add_argument(
        "--tier",
        choices=("preview", "final"),
        default="preview",
        help="preview: 1280x720 / 64 spp (seconds). final: manifest resolution / 512 spp.",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "cpu", "metal", "optix", "cuda"),
        default="auto",
        help="compute backend; auto tries METAL, OPTIX, CUDA, HIP, ONEAPI, then CPU",
    )
    parser.add_argument(
        "--denoise-cpu",
        action="store_true",
        help="run OpenImageDenoise on the CPU (escape hatch for MetalRT + GPU-OIDN crashes)",
    )
    parser.add_argument(
        "--no-portals", action="store_true", help="skip window light portals (A/B the sampling win)"
    )
    parser.add_argument(
        "--no-ceiling", action="store_true", help="delete Ceiling* objects before rendering"
    )
    parser.add_argument(
        "--save-blend", action="store_true", help="also save <out>.blend for inspection"
    )
    parser.add_argument(
        "--uv-box",
        action="store_true",
        help="use object-space box projection instead of the mesh UVs (UV fallback)",
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="print the scene's transforms as JSON and exit without rendering",
    )
    return parser


def _options(args: argparse.Namespace) -> Options:
    return Options(
        package=args.package,
        out=args.out,
        tier=args.tier,
        device=args.device,
        denoise_cpu=args.denoise_cpu,
        no_portals=args.no_portals,
        no_ceiling=args.no_ceiling,
        save_blend=args.save_blend,
        uv_box=args.uv_box,
        probe=args.probe,
    )


def _probe_dump(scene: Any) -> dict[str, Any]:
    """Every object's world bounding box plus the light/camera transforms.

    This is the runtime half of the axis-convention safety net: the CI half is
    ``tests/axis_probe_expected.json`` (pure ``convert`` maths, no Blender), and
    this dump lets a human confirm the same numbers survived the import, the
    constraint evaluation and Blender's own unit handling.
    """
    import bpy
    from mathutils import Vector

    bpy.context.view_layer.update()  # resolve Track-To before reading matrices

    def mat(obj: Any) -> list[list[float]]:
        return [[round(float(v), 6) for v in row] for row in obj.matrix_world]

    objects = []
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        entry: dict[str, Any] = {"name": obj.name, "type": obj.type}
        if corners:
            entry["bbox_min"] = [round(min(c[i] for c in corners), 6) for i in range(3)]
            entry["bbox_max"] = [round(max(c[i] for c in corners), 6) for i in range(3)]
        objects.append(entry)

    lights = []
    for obj in sorted(bpy.data.objects, key=lambda o: o.name):
        if obj.type != "LIGHT":
            continue
        data = obj.data
        lights.append(
            {
                "name": obj.name,
                "light_type": data.type,
                "location": [round(float(v), 6) for v in obj.location],
                "rotation_euler": [round(float(v), 6) for v in obj.rotation_euler],
                "energy": round(float(getattr(data, "energy", 0.0)), 6),
                "is_portal": bool(getattr(getattr(data, "cycles", None), "is_portal", False)),
                "matrix_world": mat(obj),
            }
        )

    camera = scene.camera
    return {
        "axis": "blender-z-up (from gltf-y-up via (x, -z, y))",
        "camera": None
        if camera is None
        else {
            "name": camera.name,
            "location": [round(float(v), 6) for v in camera.location],
            "sensor_fit": camera.data.sensor_fit,
            "angle_y_deg": round(math.degrees(float(camera.data.angle_y)), 6),
            "matrix_world": mat(camera),
        },
        "lights": lights,
        "objects": objects,
    }


def main(argv: list[str] | None = None) -> int:
    """Entry point called by ``blender_entry.py``.  Returns a process exit code."""
    started = time.monotonic()
    args = build_parser().parse_args(argv)
    opts = _options(args)

    # ---- bpy-free half: fail fast, with a readable message ----------------
    try:
        pkg = package_mod.open_package(opts.package)
        data = manifest_mod.load(pkg.manifest)
    except (package_mod.PackageError, manifest_mod.ManifestError) as exc:
        print(f"kprender: {exc}", file=sys.stderr)
        return 2

    extras = manifest_mod.unknown_keys(pkg.manifest)
    if extras:
        print(f"kprender: manifest has {len(extras)} unknown key(s), ignored: {extras[:8]}")

    # ---- bpy half ---------------------------------------------------------
    import bpy

    from . import camera as camera_mod
    from . import device as device_mod
    from . import lighting as lighting_mod
    from . import materials as materials_mod
    from . import render as render_mod
    from . import scene as scene_mod
    from .openpbr_map import load_library

    scene = bpy.context.scene
    scene_mod.clean(scene)

    glb_path = package_mod.write_glb_temp(pkg)
    try:
        imported = scene_mod.import_glb(glb_path)
    finally:
        glb_path.unlink(missing_ok=True)

    if opts.no_ceiling:
        scene_mod.drop_ceiling()

    device = device_mod.configure(opts.device, scene)
    try:
        library = load_library()
    except (OSError, ValueError, KeyError) as exc:
        # Graceful degradation, like a missing texture: every kp: material
        # still rebuilds, just from its flat colour instead of the library.
        print(f"kprender: cannot read the OpenPBR library ({exc}); using flat colours")
        library = {}
    materials_mod.rebuild_all(data, library, opts)
    lighting_mod.apply(data, opts, scene)
    camera_mod.setup(data, scene)

    if opts.probe:
        print(json.dumps(_probe_dump(scene), indent=2, sort_keys=True))
        return 0

    render_mod.configure(data, opts.tier, device, opts, scene)
    seconds = render_mod.render_still(opts.out, scene)

    if opts.save_blend:
        blend_path = Path(str(opts.out.expanduser().resolve()) + ".blend")
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
        print(f"kprender: saved {blend_path}")

    total = time.monotonic() - started
    print(
        f"kprender: done — device={device} tier={opts.tier} objects={imported} "
        f"render={seconds:.1f}s total={total:.1f}s out={opts.out}"
    )
    return 0
