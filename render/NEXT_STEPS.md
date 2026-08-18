# Render pipeline — next steps (local machine)

What must happen on your own Mac to validate milestone 1, and how the project
continues from there. The app-side backlog lives in the root `ROADMAP.md`;
this file is only about the render pipeline.

## State (2026-08-18)

Milestone 1 ("spike + interchange") is complete on branch
`claude/kitchen-planner-rendering-review-blie2w`, commits `b3ea440..a4ecd33`:
every material carries a semantic `kp:` name (grammar in
`src/model/materialName.ts`, mirrored by `worker/kprender/matnames.py`),
`View3D.exportRenderGLB` emits a canonicalized texture-free GLB,
`buildRenderManifest` derives camera/sky/lights/portals (golden-tested at
`manifest/examples/kitchen-min.json`, shared by vitest and pytest),
**Export ▾ → "Render package (.zip)…"** produces `interior-render.zip`, and
`worker/` renders it with Blender 5.2 LTS / Cycles — Metal-first, 153+ pytest
tests on the bpy-free math. Not yet done: anything that needs a GPU, a real
Blender run, or the ambientCG network — that is this checklist.

## Validation run, 2026-08-18 (M4 Pro) — §A done, §B mostly done

- Blender 5.2.0 pinned via `setup.sh`; **Metal needed a worker fix**:
  `compute_device_type` is a dynamic enum whose `enum_items` is empty on the
  official build, so `device.py` now probes by assignment when the enum list
  is unknown. Warm Metal preview ~2–6 s, final 1080p ~65–100 s; first-ever
  Metal render pays ~2.5 min of kernel compilation once. README table updated
  with measured numbers.
- All 10 texture sets downloaded, sha256-pinned and `verified: true` in
  `textures.lock.json` (re-fetch against the pins passes).
- `--probe` bbox/axis check passes against the plan; 44 canonical materials
  (dozens, not hundreds) and the `kp` glTF-extras custom property SURVIVES
  into the .blend — both channels of the contract work.
- Not exercised: `.blend` hand-inspection in the Blender UI, golden-hour
  reference comparison (§C needs reference photos).

## Quality track (photorealism expert pass, 2026-08-18) — R1 done, R2/R3 next

Decisions taken with the user: quality track BEFORE milestone 2; calibration
against synthetic targets (no reference photos); a "physical lights" mode so
lamps can be on in daylight renders. Full analysis lives in the R1 commit
message and below.

### R1 — correctness fixes (DONE, committed)

- `src/view3d/meshKit.ts` `prism()` side-wall UVs rewritten to (arc length
  along the contour, extrusion depth) in metres — three's stock
  ExtrudeGeometry UVs project u onto the dominant axis (cos-compressed on
  diagonals, jittery on arcs). Caps untouched (already shape-space metres).
  Pinned by `test/unit/prismUV.test.ts` (diagonal wall now spans √2, hole
  contours parameterize independently, v = extrusion depth).
- `worker/kprender/lighting.py`: sky model selected EXPLICITLY —
  NISHITA → MULTIPLE_SCATTERING → HOSEK_WILKIE — instead of trusting the
  build's default; contradictory log line gone. **Sun-disc double-count risk
  cleared by API probe**: the 5.2 MULTIPLE_SCATTERING node still has
  `sun_disc` (plus sun_elevation/rotation/size/intensity) and the worker
  already sets it False, so the KP Sun lamp stays the only direct sun.
- `use_persistent_data` lives on `scene.render` (not `cycles`) — fixed, the
  "unavailable_settings" log is clean again.
- New worker CLI flags: `--no-denoise` (benchmarking: raw per-sample noise)
  and `--lights scene|on` (`on` = LAMP_BOOST_FULL 1.44 wattage regardless of
  daylight — the staged-interior look; `scene` = viewport-faithful gate).
- Gates at commit time: worker ruff + 164 pytest green; app tsc/eslint/
  753 unit/build green; interact runs against a tree that ALSO carries
  unrelated app WIP (see the WIP commit) — its one red,
  "wall-snap placement on a migrated design", pre-exists that WIP and is NOT
  render-related (clean HEAD + UV fix alone was being verified when the
  session was stopped; finish that check or fix the WIP first).

### R2 — material realism pass (NEXT, worker + assets only)

1. `fetch_textures.py`: compute each set's mean RGB of the Color map, write
   `meanColor` into `textures.lock.json` (backfill all 10 by re-running with
   `--force`).
2. Normalized multiply: effective tint = `appColor_linear / meanColor`
   (component-clamped to [0, 4]) wherever `baseColorMode: "multiply"` — kills
   the "tint × already-brown map = mud" darkening on all 9 woods. Pure math
   in a bpy-free helper + pytest.
3. `openpbr.materials.json`: `base_metalness` → 0 on all woods/tiles/marble/
   concrete (dielectrics; the 0.02 is a viewport carry-over).

### R3 — calibration harness + light calibration (synthetic targets)

1. `render/bench/`: script renders a fixed package list (kitchen day / golden
   hour / night / all-lights-on via `--lights on` / small room) and reports
   mean/median luminance, % clipped, RMS high-frequency noise, render time.
   Packages export headlessly via playwright (pattern: drive
   `window.__kp.view.setPreset('inside')`, mutate `design.scene`, click
   `[data-export="render"]`, save the download).
2. Portal A/B with `--no-denoise` at fixed 64 spp — keep/drop verdict on RMS
   noise + time, recorded here. (OIDN flattened the first A/B; denoise-off is
   the honest test.)
3. Calibrate `SUN_W` (lighting.py, currently 3.0 — day interiors measurably
   too dark) so the day scene's median display luminance lands ~0.35–0.55
   under AgX; then the fixture watt tables + warmth endpoints
   (`convert.watts_for`) against the night scene. Freeze in one commit.

### Continuation prompt for a clean session

"Continue the render quality track per render/NEXT_STEPS.md — R2 then R3.
R1 is committed; verify its interact gate on a clean tree first."

## A. First render (the spike validation) — do this first

1. `render/setup.sh` — downloads the pinned Blender 5.2 LTS (macOS arm64 dmg,
   sha256-verified) into `render/.blender/`. If the pinned point release has
   moved on, bump `BLENDER_VERSION` at the top of the script.
2. `python3 render/materials/fetch_textures.py` — the ambientCG API was
   egress-blocked from the dev container, so all 10 sets in
   `textures.lock.json` are `"verified": false` with `sha256: null`. Confirm
   each set downloads, then paste the printed "pin this" sha256 block back
   into `textures.lock.json` and commit it — that turns the lock file into a
   real reproducibility contract. If an asset id 404s, pick a replacement on
   ambientcg.com and update both the lock file and
   `openpbr.materials.json`'s `textureSet.ref`.
3. `npm run dev`, open the demo kitchen, frame a nice view in 3D, then
   **Export ▾ → "Render package (.zip)…"**.
4. `render/render.sh ~/Downloads/interior-render.zip --out out.png --tier preview`
   — expect ~10–45 s on the GPU. Then `--tier final --save-blend` for the real
   thing (~1.5–12 min depending on chip).
5. Record actual timings per tier on your machine and correct the table in
   `render/README.md` — those numbers are estimates until measured.

Exit criterion (from the milestone plan): one convincing 1080p render of the
demo kitchen plus real time numbers on Apple Silicon.

## B. One-time correctness checks

- `render/render.sh pkg.zip --probe` dumps every object's world bbox and the
  camera/sun/light transforms as JSON — sanity-check a known cabinet against
  the plan (`Blender = (plan.x, −plan.y, height)`; the derivation lives in
  `worker/kprender/convert.py`'s docstring, pinned by
  `worker/tests/axis_probe_expected.json`).
- Open the `--save-blend` file: material names should read `kp:m:oak:…` etc.,
  textures wired, portals sitting in the window apertures, sun direction
  matching the viewport's shadows.
- A/B `--no-portals` on the same package: portals should cut noise (or time to
  the same noise) noticeably in interiors. If not, investigate before
  milestone 2 bakes them in.
- Check worktop grain scale vs a cabinet front: worktops with cutouts are
  extruded prisms whose UV units were never formally verified — if the grain
  is wrong, `--uv-box` is the escape hatch and the real fix goes in
  `src/view3d/meshKit.ts` `prism()`.
- Look for hairline light leaks where walls meet (butt-ended slabs + joint
  patches) under a low sun. A leak is a geometry fix in the app, not a worker
  workaround.
- Confirm the GLB imports with dozens of materials, not hundreds, and whether
  material custom properties (`kp` from glTF `extras`) survived — nice-to-have
  channel, the name is the contract either way.

## C. Calibration session (timebox: one afternoon)

Constants deliberately marked CALIBRATION, all in the worker:

- `SUN_W` (`worker/kprender/lighting.py`) — sun lamp watts multiplier.
- The fixture watt tables (`worker/kprender/convert.py` `watts_for`) — point
  (10+90·i), spot (15+135·i), bar (5+25·i)·width.
- Warmth→kelvin endpoints (8000 K cool / ~2198 K warm).
- Per-material OpenPBR values in `materials/openpbr.materials.json`
  (roughness/coat feel; the `base_metalness: 0.02` on woods/tiles is a
  viewport carry-over — set to 0 while you're in there).

Method: render the same 3–5 benchmark packages (kitchen day, kitchen night,
golden hour, small room/one window, all fixtures on) after every change,
compare against reference photos, freeze the winning values in one commit.
Keep the benchmark zips in a folder outside the repo.

## D. Milestone 2 — async service MVP (next implementation block)

Decided stack (user-approved in the milestone-1 planning session):

- **API**: TypeScript (Fastify or Hono) in `render/api/` — presigned upload /
  `POST /v1/renders` / `GET /v1/renders/:id`, single API key, JSON-Schema
  validation of the manifest (`render/manifest/manifest.schema.json`).
- **Queue**: BullMQ + Redis (docker-compose for API+Redis is fine — only the
  Blender process must run natively on macOS; the queue worker process
  connects out and shells `render/render.sh`).
- **Storage**: filesystem first, S3/R2 interface-shaped for later.
- **App side**: "Render this view" dialog (tier picker) + a jobs panel with
  polling; job ids in localStorage following the `src/model/prefs.ts`
  pattern (own storage key in `storageKeys.ts`, never in the Design).
- **Idempotency**: job key = hash(design.json + manifest.json + tier +
  pipelineVersion); stamp `pipelineVersion` on every output.

The full service architecture (components, contract sketch, operational
rules) is §3 and §6 of the rendering review document this work started from.

## E. Deferred / later

- **three.js `^0.166` → r18x upgrade** — its own PR, after milestone 2 if you
  like; the material-stamping and golden-manifest tests written in milestone 1
  are the regression net that makes it safe.
- **Viewport parity (Phase 4)** — derive viewport materials from
  `materials/openpbr.materials.json` + KTX2 textures; closes the WYSIWYG gap.
- **Serverless GPU** — `render/docker/` (Linux+NVIDIA, unexercised) is the
  seam for RunPod/Modal when local rendering stops being enough.
- **Native OpenPBR node** — when Blender ships it (tracking issue #156437),
  the swap is one file: `worker/kprender/openpbr_map.py`.

## Continuing with Claude

Branch: `claude/kitchen-planner-rendering-review-blie2w`. Useful next-session
prompts: "implement milestone 2 per render/NEXT_STEPS.md §D", "run the
calibration pass per §C with these reference photos", "do the three.js
upgrade PR per §E". Conventions to keep: the `kp:` grammar and the 19
material ids are a three-file cross-language contract (see CLAUDE.md
Gotchas); regenerate the manifest golden only deliberately
(`UPDATE_GOLDEN=1 npx vitest run test/unit/renderManifest.test.ts`), never to
green a red test; run `graphify update .` after merging.
