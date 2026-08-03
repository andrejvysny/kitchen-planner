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
