# CLAUDE.md

Web-based 3D kitchen planner. Vite + TypeScript + Three.js, no framework, no
backend, no 3D asset files — all meshes are procedural.

## Commands

```bash
npm run dev                 # dev server :5173
npx tsc --noEmit            # type-check (run before build; build also runs it)
npm run build               # tsc + vite build → dist/
npx vite preview &          # serve dist on :4173 (required for tests)
node test/interact.mjs      # E2E suite (Playwright, exits 1 on failure)
node test/screenshot.mjs    # UI screenshots → /tmp/shot-*.png
```

There are no unit tests; `test/interact.mjs` is the safety net — run it after
any change to snapping, store mutations, or the plan editor. Tests assume the
production build, so `npm run build` first.

## Architecture (read this before editing)

One `Store` (src/model/store.ts) is the single source of truth; both views
subscribe and never talk to each other directly.

- `store.notify({structural, transient})` drives everything:
  - `structural: true` → View3D disposes and rebuilds geometry. Use for
    add/remove/resize/param/color changes.
  - `structural: false` → View3D only updates transforms, light params,
    emissives. Use for drag moves, rotation, light sliders, day/night.
  - `transient: true` → mid-gesture; skips props-panel re-render.
- Undo = JSON snapshots. Mutations do NOT auto-commit: call `store.commit()`
  at gesture end (pointerup, input change). Forgetting commit = broken undo.
- `store.defOf(defId)` resolves both built-in catalog entries and user parts
  (custom parts are `CustomPartDef` in `design.customParts`, adapted to
  `CatalogDef` by src/model/parts.ts). Never call `catalogDef()` directly for
  an item's defId.

Room model: `design.corners` is a polygon, normalized counter-clockwise
(`normalizeDesign`). Walls are edges identified by their **start corner id**;
openings reference `wallId` + offset along the wall. The CCW invariant gives
every wall an inward normal — wall snapping, item auto-rotation
(`rotationFromInward`), and 3D wall-hiding all depend on it. If you mutate
corners, re-normalize and re-clamp openings.

Coordinate conventions (easy to get wrong):

- Plan space: meters, x right, y down on screen. Item `rotation` is around the
  item center; local +y is the item's FRONT (faces away from its wall).
- 3D: plan (x, y) → world (x, z), y up. `group.rotation.y = -item.rotation`.
- Item meshes (src/view3d/itemMeshes.ts) build in local space: x = width,
  y = 0..h up, z = depth with the BACK at −d/2 (wall side), front at +d/2.
- `item.elevation` = bottom height above floor (wall cabinets ~1.45).

## Adding a catalog item (the common task)

1. Add the `kind` to `ItemKind` and a `CatalogDef` entry in src/model/catalog.ts
   (sizes in meters; `params` for integer options like drawer count).
2. Add a mesh builder in src/view3d/itemMeshes.ts and register it in `BUILDERS`.
   Reuse `plinth/carcass/frontSlab/counterSlab` helpers to keep the style
   (handleless fronts with groove, dark plinth).
3. Add a plan symbol case in src/plan2d/symbols.ts (also renders the catalog
   thumbnail automatically).
4. Check `snapsToWall` / `isWallMounted` / `isOverhead` lists if the item is
   free-standing, wall-hugging, or above-counter (dashed in 2D).

## Gotchas

- Lights: emissive "bulb" meshes are tagged `userData.bulb = true`; View3D
  collects them for on/off/warmth updates without rebuild. Shadow-casting
  fixtures are capped by `SHADOW_LIGHT_BUDGET` (4).
- `setWallLength` propagates movement through perpendicular neighbor walls
  using ORIGINAL edge directions (rectangles stay rectangles) — don't
  "simplify" it to post-move checks; test 'wall length edit' catches this.
- GLB export (View3D.exportGLB) strips `isLight` objects and `Ground`, and
  temporarily clears the selection tint so it doesn't bake into materials.
- `window.__kp = {store, plan, view}` is exposed for tests/debugging — keep it.
- Autosave key `kitchen-planner-design-v1`, parts library
  `kitchen-planner-parts-v1`. Bump `Design.version` + migrate in
  `normalizeDesign()` on schema changes.
- Date/format: all lengths meters internally; UI shows cm (ints) except wall
  lengths (m, 2 decimals).
