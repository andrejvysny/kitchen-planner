# Next steps

A prioritized roadmap. Each item notes where in the codebase the change lands
and a rough effort estimate (S < half a day, M ≈ 1–2 days, L ≈ 3+ days).

## Known limitations (current state)

- No corner/blind-corner cabinets; runs meeting in a corner simply overlap.
- Continuous worktops merge straight runs of rect-footprint units only; a run
  turning a corner (L / U layouts) still meets as two slabs.
- Non-orthogonal walls work, but wall joints render best at 90°.
- No collision prevention — items can be pushed inside each other or through walls.
- Flat colors only (by design: Blender is the photorealism path).
- Real-time shadows are budgeted to 4 fixture lights (`SHADOW_LIGHT_BUDGET`).
- Desktop-first; both 2D views (plan + elevation) now pinch-zoom/two-finger-pan,
  and hit targets scale up on coarse (touch) pointers — but the layout and
  panels are not yet touch-optimized for small screens.
- No keyboard-only plan editing (a11y): placement, drag, resize, and rotate
  are pointer-only. Known debt, deferred.

## Recently shipped (not yet folded into the tiers above)

- Auto-shared walls: adjacent room polygons weld into one shared partition
  wall instead of double walls (`rooms.ts` shared-edge detection).
- Draw-room polygon tool: freehand room creation in the plan, not just presets.
- Floor-plan photo underlay: trace an existing plan image (`src/model/underlay.ts`).
- Spatial checks engine: collision/clearance/work-triangle warnings (`checks.ts`).
- Recovery backup + save-fail surfacing: autosave failures are now visible
  instead of silently dropped (`storageKeys.ts`, `store.ts` `markSaveResult`).

## Tier 1 — highest value next

1. ~~Corner base & wall cabinets~~ — DONE: cabinets are zone-tree parts with
   chamfer/cornerL footprints and true polygon hit-tests; ship corner PRESETS
   in `presets.ts` if wanted (S).
2. ~~Continuous worktops~~ — DONE: `worktopRuns` (`src/model/worktops.ts`)
   chains adjacent worktop-bearing rect cabinets and the run leader emits one
   merged prism (with every member's appliance cutouts) through
   `HostContext.worktop`; `hostContexts(design)` is the one composer the 3D
   view and the BOM export both call. L-corner runs remain out of scope.
3. ~~Collision & overlap warnings~~ — DONE: `src/model/checks.ts` `runChecks`
   (2.5D height-aware SAT + polygon overlap, plus ergonomic clearances and
   the work triangle), tints offending items red/amber in both views,
   `store.warnings()` lazy cache, never blocks movement.
4. ~~Shopping list / BOM export~~ — DONE: `buildBom` (`src/model/export.ts`)
   groups every item's `partPanels` output into a cut list + bought-products
   shopping list; `exportFormats.ts` renders CSV and a printable HTML sheet.
5. ~~Wall elevation view~~ — DONE: `src/plan2d/elevation.ts` + `src/model/elevation.ts`,
   follows the active room.

## Tier 2 — UX polish

6. **Marquee multi-select + group drag** (M) — `plan2d.ts` drag state and a
   `Selection { kind: 'items', ids: [] }` variant in the store.
7. **Smart placement flow** (S) — after placing a base unit, offer "add matching
   wall cabinet above" one-click action in the properties panel.
8. **Sink ↔ water-supply guide** (S) — when a sink is selected, draw a guide
   line + distance to the nearest water marker in `plan2d.ts` (helper exists:
   `nearestWall` pattern in `snapping.ts`).
9. ~~Openings survive room reshaping~~ — DONE: `setShapePreset` anchors at the
   room's min-corner and re-homes openings via `reprojectOpeningsNearest`.
10. ~~Touch support~~ — DONE: pinch zoom / two-finger pan (`src/plan2d/pinch.ts`,
    shared by plan2d and elevation), coarse-pointer hit radii via `hitRadius()`.
11. ~~Print / PDF plan sheet~~ — DONE: `Export ▾ → Plan sheet…`
    (`src/print/sheet.ts`) renders the plan offscreen at true scale through the
    shared `renderPlan` (`src/plan2d/renderPlan.ts`) and composes an A4
    landscape sheet — title block, 1:50 plan, item schedule from `buildBom` —
    for the browser's own print dialog. No PDF library.

## Tier 3 — visual & rendering

12. **Procedural textures** (M) — wood grain / stone via small canvas-generated
    textures in `itemMeshes.ts` (keeps the zero-asset property). Also export
    nicer into Blender.
13. **Ambient occlusion & soft contact shadows** (S–M) — bake a blurred
    dark plane under each item, or add SSAO postprocessing (three/examples).
14. **First-person walk mode** (M) — WASD + pointer-lock camera preset in
    `view3d.ts`; the "inside" preset is the starting point.
15. **Blender export upgrades** (S) — optional: include `KHR_lights_punctual`
    lights (flag in the export dialog), split materials by name
    (`front_sage`, `worktop_oak`) so batch-assigning materials in Blender is
    one click per material. **Half shipped:** every material is now stamped
    with a semantic `kp:` name at creation (`src/model/materialName.ts`,
    mirrored by `render/worker/kprender/matnames.py`) — the async render
    pipeline's worker reads it to rebuild real OpenPBR materials, and it
    already gives the manual Blender workflow above one name per material
    instead of GLTFExporter's per-instance defaults. `KHR_lights_punctual`
    in the plain `.glb` export remains open.

## Tier 4 — bigger bets

16. ~~Part Studio: free-form template~~ — DONE (zone-tree editor, interiors,
    appliance niches, openable fronts).
17. ~~Multi-room / whole-apartment planning~~ — DONE: Design v6 `rooms[]`,
    shared partitions, add-room tool, room switcher, v5→v6 migration.
18. **Real product catalogs** (L) — map parametric items to retailer SKUs
    (e.g. IKEA METOD sizes are already the default dimensions) for a priced
    shopping list.
19. **Cloud save / share links** (M–L) — the design is one JSON blob; any
    key-value backend (Supabase, a tiny worker + R2) plus a `?design=` loader
    gives shareable links.
20. **AI layout assistant** (L) — given the room polygon + openings + water
    marker, propose runs respecting the work-triangle rule (now codified as
    `CLEARANCE.TRIANGLE_*` + `triangleChecks` in `checks.ts`); the data model
    (walls with inward normals, snapping) makes generated layouts easy to
    validate.

## Engineering hygiene

- ~~Unit tests~~ — DONE: Vitest suite (`test/unit/`, 24 files) covers
  geometry/store/snapping, mesh-builder smoke, panels, checks, and migration.
- ~~Vite chunk split~~ — DONE: `vite.config.ts` gives `three` its own
  `manualChunks` entry, under the 600 kB warning.
- ~~CI~~ — DONE: `.github/workflows/deploy.yml` runs unit tests, `vite build`
  (which runs `tsc --noEmit`), and `test/interact.mjs` against the built
  preview on every push to master.
- Migrate `Item`/`Design` versioning: bump `version` and write a migration
  step in `normalizeDesign()` before the schema changes for tier-1 items.
