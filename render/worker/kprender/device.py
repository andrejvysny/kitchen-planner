"""Cycles compute-device selection.

Primary target is Apple Silicon (``METAL``), but the same worker has to run on
a Linux/NVIDIA box unchanged, so the preference order is
``METAL → OPTIX → CUDA → HIP → ONEAPI → CPU`` and every backend-specific
attribute is probed before it is touched.

Two Blender-version hazards are guarded here:

* ``CyclesPreferences.get_devices()`` was renamed/duplicated as
  ``refresh_devices()``; both exist in different releases.
* MetalRT (hardware ray tracing on M3+) moved from a per-scene boolean
  (``scene.cycles.use_metalrt``) to a preferences enum (``cprefs.metalrt``,
  ``'OFF' | 'ON' | 'AUTO'``).  ``'AUTO'`` is what we want — Blender then enables
  it only on hardware where it is a win.
"""

from __future__ import annotations

import bpy

__all__ = ["DEVICE_ORDER", "configure"]

#: Backend preference, best first.  ``CPU`` is the implicit tail.
DEVICE_ORDER = ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI")

_ALIASES = {
    "auto": None,
    "cpu": "CPU",
    "metal": "METAL",
    "optix": "OPTIX",
    "cuda": "CUDA",
    "hip": "HIP",
    "oneapi": "ONEAPI",
}


def _cycles_prefs():
    """The Cycles addon preferences, or ``None`` when the addon is absent."""
    addons = bpy.context.preferences.addons
    addon = addons.get("cycles")
    if addon is None:
        # Built-in and enabled by default, even under --factory-startup, but a
        # stripped build could lack it: fall back to CPU rather than crash.
        print("kprender/device: the Cycles addon is not available; falling back to CPU")
        return None
    return addon.preferences


def _available_backends(cprefs) -> list[str]:
    """Backend enum values this build exposes, in this build's own order."""
    try:
        prop = cprefs.bl_rna.properties["compute_device_type"]
        return [item.identifier for item in prop.enum_items]
    except (AttributeError, KeyError):  # pragma: no cover - defensive
        return []


def _refresh(cprefs) -> None:
    """Populate ``cprefs.devices``.  The method's name moved between releases."""
    for name in ("refresh_devices", "get_devices"):
        fn = getattr(cprefs, name, None)
        if callable(fn):
            try:
                fn()
            except TypeError:  # pragma: no cover - signature drift
                continue
            return


def _enable_devices(cprefs, backend: str) -> int:
    """Turn on every device of ``backend``; return how many were enabled.

    CPU devices are deliberately left OFF when a GPU backend is in play. On
    Metal in particular, mixing the CPU in costs more in synchronisation than
    the extra cores return, and it is the configuration Blender's own Metal
    work is tuned against.
    """
    enabled = 0
    for dev in getattr(cprefs, "devices", []):
        dev_type = getattr(dev, "type", "CPU")
        if dev_type == backend:
            dev.use = True
            enabled += 1
        elif dev_type == "CPU":
            dev.use = False
    return enabled


def _set_metalrt(cprefs, scene) -> str:
    """Best-effort MetalRT enable.  Returns a short status for the log."""
    if hasattr(cprefs, "metalrt"):
        try:
            cprefs.metalrt = "AUTO"
            return "metalrt=AUTO (preferences)"
        except (TypeError, ValueError):  # pragma: no cover - enum drift
            pass
    if hasattr(scene.cycles, "use_metalrt"):
        scene.cycles.use_metalrt = True
        return "metalrt=on (legacy scene flag)"
    return "metalrt=unavailable"


def configure(force: str | None = None, scene=None) -> str:
    """Pick and activate a compute device.

    ``force`` is the ``--device`` flag (``auto``/``cpu``/``metal``/``optix``/
    ``cuda``/``hip``/``oneapi``); ``auto`` walks :data:`DEVICE_ORDER`.  Returns
    the backend actually in use (``'METAL'``, …, or ``'CPU'``), which the CLI
    prints and :mod:`kprender.render` consults for GPU denoising.
    """
    scene = scene or bpy.context.scene
    key = (force or "auto").lower()
    if key not in _ALIASES:
        raise SystemExit(f"--device: unknown backend {force!r}; expected one of {sorted(_ALIASES)}")
    wanted = _ALIASES[key]

    cprefs = _cycles_prefs()
    if cprefs is None or wanted == "CPU":
        scene.cycles.device = "CPU"
        return "CPU"

    available = _available_backends(cprefs)
    candidates = [wanted] if wanted else [b for b in DEVICE_ORDER if b in available]
    if wanted and wanted not in available:
        print(f"kprender/device: this build has no {wanted} backend (has: {available or 'none'})")
        candidates = []

    for backend in candidates:
        try:
            cprefs.compute_device_type = backend
        except (TypeError, ValueError):
            continue
        _refresh(cprefs)
        count = _enable_devices(cprefs, backend)
        if count == 0:
            print(f"kprender/device: {backend} backend present but no devices; trying next")
            continue
        scene.cycles.device = "GPU"
        note = _set_metalrt(cprefs, scene) if backend == "METAL" else ""
        print(f"kprender/device: {backend} × {count} device(s){', ' + note if note else ''}")
        return backend

    scene.cycles.device = "CPU"
    print("kprender/device: no usable GPU backend; rendering on CPU")
    return "CPU"
