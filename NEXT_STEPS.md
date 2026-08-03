# Next steps

A prioritized roadmap. Each item notes where in the codebase the change lands
and a rough effort estimate (S < half a day, M ≈ 1–2 days, L ≈ 3+ days).

## Known limitations (current state)

- No corner/blind-corner cabinets; runs meeting in a corner simply overlap.
- Countertops are per-unit slabs — visually continuous only when units align
  exactly; no single merged worktop with cutouts.
- Non-orthogonal walls work, but wall joints render best at 90°.
- No collision prevention — items can be pushed inside each other or through walls.
- Flat colors only (by design: Blender is the photorealism path).
- Real-time shadows are budgeted to 4 fixture lights (`SHADOW_LIGHT_BUDGET`).
- Desktop-first; 2D plan has pinch zoom/pan, but the elevation view does not,
  and hit targets are mouse-sized.

## Tier 1 — highest value next

1. ~~Corner base & wall cabinets~~ — DONE: cabinets are zone-tree parts with
   chamfer/cornerL footprints and true polygon hit-tests; ship corner PRESETS
   in `presets.ts` if wanted (S).
2. **Continuous worktops** (M) — group adjacent worktop-bearing cabinets on a
   run into one merged slab. Cutouts already work per host (`HostContext`
   prism holes); the merge is the remaining piece.
3. **Collision & overlap warnings** (S–M) — oriented-bounding-box overlap test in
   `snapping.ts`; tint offending items red in both views rather than blocking
   movement (planners that hard-block feel frustrating).
4. **Shopping list / BOM export** (S) — items are already parametric data; group
   `design.items` by def + dimensions, export CSV/Markdown with counts and
   sizes. Useful for pricing against IKEA/retailer catalogs.
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
10. **Touch support** (M) — pinch zoom / two-finger pan in `plan2d.ts`
    (pointer-events code is already unified; add gesture math).
11. **Print / PDF plan sheet** (M) — dimensioned floor plan + item schedule via
    the browser print stylesheet, or client-side PDF (jsPDF).

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
    one click per material.

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
    marker, propose runs respecting the work-triangle rule; the data model
    (walls with inward normals, snapping) makes generated layouts easy to
    validate.

## Engineering hygiene

- Add unit tests for `geometry.ts`, `snapping.ts`, and `store.ts` mutations
  (Vitest — pure functions, fast wins; the E2E suite already covers flows).
- Split `three` into a manual Vite chunk to get the main bundle under the
  600 kB warning, or lazy-load `view3d` so the 2D editor paints first.
- CI: `tsc --noEmit`, `vite build`, and the Playwright suite on push
  (`test/interact.mjs` already exits non-zero on failure).
- Migrate `Item`/`Design` versioning: bump `version` and write a migration
  step in `normalizeDesign()` before the schema changes for tier-1 items.
