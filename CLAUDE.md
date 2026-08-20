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
without any rebuild (dblclick a front in 3D, or the "Open fronts" toggle on
the 3D pane's own overlay). Meshes carry `name = panel.id` and `userData.role`. A future
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
in the props panel cover variants). `DESIGN_VERSION` is 7; sanitizeDesign
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
- **Manufacturing export** (src/model/export.ts + exportFormats.ts, reached
  from BOTH the topbar's `Export ▾` menu and the Output workspace's cards —
  one handler set in src/ui/react/exportActions.ts, so the two surfaces cannot
  drift): `buildBom(design)` iterates
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

**Render pipeline** (Export ▾ → "Render package (.zip)…"): every material is
stamped with a `kp:` name + `userData.kp` at creation (`stampMaterial` in
src/view3d/textures.ts, grammar in src/model/materialName.ts, mirrored
byte-for-byte by render/worker/kprender/matnames.py — NEVER change one
without the other), because glTF carries a material's baked shape but not
which library entry it came from. `View3D.exportRenderGLB` canonicalizes the
per-instance glTF materials down to one clone per `kp:` name (materials are
minted per surface, so plain `exportGLB` would otherwise emit the same oak a
few hundred times) and strips the canonical clones' procedural canvas maps
(never the live scene's materials — the worker rebuilds the real texture set
from the name). `buildRenderManifest` (src/model/renderManifest.ts, pure)
derives camera/sky/lights/window portals mirroring the exact transforms
View3D applies, golden-tested at render/manifest/examples/kitchen-min.json —
the SAME file vitest and the worker's pytest both read, so app and worker
cannot drift (regenerate deliberately with `UPDATE_GOLDEN=1 npx vitest run
test/unit/renderManifest.test.ts`, never to make a red test green).
`buildRenderPackage` (src/model/renderPackage.ts) zips manifest + GLB + raw
design JSON into one `interior-render.zip`. render/ holds the OpenPBR
material library (ids locked 1:1 to src/model/materials.ts) and a native
Blender/Cycles worker — macOS/Apple Silicon first, since Docker on macOS has
no Metal passthrough (render/docker/ is the Linux+NVIDIA-only alternative).

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

**The wall tool is ONE tool with two gestures, and it works in CENTRELINE
space.** `EditorState.tool === 'drawRoom'` (the old separate `room` drop-tool is
gone): a DRAG makes an axis-aligned rectangle, CLICKS make a polygon ring closed
on the first corner or with Enter. `Plan2D.drawPts` are wall centrelines, not
the face ring a `Room` stores, and `commitRing` converts once at the end:

- `regularizeDrawnRing(rooms, walls, ring)` runs FIRST (rooms.ts, pure). It
  collapses every edge under `MIN_SEAM` — a ring closed by Enter keeps a stub up
  to the close radius long, and `insetPolygon` mitres that against its
  neighbours at a wild angle, which is how a square ring committed with one wall
  visibly skewed — and then snaps any edge within `REGULARIZE_TOL` (20 mm) of an
  existing wall centreline exactly onto it. That second pass exists because
  everything downstream demands 1 mm coincidence and reports NOTHING when it
  does not get it: a 15 mm miss used to commit silently as two parallel slabs.
  It is the ONE place the tool alters what the user drew, which is why the band
  is an explicit constant and why a result that is not simple falls back.
- `faceRingPlan(rooms, ring, half, walls?, tol?)` (rooms.ts, pure) decides per
  edge how far it moves inward, PLUS which existing walls have to move to meet
  it. The offset is NOT uniform, because `Room.corners` means two things: the
  room-side FACE on an exterior wall (`faceOffset` 0) and the CENTRELINE on a
  partition (`faceOffset` t/2). An edge drawn onto a neighbour's centreline
  stays put; every other edge insets by half the wall width. The match is
  `edgeCentrelineHits` — an OVERLAP test (both endpoints within `tol` of the
  line, shared stretch ≥ `MIN_SEAM`) returning EVERY collinear wall, not the
  midpoint test returning the first that it replaced: an edge longer than the
  wall it runs along, or spanning two stacked rooms, silently missed.
- `store.alignWallsToCentreline(ids)` promotes the whole batch AT ONCE, and
  that is not a convenience. A new room laid across the top of two that already
  share a wall needs both their top walls promoted, and the corner where they
  meet anchors that shared wall; asked one at a time each promotion is refused,
  and the new room comes out with a doubled wall along its entire bottom edge.
  Asked together the two moves are identical, the seam slides along itself and
  survives. So the rule is not "never move a shared corner", it is **every
  corner may move exactly one way, and a wall nobody promoted may change LENGTH
  at a moved corner but never DIRECTION** — that second gate is what separates
  sliding a seam along itself from dragging one end of a wall sideways into a
  tilt nobody drew. `alignWallToCentreline(id)` is the one-id wrapper.
  It moves that neighbour's ring edge out onto
  its own centreline so the two rings can hold the SAME edge — which is all
  `allWalls` needs to see a partition. The host's interior does not move: the
  t/2 it gives up is exactly the t/2 `faceOffset` hands back. Refused (and the
  edge stays exterior) when the wall is already shared or an end anchors another
  partition. Both halves come from ONE `faceRingPlan` call against ONE snapshot —
  promoting changes the centrelines, so re-deriving between the two is a bug.
  A REFUSAL must still be honoured: `plan.edgeWalls` names the walls each edge
  matched, and `commitRing` resets that edge's offset to `half` when none of
  them was promoted or already shared. Skipping that leaves the edge on the
  un-promoted neighbour's centreline, t/2 off its face ring, where `linkShared`
  and the weld both miss it — two parallel walls, silently. Downgrading is not a
  re-derivation: the plan is still the one snapshot, only the rejected entries
  are undone. There is no offset that shares an exterior wall whose ends anchor
  another partition, so that case ends as coincident slabs and is reported by
  the `parallelWalls` check rather than fixed.
- `snapRingToNeighbours(rooms, face, half)` is the LAST step, after
  `insetPolygon`. The per-edge inset shortens a shared edge by `half` at each
  end — right when the drawn ends were the mitred corners, since it lands the
  edge on the host's own corners and `linkShared` fires at once; anywhere else
  the two rings differ by a few centimetres, which is too big for
  `cutOrNudge`'s `SHARE_EPS` fold and too small for its `MIN_SEAM` cut, so the
  weld refuses and BOTH walls survive. Pass the same `half` the inset used: that
  is the largest distance the inset can have moved a corner, so anything further
  apart was drawn apart on purpose. The chain itself is never nudged — moving a
  drawn end shears the segment attached to it, which is the skewed wall this all
  exists to prevent.
- Snapping is to `wallCentrelines(rooms).segments` — each wall's own extent
  offset perpendicular by `bandCenter`, so a segment ends exactly where its wall
  does and exactly where promotion puts it — PLUS the MITRED `rings` from the
  same call, as the separate `junction` snap kind. The two are still different
  things: a segment ends where its wall ends, so at a right-angled corner the
  two nearest endpoints sit t/2 off along either axis and the point a
  neighbouring room's ring corner belongs on is not among them at all. Offering
  the junction is what stopped a room drawn against a neighbour coming out half
  a thickness wrong. It is safe for the WALL TOOL only, because `commitRing`
  converts through `faceRingPlan`, which promotes the neighbour's wall out to
  meet the drawn edge; `snapPointToCentrelines` and the corner drag have no such
  conversion and must keep snapping to the face ring. The rings are also where
  the plan draws its corner handles (`cornerHandlePositions`, shared with
  `Plan2D.hitCorner` so draw and hit-test cannot diverge).
  `snapRectSides` snaps a drag-rectangle's four sides INDEPENDENTLY, unlike
  `snapRoomRect`'s whole-rectangle slide, because a room laid alongside another
  needs its shared side and both flanking sides flush at once.
- Angle snapping (15° steps) is ON by default and Shift INVERTS it;
  `editor.angleSnap` is the preference and `#btn-angle-snap` the toggle. A true
  right angle draws the plan-notation square. Typing digits sets an exact segment
  length through `parseLength` (the `draw.digit*` commands — see the keyboard
  note on first-match-that-can-run).

**`src/model/snap/` is the ONE snap engine, and every plan gesture calls it.**
`resolveSnap(cursor, ctx, cfg)` is pure, DOM-free and unit-tested
(test/unit/snapEngine.test.ts). It resolves in three stages, and the split is the
whole design:

- **POINT** candidates (`close` / `junction` / `endpoint` / `midpoint` /
  `intersection`) fully determine the answer, so the best-scoring one returns
  immediately. `close` (120) is the ring's OWN first vertex once it has 3
  points, and reaches `CLOSE_REACH_SCALE` (1.4×) further than a normal point
  snap; `junction` (105) is a mitred centreline corner, supplied by the caller
  as `ctx.junctions`. Both outrank `endpoint` (100) deliberately: closing a loop
  and landing a neighbour's corner both used to LOSE a tie against an ordinary
  wall end sitting the same distance away, which is exactly why a room drawn
  against an existing one would neither close nor line up.
- **LINE** candidates (`align` / `extension` / `perpendicular` / `parallel` /
  `onSegment` / `angle`) each remove ONE degree of freedom, so the top two
  non-parallel ones are INTERSECTED — that is how "lined up with that corner AND
  square to the wall I just drew" reaches one exact point, which no ladder of
  independent tiers can express.
- **GRID** (`editor.snapGrid`, `#btn-grid-step`, null = off) is the lowest
  priority fallback, applied only when nothing else fired. It replaced four
  hardcoded `Math.round(v * 20) / 20` sites in Plan2D. Do NOT confuse it with the
  VISUAL grid renderPlan draws (`gridStep`, 0.1/0.5 m by zoom) — different thing,
  hence the different name.

Scoring is `TYPE_WEIGHT[kind] − distance / reach`, and reach is SCREEN px over
the live zoom, clamped by `maxWorldReach`. Both halves matter: screen-relative
means a snap feels the same at every zoom (the bug being fixed was a fixed 0.15 m
that became a 45 px magnet at 300 px/m), and the clamp stops zooming OUT turning
it into a magnet spanning metres. `hitRadius` is applied by the CALLER, so
src/model never imports src/plan2d.

`Plan2D.onCloseTarget` uses the same `CLOSE_REACH_SCALE` reach as the engine, and
the close target is checked BEFORE the typed-dimension branch in `snapDrawPoint`
— a typed length otherwise bypasses `resolveSnap` entirely, and with a digit in
the box the ring could not be closed at all.

Three rules that are easy to break and are pinned by tests:

- **The angle lock is a MODE, not a proximity snap.** `angleCandidates` is the
  one generator with no reach gate and a clamped penalty; gating it would switch
  it off past a few centimetres off the ray. When it is live, line candidates
  PARALLEL to it are dropped — they fight it for the same axis from a different
  origin and can never combine with it — which is what stops a distant wall's
  midpoint quietly tilting a segment the user asked to be straight.
- **Two lines through the SAME origin are never crossed.** `angle`,
  `perpendicular` and `parallel` all radiate from the anchor, so intersecting any
  two of them lands the vertex ON the anchor: a zero-length wall.
- **A constraint radiating from the anchor draws NO guide.** It would sit exactly
  under the rubber-banded segment. It reports through the cursor glyph
  (`drawSnapMarker`, renderPlan.ts) instead.

`Alt` suppresses everything, grid included, and is a POINTER modifier — read off
`e.altKey` plus window `keydown`/`keyup`/`blur` watchers in Plan2D, NOT a
`KeyBinding` (KeyboardController only ever reads ctrl/meta/shift). `Tab`
(`draw.toggleField`) moves between the HUD's length and angle boxes; the typed
ANGLE is relative to the previous segment while the 15° lock stays world-absolute.

The four callers pass different contexts, and the differences are deliberate:
the wall tool snaps to `wallCentrelines` (centreline space, because `commitRing`
converts to face space via `faceRingPlan` WITH wall promotion); `measureSnap`
snaps to raw walls + item outlines with the inference kinds DISABLED (a
measurement must read geometry, never invent a point) and no grid; the corner
drag snaps to the room-side FACE rings, because `moveCorner` + `weldRoom` has no
conversion step at all and `allWalls` only sees a partition when two rings hold
literally the same edge — snapping a dragged corner to a centreline would leave
the rings half a thickness apart and no weld could ever form. `snapItem` (item
placement) is deliberately NOT on the engine: OBB edge-to-edge plus wall-face
hugging is a different problem.

**A chain need not close, and what it becomes depends on what it touches.**
`closeDrawRoom(finishOpen?)` reads the finished chain FOUR ways, in order:

1. back on its own first corner → a ROOM (`commitRing`, above);
2. both ends landed on existing walls → a ROOM closed along that existing
   geometry (`closeChainAgainstWalls`, pure in rooms.ts → `commitRing`). This is
   how a plan gets redrawn wall by wall: you draw only the walls that are NEW.
   The answer comes from **`src/model/faces.ts` `planarFaces`**, not from
   walking one room's corner ring. That distinction is the whole feature: a ring
   walk can only close a chain against the SINGLE room it started and ended on,
   and from the third room onward the two ends land on two DIFFERENT rooms (or
   on a free chain), so a perfectly closed region committed as free-standing
   walls instead. The subdivision does not care — it cuts every centreline at
   every crossing and hands back the face the chain bounds, whatever the
   topology. The graph is built from the MITRED `rings`, never the butt-ended
   `segments`: a segment stops at its own wall's extent, so at a corner two
   centrelines miss each other by half a thickness and no face would ever close.
   Both ends must land within `REGULARIZE_TOL` and are projected exactly onto
   the geometry first (the graph joins only what actually meets). Faces
   containing an existing room's centroid are rejected, the smallest survivor
   wins, and a chain through a room's INTERIOR returns null so reading 3 keeps
   the split.
3. crossing one room's ring twice → a SPLIT (`store.splitRoom` →
   `splitRoomByChain`, pure in rooms.ts). The chain is clipped to its two ring
   crossings and becomes the shared edge of both halves; the outer arcs stay on
   the original ring. That works because the two meanings of `corners` hold at
   once — the cut edge is a partition, so its ring edge IS its centreline,
   while the untouched arcs are still exterior face. **Both halves become new
   rooms**: the original's name/style/overrides do not survive a cut that
   describes only part of what it used to. Items are re-homed by position,
   openings by nearest wall (`reprojectOpeningsNearest`).
4. anything else → FREE WALLS (`store.addFreeWall`).

**The tool stays ARMED after every commit** (`Plan2D.finishGesture`, not
`setDrawRoom(false)`). A plan is a run of rooms, and a trip back to the toolbar
between each was the slowest thing about drawing one; `addRoom` already makes
the new room active, so its Width/Depth/Ceiling are in the inspector either way.
Escape twice leaves — ring first, then tool. Note the toolbar button still
TOGGLES, so re-pressing it mid-plan disarms rather than re-arms.

**Reading 2 fires on the CLICK, not on Enter** (`addDrawPoint`): a loop of three
new walls and one existing one is finished the moment the last corner lands, and
must not need a keystroke that a loop of four new walls does not. Three points
minimum, or the second click of a chain drawn along a wall would close a sliver;
and because `closeChainAgainstWalls` refuses a chain through the interior, a cut
still reaches reading 3 instead of being stolen.

`finishOpen` (double-click, `Shift+Enter` → `tool.finishOpen`) skips straight to
reading 3, so a divider drawn against a wall stays a divider. `Plan2D.drawOutcome()`
reports which reading is live — CACHED, recomputed only when a vertex is added
or removed, which is exact rather than an approximation because `closeDrawRoom`
reads `drawPts` and never the hover. It rides `DrawHudState.outcome` so the
answer is drawn AT THE CURSOR (`⏎ room` / `⏎ split` / `⏎ walls`); the status bar
saying it at the bottom of the window was nowhere near where anyone drawing a
wall is looking. The status hint names the gesture behind it — the four readings
are not guessable from the drawing, and picking one silently is what turned
"three walls against a neighbour" into free-standing walls.

**`design.walls` is the second source of walls** (`FreeWall` — an OPEN chain of
`Corner`s, its own thickness, sharing the design-wide corner-id space so a
segment is named by its start corner exactly like a room wall). Its centreline
IS the stored polyline; there is no interior side to inset to, so `faceOffset`
is t/2 and the slab straddles it. `store.allWalls()` = `designWalls(rooms,
walls)` is the ONE choke point the plan renderer, View3D and `wallJoints`
already went through, which is why a divider needed no code of its own in any
of them — it arrives as one more `RoomWall` carrying `roomId === NO_ROOM` and a
`freeWallId`. The weld/shared-edge machinery deliberately does NOT see them
(`store.roomWalls()`): a chain that encloses nothing can never be half of a
partition. `DESIGN_VERSION` is **7**; v6→v7 only adds the empty list, and the
bump exists so an older build refuses the file instead of dropping every
divider on the next save.

**Wall width is PER WALL.** `Room.wallWidths` (optional, keyed by wall id,
mirroring `wallVisibility` exactly — same sanitize, split-remap and
duplicate-remap paths) overrides `style.wallThickness`, and `allWalls` is the ONE
place it resolves. A partition is one physical wall, so `linkShared` writes the
OWNER's width onto both twins. `DEFAULT_WALL_W` is **0.115** (a real single-leaf
partition, not a round 100 mm). `store.wallWidth`/`setWallWidth`/
`hasWallWidthOverride` are the API; the wall inspector edits one wall and the
Furnish panel still sets the room-wide default. A free chain holds the same
`wallWidths` map, so those three resolve against whichever holder owns the
wall — room or chain.

**A reference plan can be a PDF.** `src/ui/pdfImport.ts` loads pdf.js through a
DYNAMIC import (its own chunk — nothing pays for it until a PDF is picked) and
`<PdfPagePicker/>` asks WHICH page before anything is placed; the chosen page is
rasterized to the same `{src, w, h}` bitmap a photo produces and goes through the
shared `placeUnderlay`. That tail also frames the reference
(`plan.zoomFitWhenReady()` — `zoomFit` fits underlay corners as well as room
corners) and ARMS the calibrate tool, because an uncalibrated reference makes
every wall traced off it the wrong size. `shellState.pdfImport()` is which file
is waiting for a page choice.

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
(Topbar.tsx's load handler re-installs it after `replaceDesign`). renderPlan
draws it just ABOVE the grid, behind `opts.underlay` (off in `PRINT_OPTS`) —
the grid used to sit on top and moiréd the scanned lines it was there to help
trace;
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
  the module script, and src/ui/react/App.tsx renders the shell (Topbar /
  Sidebar / Workspace / PropsPanel / StatusBar are organizational splits;
  e2e/layout.spec.ts pins the boot geometry). The shell holds NO state and
  never re-renders. The TOPBAR is file- and workspace-level only: the four
  `#ws-tab-*` tabs, undo/redo, New/Save/Load, `Export ▾` (`#btn-export` — which
  now also holds `#btn-png` and `#btn-glb`) and the `#btn-settings` gear (units,
  `#btn-navinput`). What steers the DRAWING rather than the document sits over
  the drawing instead: `#view-toggle` and the day/night + open-fronts pair are
  <ViewOverlay/>/<SceneOverlay/> in src/ui/react/CanvasOverlays.tsx, which
  return null outside Plan/Furnish. **src/ui/ui.ts and `mountLegacyUI()` are GONE** — React owns
  every element in the shell, including the recovery banner
  (src/ui/react/RecoveryBanner.tsx, rendered as the first child of `#app`), and
  src/app/bootstrap.ts creates no DOM at all. What was global about the old
  controller — the key map — is `src/editor/keyboard/`, attached to `window`
  from an App-level effect that runs after the canvas effects.
- **Components take the app's object graph from a context, never from the
  bootstrap.** `src/app/services.ts` `createServices()` builds the one
  `AppServices` ({store, editor, plan, elevation, view3d, studio, commands,
  keyboard, bridge, switchWorkspace, needsRecoveryBanner, firstRun}); `src/ui/react/services.tsx` provides
  it and `useAppServices()` / `useStore()` / `useEditor()` / `useCommands()`
  read it. **src/ui/react/App.tsx is the ONLY module allowed to import
  src/app/bootstrap** — it installs the provider — and an eslint
  `no-restricted-imports` rule over `src/ui/react/**` (with App.tsx as the one
  listed exception) keeps it that way. The point is not multi-tenancy: it is
  that a new editor service must not become one more bootstrap export plus 28
  new imports.
- **The shell is four WORKSPACES, and `src/ui/workspaceState.ts` is which one.**
  `plan | furnish | workshop | output` — a device preference (WORKSPACE_KEY,
  default `furnish`), never design data, never undone — plus the ephemeral
  `workshopTarget` ({defId, itemId?, returnTo}) that says which part the
  Workshop opens on and where "Back" goes. Module singleton with ONE listener
  Set, shaped like src/ui/shellState.ts; StoreBridge carries it as the
  `'workspace'` channel. **`createServices().switchWorkspace` is the ONE
  switch** — the topbar tabs, `‹ Back` and the `workspace.*` commands behind
  keys 1-4 (`WorkspacePort` in EditorContext) all go through it, so the two
  resets (`editor.setTool('select')`, `setCatalogOpen(false)`) are written once.
  Nothing can REFUSE a switch any more: the Part-Studio dirty confirm went with
  the drafts (WP 3.1), so the boolean is `WorkspacePort`'s shape rather than a
  live veto, and tearing the studio down is <WorkshopPane/>'s cleanup effect
  reacting to the workspace change. A workspace is a
  different TASK, so surfaces scope to it: the room tools render in Plan only
  and measure/checks in Plan+Furnish (React), `CatalogSection.workspace` splits
  the catalog ('Room & utilities' = plan, the rest = furnish, `#catalog-search`
  over it), and the sidebar swaps to <WorkshopPartsPanel/> / an Output caption.
  Workshop and Output are OVERLAY PANES over `#canvases`
  (src/ui/react/WorkshopPane.tsx, OutputPane.tsx — `.workspace-pane`, z-index 30
  above `.canvas-overlay`'s 20): they COVER the two canvases and never unmount
  them, which is what keeps the WebGL context and both view attachments alive
  across a round trip (e2e/lifecycle.spec.ts). Each covering pane calls
  `view3d.setActive(false)` on entry and restores on exit only if `#pane3d` is
  not `.hidden` — the 2D/3D toggle owns that flag, so read it, never duplicate
  it.
- The whole left sidebar is React's (src/ui/react/Sidebar.tsx + CatalogPanel /
  OutlinePanel / VariablesPanel): which tab is open is component state, and the
  panels carry BOTH `.active` and `hidden` because style.css hides on
  `[hidden]` while test/interact.mjs asserts the class. **src/ui/outlineModel.ts
  `outlineGroups(source)` is the grouping truth** — CATALOG_GROUP (defId →
  catalog section), OUTLINE_ORDER and the 'Other'-leftovers rule live there,
  pure and unit-tested; OutlinePanel only formats and wires clicks. CatalogPanel
  keeps the old renderCatalogIfPartsChanged signature (JSON of
  `design.customParts`) as a `useMemo` key, so tile defs keep their identity and
  memoized <CatalogTile/>s skip the thumbnail redraw on arming ticks. The Part
  Studio is an AppServices singleton (`studio`) with a no-op close callback: every
  path that changes the library commits, so the 'history' channel is the refresh.
  It is the last imperative DOM in the app, deliberately out of scope — but it is
  NOT a modal: `open(existing, host)` builds `.studio-hosted` into the Workshop
  pane's host div (no backdrop, no ✕, Escape only clears the in-studio
  selection), and deleting the part lands on the type picker. Every
  route in — the catalog's ＋/✎ tiles, the Workshop sidebar's rows, the props
  panel's "Edit part template…" / "Customize part…" — goes through
  `openInWorkshop`, and <WorkshopPane/> is the only thing that hands it a
  host.
- **The Part Studio is LIVE-APPLY, and that is the rule the rest of it follows
  from (WS-SPEC WP 3.1).** `studio.part` IS the object in
  `design.customParts`, not a draft of it: the rail panels mutate it directly,
  the one `changed(transient?)` choke point hands it to
  `store.updateCustomPart(id, mutate, transient)`, and the plan and 3D redraw off
  the ordinary structural notify. So there is **no Save, no Revert, no
  `originalJson`, no dirty guard and no leave-confirm** — after this WP the app
  raises ZERO native dialogs (every question is <ConfirmHost/>), which
  e2e/fixtures.ts pins by registering no `page.on('dialog')` handler at all.
  Four consequences, each load-bearing:
  - **Opening MATERIALIZES.** A preset is deep-frozen and lives outside the
    design, so `store.materializePart(def)` shadows it design-locally under the
    SAME id (decision D4) and the studio edits the shadow — which is why placed
    instances follow rather than fork. It does NOT commit; picking a type in the
    picker does, because that one is a deliberate creation.
  - **Leaving DISCARDS a pristine shadow.** `PartStudio.close()` is the single
    choke point (leaving the Workshop, opening another part, delete, duplicate
    all go through it) and calls `store.discardPristineShadow(id)`, which removes
    a shadow still byte-identical to its preset — deliberately NOT
    `deleteCustomPart`, which would take the placed instances with it. With
    materialize uncommitted, the trailing `commit()` dedupes to a no-op, so
    browsing the built-ins costs no undo step and leaves no litter.
  - **An INVALID part is not written.** `sanitizePart` would rebuild a
    self-crossing outline from its bounding box, so `changed()` holds the write
    back while `validate()` reports anything — the live-apply spelling of the old
    disabled Save button, and what `.studio-validation` is still for.
  - **Undo REPLACES the design's objects**, so the studio subscribes to
    'history' and re-opens on whatever its id resolves to now (resident part,
    the preset it shadowed, or the picker). Its OWN commits are told apart by
    object IDENTITY — after `updateCustomPart` the resident IS the held part —
    which is what keeps focus and caret through an ordinary edit. `close()`
    therefore unsubscribes BEFORE it can commit, or the discard would re-enter.
  Because `sanitizePart` REBUILDS things (`sanitizeZone` mints a new object per
  leaf, `normalizeBoardOutline` re-winds a ring), it is skipped on a `transient`
  tick and any editor handler must resolve a leaf by PATH at click time, never
  capture one (`live()` in zoneCanvas.ts).
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
  isEditingVariableName guard around its innerHTML rebuilds. `wrapAngle`
  (convert.ts) and the multi-selection rule (`useMixedValue`) are pure and
  pinned by test/unit/fields.test.ts.
- **The properties inspector is keyed by the selection, and never renders
  mid-gesture.** src/ui/react/PropsPanel.tsx mounts `<PropsBody/>` under
  `` `${sel.kind}:${sel.id}` `` (or `room:<activeRoomId>` when nothing is
  selected), so picking a DIFFERENT object remounts the whole body — the React
  spelling of ui.ts's `innerHTML = ''`, and what lets every field stay
  uncontrolled — while an edit to the SAME object is an ordinary re-render that
  keeps nodes, focus and caret. PropsBody subscribes to 'selection', 'history',
  'activeRoom' and 'workspace' (the room panel's section list is
  workspace-scoped — roomSections.ts — so a tab switch must re-render it) and
  to NOTHING gesture-rate: a drag fires 'transient' at pointer
  rate, and the six dragged fields (pos-x, pos-y, rot, corner-x, corner-y,
  opening-off) follow it themselves through `useLiveValue`, writing into their
  own node. That is a hard contract, not an optimisation — PropsBody counts its
  committed renders into `window.__kp.debug.renderCounts`
  (src/ui/react/debugCounters.ts) and e2e/transient-perf.spec.ts fails on a
  single one during a drag. Panels are one file each under
  src/ui/react/props/ (Room / Item / Wall / Opening / Corner, plus the shared
  Checks / Underlay / Lighting sections); e2e/inspector.spec.ts pins each
  one's ordered section titles, because test/interact.mjs reaches into this
  panel by ordinal (`.prop-section` index, the room panel's first numeric
  field) and those couplings are invisible from the code they constrain.
- **A length or angle box is `type=text` with `data-unit`, not a spinner.**
  src/model/units.ts parses and formats it, in the unit src/model/prefs.ts
  holds (mm, 0 decimals, by default, on its own 'units' bridge channel), so
  the value can be an expression — '600-18*2', '1.2m', '90+45'. NumericRow
  (fields/NumberField.tsx) re-implements what the browser used to give for
  free, once: clamping to `min`/`max` (which are MODEL units — metres and
  radians — since the display unit is a preference), ArrowUp/Down stepping by
  `step` in the DISPLAY unit (×10 with Shift), and restoring the model's own
  value when the input parses to nothing.
- **`EditorState` (src/editor/editorState.ts) is the single source of tool
  truth**: `tool` (`select | place | measure | calibrate | drawRoom`),
  `armedDefId` (only meaningful under `place`, and `setTool` nulls it on every
  other switch), the orthogonal `checksOn` display layer, and the wall tool's
  two preferences `wallWidth` / `angleSnap`. Ephemeral like
  `store.openFronts` — never serialized, never undone. Plan2D's six public tool
  fields (`armedDef/measureOn/calibrateOn/drawRoomOn/checksOn`) are
  READ-ONLY MIRRORS written only by its `syncFromEditor()`, which the
  constructor subscribes (not `attach()` — a detached view still tracks the
  tool). A tool change there runs the **leaving-tool cleanup** — calibrate →
  `resetCalibrate`, place → ghosts, measure → `resetMeasure`, drawRoom →
  `resetDrawRing` — which is what replaced
  `closeOtherTools(keep)`. `syncFromEditor` NEVER writes the editor back
  (re-entrancy), and `resolveArmed` is null-safe on purpose: `store.defOf`
  THROWS, so a stale armed id must resolve to null, not an exception. The
  `setX()` methods are delegates that keep their ENTRY reset (re-arming the
  live tool is a no-op upstream, so that reset is the only effect) and then
  call `editor.setTool`. React's tool buttons call the editor directly.
- **Named editor behaviours live in `src/editor/commands/`, not in a listener.**
  `CommandRegistry` runs a `CommandDefinition` by id against one
  `EditorContext`; an unknown id is a no-op returning `false`, never a throw.
  The 16 seed commands (history.undo/redo, selection.delete/duplicate,
  transform.rotate90/15 + eight nudges, tool.cancel/finish) came verbatim out
  of the old keyboard map, and each mutating one still ends in `store.commit()`
  — **snapshot undo is untouched, commands are not history steps**. Because
  src/editor may not import src/ui or src/app, and src/plan2d already imports
  `editorState`, Plan2D, PartStudio and the workspace switch arrive as the
  STRUCTURAL `PlanToolPort` / `ModalPort` / `WorkspacePort` declared in
  commands/types.ts, wired in `createServices()` —
  that inversion is what killed the old bootstrap↔ui.ts cycle. `canExecute`
  carries what used to be part of the key match (`Ctrl+D` needs an item), which
  is what lets the keyboard swallow a key only when the command actually ran.
- **The key map is DATA**: `src/editor/keyboard/bindings.ts` is a pure,
  DOM-free `KeyBinding[]` + `matchBindings`, and `KeyboardController` is the
  `attach(target)`/`dispose()` adapter around it. Three behaviours are pinned by
  test/unit/editor/keyboard.test.ts because they are easy to lose: Escape runs
  even while TYPING (`allowWhileTyping`) and never calls `preventDefault`; every
  other binding is suppressed while TYPING, and that is the map's only gate —
  the "a modal is open" suppression went with the Part Studio's drafts (WP 3.1 /
  decision D2), because live-apply makes Ctrl+Z in the Workshop the feature.
  What that suppression really bought is now `onCanvas` in appCommands.ts: the
  commands that would edit an INVISIBLE selection or an invisible wall ring
  (selection.*, transform.*, tool.finish*, draw.*) require the plan or furnish
  workspace, since Workshop and Output cover the canvases; history.undo/redo
  deliberately do not. And `preventDefault` fires only on a command that ran. **First match that CAN RUN
  wins**, so table ORDER is load-bearing (Shift+Ctrl+Z above Ctrl+Z): one key may
  appear twice and `canExecute` picks between them by context — a digit is a wall
  dimension while a ring is in flight (`draw.digit*`) and a workspace switch at
  rest. **Backspace appears THREE times** and is the sharpest example: it edits
  the dimension box while a character is typed (`draw.backspace`, gated on
  `drawBufferActive`), steps the drawn ring back one corner while a ring is live
  (`draw.undoVertex`, gated on `drawInputActive`), and deletes the selection at
  rest. Splitting those two gates is what lets an EMPTY box hand the key on
  instead of eating it. `Shift+Enter` (`tool.finishOpen`) sits above plain Enter
  for the same reason — the plain row is shift-don't-care. The gates (typing,
  modal) are evaluated PER candidate, so a blocked row never hides the one below
  it.
- **Escape steps the wall tool's ring BACK ONE CORNER**, and disarms the tool
  only when the ring is empty (`Plan2D.cancelDrawRoom` → `undoDrawVertex`). It
  used to discard the whole chain, which made it the most expensive key in the
  tool: nothing else could take a corner back, so one mis-click on a ten-corner
  outline cost the outline. e2e/tools.spec.ts pins the walk.
- `src/editor/input/types.ts` and `src/editor/tools/Tool.ts` are **type
  declarations with no runtime** — the Phase C contracts. No `ToolManager`
  yet, on purpose; it lands with the first tool that exercises it. See
  src/editor/README.md for the extraction order (Measure first, **Select
  last**).
- **The right-click menu is a pure model plus a thin hit façade.**
  `contextMenu(hit, workspace, opts)` (src/ui/contextMenuModel.ts, framework-free
  and unit-tested) decides WHICH entries a hit earns; src/ui/react/ContextMenu.tsx
  only draws them and maps each id onto an EXISTING mutation or command — the
  item entries go through `commands.execute()` so the menu and the keyboard
  share one path and one undo step, which is also why they select first. What
  is under the pointer comes from `Plan2D.hitAt(clientX, clientY)` (a
  `ContextHit`, src/plan2d/planHit.ts) and `View3D.pickItem(e)`: both delegate
  to the private testers the CLICK paths already run — the plan cascade is
  item → wall → room → empty, minus the drag handles, with an opening reported
  as its host wall and `t` in METRES (what `store.splitWall` takes). No new
  geometry lives in either. Every entry carries its gesture as a trailing
  `hint`, and an entry that cannot work is OMITTED, never disabled (the last
  room has no Delete, the active room no "Make active"). The two "…" entries
  reach into the inspector by selector — `input[data-cls="wall-len"]` and
  `#section-walls` exist for them — so those are pinned in
  e2e/dom-contract.spec.ts. Popup dismissal is `useMenuDismiss`
  (src/ui/react/hooks/), shared with the two topbar dropdowns.

- Chrome state that is neither design nor tool lives in
  src/ui/shellState.ts — the status-bar hint text, the catalog drawer's open
  flag, the elevation view's wall label and whether the shortcut sheet is up, a
  module singleton shaped like src/model/prefs.ts. Everything that used to
  write `#status-hint` calls `setHint()`; `<StatusHint/>` renders it, and
  `<WallNav/>` renders `wallLabel()` the same way. StoreBridge carries all
  three upstreams as channels: Store, `'editor'` and `'shell'`.
- **`confirm()`/`prompt()` are gone; the app asks its own questions.** The
  pending `DialogRequest` is one more shellState field (`appDialog()`),
  src/ui/dialogService.ts owns the promise (`confirmDialog` → boolean,
  `promptValue` → number|null, `resolveDialog(accepted, value?)` from the host)
  and <ConfirmHost/> draws it in PdfPagePicker's `.modal-card`, Escape/Enter in
  the CAPTURE phase like <Cheatsheet/>. ONE dialog at a time: a second opener
  resolves the first as cancelled. An `input`'s `parse` both validates and maps,
  so a bad answer holds the dialog OPEN — that is how the calibrate prompt takes
  `parseLength` expressions ('2400', '2.4m', '600*4') without losing the
  two-click gesture to a typo. The ONE deliberate survivor is the Part Studio's
  dirty-close `confirm()`: it answers inside `switchWorkspace`'s SYNCHRONOUS
  refusal contract, which a promise cannot. Every caller is async now, which is
  why `Plan2D.onCalibrateDone` may return a promise — the calibration span stays
  drawn until it settles.
- **Onboarding is decided at construction, never in a component** (WS-SPEC
  §5.5). `createServices()` computes `firstRun = !loadedDesign &&
  !needsRecoveryBanner && !onboarded()` from the reads it already does plus
  src/ui/onboarded.ts (ONBOARDED_KEY, navPref-shaped: load-at-import, no
  listeners, best-effort write, and storage that THROWS reads as onboarded).
  A first run also forces `setWorkspace('plan')` right there — before React
  mounts, so the first paint is already right — and **boots `emptyDesign()`,
  not the demo kitchen**: nothing loaded (or an autosave that would not
  sanitize) lands on a blank plan, where <PlanStarterCard/> and the tour teach
  the real workflow instead of handing the user somebody else's finished
  design to delete. `store.loadDemo()` is the ONE way back to it — the card's
  "Load sample design", and the same call test/interact.mjs and
  test/screenshot.mjs seed with, so the product path and the test path cannot
  drift. <CoachMarks/> is a
  conditional in App.tsx like <RecoveryBanner/>, which is what makes the tour
  and the recovery banner mutually exclusive by construction. The tour writes
  the flag when it ENDS (walked or skipped), never on mount. The cheatsheet is
  the other half: `src/ui/shortcuts.ts` is the ONE list of gestures (data, no
  React), `cheatsheetOpen()`/`setCheatsheetOpen()` on the 'shell' channel is
  its state, `?` reaches it through the `help.shortcuts` command + `HelpPort`
  (`mod: false`, typing-guarded), and the settings menu's
  `Shortcuts…` is the pointer route. Both overlays own Escape in the CAPTURE
  phase while they are up, so closing one never also cancels the live tool.
  **A new Playwright suite MUST seed `interior-planner-onboarded-v1` at page
  init** (e2e/fixtures.ts does it for every spec on the `app` fixture,
  test/interact.mjs and test/screenshot.mjs do it for themselves): storage is
  cleared all over these suites and a cleared profile IS a first run, so
  without the seed the tour would cover the shell and eat the first click.
  e2e/coach-marks.spec.ts is the one suite that deliberately omits it.
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
  e2e/catalog-outline.spec.ts does the same for the sidebar's two ported
  panels (arm/disarm marker, place, ＋/✎ into the studio, group order and
  counts, row + room-row activation by click and by Enter);
  e2e/sidebar.spec.ts pins the per-workspace sidebar swap and
  e2e/output.spec.ts byte-compares an Output card's CSV against the Export
  menu's.
  e2e/recovery.spec.ts owns the recovery banner: it is the one spec that does
  NOT use the `app` fixture, because its subject is the state of localStorage
  BEFORE boot and the fixture clears storage as part of setup.

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
  + `parallelWalls` (two slabs running along each other within one thickness
  that the model did NOT merge into a partition — the tool's one remaining
  silent failure, made visible; `itemIds` is empty, so the row is unfocusable
  by design)
  (blocksDoor/frontClearance/walkway/workAisle/bedAccess — amber tint), info =
  hint (doorLanding/workTriangle — never tints, never counts toward the
  status bar's issue total). Each `CLEARANCE` constant carries its
  NKBA/Neufert source in a comment. `catalog.ts`'s `isDecorative`/
  `noCollide` opts an item out of every collision check (lights, sockets,
  rugs, wall panels).
- `window.__kp` is exposed for tests/debugging — keep it, and keep it FLAT:
  {store, plan, view, elev, editor, bridge, workspace, setWorkspace, navInput,
  setNavInput, debug}. Its shape is a contract typed in e2e/kp.d.ts, so a
  rename in src/ breaks the specs at typecheck. `setWorkspace` is
  services.switchWorkspace, not the raw setter — a spec must change workspace
  through the same guard a user does.
- Storage keys all live in src/model/storageKeys.ts: writes target
  `interior-planner-{design,parts,nav}-v1`, reads fall back to the legacy
  `kitchen-planner-*` keys (never deleted). `UNDERLAY_KEY` (the tracing photo),
  `WORKSPACE_KEY` (the open workspace), `UNIT_PREFS_KEY` and `ONBOARDED_KEY`
  (the first-run tour, seeded by every test suite) are new-name only — they
  postdate the rename and have no legacy twin. `NUDGE_KEY` (the Furnish
  nudge's dismissal) is the one key there in **sessionStorage**: "for the rest
  of the session" is the tab's lifetime, so a reload must keep it hidden and a
  new tab must not. `DESIGN_VERSION` is 7.
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
- Units: all lengths are meters internally, and **src/model/units.ts is the
  single conversion authority** — nothing outside it multiplies a length by
  100. The properties inspector and the Part Studio DISPLAY and PARSE through
  it, in the unit `src/model/prefs.ts` holds (**mm, 0 decimals, by default**;
  the pref is per-device, never design data). Inspector length/angle boxes are
  `type=text` + `inputMode=decimal` + `data-unit`, not spinners, because they
  take EXPRESSIONS — '600-18*2', '1.2m', '90+45' — and a rejected one restores
  the model's value instead of committing. `min`/`max` on those fields are
  MODEL units and the field clamps to them, since a text box has no browser
  range to lean on. **A dimensioned expression may not come out dimensionless**:
  `1m / 2m` is a ratio (0.5), so `parseLength` rejects it rather than read it as
  0.5 mm — only a wholly bare expression ('600-18*2') gets the prefs.unit
  interpretation. The plan and elevation CANVASES still label in cm (wall
  lengths, dimension lines): they draw their own text and were deliberately
  left alone.
- The `kp:` material-name grammar and the 19 material ids are a cross-language
  contract spanning three files that must move together: src/model/
  materialName.ts (TS), render/worker/kprender/matnames.py (Python) and
  render/materials/openpbr.materials.json (data). test/unit/materialName.test.ts
  + render/worker/tests/test_matnames.py pin the grammar; test/unit/
  openpbrLibrary.test.ts pins the library against src/model/materials.ts (id
  set, `tileMeters`, `tintable`, texture-set refs).

## graphify (knowledge graph)

`graphify-out/` holds a knowledge graph of this repo: every source symbol
and its imports/calls from AST extraction, plus the concepts and design
rationale extracted from CLAUDE.md, README.md, ROADMAP.md, TODO.md,
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
- Doc edits (this file, README, TODO, ROADMAP, HISTORY) are NOT picked up by
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
