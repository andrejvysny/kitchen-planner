"""Put ``render/worker`` on ``sys.path`` so ``import kprender.…`` works.

The package is deliberately not installable (``[tool.uv] package = false``):
at render time it is loaded by ``blender_entry.py`` inserting the same
directory, so the tests exercise the same import path the worker does.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

WORKER_ROOT = Path(__file__).resolve().parents[1]
RENDER_ROOT = WORKER_ROOT.parent

if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))


@pytest.fixture(scope="session")
def golden_manifest_path() -> Path:
    """``render/manifest/examples/kitchen-min.json`` — the fixture the app's
    vitest golden test also compares against, so the two cannot drift."""
    return RENDER_ROOT / "manifest" / "examples" / "kitchen-min.json"


@pytest.fixture(scope="session")
def golden_manifest(golden_manifest_path: Path) -> dict:
    with golden_manifest_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@pytest.fixture(scope="session")
def library_path() -> Path:
    return RENDER_ROOT / "materials" / "openpbr.materials.json"
