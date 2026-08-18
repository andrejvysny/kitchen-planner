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
