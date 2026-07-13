# CLAUDE.md

Web-based 3D kitchen planner. Vite + TypeScript + Three.js, no framework, no
backend, no 3D asset files — all meshes are procedural.

## Commands

```bash
npm run dev                 # dev server :5173
npx tsc --noEmit            # type-check (run before build; build also runs it)
npm run build               # tsc + vite build → dist/
npm run test:unit           # Vitest: geometry/store/snapping + mesh-builder smoke
npx vite preview &          # serve dist on :4173 (required for E2E)
node test/interact.mjs      # E2E suite (Playwright, exits 1 on failure)
node test/screenshot.mjs    # UI screenshots → /tmp/shot-*.png
```

`test/interact.mjs` is the main safety net — run it after any change to
snapping, store mutations, or the plan editor. It assumes the production
build, so `npm run build` first. Unit tests (test/unit/) cover the model
invariants (CCW normalization + opening remap, sanitizeDesign, clamps) and
instantiate every catalog mesh builder headless. Playwright resolves its own
chromium; set `KP_CHROMIUM_PATH` to override the browser binary.

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

Custom parts (Part Studio, src/ui/partstudio/) are a discriminated union on
`part.type`:

- `cabinet` — carcass + plinth/worktop + a **zone tree** (`part.face`) on the
  front face: n-ary weighted splits (`{dir, weights, children}`) with leaves
  `door | doorPair | drawers | open | panel | glass`. All zone math lives in
  src/model/zones.ts; `walkZones` is shared by the mesh builder AND the
  studio's zone canvas, so the editor is WYSIWYG by construction. Caps:
  MAX_LEAVES 12, MAX_DEPTH 4, MIN_FRAC 0.08. `part.footprint` supports
  `rect | chamfer (diagonal/angled-end) | cornerL` — the zone tree always
  applies to exactly ONE planar face; other fronts get a single panel/door.
- `board` — a horizontal slab extruded from a free CCW polygon `outline`
  (+ rectangular `holes`); worktops, floating shelves. Rendered via `prism()`
  (ExtrudeGeometry) in src/view3d/meshKit.ts.
- `freeform` — a list of `Board`s (box/cyl, front/accent slot, optional
  groove style) composing arbitrary furniture; meshes tagged
  `userData.boardId` for preview picking.

Custom parts render through a **panel-list IR**: `partPanels(part, dims)`
(src/model/panels.ts) emits every physical board as a `Panel` (box/cyl/prism
shape, position, role, colour slot, finish) — pure model code, no three.js.
src/view3d/partMeshes.ts only maps panels to meshes and adds the decoration
layer (routed grooves, glass material); meshes carry `name = panel.id` and
`userData.role`. A future manufacturing export (cut lists, CNC outlines)
serializes the SAME panel list — never derive board dimensions from meshes.
Anything geometric belongs in the panel generator, anything cosmetic in the
mesh layer.

Zone trees live on the part def only — placed instances override just
w/d/h/color/elevation ("Duplicate part" in the studio covers variants).
v1 templates (`{template, options}`) migrate via src/model/partsMigrate.ts;
per-instance v1 params become cloned "(variant)" parts.

## Extending custom parts

- **New zone fill** (e.g. wine rack): add to `ZoneFill` (types.ts), `FILLS` +
  count clamps in zones.ts `normalizeZones`, a case in panels.ts
  `facePanels`, the fill button + caption in
  src/ui/partstudio/zoneCanvas.ts. Builder smoke + panels tests catch misses.
- **New footprint**: extend the `Footprint` union, `footprintPolygon`
  (parts.ts), the `faces` list in panels.ts `cabinetPanels`, `faceSize` in
  zoneCanvas.ts, and the picker in cabinetPanel.ts.
- **New part type**: extend the `CustomPartDef` union + `sanitizePart` +
  factory (parts.ts), add a `partPanels` branch (panels.ts), a picker card
  (typePicker.ts) and a rail panel module; migration untouched.
- **Manufacturing export**: iterate `design.items` → `partPanels(part,
  itemDims)` → rows from `Panel.shape` dims + `role` + resolved slot colour;
  prism outlines are CNC-ready polygons. Panel ids are stable per part.

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
  collects them for on/off/warmth/colour updates without rebuild. Shadow-casting
  fixtures are capped by `SHADOW_LIGHT_BUDGET` (4). The LED strip (`bar`) is a
  `RectAreaLight` (even wash along its length, never casts shadows); pendant/spot
  are Point/Spot lights. `LightProps.color` (optional) overrides warmth.
- Global lighting lives in `design.scene` and is applied in `View3D.relight()`
  (non-structural, runs live). `timeOfDay` (0–24) is the ONLY driver of sun
  direction/colour/intensity + sky/background via `src/model/sky.ts` `skyState()`
  (pure, tested); `sunStrength/ambientStrength/sunColor/ambientColor/exposure`
  layer on top so the time slider never desyncs. `envPreset` builds a PROCEDURAL
  PMREM env (RoomEnvironment or a gradient dome — no HDR assets), regenerated
  only on preset change; its intensity fades with daylight so night goes dark.
  Legacy `{night}` scenes migrate to `timeOfDay` in `sanitizeDesign`.
- `setWallLength` propagates movement through perpendicular neighbor walls
  using ORIGINAL edge directions (rectangles stay rectangles) — don't
  "simplify" it to post-move checks; test 'wall length edit' catches this.
- GLB export (View3D.exportGLB) strips `isLight` objects and `Ground`, and
  temporarily clears the selection tint so it doesn't bake into materials.
- `window.__kp = {store, plan, view}` is exposed for tests/debugging — keep it.
- Autosave key `kitchen-planner-design-v1`, parts library
  `kitchen-planner-parts-v1`. `DESIGN_VERSION` is 2; bump + migrate in
  `sanitizeDesign()` (store.ts) on schema changes — it is the single
  validation/repair gate for autosave and file import, and it also drops
  items whose defId resolves nowhere. The parts library migrates per element
  on read (`Store.sharedLibrary()`): `type` marks v2 entries, `template`
  marks v1.
- Items with non-rect footprints hit-test against the true polygon in the
  plan (`footprintPolygon` + `pointInPolygon`) but SNAP by bounding box —
  intentional simplification; a diagonal corner unit's square back still
  hugs both walls correctly.
- Date/format: all lengths meters internally; UI shows cm (ints) everywhere,
  including wall lengths and canvas dimension labels.
