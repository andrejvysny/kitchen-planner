# Interior Planner

A web-based 3D application for designing interiors — rooms, openings,
furniture and lighting — open, hackable and parametric. Built with
**Vite + TypeScript + Three.js**. No framework, no backend, no external 3D
assets: every mesh is generated procedurally from parameters.

The built-in furniture follows a modern, matte handleless design language
(sage / navy / graphite / cream slab fronts with routed grooves, dark
recessed plinths, oak worktops and backsplash panels, warm LED strip
lighting) — the same catalog covers a kitchen (base/tall/wall cabinets +
appliances), a bedroom (beds, wardrobes, nightstands, dresser), a living room
(sofas, TV, rug, bookcase, TV bench) and an office (desks, an office chair),
plus dining seating and lighting. Cabinets and other case furniture are
zone-tree parts you can customize per instance (Part Studio); loose furniture
(beds, sofas, chairs, rugs, lamps…) renders through bespoke procedural
builders — both flow through the same catalog and plan/3D pipeline.

## Quick start

```bash
npm install
npm run dev        # → http://localhost:5173
```

Production build: `npm run build` → static output in `dist/`
(serve with `npx vite preview` or any static file server).

A demo kitchen + bedroom (sharing a partition wall) loads on first run. Your
work autosaves to the browser (`localStorage`) on every action.

## The design workflow

Work is split into four workspaces, switched from the tabs in the top bar or
with the keys `1`–`4`. All four hold the same design; what changes is the
shell around it — the catalog, the tools and what covers the canvases follow
the task at hand. The choice is remembered per device, so the app reopens
where you left it.

**1 · Plan.** Draw and dimension the shell. Set width/depth numerically in the
right panel, or drag the ■ corner handles. Drag a ◆ wall midpoint (or
double-click a wall) to add a corner and bend the outline — L-shapes,
U-shapes, anything. Select a wall to type its exact length; orthogonal rooms
keep their shape when you do. Use **▧ ＋ Add room** to start another room:
drop it free-standing, or hover an existing wall to grow the new room off it,
and that wall becomes a shared partition, built once and visible from both
sides. Click a room's floor (or its row in *Components*) to make it active;
every room keeps its own wall/floor/worktop colours, wall height and
wall-visibility overrides. The catalog here is *Room & utilities* — doors,
windows, water supply and power outlets — which snap onto walls; drag to slide
one along its wall, select it to edit width / height / sill / distance from
the corner. A door on a shared partition shows correctly, mirrored, from
either room. The room tools are in this workspace and nowhere else.

**2 · Furnish.** Fill the rooms. The catalog switches to furniture,
appliances, lighting and your own parts, with a search box over it. Click a
tile, then click in the plan (or directly in the 3D view) — items snap into
whichever room they land in, rotate to face away from the nearest wall, sit
flush against it, snap edge-to-edge into runs, and show live clearance
dimensions to the nearest corners while you drag. `Shift`-click places
several. Everything is parametric: every cabinet is a zone-tree part
(*Customize part…* forks one instance), and appliances are separate products —
a sink or hob drops into a worktop, cutting a real hole in it, an oven slides
into an appliance niche, and both move with their host cabinet. Double-click
any door or drawer in 3D (or hit *Open fronts*) to preview it open. Pendants,
ceiling spots and LED strips are real light sources with shadows; select a
fixture to adjust brightness and warmth, and toggle **☀ Day / ☾ Night** to
judge the mood.

Live spatial checks run in the background as you work, in Plan and Furnish
alike: overlapping items and things poking through a wall are flagged red;
tight door swings, walkways, work aisles, bed access and cabinet-front
clearance are amber (NKBA/Neufert minimums); a kitchen's sink/hob/fridge work
triangle gets an informational nudge. Nothing is ever blocked — every finding
is a hint, not a wall. Errors always show; toggle **⚠** to also see warnings
and hints, in both the plan and the properties panel.

**3 · Workshop.** Build the parts themselves. The sidebar becomes a list of
your own parts plus the built-in presets, and the pane over the canvases holds
the Part Studio — a full editor with a live, orbitable 3D preview. Every route
into it lands here: *＋ New part*, ✎ on a catalog tile, *Edit part template…*
and *Customize part…* in the properties panel. Saving keeps the editor open,
*Revert* reloads the saved part, and **‹ Back** returns to the workspace you
came from. Three part types cover essentially any furniture:

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
  and hobs, set thickness and height off the floor. For continuous worktops,
  bar tops and floating shelves.
- **Free boards** — compose furniture from individual boards and cylinders:
  pick a board in the preview, nudge it with the arrow keys or type exact
  positions, choose front/accent colour, grooved-front style or cylinder
  shape. Covers tables, benches, wardrobes, room dividers.

Saved parts appear under *My parts*, can be edited later or duplicated as
variants, and are kept in a shared library so new designs start with them.
Every custom part is generated through the same panel-list model that the
cut-list export reads from — geometry lives in one place, never guessed back
out of a mesh.

**4 · Output.** Take the design off the screen. The pane holds one card per
document: the A4 plan sheet, the printable bill of materials, the cut list
and shopping list as CSV, a PNG snapshot of the 3D view and the GLB scene
export. Every card runs the same code as the matching entry in the top bar's
**Export ▾** menu, against the current design.

The 2D and 3D panes sit side by side in Plan and Furnish, with the
`2D | Split | 3D` toggle over the canvases; the Workshop and Output panes
cover them without unloading them, so switching back is instant.

## Export

| Button | Output |
|---|---|
| **Save / Load** | The full design as JSON — rooms, items, openings, and your custom parts (self-contained, shareable) |
| **Export ▾ → 3D snapshot (PNG)** | PNG of the current 3D view |
| **Export ▾ → Blender export (GLB)** | `interior.glb` — the fully modelled interior for photorealistic rendering |
| **Export ▾ → Cut list (CSV)** | `interior-cutlist.csv` — every board to manufacture, generated from the same panel IR the 3D renderer uses (dimensions, material, colour, hinge/slide notes) |
| **Export ▾ → Shopping list (CSV)** | `interior-shopping-list.csv` — bought appliances/furniture/lighting, wall openings, and hardware (hinges, drawer slides) implied by the cabinets |
| **Export ▾ → Printable sheet…** | A self-contained A4 HTML bill of materials (cut list + shopping list + hardware, grouped by room) opened in a new tab, ready to print or save as PDF |
| **Export ▾ → Plan sheet…** | A self-contained A4 **landscape** sheet: the dimensioned floor plan drawn at true scale (1:50, stepping down for large apartments) plus the item schedule — print at 100% and the walls measure correctly off the paper |
| **Export ▾ → Render package (.zip)…** | `interior-render.zip` — manifest + GLB + design for the Blender render worker |

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

### Realistic renders

For a fully automated, photoreal render instead of the manual Blender
workflow above, use **Export ▾ → "Render package (.zip)…"** together with the
`render/` directory's Blender/Cycles worker: `render/setup.sh` downloads a
pinned Blender build, then `render/render.sh interior-render.zip --out
out.png --tier preview|final` turns the exported package into a PNG — no
manual material or light setup required, since the package carries the
semantic identity of every material plus the sun/sky, fixture lights and
window apertures. Apple Silicon runs natively (no Docker — macOS containers
get no Metal passthrough); `preview` is the seconds-scale iteration loop,
`final` is full manifest resolution. See `render/README.md` for the full
walkthrough and flag reference.

## Keyboard

| Key | Action |
|---|---|
| `1` … `4` | Plan / Furnish / Workshop / Output workspace |
| `R` / `Shift+R` | rotate selection 90° / 15° |
| arrow keys / `Shift`+arrows | nudge 1 cm / 10 cm |
| `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` | undo / redo |
| `Ctrl+D` | duplicate item |
| `Delete` / `Backspace` | remove selection |
| `Esc` | cancel placement · clear the studio selection · deselect |
| `?` | show the keyboard & mouse cheatsheet (also under ⚙ → *Shortcuts…*) |
| mouse wheel / drag empty space | zoom / pan the plan |
| right-click / double-click a wall | context menu for what is under the pointer / add a corner |

The very first time you open the app it starts in **Plan** and points out the
three regions of the shell — the workspace tabs, the library and the properties
panel — in three bubbles you click away. It runs once per browser; `?` is where
the same information lives afterwards.

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
    renderPlan.ts     the floor-plan renderer itself, layer-gated — shared by
                      the editor and the print sheet
    symbols.ts        architectural plan symbols (also used as catalog icons)
  print/
    sheet.ts          true-scale plan bitmap + A4 landscape plan sheet
  view3d/
    view3d.ts         Three.js scene, rooms, lighting, picking, GLB export
    itemMeshes.ts     procedural meshes for appliances/furniture/lights
    meshKit.ts        shared mesh vocabulary (slabs, plinths, prisms…)
    partMeshes.ts     panel list → meshes + openable-front pivot groups
  ui/
    workspaceState.ts which of the four workspaces is showing (+ the
                      Workshop's current target)
    shellState.ts     chrome state: status hint, catalog drawer, wall label
    outlineModel.ts   pure grouping for the Components outline
    partstudio/       Part Studio: type picker, zone canvas, polygon canvas,
                      freeform board editor, live 3D preview
    react/            the whole UI: topbar, sidebar, workspace, inspector,
                      shared field set, AppServices context
  editor/             framework-free editor core (no React, no three, no DOM
                      outside the input adapters)
    editorState.ts    ephemeral tool / armed def / checks layer
    commands/         named editor behaviours + the registry that runs them
    keyboard/         the key map as data + its DOM adapter
    tools/, input/    Phase C contracts (types only, no runtime yet)
  app/
    services.ts       createServices(): the whole object graph, in one place
    bootstrap.ts      builds it once, installs window.__kp
    main.tsx          entry point: bootstrap, then mount the React root
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
node test/interact.mjs      # broad interaction checks (place, snap, drag, undo,
                            # wall edits, doors, multi-room, part studio,
                            # keyboard, 3D picking, exports, spatial checks)
npx playwright test         # isolated specs: DOM contract, layout, lifecycle,
                            # tools, inspector, sidebar, recovery, perf
node test/screenshot.mjs    # renders UI screenshots for visual review
```

## Where things are going

`ROADMAP.md` has the forward plan, `TODO.md` the milestone in flight,
`HISTORY.md` the completed ones, and `CLAUDE.md` the architecture and the
invariants worth knowing before changing anything.
