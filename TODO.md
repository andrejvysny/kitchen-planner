# M10 — Cycle 2: B3+B4+B5 as T1-T4 — COMPLETE

Reordered (tool state first) so every later port reads clean editor state.

- [x] T1 EditorState owns tool truth: Plan2D setters are delegates with entry
  resets + immediate repaint; one `syncFromEditor()` replaced
  `closeOtherTools` (mutual exclusion structural); `toolState()` shape
  unchanged; the 5 `onXChange` callbacks died; shellState unified the three
  `#status-hint` writers; ToolButtons/Mode2dToggle/WallNav/CatalogButton/
  StatusHint went React. `e2e/tools.spec.ts` + `test/unit/planTools.test.ts`.
- [x] T2 Sidebar owns tab state (active class AND hidden flip); VariablesPanel
  React with uncontrolled inputs committing via native `change` only — a lint
  rule bans React `onChange` on inputs under fields/ and props/. The shared
  field set (src/ui/react/fields/) born. `e2e/sidebar.spec.ts`.
- [x] T3 CatalogPanel/CatalogTile (memo per def, thumbnails in ref effects,
  arming via `plan.setArmed` for ghost reset + def identity) + OutlinePanel on
  pure `outlineModel.ts` (Rooms-first invariant unit-tested). PartStudio
  construction moved to bootstrap. Six screenshots byte-identical.
  `e2e/catalog-outline.spec.ts`.
- [x] T4 The whole inspector went React in five gated commits: room+photo+
  lighting → item (+`e2e/inspector.spec.ts` pinning every panel's shape) →
  wall/opening/corner + transient wiring (`useLiveValue`, ZERO inspector
  React renders mid-drag — `e2e/transient-perf.spec.ts`) → **the sanctioned
  mm-units commit** (fields are `type=text` expression inputs through
  units.ts; Part Studio dim rows flipped too; exactly 9 interact.mjs lines
  updated) → cleanup. `ui.ts` 1772 → **130 lines** (the keyboard map, now
  with `dispose()`). Zero length `*100`//100` under src/ui.
- Cycle-end gates: lint · typecheck · **592 unit** · build · interact
  **104/104** at 1× (and 6× on T1/T4) · **40/40 Playwright specs** ·
  screenshot diffs confined to the props panel's numeric column (cm→mm).
- Known split (documented in CLAUDE.md): canvas-drawn labels (plan, elevation,
  studio zone/polygon canvases) still render cm — they flip with the
  renderPlan units plumbing in Phase E.

Next: B6 (export dialogs polish + Part Studio rail panels + delete the
mountLegacyUI guard) is small and optional before Phase C (editor core:
ToolManager, CommandRegistry, InputRouter). See the plan file.

# M8 — Phase A: baseline lock — COMPLETE

Plan: ~/.claude/plans/act-as-senior-software-polished-blanket.md (supersedes
the M7 plan below; approved program: A baseline → B React shell → C editor
core → D multi-select → E precision → F stable edge ids + dimensions +
constraints → G UX overhaul). Gate every step: `npm run lint && npm run
typecheck && npm run test:unit && npm run build && node test/interact.mjs`
(104/104) and `npx playwright test`.

- [x] Baseline re-verified green before any change: lint · typecheck ·
  434 unit · build · interact **104/104, ERRORS: none**.
- [x] A1 `@playwright/test` enabled (see M0 below) — CI runs the spec suite
  on port 4174 after the interact step.
- [x] A2 `Store.on()` returns a disposer; emit dispatches over a snapshot;
  `test/unit/store-events.test.ts` (+5, 439 total).
- [x] A3 `attach(canvas)/detach()/dispose()` on Plan2D, ElevationView and
  View3D — AbortController-signal listeners, subscription disposers, rAF
  cancellation, renderer reuse on same-canvas re-attach (StrictMode-safe),
  detach marks rebuild-dirty and attach catches up. `Store.handlerCount()`
  test seam. `e2e/lifecycle.spec.ts` (3 tests) is the leak gate.
- [x] A4 Plan2D façade `viewport()/setViewport()/toolState()/overlayState()/
  debug()`; interact.mjs no longer touches a private field (pure rename,
  104/104 unchanged).
- [x] A5 sleep sweep: **129 → 1** `waitForTimeout` (the survivor is an
  annotated dblclick-folding pacing beat). New poll helpers `resetReady`/
  `flushView`/`waitForCameraSettled`; two waits became exact via
  `camera.updateMatrixWorld()`. Wall/ceiling-visibility waits now poll the
  mesh `.visible` flag (same frame-rate bug class as the M0 pose fix).
  Verified **104/104 at 1× and at 6× CPU throttle**.
- [x] A6 `e2e/dom-contract.spec.ts`: 12-phase tour, ~95 selector assertions
  pinning every id/class/data-attr both suites use — the gate every React
  step must keep green. e2e/*.ts brought under lint + typecheck.
- [x] Repo-wide prettier reflow landed as its own commit (41 files), all
  gates green after.
- [ ] Verify CI green via `workflow_dispatch` on this branch (deploy workflow
  triggers on master push; the branch run proves the new spec step).

# M9 — Phase B0-B2: React shell foundations — COMPLETE

- [x] B0a `src/model/units.ts` — mm-default expression parser (no eval,
  per-literal unit binding, dimensional discipline, caps) + `prefs.ts`
  ({unit, decimals} outside the Design). 105 tests incl. seeded fuzz.
- [x] B0b React 19 toolchain (matched @vitejs/plugin-react\@5, StrictMode on,
  NO React Compiler), boundary lint rules (model/editor/plan2d/view3d stay
  framework-free; innerHTML banned in src/ui/react), main.ts →
  `src/app/bootstrap.ts` + inert React root; `EditorState` v0;
  `StoreBridge` per-channel version counters (transient never bumps design).
  React runtime rides its own chunk (+60.6 kB gz accepted; app chunk +0.5 kB).
- [x] B1 React owns the DOM: index.html markup ported node-for-node into
  Topbar/Sidebar/Workspace/PropsPanel/StatusBar; controllers construct
  DETACHED (`new Plan2D(store, onHint)` etc.) and get canvases from mount
  effects; legacy UI mounts once from an App effect. Parity: layout ±0px,
  83-node DOM skeleton identical, screenshots byte-identical.
  `e2e/layout.spec.ts` pins the geometry.
- [x] B2 React owns topbar/status BEHAVIOR: view toggle, undo/redo,
  day/night, open fronts, nav input, file ops, export menu, zoom, camera
  presets, `#status-info` (pure `statusInfoText`), `#status-savefail`.
  Legacy-mutated elements (4 plan tools, 2d/elev sub-toggle, wall nav,
  catalog drawer, status hint) live in never-re-rendering memo fragments
  marked "B5 EXPIRY". ui.ts 2024 → 1772 lines.
- Gates at cycle end: lint · typecheck · **564 unit** · build · interact
  **104/104** · **9/9 Playwright specs** (dom-contract, layout ×2,
  lifecycle ×3, open-fronts ×3).

Next (cycle 2): B3 sidebar/variables → B4 catalog/outline → B5 tool-state →
EditorState + props inspector (selection-array-shaped fields on units.ts) →
B6 dialogs/studio shell → delete ui.ts. Then Phase C editor core. See the
plan file for full specs.

# M7 — Editor core foundations (superseded by the plan above)

Plan: ~/.claude/plans/act-as-senior-software-hashed-honey.md
Program: Cycle 1 (M0 CI · M1 editor core · M2 multi-selection · M3 React shell),
then precision → furniture v2 → project system → domain → manufacturing.
Gate every step: `npm run lint && npm run typecheck && npm run test:unit &&
npm run build && node test/interact.mjs` (104/104).

## M0 — green, non-flaky CI

- [x] Root cause found and fixed. The CI-only 102/104 (run 30851502876) was
  never an open-fronts logic bug: `stepFrontPoses` advanced `openT` by a fixed
  fraction PER RENDERED FRAME (`POSE_LERP` 0.18), so the pose needed 18-24
  frames and the tests' fixed `waitForTimeout(1200)` silently demanded 15-20
  fps sustained — which SwiftShader on a GPU-less runner cannot deliver.
  Now time-based: `POSE_RATE` 12 /s exponential smoothing
  (k = -60·ln(0.82) = 11.91, so 60 fps is visually byte-identical to before),
  `POSE_DT_MAX` 0.25 s clamp so a stalled loop cannot teleport a door, and a
  non-finite/zero dt advances nothing. `View3D.animate` threads the rAF
  timestamp; the clock resets whenever the loop is gated off.
- [x] `snapFrontPoses` + `setActive(true)` snap. Fronts toggled while the 3D
  pane was hidden owed a catch-up animation on reveal; the user never saw them
  closed, so they now appear already in their target pose.
- [x] `test/unit/poses.test.ts` (+8, 434 total): 12 × 1/60 s == 1 × 12/60 s,
  same TIME reaches the same pose at any frame budget, dt clamp, NaN/0 dt,
  settle-and-stop, slide units, snap, and `withClosedPoses` restore.
- [x] E2E: `waitUntil` / `waitForPose` / `bootReady` / `studioReady` /
  `studioClosed` poll helpers replace 27 fixed sleeps (158 → 131), incl. all 5
  `page.reload` boot waits and every Part Studio open/save wait.
- [x] `KP_CPU_THROTTLE=<n>` reproduces CI locally via CDP
  `Emulation.setCPUThrottlingRate`. Measured: at 20× only **8 frames** render
  in the old 1200 ms budget (old code needed 18-24) and the pose still settles
  to `openT` 1.0000. Suite verified **104/104 at 1× and at 6×**.
- [x] `vitest.config.ts` scopes the unit run to `test/unit/**` so Playwright
  specs under `e2e/**` are not collected by Vitest's default `*.spec.ts` glob.

- [x] **@playwright/test enabled — was deliberately inert.** `playwright.config.ts` +
  `e2e/{fixtures.ts,kp.d.ts,open-fronts.spec.ts}` were committed but inert: the
  dependency was intentionally absent from package.json because `@playwright/test`
  ships its own `playwright` bin, and side-by-side with the existing
  `playwright` dep CI's `npx playwright install chromium` fetches one browser
  revision while `test/interact.mjs` needs the other → red build → blocked
  Pages deploy. Enabled with ONE matched version:
  `npm i -D -E playwright@1.61.1 @playwright/test@1.61.1` (both exact, no
  caret), added `npm run test:e2e`, and wired an `E2E (playwright specs)` step
  into `.github/workflows/deploy.yml` after the `interact.mjs` step
  (`KP_E2E_PORT=4174` so it doesn't collide with the interact preview still
  holding 4173; the existing `npx playwright install --with-deps chromium`
  step already covers the matched revision, so no second install step).
- [ ] Port the remaining refactor-adjacent specs: `tools`, `selection`,
  `placement`, `room-editing`. `test/interact.mjs` stays the full net.
- [ ] Verify CI green via `workflow_dispatch` on a branch before merging — the
  deploy workflow only triggers on push to master, and a red E2E blocks Pages.
- [x] Sweep the remaining sleeps — done in Phase A (see M8 above): 129 → 1.

## M1 — editor core (`src/editor/`), not started

Scaffolding first, no behaviour change: `Store.on()` returns a disposer;
`types.ts` (`Tool`/`ToolContext`/`PointerInput`/`KeyInput`, no DOM types);
`ToolManager` (structural mutual exclusion — `closeOtherTools` disappears);
`EditorState`; `CommandRegistry` (lift `wireKeyboard` + `wireTopbar` bodies);
`InputRouter`. Free prep: `wallIdAt`/`wallIndexIn`, `SnapTolerances` options
object, and the manufacturing contract fields on `Panel`
(`sourcePath`/`grain`/`edgeBanding`) + a mm rounding policy.

Then one tool per step, each with a Plan2D compatibility façade:
Measure → Calibrate → DrawRoom → Room → Place → Select.

**Hard rule:** `test/interact.mjs` reads and WRITES private Plan2D fields from
page context (`p.zoom`/`panX`/`panY`, `plan.measure`, `plan.roomGhost`,
`plan.drawRing()`). If a step needs to touch that file, the façade is wrong —
fix the façade, not the test.

## M2 — multi-selection, M3 — React shell (topbar + status bar only)

See the plan. M2 keeps `store.selection` as a derived compatibility view so the
~40 read sites migrate for free; M3 stays narrow because `#props-inner`,
`#outline`, `#catalog-inner` and partstudio carry ~70 E2E selectors.

STATUS: M0 root cause complete and verified (lint 0, typecheck clean,
434/434 unit, build clean, 104/104 E2E at 1× and 6× CPU throttle). Playwright
migration scaffolded but intentionally not wired.

NOTE: `npm run format` reflows 44 unrelated files (`.prettierrc` printWidth
100 vs code written at ~120). That repo-wide reformat is still the separate
commit M5/W4 deferred — do not let it ride along in a feature diff.

---

# M6 — Room authoring (auto-share walls · draw tool · photo underlay)

- [x] F1 auto-share adjacent rooms (Opus, diff reviewed): snapRoomRect ghost
  snap, nextWeldSeam planner + Store.weldRoom (partial-overlap splits, nudges,
  locked partition corners, convergence guard), corner-drag snapPointToRooms;
  welds on every addRoom path + corner-gesture end (+27 unit, E2E 36/37)
- [x] F2 draw-room tool (same agent): AddRoomOptions.polygon, DrawRing overlay
  in renderPlan, ✎ buttons, Esc/Enter, closeOtherTools() dedupe (399 unit)
- [x] F3 floor-plan photo underlay (Opus, diff reviewed): src/model/underlay.ts
  pure module, UNDERLAY_KEY side storage (bytes never in Design/undo),
  1600px JPEG downscale, 2-click calibration via measure overlay, drag/lock/
  opacity, exportJson embeds src, PRINT_OPTS off (+16 unit)

- [x] F4 wall-joint rendering fix (Opus, diff reviewed + screenshots checked):
  slabQuad butt-ended fills, wallJoints convex patches with miter apexes
  (MITER_LIMIT 4 bevel on acute), joints under slabs in 2D (no ink bleed),
  3D prisms w/ polygonOffset + visibility tied to incident walls; known limit
  documented: overlapping rooms crossing mid-span still interpenetrate
  (+11 unit)

FINAL VERIFY: lint 0, typecheck clean, 426/426 unit, 104/104 E2E, build
clean, screenshots eyeballed. All uncommitted on master.

(W4 tooling + W5 cleanup from M5 run AFTER M6 lands, so lint sweep touches
final code once.)

---

# M5 — Hardening milestone (audit fixes)

Plan: ~/.claude/plans/thorough-review-validation-whimsical-brook.md
Each wave ends green: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`

- [x] W1 P0 correctness (inline): deleteCustomPart cascade via withAttached,
  restore() clears openFronts, GLB export catch → status hint; 2 regression
  tests (348 unit green, tsc clean)
- [x] W2 P1 perf + P4.4/4.5 leaks (Opus agent, diff reviewed): rAF-coalesced
  rebuilds + flushRebuild (items getter/picking/snapshot/GLB), setActive gate
  on 2D-only mode, setAttachment equality guard, addVariable non-structural,
  ground cached, pmrem disposed, StudioPreview/ResizeObserver/blob-URL leaks
  fixed, WebGL context-loss overlay; CLAUDE.md contract updated (agent verified
  100/100 E2E; final integrated verify pending)
- [x] W3a P2 data safety (Sonnet, diff reviewed): RECOVERY_KEY stash-on-fail +
  boot banner (download/dismiss), savefail event + #status-savefail, item
  numeric repair (repairItemDims), corner dedupe + polygonIsSimple room gate
- [x] W3b P3 test gaps (Sonnet, diff reviewed): storageKeys/migrate/undo-depth
  units (+18), setMacOverride + __kpForceMac unlocks 7 wheel checks on ubuntu
  CI, BOM-sheet popup-fallback E2E, KP_BASE_URL parametrized (isolated run
  100/100 E2E)
- [x] W4 P4.1-4.3 tooling (Sonnet): eslint@10 flat + typescript-eslint@8 +
  prettier config (repo-wide reformat deferred to own commit — 47 files
  pending), tsconfig noUnused* on, tsconfig.test.json + typecheck script,
  CI lint/typecheck steps; 11 dead-code fixes, zones.test type bug fixed;
  flagged: plan2d pointerWorld orphan removed, interact.mjs assertion-less
  evaluate, npm audit needs vite major bump

FINAL VERIFY (M5+M6 complete): lint 0 errors, typecheck clean, 415/415 unit,
104/104 E2E, build clean. All uncommitted on master.
- [x] W5 P5 cleanup (Sonnet, diff reviewed): 3 dead exports deleted,
  localToWorld/worldToLocal in geometry.ts (attach + worktops + store
  converted; snapping.ts left — vector decomposition, not point transform),
  forkPartForItem single notify via applyCustomPart, NEXT_STEPS.md de-staled
  (415/415)

---

# M4 — Polish pack (touch parity · continuous worktops · plan sheet)

Plan: ~/.claude/plans/act-as-senior-software-elegant-unicorn.md, "MILESTONE 4"
Each item ends green: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`
((b) openings-survive-reshape shipped early, in Step 0.5.)

- [x] (d) touch parity — shared `PinchGesture` (`src/plan2d/pinch.ts`) drives
  two-finger zoom/pan in BOTH 2D views (plan + elevation), `hitRadius()` widens
  every handle on coarse pointers (corner/midpoint/rotate/measure), NEXT_STEPS
  item 10 de-staled (321 unit, 98/98 E2E)
- [x] (a) continuous worktops — `worktopRuns(design)` (`src/model/worktops.ts`,
  pure): same room/rotation/plane/depth/overhang, joints ≤ 5 mm; the run LEADER
  emits the whole slab as one prism with every member's cutouts shifted along
  the run, FOLLOWERS emit no worktop, a run of one gets no plan so the
  standalone path stays byte-identical. `hostContexts` = applianceHosting +
  worktopRuns is the single per-item context (view3d + export both call it);
  BOM "runs not merged" caveat dropped (332 unit, 98/98)
- [x] (c) print / PDF plan sheet — `renderPlan(ctx, store, view, opts,
  overlays?)` extracted from `Plan2D.draw()` into `src/plan2d/renderPlan.ts`
  (behaviour-identical on screen; the gesture state Plan2D used to read off
  `this` is threaded through the `PlanOverlays` bag, the layer switches through
  `PlanRenderOpts`). `src/print/sheet.ts`: `planLayout`/`fitScale` (pure scale
  maths, 1:50 @ 150 dpi = 118.11 px/m, stepping to 1:100/1:200 when A4
  landscape would overflow), `planImage` renders offscreen with every
  interactive layer off and all rooms in full ink, `openPrintSheet` composes
  title block + plan `<img>` sized in mm + item schedule from `buildBom().buy`
  (Hardware skipped, Openings kept) + cut totals, opened via blob URL with the
  M1 download fallback. `Export ▾ → Plan sheet…` (346 unit, 99/99)

All three complete. Uncommitted on master.

---

# M3 — Spatial checks engine

Plan: ~/.claude/plans/act-as-senior-software-elegant-unicorn.md, "MILESTONE 3"
Each phase ends green: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`

- [x] P1-P3: core — `src/model/checks.ts` `runChecks`/`Warning` (2.5D
  height-aware collision: overlap/throughWall/blocksDoor/doorLanding via SAT
  + true-polygon overlap, TOUCH_EPS-shrunk shapes so flush neighbours never
  flag), `store.warnings()` lazy dirty-flag cache invalidated by `notify()`
  (287→304 unit)
- [x] P4-P6: surfacing — 2D overlay behind `#btn-checks` (errors always
  drawn, warn/info opt-in), 3D emissive-tint refactor (`setTint`/
  `appliedTints`: selection green > error red > warn amber, info never
  tints), props panel Checks sections (per-item + design-wide, click-through)
- [x] P7-P8: ergonomics — face-model clearance primitive (`Face`/`faceGap`/
  `freeDepth`) drives frontClearance (read off `Panel.motion` — hinge leaf
  width / slide travel, so it covers every cabinet with no hard-coded kind),
  walkway 0.90 m / work aisle 1.07 m (NKBA G4/G5), bed side access 0.60 m
  (Neufert); work triangle per room (sink/hob/fridge front centers,
  best-of-triples, info severity) — demo fridge moved south (`x1 - 0.35,
  1.7`) so its front clearance clears the appliance tower's door
- [x] P9: E2E + docs — 4 new `test/interact.mjs` scenarios (overlap
  appears/clears on undo, through-wall drag + error emissive tint, `#btn-
  checks` toggle state, baseline work-triangle hint), CLAUDE.md/README.md/
  NEXT_STEPS.md sweep (304 unit, 98/98 E2E)

All phases complete. The demo ships with exactly ONE info finding — sink↔hob
70 cm, under the 120 cm minimum work-triangle leg — kept deliberately as a
discoverable hint, not a bug. Uncommitted on master.

---

# M2 — Furniture breadth (bedroom / living / office)

Plan: ~/.claude/plans/act-as-senior-software-elegant-unicorn.md, "MILESTONE 2"
Each phase ends green: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`
(E2E runs via `KP_CHROMIUM_PATH` → system Chrome since the Playwright chromium broke on a Node upgrade.)

- [x] P0: plumbing — `CatalogDef.placement` drives `snapsToWall`, sections renamed (`Kitchen · *`, `Dining & seating`), `roundedRectPoly`/`softSlab` in meshKit, `hasItemBuilder` guard test (243 unit, 89/89 E2E)
- [x] P1: hanging rail — `InteriorElement {kind:'rail'}`, RAIL_DIA, cyl `axis:'x'` panels role 'rail', zoneCanvas ＋Rail + drag fix, data-loss tests first (248 unit, 89/89)
- [x] P2: bedroom — `bed` kind (frame/headboard/mattress/duvet/pillows/drawers params) + 3 defs + symbol; wardrobe/wardrobe-wide/nightstand/dresser presets (251 unit, 91/91)
- [x] P3: living — `sofa`/`tv`/`rug` kinds + builders + symbols (shared `sofaSeats`), armchair/coffee-table reuse, tv-bench/bookcase presets, rug layer 0; fixed pre-existing open-niche liner coplanarity (moiré + cut-list double-boarding) (256 unit, 94/94)
- [x] P4: office — `officeChair` kind + builder + symbol, desk/desk-drawers freeform presets (257 unit)
- [x] P5: 2-room demo (Kitchen + Bedroom shared partition, bed/wardrobe/nightstands/rug/pendant), docs sweep; 3D-click E2E made framing-robust (camera aimed at target + render-settle before worldToScreen) (257 unit, 94/94 E2E)

All phases complete.

---

# M1 — BOM export (cut-list + shopping-list)

Plan: ~/.claude/plans/act-as-senior-software-elegant-unicorn.md, "MILESTONE 1"
Each phase ends green: `npx tsc --noEmit && npm run test:unit` (+ `npm run build && node test/interact.mjs` from Phase 4)

- [x] Phase 0: prep — `counterFin` → variables.ts, `PLINTH_COLOR` → catalog.ts (meshKit re-exports both), `catalogSection(defId)` in catalog.ts. Zero behavior change.
- [x] Phase 1: src/model/export.ts cut rows — `CutRow`, name-keyed dedup, `cutRows(design)` (one `applianceHosting` pass, `partPanels` per item), slot resolution mirroring partMeshes.ts `panelMaterial`.
- [x] Phase 2: shopping list + openings + hardware — `BuyRow`, `buyRows`/`openingRows`/`hardwareRows`, `buildBom(design, now?)` → `Bom`.
- [x] Phase 3: src/model/exportFormats.ts — `cutListCsv`/`shoppingListCsv` (UTF-8 BOM + CRLF, `CUT_HEADER`/`BUY_HEADER` contracts), `bomHtml` printable A4 sheet.
- [x] Phase 4: UI + E2E + docs — `Export ▾` topbar dropdown (index.html + style.css `.topbar-menu`), `wireExportMenu()`/`downloadText()` in ui.ts, 3 E2E scenarios (cut list header contract, cut list cabinet row, shopping list product), README/CLAUDE.md/TODO.md updated (242 unit, 89/89 E2E).

All phases complete. Uncommitted on master.

---

# v6 Multi-Room Foundation (kitchen → interior planner) — TODO

Plan: ~/.claude/plans/act-as-senior-software-elegant-unicorn.md
Each phase ends green: `npx tsc --noEmit && npm run test:unit` (+ `npm run build && node test/interact.mjs` from Phase 2)

- [x] Phase 0: de-kitchen prep — WALL_MOUNT_ELEVATION const, PresetEntry.section→string, storageKeys.ts (interior-planner-* + legacy fallback) (154 unit, 69/69 E2E)
- [x] Phase 1: rooms.ts (Room type, allWalls/shared detection/faceOffset, makeRoom, mirrorOpening) + insetPolygon + rooms.test.ts — additive, Design still v5 (178 unit, 69/69 E2E)
- [x] Phase 2: schema flip v6 — Design.rooms[], migrate.ts (inset + opening re-projection), store rewrite, snapping scope, mechanical view compile-fix, test updates (188 unit, 69/69 E2E)
- [x] Phase 3: rooms CRUD (add/delete/duplicate/rename) + activeRoom ephemeral state + tests (200 unit, 69/69 E2E)
- [x] Phase 4: View3D multi-room — partition-once ✓(phase 2), camera-in-room visibility heuristic, per-design shadow span, inside-preset→active room, GLB 'Design'/'Rooms' (200 unit, 69/69 E2E, 3-shot visual check)
- [x] Phase 5: Plan2D multi-room render + room switching + add-room tool; UI rooms panel/outline; elevation follows active room (200 unit, 75/75 E2E, visual check)
- [x] Phase 6: shared-wall openings polish — twin splitWall (bit-identical split point), sanitize owner re-homing (207 unit, 75/75 E2E)
- [x] Phase 7: de-kitchen sweep + E2E N4-N11 (N1-N3/N12 landed in phase 5) + two-room screenshot + docs (207 unit, 86/86 E2E — N10 alone asserts 4 checks, replaying tests 1/6/7 against a migrated design)

All phases complete. Uncommitted on master.

Deferred:
- partition magnetism on corner drag (near-coincident twin corner pulled into exact alignment)
- partial edge-overlap detection (a 6 m wall abutting a 3 m wall renders doubled instead of auto-splitting)
- duplicateRoom copying items (currently geometry + openings only)
- ~~room-type presets/catalogs (bedroom/bath/office furniture sets)~~ — shipped in M2 (bedroom/living/office; bathroom still deferred)
- ~~per-room demo designs (demo stays a single kitchen room)~~ — demo is now 2-room (Kitchen + Bedroom), see M2

---

# Cabinet Model Unification — TODO

Plan: ~/.claude/plans/context-this-is-wobbly-finch.md
Each phase ends green: `npx tsc --noEmit && npm run build && npm run test:unit && node test/interact.mjs`

- [x] Phase 1: WS1 plumbing — Store.partOf, placement/finishedBack/worktopOverhang, Panel slot 'counter', cabinetTreeFromCounts → zones.ts (146 unit, 62/62 E2E)
- [x] Phase 2: preset cut — presets.ts replaces baseCabinet/baseDrawers/island/pantry/wallCabinet/shelf; forkPartForItem + "Customize part…" (141 unit, 63/63 E2E)
- [x] Phase 3: DESIGN_VERSION 5 strict gate, partsMigrate.ts + migrate.test.ts deleted, CLAUDE.md updated (127 unit, 64/64 E2E)
- [x] Phase 4: interior model + hollow carcass — LeafZone.interior/hinge, interior.ts resolveInterior/drawerBoxDims, shell + dividers + real drawer boxes, zoneCanvas steppers (139 unit, 64/64 E2E)
- [x] Phase 5: openable fronts — Panel.motion in IR, OpenFronts view state + 'pose' event, pivot groups, 3D dblclick + topbar + studio toggles, GLB exports closed (143 unit, 66/66 E2E)
- [x] Phase 6: interior drill-in editor (dblclick zone) + hinge picker (143 unit, 67/67 E2E)
- [x] Phase 7: appliance substrate — Item.attach, ZoneFill 'appliance', attach.ts (pose/sync/hosting/findHost), partPanels HostContext cutouts (150 unit, 67/67 E2E)
- [x] Phase 8: counter appliances — appl-sink/appl-hob replace base-sink/base-hob; drag/place/cascade/dup lifecycle; snapItem skips attached (154 unit, 68/68 E2E)
- [x] Phase 9: zone appliances — appl-oven/appl-micro replace base-oven/oven-tower; applianceTowerPart in demo (154 unit, 69/69 E2E)
- [x] Phase 10: dishwasher/fridge/hood → Appliances (mount floor/wall), hasWorktop deleted, docs sweep (154 unit, 69/69 E2E)

All phases complete. Uncommitted on master. No pre-v5 design compatibility (by decision).
Deferred: hollow prism carcass for chamfer/cornerL (pre-export), glass-front motion units, continuous worktop runs, manufacturing export itself.

---

# Part Studio v2 — TODO

Plan: ~/.claude/plans/act-as-senior-frontend-synchronous-melody.md
Each phase ends green: `npx tsc --noEmit && npm run build && npm run test:unit && node test/interact.mjs`

- [x] Phase 1: model v2 + migration + all 3 builders — 65/65 unit, 28/28 E2E, parity screenshots byte-identical
- [x] Phase 2: studio v2 shell + type picker + freeform editor — 29/29 E2E, picker/board-list/pick verified in browser
- [x] Phase 3: worktop/board type end-to-end — 30/30 E2E, polygon editor verified in browser
- [x] Phase 4: zone editor — 31/31 E2E; per-zone carcass so open niches render truly open (visual improvement over v1)
- [x] Phase 5: angled footprints — 32/32 E2E, diagonal + L corner verified in browser
- [x] Phase 6: polish + docs + manual browser verify — 32/32 E2E, 65/65 unit, live v1→v2 migration verified (variant split, zero console errors)

All phases complete. Uncommitted on master.

---

# Better Lighting Options — TODO

Plan: ~/.claude-personal/plans/do-thorough-analysis-of-stateless-squirrel.md
Green gate: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`

## Phase 1 — Model ✅
- [x] `types.ts`: replace `Scene`, add `LightProps.color?`
- [x] new `src/model/sky.ts`: `skyState(t)` pure fn + `SkyState` + `mixHex`

## Phase 2 — Store ✅
- [x] `setScene(patch, info?)` non-structural
- [x] `setNight` → thin wrapper writing timeOfDay (13/22)
- [x] scene defaults via `defaultScene()` in `emptyDesign` + `demoDesign`
- [x] sanitize migration night→timeOfDay (drops dead `night` flag)

## Phase 3 — View3D ✅
- [x] constructor: `RectAreaLightUniformsLib.init()`, PMREMGenerator
- [x] `relight()` rewrite (exposure, bg, env fade, sun dir/color/int, hemi, per-lamp color, nightness)
- [x] env regen keyed on envPreset + `makeEnvScene` (RoomEnvironment / gradient dome)
- [x] LED strip → RectAreaLight; `FixtureLight` union incl RectAreaLight

## Phase 4 — UI ✅
- [x] generalize `sliderRow(opts)` + value readout
- [x] global Lighting + Environment sections in `renderRoomProps`
- [x] per-lamp color picker; `LIGHT_COLORS` palette in catalog
- [x] topbar Day/Night button → time 13⇄22 (labels from timeOfDay)
- [x] CSS: `.slider-val` readout

## Phase 5 — Tests ✅
- [x] update `model.test.ts` scene defaults + night→time migration test
- [x] new `sky.test.ts` (skyState curve/endpoints/wrap + mixHex)
- [x] update `interact.mjs` #16 → time-of-day round-trip

## Phase 6 — Verify ✅
- [x] `npx tsc --noEmit` clean
- [x] `npm run test:unit` — 78 passed
- [x] `npm run build` + `node test/interact.mjs` — 32/32, no errors
- [x] visual check: even LED-strip wash (bug fixed), time-of-day, dusk env, blue lamp, dark night

DONE. Uncommitted on master.

---

# Lighting Simplification — TODO

Plan: ~/.claude-personal/plans/act-as-senior-frontend-zany-cook.md
Green gate: `npx tsc --noEmit && npm run test:unit && npm run build && node test/interact.mjs`

## Phase 1 — Model + Store + View + UI ✅
- [x] `types.ts`: Scene → {sunAzimuth, sunElevation, brightness, night}; drop EnvPreset; version literal 3
- [x] `sky.ts`: skyState(azDeg, elevDeg, night); SUN_ELEV_MIN/MAX; night = old t=22 verbatim
- [x] `store.ts`: DESIGN_VERSION 3; defaultScene {215,35,1,false}; setNight → {night}; sanitizeScene (fresh object, legacy timeOfDay/night migration, clamps)
- [x] `view3d.ts`: fixed EXPOSURE; one-time initEnvironment (RoomEnvironment only); relight uses brightness
- [x] `ui.ts`: 3 sliders (Sun direction / Sun height / Brightness); drop Environment section + swatches; night button reads scene.night

## Phase 2 — Tests ✅
- [x] `sky.test.ts` rewrite (anchors, wrap, clamp, night ignores elevation)
- [x] `model.test.ts` + `migrate.test.ts`: v4 rejected, new defaults, legacy migration, full-v2 migration, clamps
- [x] `interact.mjs` #16 → scene.night round-trip

## Phase 3 — Docs + Verify ✅
- [x] CLAUDE.md lighting bullet rewrite (+ DESIGN_VERSION 3)
- [x] green gate: tsc clean, 98/98 unit, 34/34 E2E, no console errors
- [x] screenshots: default 215°/35° warm-neutral (kept); night matches old t=22 (dark bg, glowing lamps)
- [x] live browser: legacy v2 autosave migrates on boot; slider commit + undo; v3 reload round-trip (6/6)

## Phase 4 — Day-brightness retune (visual validation round) ✅
- [x] sky.ts: sun ramp lerp(0.3, 2.2, h); day ambient top `AMBIENT_DAY` 0.5 (night untouched)
- [x] view3d.ts: `ENV_FILL` 0.45 on IBL; daylight normalized by `AMBIENT_DAY`
- [x] interior lamps contribute 0 at full daylight (`boost = 1.44·nightness`), fade in below ~16° sun; night level preserved (1.15); day bulb emissive subtle
- [x] re-validated: day lamps-on == clean daylight look (saturated colors, visible sun shadows); night unchanged; 98/98 unit, 34/34 E2E

DONE. Uncommitted on master.
