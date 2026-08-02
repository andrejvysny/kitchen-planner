# Interior Planner

A web-based 3D application for designing interiors — rooms, openings,
furniture and lighting — open, hackable and parametric. Built with
**Vite + TypeScript + Three.js**. No framework, no backend, no external 3D
assets: every mesh is generated procedurally from parameters.

The built-in furniture follows a modern, matte handleless design language
(sage / navy / graphite / cream slab fronts with routed grooves, dark
recessed plinths, oak worktops and backsplash panels, warm LED strip
lighting) — the same catalog works whether you're laying out a kitchen, a
bedroom or an office.

## Quick start

```bash
npm install
npm run dev        # → http://localhost:5173
```

Production build: `npm run build` → static output in `dist/`
(serve with `npx vite preview` or any static file server).

A demo kitchen loads on first run. Your work autosaves to the browser
(`localStorage`) on every action.

## The design workflow

The app is a **2D floor plan + live 3D view** (split screen by default, toggle
with `2D | Split | 3D`).

**1 · Sketch your rooms.**
Set width/depth numerically in the right panel, or drag the ■ corner handles.
Drag a ◆ wall-midpoint (or double-click a wall) to add a corner and bend the
outline — L-shapes, U-shapes, anything. Select a wall to type its exact length;
orthogonal rooms keep their shape when you do. Use **▧ ＋ Add room** to start
another room: drop it free-standing, or hover an existing wall to grow the new
room off it — that wall becomes a shared partition, built once and visible
from both sides. Click a room's floor (or its row in *Components*) to make it
active; every room keeps its own wall/floor/worktop colours, wall height and
wall-visibility overrides. Wall lengths and floor area are always labelled.

**2 · Place openings and utilities.**
*Room & utilities* in the catalog: **doors, windows, water supply, power
outlets**. They snap onto walls; drag to slide along a wall, select to edit
width / height / sill / distance-from-corner. A door on a shared partition
shows correctly, mirrored, from either room.

**3 · Furnish.**
Click a catalog item, then click in the plan (or directly in the 3D view) —
items snap into whichever room they land in. Items automatically rotate to
face away from the nearest wall and sit flush against it, snap edge-to-edge
into runs, and show live clearance dimensions (cm) to the nearest corners
while you drag. `Shift`-click places several. Everything is **parametric**:
every cabinet is a zone-tree part (customize one instance via *Customize
part…*), and appliances are separate products — a sink or hob drops INTO a
worktop (cutting a real hole in it), an oven slides into an appliance niche,
and they all move with their host cabinet. Double-click any door or drawer in
3D (or hit *Open fronts*) to preview it open — shelves, internal drawers and
drawer boxes are really in there.

**4 · Light it.**
Pendants, ceiling spots and LED strips are real light sources with shadows.
Select a fixture to adjust brightness and warmth. Toggle **☀ Day / ☾ Night**
to judge the mood.

**5 · Create your own parts (Part Studio).**
*＋ New part* opens a full editor with a live, orbitable 3D preview. Three
part types cover essentially any furniture:

- **Cabinet** — a carcass whose front you split into **zones**, Mozaik-style:
  click a zone, split it horizontally or vertically, drag the dividers to
  resize (cm-snapped, double-click to equalize), and fill each zone with a
  door, door pair, drawer stack, open oak niche, panel, glass door or an
  appliance niche. Double-click a zone to edit its interior (shelves and
  internal drawers, dragged to exact positions); doors get a hinge-side
  picker. Footprints go beyond rectangles: angled ends, diagonal corner
  units and L-shaped blind corners. Plinth, worktop (with per-edge overhang)
  and wall-mounting are toggles.
- **Worktop / board** — draw any outline (L/U presets included) with the same
  corner-and-midpoint editing as a room, add rectangular cutouts for sinks
  and hobs, set thickness and height off the floor. Great for continuous
  worktops, bar tops and floating shelves.
- **Free boards** — compose arbitrary furniture from individual boards and
  cylinders: pick a board in the preview, nudge it with the arrow keys or
  type exact positions, choose front/accent colour, grooved-front style or
  cylinder shape. Covers tables, benches, wardrobes, room dividers.

Saved parts appear under *My parts*, can be edited later (✎ on the tile) or
duplicated as variants, and are kept in a shared library so new designs start
with them. Every custom part is generated through the same panel-list model
that a manufacturing / cut-list export would read from — geometry lives in
one place, never guessed back out of a mesh.

## Export

| Button | Output |
|---|---|
| **Save / Load** | The full design as JSON — rooms, items, openings, and your custom parts (self-contained, shareable) |
| **Snapshot** | PNG of the current 3D view |
| **Blender** | `interior.glb` — the fully modelled interior for photorealistic rendering |

### Blender workflow

The GLB contains the complete geometry: a `Rooms` group with one sub-group per
room (`Floor`, `Ceiling`, `Wall_1…n` with door/window cutouts and frames —
shared partitions appear once) and every piece of furniture as a named object
under `Furniture`. Base colors come along as basic PBR materials; **light
sources are intentionally not exported** — Blender is responsible for
materials and lighting:

1. Blender → *File → Import → glTF 2.0* → `interior.glb` (units are meters, 1:1).
2. Delete or hide `Ceiling` / individual walls for camera access.
3. Assign proper materials (wood grain, stone, metal) by object name.
4. Add lights (area lights in place of the strip/pendant geometry works well)
   and render with Cycles.

## Keyboard

| Key | Action |
|---|---|
| `R` / `Shift+R` | rotate selection 90° / 15° |
| arrow keys / `Shift`+arrows | nudge 1 cm / 10 cm |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | undo / redo |
| `Ctrl+D` | duplicate item |
| `Delete` / `Backspace` | remove selection |
| `Esc` | cancel placement · close dialog · deselect |
| mouse wheel / drag empty space | zoom / pan the plan |

## Architecture

```
src/
  model/            pure data + logic, no rendering
    types.ts          Design, Room, Item, Opening, Corner, CustomPartDef
    rooms.ts          multi-room derivation: walls, shared-partition
                      detection, room/wall/opening lookups
    catalog.ts        appliances/furniture/lights/markers + color palettes
    presets.ts        built-in cabinets as readonly zone-tree part defs
    parts.ts          part factories, CatalogDef adapter, footprints, sanitize
    zones.ts          cabinet zone-tree math (split/merge/walk/normalize)
    interior.ts       shelf/drawer-box layout (parametric → exact positions)
    panels.ts         part → panel list IR (every physical board; the basis
                      for rendering today and manufacturing export tomorrow)
    attach.ts         appliance hosting (anchors, cutouts, niche occupancy)
    openFronts.ts     ephemeral open-door/drawer preview state
    migrate.ts        versioned design migrations (v5 → v6)
    store.ts          state, events, undo/redo, autosave, all mutations
    snapping.ts       wall / edge-to-edge / alignment snapping (shared 2D+3D)
    geometry.ts       polygon & vector math
  plan2d/
    plan2d.ts         canvas floor-plan editor (pan/zoom, drag, ghosts, dims,
                      room switching, add-room tool)
    symbols.ts        architectural plan symbols (also used as catalog icons)
  view3d/
    view3d.ts         Three.js scene, rooms, lighting, picking, GLB export
    itemMeshes.ts     procedural meshes for appliances/furniture/lights
    meshKit.ts        shared mesh vocabulary (slabs, plinths, prisms…)
    partMeshes.ts     panel list → meshes + openable-front pivot groups
  ui/
    ui.ts             catalog, properties panel, toolbar, shortcuts
    partstudio/       Part Studio: type picker, zone canvas, polygon canvas,
                      freeform board editor, live 3D preview
  main.ts           bootstrapping
```

Decisions worth knowing:

- **A design is an array of rooms**, each owning its own polygon of corners
  and its own style. Walls are polygon edges (identified by their start
  corner), openings live on walls by offset. Corner order is normalized
  counter-clockwise so every wall knows its inward normal — that single fact
  drives item auto-rotation, wall snapping and 3D wall-hiding. Two rooms that
  share a coincident, oppositely-wound edge form a partition, built once and
  rendered from both sides.
- **One store, two views.** `Store` emits `change {structural, transient}`
  events. Structural changes rebuild 3D geometry; transient ones (dragging)
  only update transforms and light parameters, so dragging stays at 60 fps.
- **Undo is JSON snapshots**, pushed at gesture boundaries (`commit()`), not on
  every mouse-move.
- **Walls face-cull toward the camera** (per-frame dot product of the wall's
  inward normal), so orbiting never traps you outside a room; a shared
  partition stays up while the camera is in either of its rooms.

## Tests

Unit tests (Vitest) cover the model layer and instantiate every mesh builder
headless; end-to-end tests run against the production build with Playwright:

```bash
npm run test:unit           # geometry / store / snapping + builder smoke tests
npm run build
npx vite preview &          # serves dist on :4173
node test/interact.mjs      # 86 interaction checks (place, snap, drag, undo,
                            # wall edits, doors, multi-room, part studio,
                            # keyboard, 3D picking, exports)
node test/screenshot.mjs    # renders UI screenshots for visual review
```
