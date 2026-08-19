# Realistic sunlight — north, geographic site, date/time, and site context

## Context

`design.scene` has two raw dials: `sunAzimuth` (degrees, `0 = +z`, increasing
toward `+x` — a plan-frame angle with **no relation to north**) and
`sunElevation` (clamped 5..85°). They are art-direction sliders. Nothing in the
repo knows about north, latitude, longitude, timezone, date or time of day:
`grep -riE "north|compass|latitude|longitude|timezone|solar"` over
`src/ render/ test/ e2e/` returns one descriptive word in a doc comment
(`src/model/types.ts:137`) and nothing else. No astronomy dependency exists
(deps are fflate, pdfjs-dist, react, react-dom, three).

So the app cannot answer the question a kitchen actually gets designed around:
*how much sun does this room get, from which window, at 09:00 in December — and
does the block across the street take it away?* Shadows today are decorative,
not evidence.

The model this lands on is the one the BIM tools converged on: **Project North**
(the drawing stays as drawn) plus an **Angle to True North** on the site, with
geographic location and time zone driving the sun — Revit's split exactly, down
to its recommended verification (*at local solar noon shadows must point due
north–south*), reused as a manual test below.

### Decisions

| | |
|---|---|
| Sun modes | **Dual mode + pure resolver.** `scene.sunMode: 'manual' \| 'solar'`; a pure `resolveSun(design)` becomes the ONE feed into `skyState`. No cached derived state, nothing can drift. |
| Astronomy | **NOAA/Meeus**, not NREL SPA. ~60 lines at ±0.2° elevation / ±0.3° azimuth vs SPA's ~1000 lines at ±0.0003°. |
| Time | **IANA timezone via `Intl`.** Verified locally: 418 zones from `Intl.supportedValuesOf('timeZone')`, and the two-pass offset inversion resolves the 2026-03-29 Bratislava spring-forward gap correctly (02:30 local → `01:30Z`, offset 120). Zero dependency; `Temporal` is not available (Node 22, no browser baseline). |
| Below horizon | Scrub bounded to sunrise..sunset; `resolveSun` clamps elevation at 0; panel hint for a value that got out of range another way. `skyState` untouched, `scene.night` stays manual. |
| Location input | lat/lon fields + a **SK/CZ-heavy then European** city table + "Use my location". |
| Panel | **One `sunSite` section listed in BOTH workspaces**, the way `checks` already is. Brightness + the manual sliders stay in Lighting. |
| Sun study | date presets · sun-path arc in the plan · direct-sun hours per window · animate the day. |
| Storey | `site.floor` × `site.floorHeight`. |
| Manifest | **`sky.solar` provenance block, emitted in solar mode only** — so the manual-mode golden stays byte-identical and the regression gate survives. |
| Site context | **Overpass one-shot import**, public endpoint with an override field, 250 m default radius, cached **outside** the Design. |
| Context shadows | **Split by renderer**: analytic occlusion in the viewport, real prism geometry in the Cycles render. |
| Sequencing | **Two milestones**, both specified here so M-A's model shape is already M-B-ready. |
| Not doing | auto-deriving `scene.night` from elevation; map tile backdrops. |

---

## The one piece of maths everything hangs on

Plan space is metres, x right, **y down**; `plan(x,y) → world(x,·,z=y)`.
`sunAzimuth = A` means direction-toward-sun `= (sin A, ·, cos A)`
(`src/view3d/view3d.ts:960-964`, mirrored expression-for-expression at
`src/model/renderManifest.ts:243-247`), so in plan coords the sun lies along
`(sin A, cos A)`: `A=0` is screen-DOWN, `A=90` is screen-RIGHT — a CCW sweep.

Define `site.northDeg` = bearing of true north **clockwise from plan "up"**
(`0` = north up the page, the default and what the compass rose draws). In a
y-down frame the visually-clockwise rotation is the standard matrix, so a
compass bearing `B` points along `(sin(B+N), −cos(B+N))`. Equating to
`(sin A, cos A)`:

```
planAzimuth A = wrap360(180 − site.northDeg − solarBearingDeg)
```

Checks: `N=0, B=180` (south) → `A=0` → screen down ✓ · `N=0, B=90` (east) →
`A=90` → screen right ✓ · `N=0, B=270` (west) → `A=270` → screen left ✓.

That single line is the whole north feature. Everything else is plumbing.

---

# Milestone A — true sun (no network, shippable alone)

## A1 · `src/model/solar.ts` (new, pure, unit-tested)

Follows the `src/model/underlay.ts` precedent: the feature's astronomy,
Design-facing resolver and its own sanitizer in one file.

```ts
export interface SolarPosition {
  /** degrees above the true horizon; NEGATIVE when the sun is down */
  elevationDeg: number;
  /** compass bearing, degrees CLOCKWISE from true north (N=0, E=90, S=180) */
  bearingDeg: number;
}

// --- astronomy: NOAA / Meeus low-precision ---
export function solarPosition(latDeg, lonDeg, utcMs): SolarPosition;
/** geometric horizon dip from eye height, degrees: 0.0347·√h (24 m ⇒ 0.17°) */
export function horizonDipDeg(heightM: number): number;
export function sunTimes(latDeg, lonDeg, dateISO, tz, horizonDeg):
  { riseMin: number; setMin: number } | null;   // null = polar day/night

// --- timezone: Intl only, no data table ---
export function tzOffsetMinutes(tz: string, utcMs: number): number;
/** local civil date+minutes → absolute instant. Two-pass: guess the offset from
 *  the naive instant, recompute AT that instant, re-apply — the standard fix for
 *  the DST inversion. A spring-forward gap resolves post-transition. VERIFIED. */
export function localToUtcMs(dateISO: string, minutes: number, tz: string): number;
export function tzZones(): string[];   // Intl.supportedValuesOf, guarded

// --- Design-facing ---
export function defaultSite(): Site;
export function sanitizeSite(raw: unknown): Site;
export function groundDropM(site: Site): number;   // site.floor * site.floorHeight
/** THE resolver. Manual mode returns the stored pair verbatim; solar clamps ≥ 0. */
export function resolveSun(design: Design): { azimuthDeg: number; elevationDeg: number };
export function sunBelowHorizon(design: Design): boolean;   // drives the panel hint
```

A 0.3° azimuth error moves a shadow edge ~5 mm per metre of throw — an order of
magnitude under this app's other approximations (flat terrain, estimated context
heights, no refraction beyond the standard 0.833° sunrise term). NOAA is the
right accuracy for the money; clamp latitude off exactly ±90°, where the
algorithm is documented unstable.

`tzOffsetMinutes` parses `Intl.DateTimeFormat(…, { timeZone, timeZoneName:
'longOffset' })` → `GMT±HH:MM`.

## A2 · `src/model/cities.ts` (new)

Frozen `{ label, lat, lon, tz }[]`. ~20 Slovak and Czech entries first
(Bratislava, Košice, Žilina, Nitra, Prešov, Banská Bystrica, Trnava, Trenčín,
Poprad, Martin, Prague, Brno, Ostrava, Plzeň, Olomouc, Liberec, České
Budějovice…), then ~30 European capitals and large cities. Pure data — no
network, no geocoding, no privacy question. Anywhere else falls back to the
lat/lon fields or the geolocation button.

## A3 · Model

**`src/model/types.ts`** — `Scene` angles stay DEGREES (the documented
non-radian exception, `types.ts:129-135`); `northDeg` joins it.

```ts
export interface Site {
  /** bearing of TRUE NORTH, degrees clockwise from plan "up" (−y); 0 = north up */
  northDeg: number;
  lat: number;            // −90..90
  lon: number;            // −180..180
  tz: string;             // IANA id
  label?: string;         // display only, free text
  /** plan point that `lat`/`lon` names. Unused in M-A; M-B's georeferencing anchor. */
  anchor: Point;
  /** storey the plan sits on; 0 = ground */
  floor: number;
  /** storey height turning `floor` into height above grade, metres */
  floorHeight: number;
}

// Scene gains:
  sunMode: 'manual' | 'solar';
  date: string;   // local civil date, 'YYYY-MM-DD'
  time: number;   // local civil time, minutes since midnight, 0..1439

// Design gains:
  site: Site;
```

`site.anchor` ships in M-A even though only M-B reads it — adding it later means
a second sanitize/test pass over the same struct for no gain.

**`src/model/store.ts`**
- `sanitizeScene` (`:1878-1887`) deliberately rebuilds a FRESH object, so the
  three new keys must be added there or they are dropped on every autosave.
- `sanitizeDesign` (`:1717`) — add `d.site = sanitizeSite(d.site)` beside
  `d.scene = sanitizeScene(d.scene)`, mirroring `sanitizeUnderlay` at `:1721`.
- `defaultScene()` (`:1892`) — `sunMode: 'manual'` keeps every existing design
  byte-identical; `date` a fixed literal, `time: 720`.
- `emptyDesign()` `:1904` / `demoDesign()` `:2068` — `site: defaultSite()`.
- New `setSite(patch: Partial<Site>, info = { structural: false })` beside
  `setScene` (`:1265`). Non-structural is enough: `relight()` runs on the spot
  and Plan2D redraws on every `'change'` (`src/plan2d/plan2d.ts:213`).

`defaultSite()` must be **deterministic** — `emptyDesign()` feeds unit tests and
the golden fixture, so it may not read `Intl` or geolocation. Fixed neutral
default `{ northDeg: 0, lat: 50, lon: 10, tz: 'Europe/Berlin', anchor: {x:0,y:0},
floor: 0, floorHeight: 3 }`. The device's real zone/position arrives only through
an explicit UI action, never inferred silently. Same rule for the date: the model
default is a literal; the panel's **Today** preset does the non-deterministic bit.

**No `DESIGN_VERSION` bump** — purely additive with defaulting sanitizers,
exactly how `underlay?` was added. `src/model/migrate.ts` untouched.

## A4 · Viewport + manifest

**`src/view3d/view3d.ts:942-944`** (`relight`):

```ts
const { azimuthDeg, elevationDeg } = resolveSun(this.store.design);
const sky = skyState(azimuthDeg, elevationDeg, scene.night);
```

Nothing else in `relight` changes — direction formula, `SUN_RADIUS`, shadow
frustum, lamp `boost` all stay.

**`src/model/renderManifest.ts:234-247`** (`manifestSky`): same substitution, so
the manifest's `azimuthDeg`/`elevationDeg` carry the *resolved* solar angles.
Because those two numbers are all the worker consumes
(`lighting.py:182-185` drives the Nishita sky from `sun_elevation`/`sun_rotation`,
`convert.py:182-195` owns the bearing conversion), **real sun reaches Cycles with
no change to the render code at all**.

**Storey / ground disc** — `view3d.ts:211-222` builds a helper ground disc at
`y = -0.012`, stripped from GLB export (`:1378`). Add `syncGround()`, called from
`rebuild()` and `softUpdate()`: `ground.position.y = -0.012 - groundDropM(site)`
and `ground.receiveShadow = site.floor === 0`.

Be straight about what storey buys: **solar geometry is essentially unaffected**
by 30 m of height — a 0.17° horizon dip, ~40 s of sunset, folded into `sunTimes`
for correctness of the scrub range and nothing else. What the floor number really
changes is the view out of the window: the ground drops away and sky fills the
openings. Blender's Nishita `altitude` input is *height above sea level* and is
invisible below ~100 m, so it stays unwired. Two limitations for the doc comment:
the room's floor slab has nothing under it at grazing angles, and the worker
builds no ground at all, so a render sees pure sky below the sill.

## A5 · `sky.solar` provenance block

`ManifestSky` gains an **optional** `solar`:

```ts
solar?: {
  lat: number; lon: number; tz: string;
  dateISO: string; timeMinutes: number;
  northDeg: number; solarBearingDeg: number;
};
```

**Emitted only when `scene.sunMode === 'solar'`.** That is what keeps
`render/manifest/examples/kitchen-min.json` (a manual-mode fixture)
**byte-identical**, so the strongest regression gate in the milestone survives
the change. It is provenance only — the worker reads it for nothing.

The cross-language contract moves together, in one change:
- `src/model/renderManifest.ts` — the interface + `manifestSky`.
- `render/worker/kprender/manifest.py:234-253` — the `Sky` dataclass `FIELDS`
  table gains an optional nested `Solar`, so `unknown_keys` does not flag it.
- `render/manifest/manifest.schema.json` — `ManifestSky` is
  `additionalProperties: false`, so `solar` must be declared there.
- New golden fixture for a solar-mode design, read by **both** vitest and the
  worker's pytest, exactly as `kitchen-min.json` already is. The manual golden is
  not regenerated.

## A6 · Inspector — one `sunSite` section, both workspaces

`roomSections.ts` gains `'sunSite'`, listed in **both** the `plan` and `furnish`
arrays — precisely what `checks` already does ("a section id listed under both
workspaces is shared/reused, not duplicated", `roomSections.ts:6-7`). Dispatched
from `RoomProps.tsx:65-79`. One new component
**`src/ui/react/props/SunSiteProps.tsx`**, title "Sun & site":

- **North** — `SliderRow` 0..360 step 1, `fmt` `0° · N up`, `90° · N right`, …
- **Place** — `<select>` of `CITIES` + "Custom…", filling lat/lon/tz in one pick;
  two `NumberField`s; `#btn-geolocate` "Use my location"
  (`navigator.geolocation`, visible denied/unavailable fallback; it yields no
  timezone, so it fills lat/lon only).
- **Time zone** — `<select>` over `tzZones()`; degrade to the stored value alone
  when `Intl.supportedValuesOf` is missing.
- **Storey** — `StepperRow` `floor` + `LengthField` `floorHeight` (through
  `src/model/units.ts` like every length), with a derived "24.0 m above grade".
- **Sun** — `ChoiceRow` `Manual | Date & time`. In solar mode: `<input
  type="date">`; presets `21 Jun · 21 Dec · 21 Mar · Today`; a `SliderRow` for
  `scene.time` whose `min`/`max` are that day's `sunTimes` so the scrub cannot
  leave daylight, `fmt` `HH:MM`; `#btn-sun-play` sweeping sunrise→sunset over
  ~10 s on a rAF loop; a read-only caption `Sun 214° · 38° · rise 05:12 · set
  21:03`; the `sunBelowHorizon` hint when a stored time is out of range.

`LightingProps.tsx` keeps **Brightness** and the two manual sliders (shown only
in manual mode).

**Re-render contract.** `PropsBody` subscribes to `'selection' | 'history' |
'activeRoom'` and nothing else, on purpose — a drag fires `'transient'` at
pointer rate. `SunSiteProps`' selects and derived captions therefore re-read on
commit the way `UnderlaySection` does (`useChannel('editor')`,
`useChannel('units')` at `UnderlaySection.tsx:22-23`), and every slider takes its
single undo step from `SliderRow`'s native `change`. The play loop writes
`scene.time` with `{ transient: true }` and commits once at the end, so a
10-second animation is one undo step and zero `PropsBody` renders —
`e2e/transient-perf.spec.ts` is the gate.

## A7 · Plan compass + sun path

`PlanRenderOpts` (`renderPlan.ts:146-163`) gains **one** switch,
`compass: boolean`, drawn by a new `drawCompass(ctx, design, view)` in
`renderPlan.ts` (never in Plan2D — the layer rule). Screen-space, bottom-right of
the viewport, `INK`:

- north arrow rotated clockwise by `site.northDeg` from up;
- in solar mode, the day's **sun-path arc** around the rose with the current time
  marked and the sunrise/sunset ends labelled.

**ON in both** `plan2d.ts:1728-1739` and `PRINT_OPTS` (`src/print/sheet.ts:48`) —
a north arrow is standard on a printed plan, and the arc is exactly what a sheet
should carry. Display only in M-A: north comes from the slider, not from dragging
the rose.

## A8 · Direct-sun hours per window

Pure function in `solar.ts`:

```ts
/** daily intervals when the sun is up AND within the opening's inward half-space */
export function directSunIntervals(design, openingId, dateISO): { fromMin, toMin }[];
```

The geometry already exists: `openingsOfWall` + `wall.inward`/`wall.dir`
(`rooms.ts`), the same basis `manifestPortals` uses
(`renderManifest.ts:344-355`). Sample the day at 5-minute steps and merge runs —
more robust than solving the crossing analytically, and 288 NOAA evaluations is
microseconds. Rendered in `OpeningProps.tsx`: `Direct sun 09:40–14:20 · 4 h 40 m`.
M-B extends the same function with context occlusion; the signature does not
change.

## A9 · Tests

**`test/unit/solar.test.ts` (new)**
- `solarPosition` vs published NOAA values: Bratislava summer-solstice local
  noon; equinox at the equator; high-latitude midnight sun (elevation positive at
  local midnight); a southern-hemisphere case where the bearing crosses north.
- `tzOffsetMinutes('Europe/Bratislava', …)` = 60 in January, 120 in July.
- `localToUtcMs` across a DST boundary and through the spring-forward gap.
- **The four plan-azimuth cases from the maths section** — the test that catches
  a sign flip, and the most valuable assertion in the milestone.
- `horizonDipDeg(24) ≈ 0.17`.
- `resolveSun` manual mode returns the stored pair *identically* (the
  no-regression guard); solar mode matches a hand-computed angle; clamps at 0.
- `sanitizeSite` clamps lat/lon/floor, rejects a bad tz id, defaults a design
  with no `site` at all.
- `directSunIntervals`: a due-south window at the equinox ≈ sunrise→sunset; a
  due-north window in Bratislava in December ≈ empty.

**`test/unit/renderManifest.test.ts`** — manual-mode golden passes **without**
`UPDATE_GOLDEN=1`; new solar-mode golden asserted field by field.
**`render/worker/tests/test_manifest.py`** — parses the new solar golden with
`unknown_keys` empty.

**Existing tests to update** — these `toEqual` the whole `scene`, so three new
keys break them: `test/unit/model.test.ts:143, 176-183, 550, 590`;
`test/unit/renderManifest.test.ts:73, 568, 581, 597, 757`;
`test/unit/checks.test.ts:88`; `test/unit/wallTool.test.ts:374`;
`test/unit/renderPackage.test.ts:57`. Mechanical.

**e2e**
- `e2e/inspector.spec.ts:57-68` — ordered section-title list gains "Sun & site"
  in both workspaces; `:84` (`toHaveCount(3)` on `#props-inner
  input[type=range]`, "the three Lighting sliders") changes with the new rows.
- `e2e/dom-contract.spec.ts` — add `#site-north`, `#site-city`, `#site-tz`,
  `#btn-geolocate`, `#sun-mode`, `#sun-date`, `#sun-time`, `#btn-sun-play`.
  Contract table and specs move in the same change, per that file's own rule
  (`:14-18`).
- `e2e/sun.spec.ts` (new, on the `app` fixture so `ONBOARDED_KEY` is seeded) —
  drive `__kp.store.setSite/setScene` into solar mode, assert the resolved angle,
  assert the compass redraws (`plan.debug().drawCount` advancing — the no-sleep
  seam), assert the section appears in both workspaces, assert manual mode is
  bit-identical to before.

## A10 · Docs

`CLAUDE.md` — extend the lighting contract with `resolveSun` as the single feed,
the `northDeg` convention, and `sky.solar`'s solar-mode-only rule; add `solar.ts`
to the pure-model list; note the new golden. `TODO.md` — new milestone block in
the existing WP style. `ROADMAP.md` — move "lighting groups and lux estimates"
next to this. `graphify update .` at the end.

## A11 · Verification

```bash
npm run lint && npm run typecheck && npm run test:unit && npm run build \
  && node test/interact.mjs && npx playwright test
```
(`interact.mjs` needs `npx vite preview` on :4173 against a fresh `dist/`.)

Plus:

1. `git diff --stat render/manifest/examples/kitchen-min.json` — **empty**. A
   changed manual golden means either the resolver leaked or `sky.solar` is being
   emitted unconditionally.
2. `cd render/worker && python -m pytest` — green, including the new solar golden.
3. **The Revit check**: north = 0, Bratislava, any date, scrub to local solar
   noon — every shadow must point due north–south, straight up the plan. This
   single test catches every sign error in the chain at once.
4. 21 Jun 13:00 → sun high, slightly west of south (plan shadow up-and-right);
   21 Dec 09:00 → sun low in the south-east (long shadow up-and-left). Rotate
   north to 90° and confirm every shadow rotates with it.
5. Scrub and play: `window.__kp.debug.renderCounts.propsBody` must not advance.
6. Export → "Render package (.zip)…" on a solar-mode design; confirm the manifest
   carries both the resolved angles and `sky.solar`; run the worker; confirm the
   Cycles sun matches the viewport.

---

# Milestone B — site context (georeferencing + neighbouring massing)

## B1 · Georeferencing — `src/model/geo.ts` (new, pure)

`site.lat/lon` names the world position of plan point `site.anchor`, and
`site.northDeg` gives the rotation. That is a complete local frame:

```ts
/** local ENU tangent plane; exact enough (<0.1%) over a few hundred metres */
export function planToLatLon(site: Site, p: Point): { lat: number; lon: number };
export function latLonToPlan(site: Site, lat: number, lon: number): Point;
// 1° lat ≈ 111_320 m; 1° lon ≈ 111_320 · cos(lat)
```

Tests: round-trip identity; a 250 m offset lands within a metre of a known
reference pair; `northDeg = 90` rotates east → plan-down.

## B2 · Import — `src/ui/contextImport.ts` (new)

One-shot `fetch` to Overpass — no dependency, it is a POST of Overpass QL and a
JSON parse:

```
[out:json][timeout:25];
way["building"](around:${radius},${lat},${lon});
out geom;
```

**Endpoint**: `overpass-api.de` by default, with an override field in the section
(the public instance is 10k requests/day, ODbL, and its policy warns access "may
be withdrawn at any point" for commercial services). **Radius**: 250 m default,
adjustable 50–1000 m — a 30 m block shades ~50 m at a 30° winter sun and ~100 m
at 15°, so 250 m covers what can realistically matter without dragging in
hundreds of polygons the occlusion test would walk per window per timestep.

Height ladder: `height` → `building:levels × 3` → `6 m`, each volume tagged with
which rule produced it so the panel can show estimated heights differently from
surveyed ones. Ways convert through `latLonToPlan` and are simplified.

**Where the bytes live.** `CONTEXT_KEY` in `src/model/storageKeys.ts`, *not* in
the Design — precisely the underlay rule (`storageKeys.ts:13-18`): undo is a JSON
snapshot of the whole design and autosave writes it on every commit, so a few
hundred polygons in `design.*` would blow up both. Store API mirrors the
underlay's exactly: `store.setContext(...)` writes the side key first and returns
false when storage refuses, `store.contextRef()` returns it or null,
`store.updateContext(patch)` for per-volume edits. `exportJson` carries it as an
extra top-level `contextMassing` field and `sanitizeDesign` strips it, exactly as
`underlaySrc` is handled — with the load handler re-installing it after
`replaceDesign`.

**Constraints, surfaced in the UI rather than buried:**

- <5% of OSM buildings carry `height`; ~40% carry `building:levels`. Most heights
  are **estimates**, labelled as such per volume. Shadows are indicative, not
  authoritative — every imported volume stays hand-editable.
- Cache keyed on lat/lon/radius so re-opening a design never re-fetches. Required
  ODbL attribution in the UI and in the render package. Offline / rate-limited
  degrades to "no context" — the feature is additive, never load-bearing.
- **The host building is in OSM too** and would self-shadow the design. Exclude
  the way containing `site.anchor` automatically, with a manual override.
- Flat terrain: no DEM, so a hillside neighbour is wrong. Vegetation absent.
- Map *tiles* stay out of scope: `tile.openstreetmap.org`'s policy prohibits app
  use and any real provider needs a key. The visual-backdrop path already ships —
  screenshot a map, import as underlay, calibrate.

## B3 · Plan layer

Context footprints under the rooms in `MUTED`, hatched, behind a new
`context: boolean` `PlanRenderOpts` switch (ON on screen, ON in `PRINT_OPTS`).
Selectable and editable — height field, delete, and hand-drawn volumes through
the existing wall tool, so a user with no OSM coverage is not locked out.

## B4 · 3D and the render — split by renderer

Context volumes become extruded prisms via the existing `prism()` in
`src/view3d/meshKit.ts`, one shared grey `kp:` material. They are not
`design.items`, so `buildBom` never sees them — the cut list stays clean by
construction.

Why not a second shadow-casting sun, verified against `three@0.166` source:
`WebGLRenderer.js:940` gathers a light only when `light.layers.test(camera.layers)`
— tested against the **main** camera, so a light cannot hide on its own layer;
and `WebGLShadowMap.js:335` tests `object.layers.test(camera.layers)` where
`camera` is likewise the **main** camera, not the shadow camera. Layers cannot
gate which objects cast into which light's map, and two full-intensity suns
simply double the light.

- **Viewport (approximate, fast)** — keep today's single tight 2048² shadow map,
  so cabinet shadows stay crisp. Context occlusion is analytic:
  `sunOccluded(design, point, sunDir)`, a pure ray-vs-prism test, cheap and
  unit-testable, scaling the sun's contribution per window. Exact for "does
  direct sun reach this window now"; it just draws no soft neighbour shadows.
- **Render package (physical, slow)** — context prisms go into the GLB.
  **Cycles has no shadow-map budget** — it ray-traces, so the block across the
  street casts a physically correct shadow through the window for free.
- The same function extends A8's `directSunIntervals`, so the readout becomes
  context-aware with no new machinery.

If soft neighbour shadows in the viewport later matter, the standard fix is
**CSM** — `three/examples/jsm/csm/CSM.js` ships with 0.166 (confirmed present),
one light split into a crisp near cascade and a wide far cascade. Contained
follow-up, not a prerequisite.

## B5 · Render package

Context prisms flow through `exportRenderGLB` as ordinary meshes (unlike `Ground`
and lights, stripped at `view3d.ts:1378`). One new `kp:` material name — so the
**three-file cross-language contract** moves together: `src/model/materialName.ts`,
`render/worker/kprender/matnames.py`, `render/materials/openpbr.materials.json`,
plus `test/unit/materialName.test.ts` and `render/worker/tests/test_matnames.py`.
ODbL attribution into the manifest and the printed sheet.

## B6 · Tests

- `geo.ts` round-trips and a known reference pair.
- Overpass parsing against a checked-in fixture response (no network in tests);
  the height-rule ladder and the host-building exclusion.
- `sunOccluded` against hand-built prisms: directly behind, beside, above.
- e2e with `page.route()` intercepting the Overpass call — never a live request
  from CI.

---

## Open items (none blocking)

- Compass rose is display-only; drag-to-rotate is a possible later addition.
- `skyState` still clamps at 0°; extending it through civil twilight would make
  a full 24 h scrub look right and is a contained change to one file, if the
  bounded scrub ever feels restrictive.
- Blender's Nishita `altitude` (height above sea level) stays unwired —
  invisible below ~100 m.

---

## Sources

- [NOAA vs NREL SPA accuracy — Ladybug Tools](https://discourse.ladybug.tools/t/sun-position-algoritm-noaa-vs-spa/17459)
- [NREL Solar Position Algorithm, NREL/TP-560-34302](https://docs.nrel.gov/docs/fy08osti/34302.pdf)
- [Blender Sky Texture node — sun elevation / rotation / altitude](https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/sky.html)
- [Revit project north vs true north, solar accuracy](https://novedge.com/blogs/design-news/revit-tip-rotate-project-north-to-align-plans-on-sheets-while-preserving-true-north-solar-accuracy)
- [Revit solar study and shadow analysis workflow](https://novedge.com/blogs/design-news/revit-tip-revit-solar-study-and-shadow-analysis-workflow)
- [OSM building attribute quality — global assessment](https://www.sciencedirect.com/science/article/pii/S0360132323003220)
- [OSM Simple 3D Buildings tagging](https://wiki.openstreetmap.org/wiki/Simple_3D_buildings)
- [Overpass API status / rate limits](https://wiki.openstreetmap.org/wiki/Overpass_API/status)
- [OSMF API usage policy](https://operations.osmfoundation.org/policies/api/)
- [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [Overture Maps buildings schema (height / est_height)](https://docs.overturemaps.org/schema/concepts/by-theme/buildings/)
- [Temporal.ZonedDateTime disambiguation (DST gap/overlap semantics)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/ZonedDateTime)
