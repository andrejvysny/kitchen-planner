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

No API, queue, or job UI yet — this milestone is the data layer, the
interchange format and a hand-runnable native worker. **First time here?
`NEXT_STEPS.md` (this directory) is the local-machine checklist: first
render, texture pinning, correctness checks, calibration, and the milestone-2
service plan.**

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
cd render
./setup.sh                                                      # Blender 5.2 (sha256-pinned) + CC0 textures
./render.sh interior-render.zip --out out.png --tier preview    # fast iteration, ~seconds
./render.sh interior-render.zip --out out.png --tier final --save-blend
```

`interior-render.zip` comes from the app's Export ▾ menu ("Render
package…"). `setup.sh` installs into `render/.blender/` — nothing is written
outside this directory and nothing is installed system-wide. If you already
have Blender 5.2, skip `setup.sh` and `export BLENDER=/path/to/blender`
instead.

### Worker flags

`./render.sh <package.zip> [flags]` — everything after the package is passed
straight through to `worker/kprender/cli.py` (`--help` lists them all):

| Flag | Effect |
|---|---|
| `--out PATH` | output PNG (default `out.png`) |
| `--tier preview\|final` | 1280×720 / 64 spp, or manifest resolution / 512 spp (default `preview`) |
| `--device auto\|cpu\|metal\|optix\|cuda` | compute backend; `auto` = METAL → OPTIX → CUDA → HIP → ONEAPI → CPU |
| `--denoise-cpu` | run OpenImageDenoise on the CPU (escape hatch for MetalRT + GPU-OIDN crashes) |
| `--no-portals` | skip window light portals — A/B how much they buy |
| `--no-ceiling` | delete `Ceiling*` objects (top-down framing) |
| `--save-blend` | also write `<out>.blend` for inspection |
| `--uv-box` | object-space box projection instead of mesh UVs (UV fallback) |
| `--probe` | print every object/light/camera transform as JSON and exit without rendering |

`--probe` is the axis-convention check: its numbers should match
`worker/tests/axis_probe_expected.json`, which pytest already verifies against
the golden manifest with no Blender in the loop.

### Developing the worker

```bash
cd render/worker
uv run ruff check .     # lint (line length 100, py311)
uv run pytest           # the bpy-free modules: convert, matnames, manifest, package, openpbr_map
```

`pytest`/`ruff` are **dev-only**. Everything under `worker/kprender/` runs
inside Blender's bundled Python at render time, so it is stdlib-only — the
bpy-free half exists precisely so the numbers that matter (axis conversion,
colour, colour temperature, lamp watts, manifest parsing) can be tested
without a GPU or a Blender install.

## Performance expectations

Preview = the iteration loop (low sample count, half resolution); final =
full manifest resolution. Numbers are wall-clock, Cycles + OIDN denoise,
single render — actuals depend on scene complexity and window/portal count.

| Hardware | Preview | Final (1080p) |
|---|---|---|
| Apple M4 Pro (measured, demo kitchen, 419 objects) | ~2–6 s | ~65–100 s |
| Apple M1 / M2 Pro (estimate) | ~10–30 s | ~3–8 min |
| CPU fallback, M4 Pro (measured, preview only) | ~4 s | untested |

The FIRST Metal render on a machine compiles the Cycles Metal kernels —
~2.5 min one-off (measured, M4 Pro), cached by Blender afterwards. Time
`--tier preview` twice before believing any number.

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
  setup.sh                     downloads + verifies the pinned Blender, fetches textures
  render.sh                    resolves Blender and runs the worker on a package
  manifest/
    manifest.schema.json        JSON Schema (2020-12) for RenderManifest v1
    examples/kitchen-min.json   golden fixture shared by vitest + pytest
  materials/
    openpbr.materials.json      the 19 built-in MaterialDefs -> OpenPBR 1.1 params + texture refs
    textures.lock.json          pinned ambientCG CC0 texture sets (URL + sha256 + file list)
    fetch_textures.py           stdlib downloader for the sets above
    textures/                   (gitignored) fetched JPGs, per asset id
  worker/
    pyproject.toml              uv project: pytest + ruff, DEV ONLY
    blender_entry.py            `blender -b -P blender_entry.py -- <args>` bootstrap
    kprender/
      package.py                reads interior-render.zip                    | bpy-free
      manifest.py               RenderManifest v1 dataclasses + validation   | bpy-free
      convert.py                axis map, sRGB, kelvin, lamp watts           | bpy-free
      matnames.py               the kp: grammar (mirrors materialName.ts)    | bpy-free
      openpbr_map.py            OpenPBR -> Principled table + library loader | bpy-free
      device.py                 METAL/OPTIX/CUDA/HIP/ONEAPI/CPU selection
      textures.py               texture-set node subtrees
      materials.py              rebuilds every kp: material
      lighting.py               sun, sky, fixtures, window portals
      camera.py                 pose, vertical sensor fit, Track-To
      scene.py                  clean + glTF import
      render.py                 Cycles settings, the two tiers, the render call
      cli.py                    argparse + the whole flow
    tests/                      pytest for the bpy-free half (+ axis_probe_expected.json)
  docker/                       (follow-up, optional) Linux/NVIDIA container — see render/api/README.md
  api/
    README.md                   placeholder for the future TS job API
```

## How the worker fits together

The rule that keeps a pipeline nobody can run locally correct: **the bpy layer
is thin, and every computation lives in a bpy-free module a test can reach.**

* `convert.py` owns every sign. glTF/three `(x, y_up, z)` → Blender
  `(x, −z, y)`; end to end, plan `(px, py)` at height `h` → Blender
  `(px, −py, h)`. Because that map is a proper rotation (`Rx(+90°)`, det +1), a
  yaw about glTF `+Y` is the same angle about Blender `+Z` — which is why the
  LED-strip rotation needs no sign flip. Colour temperature
  (`1e6 / (125 + 330·warmth)`), the sRGB EOTF, the sun's sky-texture bearing
  (`azimuth − 90°`) and the lamp-watt table all live here too.
* `matnames.py` mirrors `src/model/materialName.ts` exactly, and its tests are
  ported from that module's vitest cases — the two parsers are a contract
  across a language boundary.
* `manifest.py` validates structurally without `jsonschema` (unavailable inside
  Blender): each dataclass carries its own field table, which doubles as the
  "did we silently drop a field?" check against the golden manifest.
* `openpbr_map.py` is the OpenPBR → Principled projection as *data*, so the
  eventual swap to Blender's native OpenPBR node is one file.

Every `bpy` attribute that has moved between releases is behind a `hasattr` or
an enum probe (MetalRT, `Thin Wall`, `denoising_use_gpu`, `tile_size`, the
Nishita sky, `visible_shadow`, the glTF importer's operator name), so a build
that lacks one renders slightly differently instead of crashing.
