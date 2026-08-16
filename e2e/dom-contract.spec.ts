import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * DOM CONTRACT — the gate every React-migration step must keep green.
 *
 * This spec pins every DOM id/class/data-attribute that `test/interact.mjs`
 * (the bespoke 2,540-line Playwright driver) and the `e2e/*.spec.ts` suite
 * (open-fronts.spec.ts today) reach into. It asserts TODAY's markup, not an
 * aspiration: every selector below was found by grepping both suites and
 * then confirmed against either the live DOM or the renderer in
 * src/ui/ui.ts / src/ui/partstudio/*.ts that emits it.
 *
 * If a selector here goes missing, one of two things happened:
 *  - a real regression in src/ui broke a selector the old suites depend on, or
 *  - a React component intentionally renamed it, in which case update BOTH
 *    this table and the two suites' selectors in the same change.
 *
 * State is driven through window.__kp (see e2e/kp.d.ts) wherever a store
 * mutator exists, exactly like e2e/open-fronts.spec.ts — never by clicking
 * through a fragile UI path when a deterministic store call does the same
 * thing. The one exception is the Part Studio and the export menu, which
 * are themselves the UI surface under test.
 */

interface ContractEntry {
  /** CSS selector, asserted against `#props-inner`/document scope as noted per group. */
  readonly sel: string;
  /**
   * 'visible' (default): the element must be on screen right now.
   * 'present': `count >= 1` in the DOM is enough — some pinned elements are
   * legitimately hidden at this point (e.g. #canvas-elev before Elevation
   * mode, #outline under the not-yet-opened Components tab).
   */
  readonly mode?: 'present';
}

const vis = (sel: string): ContractEntry => ({ sel });
const present = (sel: string): ContractEntry => ({ sel, mode: 'present' });

/** Every element the app shell renders unconditionally at boot. */
const ALWAYS: readonly ContractEntry[] = [
  // topbar
  vis('#topbar'),
  present('#btn-catalog'), // mobile-only hamburger, display:none above 900px
  vis('#view-toggle'),
  vis('button[data-view="2d"]'),
  vis('button[data-view="split"].active'), // Split is the default view
  vis('button[data-view="3d"]'),
  vis('#btn-undo'),
  vis('#btn-redo'),
  vis('#btn-daynight'),
  vis('#btn-openfronts'),
  // the app fixture forces window.__kpForceMac = true, so the mac-gated
  // nav-input control is visible for every spec run regardless of CI OS
  vis('#navinput-group'),
  vis('#btn-navinput'),
  vis('#btn-new'),
  vis('#btn-save'),
  vis('#btn-load'),
  vis('#btn-png'),
  vis('#btn-glb'),
  vis('#btn-export'),
  present('#export-menu'), // display:none until .open
  present('#file-input'),
  present('#underlay-input'),

  // sidebar
  vis('#sidebar-tabs'),
  vis('#tab-btn-library'),
  vis('#tab-btn-components'),
  vis('#tab-btn-variables'),
  vis('#tab-library'),
  present('#tab-components'), // hidden attr until the Components tab is picked
  present('#tab-variables'), // hidden attr until the Variables tab is picked
  vis('#catalog-inner'),
  present('#outline'), // lives inside the hidden #tab-components
  present('#variables-panel'), // lives inside the hidden #tab-variables

  // canvases
  vis('#canvas2d'),
  vis('#canvas3d'),
  present('#canvas-elev'), // display:none outside Elevation mode
  vis('#mode2d-toggle'),
  vis('button[data-2dmode="plan"].active'),
  vis('button[data-2dmode="elev"]'),

  // plan overlays
  vis('#zoom-controls'),
  vis('#btn-zoom-in'),
  vis('#btn-zoom-fit'),
  vis('#btn-zoom-out'),
  vis('#measure-controls'),
  vis('#btn-room'),
  vis('#btn-draw-room'),
  vis('#btn-measure'),
  vis('#btn-checks'),
  present('#wall-nav'), // display:none outside Elevation mode
  present('#btn-wall-prev'),
  present('#wall-label'),
  present('#btn-wall-next'),

  // 3D pane
  vis('#cam-controls'),
  vis('button[data-cam="corner"].active'),

  // props panel — a fresh room's own Size/Ceiling rows already render .prop-row.
  // Scoped to #props-inner: .prop-row/.props-sub/.btn-row are reused verbatim
  // by the Variables panel (#variables-panel, under the hidden Variables tab),
  // so an unscoped `.first()` can resolve to a hidden match there instead.
  vis('#props'),
  vis('#props-inner'),
  vis('#props-inner .prop-row'),
  vis('#props-inner .prop-section'),
  vis('#props-inner .prop-section-title'),

  // status bar
  vis('#statusbar'),
  vis('#status-hint'),
  present('#status-savefail'), // hidden unless storage write fails
  vis('#status-info'),
];

/** Catalog tiles — .cat-item is one of the selectors named in the plan. */
const CATALOG: readonly ContractEntry[] = [
  vis('.cat-section'),
  vis('.cat-title'),
  vis('.cat-grid'),
  vis('.cat-item'),
  vis('.cat-item-wrap'),
  vis('.cat-item[data-def-id="base-cabinet"]'),
  vis('.cat-item[data-def-id="door"]'),
  vis('.cat-item[data-def-id="window"]'),
  vis('.cat-item.cat-new'), // "+ New part" tile that opens the Part Studio
];

/** src/ui/ui.ts renderOutline — the Components-tab list (interact.mjs uses .ol-row / .room-row-name). */
const OUTLINE: readonly ContractEntry[] = [
  vis('#outline .ol-head'),
  vis('#outline .ol-group'),
  vis('#outline .ol-group-title'),
  vis('#outline .ol-label'),
  vis('#outline .ol-row'),
  vis('#outline .room-row'),
  vis('#outline .room-row-name'),
  vis('#outline .room-row-area'),
];

// NOTE: .props-sub, .prop-row, .btn-row, .swatches and .stepper are all
// generic helper classes shared with the room-props panel (default view) and
// the Variables panel (#variables-panel, under the hidden Variables tab) —
// see src/ui/ui.ts numberRow/materialRow/renderVariablesSection. Every entry
// below is scoped to `#props-inner` so `.first()` can't resolve to a hidden
// match sitting in one of those other panels instead of the selected one.

/** src/ui/ui.ts renderItemProps — Dimensions/Position/Colour sections. */
const ITEM_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'),
  vis('input[data-cls="pos-x"]'),
  vis('input[data-cls="pos-y"]'),
  vis('input[data-cls="rot"]'),
  vis('#props-inner .stepper'),
  vis('#props-inner .swatches'),
  vis('#props-inner .btn-row'), // Duplicate / Delete actions
];

/** src/ui/ui.ts renderWallProps — Size/Visibility/Shape sections. */
const WALL_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'), // Length, Thickness
  vis('#props-inner .btn-row'), // Visibility choice row + "Add corner in the middle"
];

/** src/ui/ui.ts renderOpeningProps — Size/Swing sections. */
const OPENING_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'), // Width, Height, From corner
  vis('input[data-cls="opening-off"]'),
  vis('#props-inner .btn-row'), // hinge/swing choice rows + Delete
];

/** src/ui/ui.ts renderCornerProps — Position section. */
const CORNER_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'),
  vis('input[data-cls="corner-x"]'),
  vis('input[data-cls="corner-y"]'),
  vis('#props-inner .btn-row'), // Remove corner
];

/** src/ui/partstudio/index.ts + typePicker.ts — the type-picker stage. */
const STUDIO_PICKER: readonly ContractEntry[] = [
  vis('.studio-overlay'),
  vis('.studio'),
  vis('.studio-head'),
  vis('.studio-x'),
  vis('.studio-body'),
  vis('.studio-cards'),
  vis('.studio-card[data-type="cabinet"]'),
  vis('.studio-card[data-type="board"]'),
  vis('.studio-card[data-type="freeform"]'),
];

/** src/ui/partstudio/index.ts + cabinetPanel.ts — the cabinet editor stage. */
const STUDIO_EDITOR: readonly ContractEntry[] = [
  vis('.studio-overlay'),
  vis('.studio-name'),
  vis('.studio-type-badge'),
  vis('.studio-form'),
  vis('.studio-canvas'),
  vis('.zone-canvas'),
  vis('.studio-preview'),
  vis('.choice-btn'), // footprint picker (rect / chamfer / corner-L)
  vis('.studio-foot'),
  vis('.studio-cancel'),
  vis('.studio-save'),
];

/** index.html export menu, toggled open by src/ui/ui.ts wireExportMenu. */
const EXPORT_MENU: readonly ContractEntry[] = [
  vis('#export-menu.open'),
  vis('[data-export="cut"]'),
  vis('[data-export="buy"]'),
  vis('[data-export="sheet"]'),
  vis('[data-export="plan"]'),
];

/** Runs every entry in a group; a failure names the exact missing selector. */
async function assertContract(page: Page, group: readonly ContractEntry[]): Promise<void> {
  for (const { sel, mode } of group) {
    const loc: Locator = page.locator(sel).first();
    if (mode === 'present') {
      await expect(loc, `expected element present (count >= 1): ${sel}`).toBeAttached();
    } else {
      await expect(loc, `expected element visible: ${sel}`).toBeVisible();
    }
  }
}

test('DOM contract: selector table stays present across every pinned app state', async ({ app }) => {
  // One long tour through every pinned selection state, each assertion group
  // scanning ~10-90 selectors under SwiftShader — comfortably over the
  // config's default 60s, and this repo's shared CI/dev sandbox can run
  // several concurrent Playwright suites at once. This is a gate spec, not a
  // hot dev-loop test, so it trades speed for asserting the whole contract in
  // one deterministic pass instead of re-booting the app per state.
  test.setTimeout(300_000);

  // ---- boot: the static shell + first render ----
  await test.step('always (boot state)', async () => {
    await assertContract(app, ALWAYS);
  });

  await test.step('catalog', async () => {
    await assertContract(app, CATALOG);
  });

  // Components tab: renderOutline() runs at boot regardless of which sidebar
  // tab is active, so #outline already has content — switching tabs only
  // flips visibility. Switch back to Library before the catalog/studio steps
  // below, which click tiles that live under #tab-library.
  await test.step('sidebar tabs / outline', async () => {
    await app.click('#tab-btn-components');
    await expect(app.locator('#tab-components')).toBeVisible();
    await assertContract(app, OUTLINE);
    await app.click('#tab-btn-library');
    await expect(app.locator('#tab-library')).toBeVisible();
    await expect(app.locator('#catalog-inner')).toBeVisible();
  });

  // ---- item selection ----
  const itemId = await test.step('place + select an item', async () => {
    const id = await app.evaluate(() => {
      const st = window.__kp.store;
      const item = st.addItem(st.defOf('base-cabinet'), 2.0, 1.0, 0);
      st.commit();
      st.select({ kind: 'item', id: item.id });
      return item.id;
    });
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.selection))
      .toEqual({ kind: 'item', id });
    return id;
  });

  await test.step('itemSelected', async () => {
    await assertContract(app, ITEM_SELECTED);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Base cabinet');
  });

  // ---- wall selection ----
  const wallId = await test.step('select a wall', async () => {
    const id = await app.evaluate(() => {
      const st = window.__kp.store;
      const wall = st.allWalls()[0];
      st.select({ kind: 'wall', id: wall.id });
      return wall.id;
    });
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.selection))
      .toEqual({ kind: 'wall', id });
    return id;
  });

  await test.step('wallSelected', async () => {
    await assertContract(app, WALL_SELECTED);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Wall');
  });

  // ---- opening selection (add a door on the selected wall, then select it) ----
  const openingId = await test.step('add + select an opening', async () => {
    const id = await app.evaluate((wId) => {
      const st = window.__kp.store;
      const wall = st.wallById(wId)!;
      const o = st.addOpening(st.defOf('door'), wall.id, wall.len / 2);
      st.commit();
      st.select({ kind: 'opening', id: o.id });
      return o.id;
    }, wallId);
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.selection))
      .toEqual({ kind: 'opening', id });
    return id;
  });

  await test.step('openingSelected', async () => {
    await assertContract(app, OPENING_SELECTED);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Door');
  });

  // ---- corner selection ----
  const cornerId = await test.step('select a corner', async () => {
    const id = await app.evaluate(() => {
      const st = window.__kp.store;
      const corner = st.design.rooms[0].corners[0];
      st.select({ kind: 'corner', id: corner.id });
      return corner.id;
    });
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.selection))
      .toEqual({ kind: 'corner', id });
    return id;
  });

  await test.step('cornerSelected', async () => {
    await assertContract(app, CORNER_SELECTED);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Corner');
  });

  // ---- Part Studio: picker -> cabinet editor -> cancel (no design mutation) ----
  await test.step('open Part Studio (picker)', async () => {
    await app.click('.cat-new');
    await assertContract(app, STUDIO_PICKER);
  });

  const partsBefore = await app.evaluate(() => window.__kp.store.design.customParts.length);

  await test.step('studio (cabinet editor)', async () => {
    await app.click('.studio-card[data-type="cabinet"]');
    await assertContract(app, STUDIO_EDITOR);
  });

  await test.step('close Part Studio without saving', async () => {
    await app.click('.studio-cancel');
    await expect(app.locator('.studio-overlay')).toHaveCount(0);
    // Cancelling an untouched fresh part must not mutate the design.
    const partsAfter = await app.evaluate(() => window.__kp.store.design.customParts.length);
    expect(partsAfter).toBe(partsBefore);
  });

  // ---- export menu ----
  await test.step('open export menu', async () => {
    await app.click('#btn-export');
    await assertContract(app, EXPORT_MENU);
  });

  await test.step('close export menu', async () => {
    await app.click('#btn-export');
    await expect(app.locator('#export-menu.open')).toHaveCount(0);
  });

  // itemSelected/wallSelected/openingSelected/cornerSelected all target the
  // same #props-inner subtree in sequence, so re-confirm the selections that
  // are still supposed to be alive weren't quietly dropped by the studio or
  // export-menu detour (corner was the last live selection made above).
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.selection))
    .toEqual({ kind: 'corner', id: cornerId });

  // openingId/itemId are asserted transitively above (selection + panel
  // fields); keep the references live so a future edit that drops one of the
  // intermediate assertions is a visible unused-variable, not silent drift.
  void itemId;
  void openingId;
});
