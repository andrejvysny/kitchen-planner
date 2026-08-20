# TODO — active milestone only

Completed milestones live in HISTORY.md. The forward plan lives in ROADMAP.md.
Architecture, invariants and gotchas live in CLAUDE.md.

Green gate for every step (not just at the end of a milestone):

```bash
npm run lint && npm run typecheck && npm run test:unit && npm run build \
  && node test/interact.mjs && npx playwright test
```

`interact.mjs` needs `npx vite preview` on :4173 against a fresh `dist/`.

---

# M17 — UX review execution (active)

Plan: `~/.claude/plans/act-as-senior-software-vast-waffle.md`. Full UX review
done 2026-08-19 (findings in the plan). Decisions: both personas (progressive
disclosure), full scope, empty first run.

## Phase 0 — restore validation

- [x] 0.1 e2e fixture fix — `bootReady` no longer waits rooms>0; `resetDesign`
      seeds the 4x3 room via `addRoom()+commit()`. Suite RUNS again:
      72/84 green on first run; 12 failures are spec drift from the dead
      period (M13–M16 specs written blind) — repair in flight.
- [x] 0.2 `Ctrl+R` no longer swallowed — `mod: false` on both rotate rows
      (bindings.ts) + pinned test (keyboard.test.ts, 26 green).
- [x] 0.3 doc drift — CLAUDE.md `DESIGN_VERSION` 6→7 (two stale spots),
      README stale interact count.
- [x] 0.1b spec repairs landed — **85/85 Playwright**, interact 109/109,
      880 unit, lint clean, typecheck at the 8-error TS2531 baseline. Two
      product bugs the revived suite surfaced are FIXED: PropsBody now
      subscribes 'workspace' (stale room panel on tab switch), and
      'Wall colour…' is omitted in Plan (dead row — its #section-walls
      destination is Furnish-only).
- [x] 0.4 B1-equivalent acceptance walk run 2026-08-20 (WS-SPEC §9 doc not on
      disk; reconstructed: first-run tour → onboarded persistence → workspace
      round-trip by keys → wall-tool drag-rect room → catalog place +
      undo/redo → ? cheatsheet → 3D + day/night → Output CSV download).
      **19/19 PASS, no page errors**; screenshots reviewed. Phase 2 of the
      WS redesign is CLOSED. Noted, pre-existing: the Output workspace's
      props panel falls back to the Plan room-section list
      (WORKSPACE_ROOM_SECTIONS has no 'output' key).

## Phase 1 — quick wins

- [x] 1.1 empty first run — boot `emptyDesign()`, `store.loadDemo()` behind
      the starter card's "Load sample design", FurnishNudge persists per tab
      (NUDGE_KEY, sessionStorage). interact checks 31-35 re-seed the demo via
      loadDemo(); recovery fallback is empty too.
- [x] 1.2 one export manifest — `EXPORT_DOCS` in exportActions.ts; Topbar menu
      + Output cards render from it; label-parity e2e test added.
- [x] 1.3 terminology — wall "Thickness" everywhere user-facing;
      "Edit/Customize in Workshop…"; Mode2dToggle says "Floor plan".
- [x] 1.4 app-modal confirms — dialogService + <ConfirmHost/> (#app-dialog,
      capture-phase Escape/Enter); New / delete room / studio revert+delete;
      calibrate promptValue takes expressions via parseLength. One deliberate
      native survivor: Part Studio close-dirty guard (sync switchWorkspace
      contract; WP 3.1 deletes it). Gates: 888 unit, interact 109/109,
      Playwright 89/89.

**Phase 1 shipped.**
- [x] 1.5 hint severity (info|success|error) + persistent "Reference photo is
      NOT saved" warning + export failures console.error the real error.
- [x] 1.6 draw-tool discoverability — chip names Shift/Alt, DrawHud ⟂ lock
      glyph, 4th coach mark points at ?, guide grammar rows in cheatsheet.
- [x] 1.7 cosmetics — zone-canvas footer ellipsizes (canvas.title fallback),
      "Room wall colour…"; #wsp-back was already fixed in ws1.9 (stale note).

Bugs fixed along the way (found by the revived suite): PropsBody subscribes
'workspace' (stale room panel on tab switch); 'Room wall colour…' omitted in
Plan (dead row).

## Phase 2 — core flow

- [x] 2.1 3D drag-to-move the selected item (shared snapMoveItem path with the
      gizmo; orbit only from unselected/empty; e2e/3d-move.spec.ts).
- [x] 2.2 hidden-gesture hints — stack cycling shown only when stacked,
      "Mounted on <host>" naming, post-place fine-drag hint.
- [x] 2.3 zone-canvas dblclick = drill-in only; dividers select, ≡ Equalize on
      the toolbar.

**Phase 2 shipped.** Gates: 890 unit · interact 109/109 · Playwright 92/92.

## Phase 3+4 — Workshop maturation + materials

See WS Phase 3/4 sections below (WP 3.1–3.4, 4.1–4.3) — unchanged, executed
after Phase 2 per the plan.

---

# M11 — Close the React migration seam + editor-core skeleton

Plan: `~/.claude/plans/act-as-senior-software-distributed-church.md`

The React migration is done as a migration; what was left were three seams that
would only get more expensive once new editor services existed: a
bootstrap↔ui.ts module cycle, two pieces of DOM the bootstrap built by hand, and
eight keyboard behaviours with no names.

- [x] T0 baseline re-verified on the merge commit: lint · typecheck · 592 unit ·
      build · interact **104/104, ERRORS: none**.
- [x] T1 `src/editor/commands/` — `CommandRegistry` (unknown id = no-op
      returning false, never a throw) + 16 seed commands lifted verbatim from
      the keyboard map. `Plan2D`/`PartStudio` enter as the structural
      `PlanToolPort`/`ModalPort` declared in `src/editor`, which is what breaks
      the cycle by inversion. `test/unit/editor/commands.test.ts` (20 tests).
- [x] T2 `src/editor/keyboard/` — the key map as DATA (`bindings.ts`, pure and
      DOM-free) plus `KeyboardController`, an `attach`/`dispose` adapter.
      `preventDefault` now follows one rule (`registry.execute` returned true)
      instead of eight guards. `test/unit/editor/keyboard.test.ts` (13 tests).
- [x] T3 `src/ui/ui.ts` and `mountLegacyUI()` DELETED. Recovery banner →
      `<RecoveryBanner/>`; `#wall-label` → a `shellState` field rendered by
      `<WallNav/>`. bootstrap creates no DOM at all. `e2e/recovery.spec.ts`.
- [x] T4 `AppServices` — `src/app/services.ts` `createServices()` +
      `src/ui/react/services.tsx` provider/hooks. All 28 direct bootstrap
      imports rewritten; `App.tsx` is the only one left and an eslint
      `no-restricted-imports` rule keeps it that way.
- [x] T5 Phase C contracts, TYPES ONLY: `src/editor/input/types.ts`
      (`PointerInput`/`KeyInput`, no DOM), `src/editor/tools/Tool.ts`
      (`Tool`/`ToolContext`/`ToolResult`), `src/editor/README.md` with the M12
      migration order. No `ToolManager` — it lands with the first real tool.
- [x] T6 `units.ts`: a dimensioned expression may no longer come out
      dimensionless. `1m / 2m` is a ratio, so `parseLength` rejects it instead
      of reading 0.5 as 0.5 mm; bare `600-18*2` is unchanged.
- [x] T7 docs restructured: HISTORY.md (M1–M10), ROADMAP.md (replaces the stale
      NEXT_STEPS.md), TODO.md active-only, CLAUDE.md updated.

Cycle-end gates: lint · typecheck · **630 unit** · build · interact
**104/104** · Playwright specs.

## Known, deliberately unchanged

`Ctrl+R` rotates the selected item and swallows the browser's reload, because
the old listener's `r` branch never checked for a modifier. M11 preserved
behaviour byte-for-byte, so the binding table reproduces it. Worth a decision
of its own — the fix is one `mod: false` in `KEY_BINDINGS`.

---

# WS — Workspace redesign (WS-SPEC, Phases 1–4)

Plan: `~/.claude/plans/act-as-senior-software-glowing-seahorse.md`

Four task-focused workspaces — Plan · Furnish · Workshop · Output — as filters +
toolsets (never locks). One commit per WP on master (`ws1.3: …` style); the
green gate above runs per WP.

## Phase 1 — shell + navigation

- [x] WP 1.1 `workspaceState` module + `'workspace'` bridge channel + storageKeys TODO
- [x] WP 1.2 workspace tabs in topbar + `workspace.*` commands + `1`–`4` keys
- [x] WP 1.3 catalog filtering by workspace + search
- [x] WP 1.4 tool scoping per workspace
- [x] WP 1.5 sidebar per workspace (WorkshopPartsPanel / output caption)
- [x] WP 1.6 hosted Part Studio (WorkshopPane) + caption fix
      (follow-up noted: openInWorkshop skips setTool('select')/drawer close;
      declined re-open confirm leaves workshopTarget naming the other part)
- [x] WP 1.7 topbar slimming + settings menu + canvas overlays
- [x] WP 1.8 output pane (six export cards)
- [x] WP 1.9 test + docs migration sweep; Phase 1 exit criteria walk —
      `window.__kp` gains `workspace`/`setWorkspace` (the GUARDED switch) +
      e2e/kp.d.ts; interact and tools.spec assert the seam; screenshot.mjs
      gains one shot per workspace; README workflow rewritten around the four
      workspaces, CLAUDE.md gains the workspace-shell contract and drops the
      "Part Studio is a modal" / topbar-owns-view-and-scene claims.

**Phase 1 shipped.** - [x] S9 (follow-up, from a second report) two defects the first pass missed:
      reading 2 needed **Enter** — landing the last corner on the host wall now
      commits on the click; and a chain whose ends sat on the wall's SEGMENT
      ends rather than its mitred corners built a room that shared NOTHING,
      because the inset shortens the shared edge by `half` at each end and the
      weld can neither fold (`SHARE_EPS`) nor cut (`MIN_SEAM`) that gap.
      `snapRingToNeighbours(rooms, face, half)` closes it on the FACE ring,
      where both rings live; the drawn chain is never moved, since nudging an
      end shears the segment attached to it.

- [x] S10 (third report) **only the first room was ever detected.** The ring
      walk in `closeChainAgainstWalls` could close a chain against the SINGLE
      room it started and ended on, so from the third room on — where the two
      ends land on two DIFFERENT rooms — a closed region committed as free
      walls. Replaced by `src/model/faces.ts` `planarFaces`, a planar
      subdivision of every centreline: cut at every crossing, faces traced by
      the next-edge-clockwise rule, take the face the chain bounds. Built from
      the MITRED rings (butt-ended segments miss each other at a corner by half
      a thickness, so no face closes). Handles two rooms, free chains,
      T-junctions and mid-wall ends alike. `test/unit/faces.test.ts`.
- [x] S11 `store.alignWallsToCentreline(ids)` — promote as a BATCH. Promoting
      one at a time refused every corner anchoring a partition, which is
      exactly the corner a third room lands on, so its whole bottom edge came
      out doubled. Two gates replace the blanket refusal: one move per corner,
      and a wall nobody promoted may change length at a moved corner but never
      direction (that is what stops a propagated move tilting a neighbour).
- [x] S12 UX — the tool STAYS ARMED after a commit (`finishGesture`), so a run
      of rooms is one continuous gesture instead of a toolbar trip each; and
      `DrawHudState.outcome` puts `⏎ room` / `⏎ split` / `⏎ walls` at the
      CURSOR, where the status bar's version of it was never going to be read.
      The outcome is cached per vertex, not recomputed per pointermove.

Gate: lint · typecheck · **657 unit** · build · interact
**106/106** (was 104 — two workspace-state assertions added) · **51/51
Playwright** (layout.spec's topbar-height check passed here too) · exit-criteria
walk **34/34**, no console errors. Known cosmetic follow-ups, both out of WP 1.9's
scope: `#wsp-back` inherits `.btn { flex: 1 }` and stretches across the Workshop
pane head, and the zone canvas' footer caption is clipped at the pane's width.

## Phase 2 — discoverability + onboarding

- [x] WP 2.1 context menu (plan + 3D) + pure `contextMenuModel`
      (`Plan2D.hitAt` / `View3D.pickItem` façades; no per-item "Open fronts"
      entry — `store.openFronts` has no per-ITEM toggle to call)
- [x] WP 2.2 cursor hint chip (`HintChip.tsx`, rAF-positioned, no re-render per
      pointermove; 2D covers every armed tool, 3D only `place`)
- [x] WP 2.3 hover affordances in the plan (renderPlan paint-only, redraw
      requested only while over a handle)
- [x] WP 2.4 empty states — plan starter card (pristine-design trigger; the
      spec's no-rooms one is unreachable), furnish nudge, workshop caption
- [x] WP 2.5 coach marks + shortcuts cheatsheet — committed on a fast gate
      only (tsc · typecheck · lint · 687 unit); the browser gates (interact +
      full Playwright) were NOT re-run after the implementing agent was
      interrupted — see the handoff below — `ONBOARDED_KEY` +
      `src/ui/onboarded.ts`; `firstRun` decided in `createServices()` (no
      second storage parse, and never together with the recovery banner) and
      forcing `setWorkspace('plan')` before React mounts; `<CoachMarks/>`
      three dismiss-anywhere bubbles over `#ws-tabs`/`#catalog`/`#props`;
      `src/ui/shortcuts.ts` as the one gesture list behind `<Cheatsheet/>`,
      raised by `?` (`help.shortcuts` + `HelpPort`) or ⚙ → *Shortcuts…*, both
      overlays owning Escape in the capture phase. Every suite seeds
      ONBOARDED_KEY at page init — a cleared profile is a first run.

**Phase 2 status:** WPs 2.1–2.5 fully gated and committed. WP 2.5's browser
gates were re-verified 2026-08-18 (post render-pipeline merge): interact
106/106, Playwright 77/77 — the four longest coach-marks/cheatsheet walks
needed `test.slow()` (they blow the 60s budget under full-suite parallelism on
SwiftShader; solo runs always passed, no product bug). B1 walk (§9) still to
run by hand.

## HANDOFF — continuing in a new session

State at handoff (2026-08-18): everything through WP 2.5 is committed on
master (`ws1.1`…`ws2.5`). No branch, no uncommitted work.

Read first: this file, `~/.claude/plans/act-as-senior-software-glowing-seahorse.md`
(the execution plan: per-WP designs, decided semantics D1–D5, verified anchors),
and CLAUDE.md's workspace-shell section.

Next tasks, in order:

1. **Verify WP 2.5's browser gates** — `npm run build`, serve dist on :4173
   (`nohup npx vite preview --port 4173 &` — the server dies between shells),
   `node test/interact.mjs` (expect 106/106, ERRORS: none), `npx playwright
   test --workers=3` (expect all green; layout.spec's topbar-height check can
   fail machine-locally under Apple Color Emoji — that one failure is known).
   Fix anything red before Phase 3; amend the ws2.5 commit message claim if
   numbers differ.
2. **Run the B1 acceptance walk by hand** (WS-SPEC §9, eight steps) and record
   the result here — it closes Phase 2.
3. ~~**WP 3.1 live-apply**~~ — DONE. `store.updateCustomPart` /
   `materializePart` / `discardPristineShadow`; the studio's `part` IS the
   resident def and every field writes through it; Save / Revert / dirty guard /
   `originalJson` / the `switchWorkspace` abort path and the app's LAST native
   `confirm()` are gone. D2 resolved by removing the modal gate outright
   (`KeyBinding.allowInModal` and `KeyboardOptions.modalOpen` deleted) and
   moving what it protected into an `onCanvas` precondition on the commands that
   edit an invisible selection/ring — undo/redo excluded, deliberately.
   `PartStudio.close()` is the discard-if-pristine choke point. Tests:
   test/unit/livePart.test.ts + e2e/live-apply.spec.ts.
4. **WP 3.2 scope header** — pure instance-count helper in `src/model/` +
   `Fork for this item only` via `store.forkPartForItem` (store.ts ~L1094).
5. **WP 3.3 Simple/Advanced split** — studio form column sub-tabs, session
   module flag; hidden for board/freeform parts.
6. **WP 3.4 front-layout presets** — `src/model/faceLayouts.ts`, 8 canned zone
   trees built with zones.ts constructors, normalize + caps unit test,
   Simple-tab tile row with replace-confirm on customized trees.
7. **Phase 4 materials** — WP 4.1 `materialInfo.ts` + palette-coverage test,
   WP 4.2 swatch names/captions/group headers, WP 4.3 Variables→Materials
   panel copy (read what "Apply to all fronts" really does before labelling).

Known small follow-ups (not blocking): `openInWorkshop` skips
`setTool('select')`/drawer close (WP 1.6 note above); a declined same-studio
re-open confirm leaves `workshopTarget` naming the other part; the zone canvas'
footer caption clips at narrow pane widths; right-drag pans behind an open
context menu (flagged in ws2.1, left as-is deliberately).

Session conventions that carried the work so far: one WP = one commit on
master; every WP delegated with a full brief (GOAL/CONTEXT with file:line
anchors/DESIGN/CONSTRAINTS/VERIFY/REPORT) and reviewed via `git diff` + a
re-run gate before committing; subagent briefs must mention the graphify
PreToolUse hook (project tooling, not an attack) and that suites seed
`ONBOARDED_KEY` at page init so a cleared profile means first-run coach marks.

## Phase 3 — workshop maturation

- [x] WP 3.1 live-apply (`store.updateCustomPart`, guard deletion, discard-if-pristine)
- [x] WP 3.2 scope header — `instancesOf` (partUsage.ts), live scope line,
      "Fork for this item only" gated on the target still holding the def.
- [x] WP 3.3 Simple / Advanced split — session `studioTab` flag, sections
      declare their tab at the render site, zone canvas Advanced-only.
- [x] WP 3.4 front-layout presets — `faceLayouts.ts` (8 normalize-stable
      trees), schematic tiles, replace-confirm on customized trees.

**Phase 3 shipped.** Gates: 938 unit · interact 109/109 · Playwright 103/103.

## Phase 4 — materials

- [ ] WP 4.1 material metadata (`materialInfo.ts`) + coverage test
- [ ] WP 4.2 swatch-row names, captions, group headers
- [ ] WP 4.3 Materials panel (label + bind/apply copy)

---

# M12 — Editor core (next)

See ROADMAP.md. In short: `ToolManager` + `InputRouter` land together with
`MeasureTool`, then Calibrate → DrawRoom → AddRoom → Place → **Select last**.
Nothing starts until the M11 gates are green on CI.

---

# M13 — Unified centreline wall tool

Plan: `~/.claude/plans/smooth-tumbling-spring.md`

One `✎ Wall` tool replaces `room` + `drawRoom`: drag a rectangle or click
corner by corner, in **wall-centreline** space, with real wall bodies in the
preview, 15° Shift lock, type-in segment length and per-wall width.

The model invariant is untouched — `Room.corners` stays the room-side wall
FACE. The tool converts its centreline ring to a face ring on close via
`insetPolygon` (now per-edge), which is the same function that derives
centreline junctions back out of a committed room.

- [x] S1 `insetPolygon` per-edge + `wallCentrelines` / `snapPointToCentrelines`
- [x] S2 `Room.wallWidths` per-wall override (model + store + WallProps)
- [x] S3 Plan2D unified tool (centreline ring, drag-rect, angle lock, type-in)
- [x] S4 renderPlan wall-body preview + centreline handles (+ hitCorner parity)
- [x] S5 UI surface collapse (toolbar / props / context menu / empty state) + commands
- [x] S6 test sweep — units 784 green, `interact.mjs` 108/108
- [x] S7 angle snap ON by default (Shift inverts) + right-angle markers + `#btn-angle-snap`
- [x] S8 `faceRingPlan` + `alignWallToCentreline`: a drawn edge on a neighbour's
      centreline becomes a real partition, host interior unchanged, no stubs
- [x] S9 `DEFAULT_WALL_W` 0.115 (golden manifest regenerated deliberately)
- [x] S10 PDF reference import + page picker (`pdfjs-dist`, dynamic chunk)
- [x] S11 import UX: underlay over the grid, starter card hides, roomless
      inspector shows the reference section, auto-frame + auto-arm calibrate

**Blocked, pre-existing (NOT from M13):** `npm run test:e2e` cannot run at all —
`e2e/fixtures.ts` `bootReady` waits for `rooms.length > 0` but `#btn-new` has
produced a ZERO-room design since `baba3e7` ("zero-room New flow"), so every spec
using the `app` fixture times out in setup. Verified by stashing M13 entirely and
running `e2e/dom-contract.spec.ts` on the clean tree: same failure. The e2e specs
in this change (including the new `e2e/pdf-import.spec.ts`) are written and
typecheck, but cannot be executed until that fixture is reconciled with the
zero-room flow. `test/interact.mjs` is unaffected and green.

---

# M14 — open wall chains + free-standing walls

A floor plan is redrawn wall by wall, not loop by loop. Today `Room[]` closed
rings are the ONLY source of walls, so adding a room next to an existing one
means re-drawing walls that are already there, and a divider or corner stub
cannot be drawn at all.

Two additions, decided with the user:

1. **A chain that touches existing walls closes against them.** Start and/or
   end on an existing wall and the tool completes the loop along the existing
   geometry — across one room it SPLITS it (BOTH halves become new rooms), off
   a room's outer face it creates a neighbour reusing that wall.
2. **A chain that closes against nothing commits as FREE WALLS** — dividers,
   peninsulas, corner stubs. New `design.walls` entity; `store.allWalls()` is
   the single choke point every renderer already goes through, so slabs and
   `wallJoints` pick them up for free.

- [x] W1 `FreeWall` model + `design.walls`, sanitize, DESIGN_VERSION 7 (+ v6→v7)
- [x] W2 `store.allWalls()` emits free walls; `wallById`, plan slabs, 3D slabs
- [x] W3 tool: open chain → free walls (Enter / double-click commits)
- [x] W4 tool: chain across a room → `splitRoomByChain` cuts it, both halves new
- [x] W5 dimension flow — already satisfied: committing a room disarms the tool
      and selects nothing, so the room panel's Width/Depth/Ceiling are right
      there to type into before drawing the next one
- [x] W6 free walls are first-class: selectable, per-segment width, Delete,
      their own inspector panel, corners draggable, undo/redo

Deferred (not blocking, say so before assuming they work): a free chain has no
elevation-view entry and no per-wall visibility override (it belongs to no room,
so there is nothing to override); splitting a segment of a free chain (the
"add corner in the middle" action) is room-walls only.

---

# M15 — CAD drawing guides + unified snap engine

Plan: `~/.claude/plans/now-detaily-plan-implementation-rippling-rose.md`

The wall tool draws in centreline space and snaps well enough, but it does not
behave like a CAD sketcher. Four defects, all structural rather than cosmetic:

1. `snapDrawPoint` returns a bare `Point` — the snap's identity is discarded, so
   no cursor glyph is possible and "landed on the neighbour's corner" looks
   exactly like "landed 4 mm off on the grid".
2. Alignment inference is two vertices deep and chain-local (previous vertex +
   ring start). No inference to other chain vertices, to existing corners, or
   along any direction but world x/y.
3. Snap reach is in WORLD units (`ROOM_CORNER_SNAP` 0.15 m), so it grows into an
   inescapable magnet as you zoom in. `measureSnap` next door already does it in
   screen px — one tool, two policies.
4. Four snap implementations with three tolerance policies; corner-drag still
   snaps to the FACE ring, the exact mismatch the centreline rewrite existed to
   remove.

One pure engine (`src/model/snap/`) returning point + kind + guides, called by
every plan gesture. Screen-px reach with a max-world clamp, scored candidates, a
two-tier point/line resolve so two constraints can intersect, guides capped at 3.

- [x] P-1 finish the half-applied `freeWalls` thread (`centrelineAxisLines` /
      `snapRectSides`) so the drag-rectangle sees free chains
- [x] P0 `src/model/snap/` engine + `lineIntersection` + `snapEngine.test.ts`
      (no call sites rewired — zero behaviour change)
- [x] P1 rewire `snapDrawPoint`; `Guide.kind`; per-kind guide styling;
      `drawSnapMarker` cursor glyph
- [x] P2 length/angle HUD — `src/ui/drawHud.ts`, `'draw'` bridge channel,
      `<DrawHud/>`, `draw.toggleField` on Tab; typed angle is RELATIVE to the
      previous segment, the 15° lock stays absolute world
- [x] P3 `EditorState.snapGrid` + `#btn-grid-step`; grid becomes the lowest
      priority fallback; the four hardcoded `Math.round(v*20)/20` sites go
- [x] P4 Alt suppresses snapping (pointer modifier + window keydown/keyup, not a
      keybinding) + cheatsheet entry
- [x] P5 rewire `measureSnap`; `rectRing` gets screen-px reach, free walls and
      guides
- [x] P6 corner-drag in centreline space via `cornerHandlePositions`, fixing the
      draw/edit mismatch

Out of scope: `snapItem` (item placement — OBB edge-to-edge is a different
problem) and persistent constraints (needs a solver and a DESIGN_VERSION bump).

---

# M16 — the wall tool actually closes, and merges instead of doubling

Plan: `~/.claude/plans/do-thorough-analysis-of-cozy-mango.md`

Reported from a real session: a room drawn beside an existing one would not
close, `Esc` then threw the whole chain away, and what finally committed came
out as two parallel wall slabs with one wall visibly skewed. Six distinct
defects behind those three symptoms, four of them in pure model code.

- [x] S1 `edgeCentrelineHits` — the shared-edge test becomes an OVERLAP test
      (both endpoints within tol, shared stretch ≥ `MIN_SEAM`) returning EVERY
      collinear wall and seeing free chains. The midpoint test it replaces
      missed an edge longer than the wall it ran along, and could only ever
      report one of two stacked rooms. `faceRingPlan` gains `edgeWalls`.
- [x] S2 `commitRing` honours `alignWallToCentreline`'s refusal — an edge whose
      walls all refused falls back to `half` instead of keeping a 0 offset that
      puts it t/2 off the neighbour's face ring with no weld able to close it.
- [x] S3 `regularizeDrawnRing` + `REGULARIZE_TOL` (20 mm) — collapse the stub a
      ring closed by Enter leaves (the skewed wall), then snap a near-miss edge
      exactly onto the centreline it was aimed at, so the 1 mm coincidence
      everything downstream demands can actually fire.
- [x] S4 `closeChainAgainstWalls` — a chain whose two ends land on one room's
      walls closes along that geometry into a neighbour REUSING the wall. This
      is the half of M14 item 1 that never shipped; `closeDrawRoom` now reads a
      chain four ways and `finishOpen` (double-click, `Shift+Enter`) forces the
      open one.
- [x] S5 `close` (120) and `junction` (105) snap kinds — the ring's own first
      vertex and the mitred centreline corner, both outranking `endpoint`, both
      with their own glyph. The junction is the root fix: a wall's segment ends
      sit t/2 off along either axis, so the point a neighbour's ring corner
      belongs on was never offered. Close is also checked before the
      typed-dimension branch, which used to switch snapping off entirely.
- [x] S6 `Esc` / `Backspace` step the ring back ONE corner (`draw.undoVertex`,
      `drawBufferActive` splitting the two Backspace meanings).
- [x] S7 the in-flight ring previews which edges will MERGE (`DrawRing
      .sharedEdges`), and the status hint names which of the four readings
      Enter would take.
- [x] S8 `parallelWalls` check — two slabs running along each other within one
      thickness that the model did not merge. The tool's one remaining silent
      failure, made visible.

- [x] S9 (follow-up, from a second report) two defects the first pass missed:
      reading 2 needed **Enter** — landing the last corner on the host wall now
      commits on the click; and a chain whose ends sat on the wall's SEGMENT
      ends rather than its mitred corners built a room that shared NOTHING,
      because the inset shortens the shared edge by `half` at each end and the
      weld can neither fold (`SHARE_EPS`) nor cut (`MIN_SEAM`) that gap.
      `snapRingToNeighbours(rooms, face, half)` closes it on the FACE ring,
      where both rings live; the drawn chain is never moved, since nudging an
      end shears the segment attached to it.

- [x] S10 (third report) **only the first room was ever detected.** The ring
      walk in `closeChainAgainstWalls` could close a chain against the SINGLE
      room it started and ended on, so from the third room on — where the two
      ends land on two DIFFERENT rooms — a closed region committed as free
      walls. Replaced by `src/model/faces.ts` `planarFaces`, a planar
      subdivision of every centreline: cut at every crossing, faces traced by
      the next-edge-clockwise rule, take the face the chain bounds. Built from
      the MITRED rings (butt-ended segments miss each other at a corner by half
      a thickness, so no face closes). Handles two rooms, free chains,
      T-junctions and mid-wall ends alike. `test/unit/faces.test.ts`.
- [x] S11 `store.alignWallsToCentreline(ids)` — promote as a BATCH. Promoting
      one at a time refused every corner anchoring a partition, which is
      exactly the corner a third room lands on, so its whole bottom edge came
      out doubled. Two gates replace the blanket refusal: one move per corner,
      and a wall nobody promoted may change length at a moved corner but never
      direction (that is what stops a propagated move tilting a neighbour).
- [x] S12 UX — the tool STAYS ARMED after a commit (`finishGesture`), so a run
      of rooms is one continuous gesture instead of a toolbar trip each; and
      `DrawHudState.outcome` puts `⏎ room` / `⏎ split` / `⏎ walls` at the
      CURSOR, where the status bar's version of it was never going to be read.
      The outcome is cached per vertex, not recomputed per pointermove.

Gate: lint · typecheck (the 8 pre-existing `TS2531`s in context-menu.spec,
inspector.spec and model.test are unchanged from master) · **879 unit** ·
build · `interact.mjs` **109/109, ERRORS: none**.

## Known limit, deliberately not fixed

An exterior wall whose ends anchor another partition cannot be promoted
(`alignWallToCentreline` refuses, and rightly — moving either corner un-shares
the seam it holds). There is then no offset that makes a third room share it
either, because sharing needs the HOST's ring to move. That case commits as
coincident slabs and is REPORTED by `parallelWalls` rather than fixed; fixing it
means splitting the host wall at the contact first, which is a bigger change.

Playwright (`npm run test:e2e`) is still blocked by the pre-existing
`e2e/fixtures.ts` `bootReady` mismatch with the zero-room `#btn-new` flow, so
`e2e/tools.spec.ts`'s updated Escape walk is written and typechecked but not
executed.
