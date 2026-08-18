# Kitchen Planner — Render Pipeline

## What this is

An **async, realistic-render pipeline** for the Kitchen Planner app. The app
itself (Vite + TS + three.js) stays a pure, static modeling tool — it never
renders photorealistically in the browser. Instead, "Export ▾ → Render
package" hands you a self-contained zip (`interior-render.zip`: a render
manifest + the scene as glTF binary + the raw design JSON). A **Blender 5.2
LTS / Cycles** worker, driven by an **OpenPBR** material library that is this
directory's source of truth, turns that package into a PNG:

```
interior-render.zip  --[render.sh]-->  out.png
```

No API, queue, or job UI yet — this milestone is the data layer and the
interchange format; the worker and a hand-runnable spike land in follow-up
commits (see the milestone plan's Design §7–§8).

## Requirements

**Primary target: macOS, Apple Silicon.**

- Blender **5.2 LTS** (arm64 build), downloaded and pinned by `setup.sh`
  (sha256-verified) into `render/.blender/` — not committed, not installed
  system-wide.
- **No Docker for rendering.** macOS containers get no Metal passthrough, so
  the Blender/Cycles process must run **natively** on the host. Cycles picks
  a device with fallback `METAL → OPTIX → CUDA → HIP → CPU`, so the same
  worker code is hosting-agnostic even though the primary target is native
  macOS.
- Python 3.10+ for the data-layer scripts in this directory (`fetch_textures.py`);
  the worker's own render-time code runs inside Blender's *bundled* Python
  (stdlib only — no pip install into it).

**Secondary target: Linux + NVIDIA**, where the worker *can* run inside a
container (see `render/docker/`, optional) since Linux containers do have
GPU passthrough via NVIDIA's runtime.

## Quickstart

```bash
./setup.sh                                              # downloads Blender 5.2 arm64 + pinned textures
./render.sh interior-render.zip out.png --tier preview  # fast iteration, ~seconds
./render.sh interior-render.zip out.png --tier final     # full quality
```

`interior-render.zip` comes from the app's Export ▾ menu ("Render
package…"). `setup.sh` and `render.sh` are not in this commit yet — they
land in a follow-up (see the milestone plan, Design §7). This README ships
ahead of them so the directory layout, material data, and manifest contract
are locked first.

## Performance expectations

Preview = the iteration loop (low sample count, half resolution); final =
full manifest resolution. Numbers are wall-clock, Cycles + OIDN denoise,
single render — actuals depend on scene complexity and window/portal count.

| Hardware | Preview | Final |
|---|---|---|
| Apple M1 / M2 Pro | ~20–45 s | ~5–12 min |
| Apple M3 / M4 Max | ~10–20 s | ~1.5–4 min |
| CPU fallback (no GPU device) | — | ~20–60 min |

## Texture licensing

All PBR texture sets referenced by `materials/openpbr.materials.json` are
**CC0-1.0** (public domain) assets from [ambientCG](https://ambientcg.com).
They are **fetched, never committed** — `render/materials/textures/` is
gitignored. Pull them with:

```bash
python3 materials/fetch_textures.py
```

This reads `materials/textures.lock.json` (pinned asset ids, download URLs,
and sha256 hashes once recorded), downloads each set's zip, verifies its
hash when one is pinned, extracts only the three maps the library actually
uses (`Color` / `Roughness` / `NormalGL`), and deletes the zip. See that
script's `--help` for `--only`/`--force`.

## Directory map

```
render/
  README.md                    this file
  .gitignore                   .blender/, materials/textures/, out/, __pycache__/, .venv/, *.blend1
  setup.sh, render.sh           (follow-up commit) native-worker entry points
  manifest/
    manifest.schema.json        JSON Schema (2020-12) for RenderManifest v1
    examples/                   (follow-up) golden fixtures shared by vitest + pytest
  materials/
    openpbr.materials.json      the 19 built-in MaterialDefs -> OpenPBR 1.1 params + texture refs
    textures.lock.json          pinned ambientCG CC0 texture sets (URL + sha256 + file list)
    fetch_textures.py           stdlib downloader for the sets above
    textures/                   (gitignored) fetched JPGs, per asset id
  worker/                       (follow-up) bpy-free + bpy Python modules, Blender entry point
  docker/                       (follow-up, optional) Linux/NVIDIA container — see render/api/README.md
  api/
    README.md                   placeholder for the future TS job API
```
