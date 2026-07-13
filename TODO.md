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
