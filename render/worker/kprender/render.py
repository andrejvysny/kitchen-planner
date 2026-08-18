"""Cycles settings, the two quality tiers, and the actual render call.

``preview`` is the iteration loop — fixed 1280×720, 64 samples, loose adaptive
threshold, fast denoise prefilter — and ``final`` is the manifest's own
resolution at 512 samples with the accurate prefilter.  Everything else is
shared:

* **AgX** view transform (Blender 4.0+). Filmic and Standard are the fallbacks
  if a build's OCIO config lacks it; the *look* stays ``None`` so no contrast
  curve is baked in on top.
* **Clamped indirect** at 10 — kills fireflies from the small, bright fixture
  lamps without visibly touching the daylight.
* **Reflective caustics off** always; refractive caustics only on ``final``,
  where the window glass has the sample budget to resolve them.
* **Light tree on** — with a dozen fixtures plus portals, the many-light
  sampler is the difference between "noisy" and "done".
* **Persistent data on** and a 2048 tile: this process renders exactly one
  frame, so trading memory for setup time is free.

Every setting that has moved between Blender releases is applied through
:func:`_set`, which reports rather than raises when an attribute is absent.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import bpy

from .manifest import Manifest

__all__ = ["TIERS", "Tier", "configure", "render_still"]


@dataclass(frozen=True)
class Tier:
    samples: int
    adaptive_threshold: float
    denoise_prefilter: str
    max_bounces: int
    diffuse_bounces: int
    glossy_bounces: int
    transmission_bounces: int
    caustics_refractive: bool
    #: ``None`` = use the manifest's resolution.
    resolution: tuple[int, int] | None


TIERS: dict[str, Tier] = {
    "preview": Tier(
        samples=64,
        adaptive_threshold=0.05,
        denoise_prefilter="FAST",
        max_bounces=6,
        diffuse_bounces=3,
        glossy_bounces=3,
        transmission_bounces=6,
        caustics_refractive=False,
        resolution=(1280, 720),
    ),
    "final": Tier(
        samples=512,
        adaptive_threshold=0.01,
        denoise_prefilter="ACCURATE",
        max_bounces=12,
        diffuse_bounces=4,
        glossy_bounces=6,
        transmission_bounces=12,
        caustics_refractive=True,
        resolution=None,
    ),
}

#: Fixed exposure — the manifest's ``brightness`` is already the master level,
#: and a second one here would make the two impossible to reason about.
FILM_EXPOSURE = 1.0

_missing: list[str] = []


def _set(owner: Any, attr: str, value: Any, *, label: str | None = None) -> bool:
    """Set ``owner.attr`` if it exists; record and return False if it does not."""
    name = label or attr
    if not hasattr(owner, attr):
        _missing.append(name)
        return False
    try:
        setattr(owner, attr, value)
    except (TypeError, ValueError) as exc:  # pragma: no cover - enum drift
        _missing.append(f"{name} ({exc})")
        return False
    return True


def _enum_ids(rna_owner: Any, prop: str) -> list[str]:
    try:
        return [item.identifier for item in rna_owner.bl_rna.properties[prop].enum_items]
    except (AttributeError, KeyError):  # pragma: no cover - defensive
        return []


def _view_transform(scene: Any) -> str:
    """Pick the best available view transform: AgX → Filmic → Standard."""
    available = _enum_ids(scene.view_settings, "view_transform")
    settings = scene.view_settings
    for candidate in ("AgX", "Filmic", "Standard"):
        usable = not available or candidate in available
        if usable and _set(settings, "view_transform", candidate, label="view_transform"):
            _set(settings, "look", "None", label="look")
            return candidate
    return str(getattr(scene.view_settings, "view_transform", "?"))  # pragma: no cover


def configure(
    manifest: Manifest,
    tier_name: str,
    device: str,
    opts: Any = None,
    scene: Any = None,
) -> dict[str, Any]:
    """Apply engine, sampling, bounces, denoising and output settings.

    ``opts`` is duck-typed: only ``denoise_cpu`` is read.
    """
    scene = scene or bpy.context.scene
    tier = TIERS[tier_name]
    _missing.clear()

    scene.render.engine = "CYCLES"
    cycles = scene.cycles

    width, height = tier.resolution or (manifest.render.width_px, manifest.render.height_px)
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100

    # sampling
    _set(cycles, "use_adaptive_sampling", True)
    _set(cycles, "adaptive_threshold", tier.adaptive_threshold)
    _set(cycles, "samples", tier.samples)
    _set(cycles, "use_preview_adaptive_sampling", True)

    # light transport
    _set(cycles, "max_bounces", tier.max_bounces)
    _set(cycles, "diffuse_bounces", tier.diffuse_bounces)
    _set(cycles, "glossy_bounces", tier.glossy_bounces)
    _set(cycles, "transmission_bounces", tier.transmission_bounces)
    _set(cycles, "transparent_max_bounces", tier.max_bounces)
    _set(cycles, "volume_bounces", 2)
    _set(cycles, "sample_clamp_indirect", 10.0)
    _set(cycles, "caustics_reflective", False)
    _set(cycles, "caustics_refractive", tier.caustics_refractive)
    _set(cycles, "use_light_tree", True)

    # performance — persistent data lives on scene.render (older builds had it
    # under cycles; try both so the "unavailable" log stays honest)
    if not _set(scene.render, "use_persistent_data", True) and _set(
        cycles, "use_persistent_data", True
    ):
        _missing.remove("use_persistent_data")
    _set(cycles, "tile_size", 2048)

    # denoising (--no-denoise = benchmarking: measure raw per-sample noise)
    no_denoise = bool(getattr(opts, "no_denoise", False))
    _set(cycles, "use_denoising", not no_denoise)
    _set(cycles, "denoiser", "OPENIMAGEDENOISE")
    _set(cycles, "denoising_prefilter", tier.denoise_prefilter)
    denoise_gpu = device == "METAL" and not bool(getattr(opts, "denoise_cpu", False))
    # OIDN on GPU is a large win on Apple Silicon, but MetalRT + GPU denoise has
    # crash reports in the wild — hence --denoise-cpu as the documented escape.
    _set(cycles, "denoising_use_gpu", denoise_gpu)

    # colour management + film
    view_transform = _view_transform(scene)
    _set(scene.render, "film_transparent", False)
    _set(scene.view_settings, "exposure", 0.0)
    _set(cycles, "film_exposure", FILM_EXPOSURE)

    # output
    image = scene.render.image_settings
    image.file_format = "PNG"
    _set(image, "color_mode", "RGB")
    _set(image, "color_depth", "8")
    _set(image, "compression", 15)

    report = {
        "tier": tier_name,
        "device": device,
        "resolution": f"{width}x{height}",
        "samples": tier.samples,
        "view_transform": view_transform,
        "denoise": "off" if no_denoise else ("gpu" if denoise_gpu else "cpu"),
        "unavailable_settings": sorted(set(_missing)),
    }
    print(f"kprender/render: {report}")
    return report


def render_still(out_path: str | Path, scene: Any = None) -> float:
    """Render one frame to ``out_path``; returns wall-clock seconds.

    ``time.monotonic`` on purpose — a wall-clock jump (NTP, DST) must not turn a
    render duration negative.
    """
    scene = scene or bpy.context.scene
    destination = Path(out_path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = str(destination)

    started = time.monotonic()
    bpy.ops.render.render(write_still=True)
    return time.monotonic() - started
