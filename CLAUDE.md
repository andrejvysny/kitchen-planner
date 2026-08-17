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
  - Structural notifies COALESCE: View3D queues one rebuild per animation
    frame (`queueRebuild`) and skips it entirely while the pane is hidden
    (`setActive(false)`, wired to the 2D/3D toggle). Anything that reads the
    scene synchronously must call `view.flushRebuild()` first — `view.items`,
    picking, `snapshotPNG` and `exportGLB` already do.
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
cutouts/occupancy come from `applianceHosting(design)`. Deleting a host
cascades to its appliances; unresolvable attachments detach-to-world.
snapItem skips attached items (they overlap their hosts).

**Continuous worktops** merge in the panel IR, never in the mesh layer:
`worktopRuns(design)` (src/model/worktops.ts, pure) chains adjacent
worktop-bearing RECT cabinets — same room, rotation, worktop plane, depth and
overhang, joint ≤ 5 mm — and hands each one a `HostContext.worktop`
`WorktopPlan`. The run LEADER emits the whole slab as one prism in its own
item-local frame (appliance cutouts of every member shifted along the run);
FOLLOWERS emit no worktop board at all. A run of one gets no plan, so the
standalone slab path stays byte-identical. `hostContexts(design)` =
applianceHosting + worktopRuns is THE per-item context: computed once per
View3D rebuild and once per BOM export — call it, not applianceHosting.
Polygon footprints (chamfer/cornerL) and L-corner runs are out of scope.

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
  hostContexts(design).get(item.id))` and dedupes into `CutRow`s (cut
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
`openingsOfWall`); the Store only delegates. Wall slabs are BUTT-ENDED —
`slabQuad(wall)` spans exactly [0, len], nothing runs past a corner — and
every welded junction is closed by a separate patch from `wallJoints(walls)`
(convex hull of the incident end cross-sections plus their mitre apexes, with
a 4×thickness mitre limit that bevels acute corners); both the plan fill and
the 3D `WallJoint` prisms consume the same pure output, so tees, four-room
crossings and oblique corners all close. Two OVERLAPPING rooms whose walls
cross mid-span share no corner and so get no joint — they still
interpenetrate. The active room is ephemeral
view state like the selection (`store.activeRoomId`, `'activeRoom'` event) —
never serialized, never in an undo step. Room-scoped mutations take a
trailing `roomId?` defaulting to the active room.

Rooms that end up flush with each other are WELDED into a partition, since
`allWalls` only sees a seam when two rings hold the very same edge reversed.
`nextWeldSeam(rooms, roomId)` (rooms.ts, pure) reports one contact stretch at
a time as the cuts + sub-mm nudges that would make that true — a partial
overlap cuts the longer wall in three — and `store.weldRoom` applies them
(splitWallRaw, so openings re-key) until no seam is left. It runs at the END
of a gesture only: `addRoom` (every path, `polygon` included) and Plan2D's
corner-drag `endGesture`, NEVER on a pointermove. Getting a room flush in the
first place is the snapping layer: `snapRoomRect` (placement ghost) and
`snapPointToRooms` (dragged / drawn corners), both pure, both in rooms.ts.

Every plan pixel is drawn by `renderPlan(ctx, store, view, opts, overlays?)`
(src/plan2d/renderPlan.ts) — Plan2D owns the gestures and `draw()` is a thin
caller that hands its in-flight state in through `PlanOverlays` (guides, ghosts,
armed def, measure, ⚠ advisory flag) with every `PlanRenderOpts` layer on. The
print sheet (src/print/sheet.ts `planImage`) calls the SAME function on an
offscreen canvas with `PRINT_OPTS` — no handles/guides/ghosts/measure/checks and
`roomEmphasis: false` so every room prints in full ink, not just the active one.
`view.zoom` is px per metre in the caller's transform units; the caller sets the
base transform, which is how the sheet renders a 96 dpi layout at 150 dpi
(`planLayout` → `dpr`). Anything new drawn in the plan belongs in renderPlan
behind a layer switch, never in Plan2D. The plan-geometry helpers hit-testing
also needs (`sortedItems`, `footprintOf`, `itemOutlineWorld`, `rotateHandlePos`,
`bandCenter`/`bandExtend`) are exported from there too — one definition, both
users.

**Reference underlay** (tracing photo): `design.underlay` is a TRANSFORM ONLY
(`{x, y, scale, rotation, opacity, visible, locked}`, x/y = world position of
the image's top-left, scale = m per image pixel). The image BYTES live in their
own key (`UNDERLAY_KEY`), never in the Design — undo is a JSON snapshot of the
whole design and autosave writes it every commit, so a data URL there would
blow up both. `store.setUnderlay(src, transform?)` writes the side key first
(returns false when storage refuses), `store.underlayRef()` = transform + bytes
or null, `updateUnderlay(patch)` moves/scales it. Consequence, by design: the
transform is undoable, swapping/removing the photo is not. `exportJson` carries
the photo as an extra top-level `underlaySrc` field and sanitizeDesign strips it
(the load handler in ui.ts re-installs it after `replaceDesign`). renderPlan
draws it first, under the grid, behind `opts.underlay` (off in `PRINT_OPTS`);
the decoded `HTMLImageElement` is cached in renderPlan.ts keyed by src, and a
miss clears the map so exactly one photo is ever held. All underlay maths
(sanitize, calibration, hit test) is pure in src/model/underlay.ts.

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
appliances also set `appliance: {mount, cutout?/niche?}`; decorative items that
may legally share space — lights, sockets, rugs, wall panels — set
`noCollide: true` so the spatial checks skip them), a builder in
itemMeshes.ts `BUILDERS`, a symbol case in symbols.ts, and a check of
`snapsToWall`/`isWallMounted`/`isOverhead`.

## Editor infrastructure contracts (Phase A — baseline lock)

- `Store.on()` returns a disposer; calling it twice is a no-op, and `emit`
  dispatches over a snapshot so unsubscribing mid-dispatch never skips a
  sibling. `store.handlerCount(evt)` is a read-only test seam — a view that
  attaches and detaches must leave it at its baseline.
- Plan2D, ElevationView and View3D share one lifecycle contract:
  `attach(canvas)` (idempotent for the held canvas) / `detach()` (idempotent;
  aborts listeners, disconnects the ResizeObserver, runs store-subscription
  disposers, cancels rAF loops) / `dispose()` (detach + permanent teardown).
  All three are constructed DETACHED — `new Plan2D(store, editor, onHint)`,
  `new ElevationView(store, onWallChange)`, `new View3D(store, opts)` never
  touch the DOM — and the React shell hands each one its canvas from a ref
  effect (src/ui/react/Workspace.tsx). View3D therefore starts rebuild-dirty
  and frames the design (`setPreset('corner')`) on its FIRST attach only. It
  keeps its WebGLRenderer when re-attached to the SAME canvas (StrictMode
  remounts) and marks itself rebuild-dirty while detached so it catches up on
  attach. Never call `forceContextLoss()`. e2e/lifecycle.spec.ts is the leak
  gate.
- React owns the application DOM: index.html is `<div id="react-root">` plus
  the module script, and src/ui/react/App.tsx renders the former markup
  node-for-node (Topbar / Sidebar / Workspace / PropsPanel / StatusBar are
  organizational splits — the rendered tree is identical, and
  e2e/layout.spec.ts pins the boot geometry). The shell holds NO state and
  never re-renders, so src/ui/ui.ts keeps filling #catalog-inner, #outline and
  #props-inner exactly as before. `UI` itself has no
  dispose(), so `mountLegacyUI()` (src/app/bootstrap.ts) constructs it once
  behind a module guard, from an App-level effect that runs after the canvas
  effects; the guard goes away when ui.ts is dissolved into components.
- The sidebar tabs and the Variables panel are React's (src/ui/react/Sidebar.tsx
  + VariablesPanel.tsx): which tab is open is component state, and the panels
  carry BOTH `.active` and `hidden` because style.css hides on `[hidden]` while
  test/interact.mjs asserts the class.
- **Fields commit on the DOM's native `change` event, never React's onChange**
  — src/ui/react/fields/ is the shared set (SwatchRow, MaterialRow, VarChips,
  ChoiceRow, ToggleRow, SliderRow, StepperRow, RotToggle, Number/Length/Angle
  fields) every panel builds from, and `useNativeChange` is how each one takes
  its undo step. React's onChange on an input is the per-keystroke `input`
  event, so committing there would push one undo step per character;
  eslint.config.js enforces this with a `no-restricted-syntax` rule over
  fields/** and props/**, and SliderRow — which genuinely wants the live input
  while dragging — is the one inline-disabled exception. The inputs stay
  UNCONTROLLED: `useSyncedValue` mirrors the model into them after each render
  and `useLiveValue` during a drag ('transient' channel), both refusing to write
  into `document.activeElement` — that check is what replaced ui.ts's
  isEditingVariableName guard around its innerHTML rebuilds. Display-unit
  arithmetic (`convert.ts`) and the multi-selection rule (`useMixedValue`) are
  pure and pinned by test/unit/fields.test.ts.
- **`EditorState` (src/editor/editorState.ts) is the single source of tool
  truth**: `tool` (`select | place | measure | calibrate | room | drawRoom`),
  `armedDefId` (only meaningful under `place`, and `setTool` nulls it on every
  other switch) and the orthogonal `checksOn` display layer. Ephemeral like
  `store.openFronts` — never serialized, never undone. Plan2D's six public tool
  fields (`armedDef/measureOn/calibrateOn/roomToolOn/drawRoomOn/checksOn`) are
  READ-ONLY MIRRORS written only by its `syncFromEditor()`, which the
  constructor subscribes (not `attach()` — a detached view still tracks the
  tool). A tool change there runs the **leaving-tool cleanup** — calibrate →
  `resetCalibrate`, place → ghosts, measure → `resetMeasure`, room →
  `roomGhost`, drawRoom → `resetDrawRing` — which is what replaced
  `closeOtherTools(keep)`. `syncFromEditor` NEVER writes the editor back
  (re-entrancy), and `resolveArmed` is null-safe on purpose: `store.defOf`
  THROWS, so a stale armed id must resolve to null, not an exception. The
  `setX()` methods are delegates that keep their ENTRY reset (re-arming the
  live tool is a no-op upstream, so that reset is the only effect) and then
  call `editor.setTool`. React's tool buttons call the editor directly.
- Chrome state that is neither design nor tool lives in
  src/ui/shellState.ts — the status-bar hint text and the catalog drawer's
  open flag, a module singleton shaped like src/model/prefs.ts. Everything
  that used to write `#status-hint` calls `setHint()`; `<StatusHint/>` renders
  it. StoreBridge carries all three upstreams as channels: Store, `'editor'`
  and `'shell'`.
- Tests drive Plan2D ONLY through its façade: `viewport()/setViewport()/
  toolState()/overlayState()/debug()`. `debug().drawCount/gestureCount` are
  monotonic counters — the no-sleep assertion seam. If a test needs a private
  field, the façade is wrong: fix the façade, not the test.
- E2E waits POLL, never sleep: `waitUntil`/`resetReady`/`flushView`/
  `waitForPose` + the debug counters. `test/interact.mjs` has exactly ONE
  `waitForTimeout` (an annotated dblclick-folding pacing beat); do not add
  more. Suite must stay green at `KP_CPU_THROTTLE=6`.
- e2e/*.ts is covered by lint AND typecheck (eslint block + tsconfig.test.json
  include) — a selector or API drift breaks the build, not just the specs.
- e2e/dom-contract.spec.ts pins every DOM id/class/data-attr the suites use.
  Renaming one means updating the contract table AND both suites in the same
  change. e2e/tools.spec.ts is the gate for the EditorState seam (mirror
  parity, leaving-tool cleanup, entry resets, Escape order, stale armed ids);
  test/unit/planTools.test.ts covers the DOM-free half of it — Plan2D
  constructs headless, so the mirrors are unit-testable without a canvas.

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
- Spatial checks (`src/model/checks.ts` `runChecks`/`Warning`) are pure and
  NEVER imported by a mutator — the planner warns, it never blocks an edit.
  `store.warnings()` lazy-caches the result, invalidated by every `notify()`.
  Severity is a strict contract every consumer switches on, never `kind`:
  error = collision (overlap/throughWall — red 3D tint), warn = clearance
  (blocksDoor/frontClearance/walkway/workAisle/bedAccess — amber tint), info =
  hint (doorLanding/workTriangle — never tints, never counts toward the
  status bar's issue total). Each `CLEARANCE` constant carries its
  NKBA/Neufert source in a comment. `catalog.ts`'s `isDecorative`/
  `noCollide` opts an item out of every collision check (lights, sockets,
  rugs, wall panels).
- `window.__kp = {store, plan, view}` is exposed for tests/debugging — keep it.
- Storage keys all live in src/model/storageKeys.ts: writes target
  `interior-planner-{design,parts,nav}-v1`, reads fall back to the legacy
  `kitchen-planner-*` keys (never deleted). `UNDERLAY_KEY` (the tracing photo)
  is new-name only — it has no legacy twin. `DESIGN_VERSION` is 6.
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

## graphify (knowledge graph)

`graphify-out/` holds a knowledge graph of this repo: every source symbol
and its imports/calls from AST extraction, plus the concepts and design
rationale extracted from CLAUDE.md, README.md, NEXT_STEPS.md, TODO.md,
index.html and the deploy workflow. Use it to ORIENT — it tells you which
files and communities a question touches — then read the real source for
anything you are about to change. The graph is a map, never the territory.

```bash
graphify query "<question>"          # BFS subgraph around the question
graphify query "<q>" --dfs           # trace one path instead of a neighbourhood
graphify query "<q>" --budget 4000   # widen the default 2000-token cap
graphify explain "worktopRuns"       # one node + its neighbours, in prose
graphify path "Store" "partPanels"   # shortest path between two concepts
graphify affected "Panel"            # reverse traversal: blast radius of a change
graphify update .                    # re-extract changed CODE files (AST, free)
graphify diagnose multigraph         # edge-collapse / dangling-edge health
```

Use it for: "where does X live", "what breaks if I change Y"
(`affected`), "how do these two subsystems connect" (`path`), and getting a
file shortlist before a refactor. Do NOT use it for line-level truth,
control flow, or deciding whether an edge case is handled — grep and read
the file for those. `query` starts from the graph's own vocabulary, so
phrase questions with real symbol names (`partPanels`, `hostContexts`,
`nextWeldSeam`) rather than prose descriptions.

Keeping it current:

- `graphify update .` after code edits — AST only, no LLM, no API key.
- Doc edits (this file, README, TODO, NEXT_STEPS) are NOT picked up by
  `update`; the concept layer only re-extracts on a full `/graphify .` run,
  which costs LLM tokens. Re-run it after a real architecture change, not
  after every doc tweak.
- `graphify hook install` wires a post-commit AST rebuild if you want it
  automatic (not installed by default).

Known limits of the current graph (1280 nodes / 4044 edges / 51 communities,
built from 85 files):

- ~150 dangling edges point at `three` and other external symbols that were
  never extracted as nodes. Expected, not corruption.
- The graph is UNDIRECTED and collapses same-endpoint edges: ~71 pairs that
  have both `imports_from` and `re_exports` (e.g. `meshKit → catalog`)
  survive as one edge. Absence of an edge is NOT proof of no dependency.
- `Point` and `Store` are the top bridge nodes by betweenness, so a BFS from
  either fans out across most of the codebase — start from a narrower symbol
  when you want a focused answer.
- `graphify-out/` is regenerated output (~3 MB, includes `graph.html`). It is
  untracked; keep it out of commits unless you deliberately want the graph
  versioned.
