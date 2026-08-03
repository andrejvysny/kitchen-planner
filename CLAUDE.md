# CLAUDE.md

Web-based 3D interior planner (multi-room). Vite + TypeScript + Three.js, no
framework, no backend, no 3D asset files — all meshes are procedural.

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
- `store.partOf(defId)` resolves a part def: design-local custom part first
  (`design.customParts`), then the built-in cabinet PRESETS
  (src/model/presets.ts — readonly, deep-frozen, never copied into a design).
  `store.defOf(defId)` wraps that as a `CatalogDef` (via toCatalogDef,
  kind 'custom') and falls back to `catalogDef()` for non-cabinet catalog
  entries. Never call `catalogDef()` directly for an item's defId.
- Cabinets are ALL zone-tree parts now: the old baseCabinet/baseDrawers/
  island/pantry/wallCabinet/shelf kinds are gone; their ids live on as preset
  parts ('base-cabinet', 'wall-cabinet', …). "Customize part…" in the props
  panel forks a preset into design.customParts for one instance
  (`store.forkPartForItem`).

Custom parts (Part Studio, src/ui/partstudio/) are a discriminated union on
`part.type`:

- `cabinet` — hollow carcass (shell boards + one divider board per zone
  boundary via `walkSplits`) + plinth/worktop + a **zone tree** (`part.face`)
  on the front face: n-ary weighted splits (`{dir, weights, children}`) with
  leaves `door | doorPair | drawers | open | panel | glass | appliance`. All
  zone math lives in src/model/zones.ts; `walkZones`/`walkSplits` are shared
  by the panel generator AND the studio's zone canvas, so the editor is
  WYSIWYG by construction. Caps: MAX_LEAVES 12, MAX_DEPTH 4, MIN_FRAC 0.08.
  `part.footprint` supports `rect | chamfer (diagonal/angled-end) | cornerL`
  (polygon footprints keep a solid prism carcass for now). Leaves carry
  `interior?` (shelves/internal drawers: `{mode:'auto', counts}` resolved to
  exact positions by src/model/interior.ts `resolveInterior` — the ONLY
  parametric→explicit bridge — or `{mode:'custom', elements}` edited in the
  zone canvas drill-in) and `hinge?` on doors (drilling datum). Every drawer
  front emits a real drawer box (sides/back/bottom) into the panel list.
- `board` — a horizontal slab extruded from a free CCW polygon `outline`
  (+ rectangular `holes`); worktops, floating shelves. Rendered via `prism()`
  (ExtrudeGeometry) in src/view3d/meshKit.ts.
- `freeform` — a list of `Board`s (box/cyl, front/accent slot, optional
  groove style) composing arbitrary furniture; meshes tagged
  `userData.boardId` for preview picking.

Custom parts render through a **panel-list IR**: `partPanels(part, dims,
ctx?)` (src/model/panels.ts) emits every physical board as a `Panel`
(box/cyl/prism shape, position, role, colour slot, finish, `motion?`) — pure
model code, no three.js. The optional `ctx: HostContext` carries appliance
cutouts (a sink turns the worktop into a prism with holes). `Panel.motion`
({unit, hinge side | slide travel}) is geometric truth (drilling datum,
cavity-derived travel); the open/closed POSE is ephemeral view state
(`store.openFronts`, like the selection — never in the Design, no undo/
autosave contamination) applied by pivot groups in src/view3d/partMeshes.ts
without any rebuild (dblclick a front in 3D, or the topbar "Open fronts"
toggle). Meshes carry `name = panel.id` and `userData.role`. A future
manufacturing export serializes the SAME panel list — never derive board
dimensions from meshes. Anything geometric belongs in the panel generator,
anything cosmetic in the mesh layer.

**Appliances** are bought products, not manufactured: their meshes stay
bespoke builders (itemMeshes.ts) and never enter panel lists. They mount on
hosts via `item.attach` ({kind:'counter', hostId, u, v} into a worktop, or
{kind:'zone', hostId, path} into an `appliance` zone niche) — anchors are
HOST-LOCAL; `item.x/y/rotation/elevation` stay the authoritative world cache
recomputed by `syncAttachments` (src/model/attach.ts, all pure). Hosting
cutouts/occupancy come from `applianceHosting(design)` — computed once per
View3D rebuild and once per BOM export. Deleting a host cascades to its
appliances; unresolvable attachments detach-to-world. snapItem skips
attached items (they overlap their hosts).

Zone trees live on the part def only — placed instances override just
w/d/h/color/elevation ("Duplicate part" in the studio and "Customize part…"
in the props panel cover variants). `DESIGN_VERSION` is 6; sanitizeDesign
migrates v5 forward (src/model/migrate.ts) and returns null for anything
older or unknown (callers fall back to a fresh/demo design).

## Extending custom parts

- **New zone fill** (e.g. wine rack): add to `ZoneFill` (types.ts), `FILLS`
  in zones.ts + the leaf-field whitelist in `normalizeZones` (leaves are
  REBUILT there — unlisted fields silently drop), a case in panels.ts
  `facePanels`, the `FILL_LABELS` entry in src/ui/partstudio/zoneCanvas.ts.
  Builder smoke + panels tests catch misses.
- **New footprint**: extend the `Footprint` union, `footprintPolygon`
  (parts.ts), the `faces` list in panels.ts `cabinetPanels`,
  `cabinetFaceSize` (panels.ts — the single body-math source), and the
  picker in cabinetPanel.ts.
- **New part type**: extend the `CustomPartDef` union + `sanitizePart` +
  factory (parts.ts), add a `partPanels` branch (panels.ts), a picker card
  (typePicker.ts) and a rail panel module.
- **New interior element**: extend `InteriorElement` (types.ts) — e.g. the
  wardrobe hanging `rail`, a cylinder spanning the cavity on its x axis —
  `sanitizeInterior`/`resolveInterior` (interior.ts), the emission in
  panels.ts `facePanels`, and the drill-in editor in zoneCanvas.ts. Rails are
  `custom`-mode only: `resolveInterior`'s `auto` branch never emits one, so a
  rail always comes from a hand-authored `elements` list (a preset or the
  zone canvas' ＋Rail button).
- **Manufacturing export** (src/model/export.ts + exportFormats.ts, wired via
  the topbar `Export ▾` menu in src/ui/ui.ts): `buildBom(design)` iterates
  `design.items`, resolves each to `partPanels(part, itemDims,
  applianceHosting(design).get(item.id))` and dedupes into `CutRow`s (cut
  list) plus bought products/openings/hardware into `BuyRow`s (shopping
  list); `exportFormats.ts` renders CSV and a printable HTML sheet. Two
  invariants hold it together: (a) every cut row comes from `partPanels`,
  NEVER from meshes — the panel list is the geometric truth the renderer
  also uses; (b) slot colours resolve through src/model/variables.ts
  (`resolveFinish`/`resolveColor`/`counterFin`), mirroring partMeshes.ts
  `panelMaterial` exactly, NEVER through meshKit. Panel ids are stable per
  part; `motion` carries hinge sides + slide travel; drawer boxes are real
  boards.

Room model: `design.rooms` is an array of `Room`s, each owning a corner
polygon normalized counter-clockwise (`normalizeRoom`, applied to every room
by `normalizeDesign`) plus its own `RoomStyle`. Corner ids are unique
design-wide, so walls — edges identified by their **start corner id** — and
the openings that reference `wallId` + offset stay design-global. The CCW
invariant gives every wall an inward normal: wall snapping, item
auto-rotation (`rotationFromInward`), and 3D wall-hiding all depend on it. If
you mutate corners, re-normalize that room and re-clamp openings.

A room's polygon is the **room-side wall face**, not the centreline: an
exterior wall slab lies entirely outside it, a shared partition straddles it.
`RoomWall.faceOffset` (src/model/rooms.ts — 0 exterior, thickness/2 shared)
is the single sanctioned source for that offset; never hardcode `t / 2`.
Everything derived from `Room[]` lives in rooms.ts (`allWalls` with
geometric shared-edge detection, `wallsOf`, `roomOfItem`, `styleOfItem`,
`openingsOfWall`); the Store only delegates. The active room is ephemeral
view state like the selection (`store.activeRoomId`, `'activeRoom'` event) —
never serialized, never in an undo step. Room-scoped mutations take a
trailing `roomId?` defaulting to the active room.

Coordinate conventions (easy to get wrong):

- Plan space: meters, x right, y down on screen. Item `rotation` is around the
  item center; local +y is the item's FRONT (faces away from its wall).
- 3D: plan (x, y) → world (x, z), y up. `group.rotation.y = -item.rotation`.
- Item meshes (src/view3d/itemMeshes.ts) build in local space: x = width,
  y = 0..h up, z = depth with the BACK at −d/2 (wall side), front at +d/2.
- `item.elevation` = bottom height above floor (wall cabinets ~1.45).

## Adding a cabinet preset (the common task)

Add a `PresetEntry` in src/model/presets.ts: a full `CabinetPartDef` (or
freeform) with a stable literal id + a catalog section title. That's it —
tiles, plan symbol (generic custom case + footprint polygon), meshes (panel
IR), outline grouping and sanitize gating all flow from the parts pipeline.
`placement: 'free'` opts out of wall snapping; `worktopOverhang` and
`finishedBack` cover island-style looks. builders.test iterates PRESETS.

Adding a NON-cabinet catalog item (appliance/furniture/light) still means:
`ItemKind` (loose furniture already covers `bed`/`sofa`/`tv`/`rug`/
`officeChair` — a new kind is rarely needed) + `CatalogDef` (catalog.ts —
appliances also set `appliance: {mount, cutout?/niche?}`), a builder in
itemMeshes.ts `BUILDERS`, a symbol case in symbols.ts, and a check of
`snapsToWall`/`isWallMounted`/`isOverhead`.

## Gotchas

- Lights: emissive "bulb" meshes are tagged `userData.bulb = true`; View3D
  collects them for on/off/warmth/colour updates without rebuild. Shadow-casting
  fixtures are capped by `SHADOW_LIGHT_BUDGET` (4). The LED strip (`bar`) is a
  `RectAreaLight` (even wash along its length, never casts shadows); pendant/spot
  are Point/Spot lights. `LightProps.color` (optional) overrides warmth.
- Global lighting lives in `design.scene = {sunAzimuth, sunElevation,
  brightness, night}` (angles in DEGREES — the model's only non-radian angles)
  and is applied in `View3D.relight()` (non-structural, runs live).
  `skyState(azDeg, elevDeg, night)` in `src/model/sky.ts` (pure, tested)
  auto-derives sun colour (low sun = golden, high = neutral), ambient and
  background from elevation; `night` overrides with the fixed moonlight look.
  `brightness` is the single master scale for sun + ambient + reflections;
  tone-mapping exposure is a fixed constant (`EXPOSURE` in view3d.ts). The env
  is a one-time PROCEDURAL RoomEnvironment PMREM (no HDR assets) whose
  intensity = brightness × daylight × `ENV_FILL` so night goes dark. Fills are
  deliberately restrained vs the sun (`AMBIENT_DAY`, `ENV_FILL`) — raising
  them washes the day scene out.
- `setWallLength` propagates movement through perpendicular neighbor walls
  using ORIGINAL edge directions (rectangles stay rectangles) — don't
  "simplify" it to post-move checks; test 'wall length edit' catches this.
- GLB export (View3D.exportGLB) strips `isLight` objects and `Ground`,
  temporarily clears the selection tint so it doesn't bake into materials,
  and snaps all open-front poses closed for the clone (snapshotPNG stays
  as-posed — an opened drawer is staged content).
- `window.__kp = {store, plan, view}` is exposed for tests/debugging — keep it.
- Storage keys all live in src/model/storageKeys.ts: writes target
  `interior-planner-{design,parts,nav}-v1`, reads fall back to the legacy
  `kitchen-planner-*` keys (never deleted). `DESIGN_VERSION` is 6.
  `sanitizeDesign()` (store.ts) is the single validation/repair gate for
  autosave and file import: it runs `migrateDesign()` first (versioned step
  map, `MIN_MIGRATABLE_VERSION` 5) and returns null when there is no path.
  It also drops rooms under 3 corners, re-ids corners colliding across
  rooms, drops openings whose wallId resolves nowhere, and drops items whose
  defId resolves nowhere (custom part, preset, or catalog). The parts
  library sanitizes per element on read (`Store.sharedLibrary()`).
- Items with non-rect footprints hit-test against the true polygon in the
  plan (`footprintPolygon` + `pointInPolygon`) but SNAP by bounding box —
  intentional simplification; a diagonal corner unit's square back still
  hugs both walls correctly.
- Date/format: all lengths meters internally; UI shows cm (ints) everywhere,
  including wall lengths and canvas dimension labels.
