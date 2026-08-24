# Roadmap

Where the product is going, in the order it should be built. Replaces the old
NEXT_STEPS.md, whose tier list had drifted out of date (it still described flat
colours and procedural textures as future work; both shipped).

Completed milestone logs: HISTORY.md. Active milestone: TODO.md. Architecture,
invariants and gotchas: CLAUDE.md.

**Two numbering schemes, deliberately not merged.** The M-numbers BELOW are
planned tiers, in build order. The M-numbers in TODO.md/HISTORY.md are the
chronological sequence of what was actually built, and they were already out of
step before this note (TODO's M17 was the UX review, not this file's
"Organization UX"). When the two meet, the mapping is written down: the
selection system is **planned M13, delivered as TODO's M18**.

The through-line: **precision first → furniture → persistence → domain
breadth.** Professional precision features are the thing every later feature
leans on, and they need editor abstractions the app did not have while the UI
was one imperative controller. That is why the React migration came first and
why the editor core comes next — not because the UI framework was the point.

---

## Where things stand

| Area | State |
| --- | --- |
| React/UI architecture | Done as a migration. React owns every element in the shell. |
| View lifecycle | `attach`/`detach`/`dispose` on all three views; `e2e/lifecycle.spec.ts` is the leak gate. |
| Editor infrastructure | Tool state + commands + key map exist; tools, input routing and snapping do not. |
| Test infrastructure | Two complementary layers: `test/interact.mjs` (broad) and `e2e/*.spec.ts` (isolated, architectural). |
| Numeric input | Expressions + mm through `units.ts`, in the inspector and the Part Studio. Canvas labels still cm. |
| Multi-selection | **Done (M18).** `EntityRef[]` on `EditorState`; items-only sets, primary-snapped moves, marquee, multi-edit inspector. |
| Snapping | Fixed world-space tolerances inside one item-specific `snapItem()`. Unchanged since the prototype. |
| Dimensions / constraints | Absent. |
| Furniture | Zone-tree parts + panel-list IR — the strongest part of the model. |
| Persistence | localStorage + whole-design JSON snapshots. Fine for now. |

---

## M12 — Editor core

`ToolManager` and `InputRouter` land WITH the first tool that exercises them,
not before. Contracts already exist (`src/editor/tools/Tool.ts`,
`src/editor/input/types.ts`).

Extraction order, easiest first, and **Select last** — it carries stacked-item
cycling, corners, walls, openings, the rotate handle, underlay hit-testing,
splitting and pan fallthrough, so freezing the abstraction around it first
would be a mistake:

```
Measure → Calibrate → DrawRoom → AddRoom → Place → Select
```

Undo stays snapshot-based throughout. Command-shaped history is a separate
decision, taken only if project size makes snapshots hurt.

## M13 — Selection system — SHIPPED (as TODO's M18)

Delivered 2026-08-24, with three deliberate differences from the sketch below:

- selection lives on `EditorState`, not in a new module, and `store.selection`
  is GONE rather than kept as a projection — `editor.selection` projects the
  primary in the same single shape, so the call sites did not change;
- a multi-selection is **items-only** (a wall/corner/opening replaces), which
  is why `'room'` never became an `EntityRef` kind — `store.activeRoomId`
  already means "the room edits target";
- marquee is **window-select** (fully enclosed), on a left-drag over empty
  floor; pan moved to the middle and right buttons, except under a finger.

Multi-move snaps the PRIMARY and applies its delta to the rest, exactly as
sketched. `useMixedValue` was reused, not redesigned. See CLAUDE.md's selection
contract and `src/editor/selection.ts` / `selectionOps.ts` / `selectionSync.ts`.

## M14 — Precision editor v1

A real `SnapEngine` producing ranked candidates, replacing the fixed tolerances
inside `snapItem()`:

```
grid · endpoint · midpoint · center · edge · wall · wall projection
horizontal / vertical alignment · intersection · parallel · perpendicular
```

- **Screen-space tolerances.** The measure tool already does this right
  (`hitRadius(11) / zoom`); everything else should. Roughly: candidate visible
  at ~12 px, strong snap at ~7 px, world distance derived from the viewport.
- **Visible inference.** Show WHY something snapped — endpoint dot, midpoint
  triangle, alignment guide, perpendicular mark. A user should never wonder why
  the cabinet jumped.
- **Modifiers**, defined once and early because they become muscle memory:
  Shift locks the current inference, Alt suspends snapping, arrows lock an axis.
- **Gesture-time numeric input** — an editor-level `NumericInputSession`, not
  per-tool logic: move → type `600` → Enter. Same for rotate and wall drawing.
  The status bar shows the live value.

## M15 — Stable topology + persistent dimensions

Walls are identified by their START CORNER id today. That holds while nothing
persists a reference to a wall; it stops holding the moment dimensions,
constraints, electrical devices or annotations do.

Design **v7**: give each room an `edges: RoomEdge[]` parallel to `corners`,
with `edge[i]` joining `corner[i] → corner[(i+1) % n]`. Wall identity then stops
depending on corner identity. The migration remaps `Opening.wallId` and
`Room.wallVisibility`.

Topology rules must be WRITTEN DOWN and unit-tested before the code:

- split `A—B` at `C` → `A→C` keeps the old id, `C→B` gets a new one;
- merge by deleting `C` → `A→C`'s id survives deterministically;
- duplicate room → all corner, edge and room ids are new;
- shared partitions keep two ids, related through the existing twin detection.

Then dimensions as document entities, anchored SEMANTICALLY (`corner`,
`wallEndpoint`, `wallPoint(t)`, `itemFeature`, `openingFeature`, `free`) so
they follow geometry instead of floating at coordinates. Driving dimensions
stay deliberately narrow in v1: wall length, item w/d/h, opening width and
offset, object↔wall distance. An arbitrary diagonal stays reference-only, and
the UI distinguishes the two.

## M16 — Constraints

A small fixed set, solved locally — no general sketcher, no tangent solver, no
whole-apartment solve when one cabinet moves:

```
horizontal · vertical · parallel · perpendicular · fixed length
aligned X · aligned Y · fixed position
```

Results are explicit (`SOLVED` / `CONFLICT` / `UNSOLVABLE`) and a constraint
never disappears silently.

## M17 — Organization UX

Three distinct concepts, deliberately not merged into one "group" object:

- **Folder** — organizational only;
- **Group** — a logical transform/selection unit;
- **Layer** — visibility and locking.

`src/ui/outlineModel.ts` is the pure seed for the hierarchy tree. Align and
distribute land here too, as editor commands, not React button handlers.

## M18 — Furniture engine v2

Typed parameters, a safe formula engine (the `units.ts` parser generalizes),
a dependency graph, reusable and nested subassemblies — **preserving the panel
IR**, which stays the geometric truth for both the renderer and the BOM.

## M19 — Project system

A `ProjectRepository` (list / load / save) behind IndexedDB in the browser and
whatever fits a desktop host later, plus a project browser and design variants
(A/B/C). Only then does Store's direct ownership of the Design need revisiting.

## M20 — Materials + assets

User texture uploads wait for an asset repository: texture bytes must never
enter the Design, which is JSON-cloned per undo step and per autosave — the same
rule the tracing photo already follows (`UNDERLAY_KEY`).

Partly shipped by the render pipeline (milestone 1): every material is stamped
with a semantic `kp:` name at creation (`src/model/materialName.ts`, mirrored
by `render/worker/kprender/matnames.py`) — the render worker reads it to
rebuild real OpenPBR materials, and the manual Blender workflow gets one name
per material instead of GLTFExporter's per-instance defaults.
`KHR_lights_punctual` in the plain `.glb` export remains open. The pipeline's
own backlog: `render/NEXT_STEPS.md`.

## M21+ — Domain breadth

Real product catalogs and an import architecture (OBJ/STEP/SKP) · electrical
planning · lighting groups and lux estimates · room/building hardening
(corner cabinets in L/U runs, oblique wall joints, overlapping rooms).

---

## Known limitations (current)

- No corner/blind-corner cabinet PRESETS; the footprints exist, the catalog
  entries do not.
- Continuous worktops merge straight runs of rect-footprint units only; a run
  turning a corner still meets as two slabs.
- No collision PREVENTION — the checks engine warns, it never blocks an edit.
  That is by design.
- Real-time shadows are budgeted to 4 fixture lights (`SHADOW_LIGHT_BUDGET`).
- Two OVERLAPPING rooms whose walls cross mid-span share no corner, so they get
  no joint patch and still interpenetrate.
- Desktop-first. Both 2D views pinch-zoom and hit targets scale on coarse
  pointers, but the layout is not touch-optimized for small screens.
- No keyboard-only plan editing (a11y): placement, drag, resize and rotate are
  pointer-only. Known debt — the command registry is the natural home for the
  fix.
- Plan, elevation and Part Studio canvases still label in cm while the
  inspector is in mm; they draw their own text and were left alone deliberately.
