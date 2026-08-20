import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * DOM CONTRACT — the gate every React-migration step must keep green.
 *
 * This spec pins every DOM id/class/data-attribute that `test/interact.mjs`
 * (the bespoke 2,540-line Playwright driver) and the `e2e/*.spec.ts` suite
 * (and the rest of e2e/) reach into. It asserts TODAY's markup, not an
 * aspiration: every selector below was found by grepping both suites and
 * then confirmed against either the live DOM or the component in
 * src/ui/react/** / src/ui/partstudio/*.ts that emits it.
 *
 * If a selector here goes missing, one of two things happened:
 *  - a real regression in src/ui broke a selector the old suites depend on, or
 *  - a component intentionally renamed it, in which case update BOTH this
 *    table and the two suites' selectors in the same change.
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
  vis('#ws-tabs'),
  vis('#ws-tab-plan'),
  vis('#ws-tab-furnish.active'), // Furnish is the default workspace, and the fixture clears storage
  vis('#ws-tab-workshop'),
  vis('#ws-tab-output'),
  vis('#btn-undo'),
  vis('#btn-redo'),
  vis('#btn-new'),
  vis('#btn-save'),
  vis('#btn-load'),
  vis('#btn-export'),
  present('#export-menu'), // display:none until .open
  vis('#btn-settings'), // WS-SPEC §2.3: device preferences moved behind the gear
  present('#settings-menu'), // display:none until .open
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

  // canvas overlays — WS-SPEC §2.3 moved these off the top bar. The view
  // toggle floats over #canvases, the scene toggles inside #pane3d; both are
  // on screen at boot (Furnish + Split) and both unmount in Workshop/Output.
  vis('#view-toggle'),
  vis('button[data-view="2d"]'),
  vis('button[data-view="split"].active'), // Split is the default view
  vis('button[data-view="3d"]'),
  vis('#btn-daynight'),
  vis('#btn-openfronts'),

  // plan overlays
  vis('#zoom-controls'),
  vis('#btn-zoom-in'),
  vis('#btn-zoom-fit'),
  vis('#btn-zoom-out'),
  vis('#measure-controls'),
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

/** Plan-workspace-only chrome — the wall tool exists only under #ws-tab-plan
 *  (WS-SPEC §4.4: workspaces scope toolsets; #btn-measure/#btn-checks stay in
 *  ALWAYS because they exist in Furnish, the boot default, too). #btn-angle-snap
 *  and #wall-width mount only while that tool is armed, so they are covered by
 *  e2e/tools.spec.ts rather than pinned here. */
const PLAN_TOOLS: readonly ContractEntry[] = [vis('#btn-draw-room')];

/** Catalog tiles — .cat-item is one of the selectors named in the plan.
 *  Furnish-scoped: door/window moved to CATALOG_PLAN (WS-SPEC §4.3), since
 *  they render only under the Plan workspace now. */
const CATALOG: readonly ContractEntry[] = [
  vis('.cat-section'),
  vis('.cat-title'),
  vis('.cat-grid'),
  vis('.cat-item'),
  vis('.cat-item-wrap'),
  vis('.cat-item[data-def-id="base-cabinet"]'),
  vis('.cat-item.cat-new'), // "+ New part" tile that opens the Part Studio
  vis('#catalog-search'), // WS-SPEC §4.3
];

/** Catalog tiles that only exist under the Plan workspace (WS-SPEC §4.3). */
const CATALOG_PLAN: readonly ContractEntry[] = [
  vis('.cat-item[data-def-id="door"]'),
  vis('.cat-item[data-def-id="window"]'),
];

/** src/ui/react/WorkshopPartsPanel.tsx — the Workshop workspace's sidebar (WS-SPEC §4.5). */
const WORKSHOP_SIDEBAR: readonly ContractEntry[] = [
  vis('#workshop-parts'),
  vis('#wsp-new'),
  vis('.wsp-row.wsp-preset'),
];

/** src/ui/react/OutputDocsPanel.tsx — the Output workspace's sidebar (WS-SPEC §4.5). */
const OUTPUT_SIDEBAR: readonly ContractEntry[] = [vis('#output-docs')];

/** src/ui/react/OutlinePanel.tsx — the Components-tab list (interact.mjs uses .ol-row / .room-row-name). */
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
// see src/ui/react/fields/**. Every entry below is scoped to `#props-inner`
// so `.first()` can't resolve to a hidden match sitting in one of those other
// panels instead of the selected one.
//
// e2e/inspector.spec.ts pins the panels' CONTENT (section titles and order);
// this table only pins the selectors the other suites reach for.

/** src/ui/react/props/ItemProps.tsx — Dimensions/Position/Colour sections. */
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

/** src/ui/react/props/WallProps.tsx — Size/Visibility/Shape sections. */
const WALL_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'), // Length, Thickness
  vis('input[data-cls="wall-len"]'), // the context menu's "Set wall length…" target
  vis('#props-inner .btn-row'), // Visibility choice row + "Add corner in the middle"
];

/** src/ui/react/props/OpeningProps.tsx — Size/Swing sections. */
const OPENING_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'), // Width, Height, From corner
  vis('input[data-cls="opening-off"]'),
  vis('#props-inner .btn-row'), // hinge/swing choice rows + Delete
];

/** src/ui/react/props/CornerProps.tsx — Position section. */
const CORNER_SELECTED: readonly ContractEntry[] = [
  vis('#props-inner .props-title'),
  vis('#props-inner .props-sub'),
  vis('#props-inner .prop-row'),
  vis('input[data-cls="corner-x"]'),
  vis('input[data-cls="corner-y"]'),
  vis('#props-inner .btn-row'), // Remove corner
];

/**
 * src/ui/react/WorkshopPane.tsx — the pane that hosts the Part Studio over the
 * canvases (WS-SPEC WP 1.6). `#wsp-back` replaced the studio's own `.studio-x`:
 * leaving is the workspace's job now, not the editor's.
 */
const WORKSHOP_PANE: readonly ContractEntry[] = [
  vis('#pane-workshop'),
  vis('#pane-workshop .workshop-host'),
  vis('#wsp-back'),
];

/**
 * src/ui/react/OutputPane.tsx — the Output workspace's canvas pane (WP 1.8):
 * six export cards over #canvases, the Output sibling of WORKSHOP_PANE above.
 */
const OUTPUT_PANE: readonly ContractEntry[] = [
  vis('#pane-output'),
  vis('#out-card-plan'),
  vis('#out-card-cut'),
  vis('#out-card-glb'),
  vis('#out-card-render'),
];

/** src/ui/partstudio/index.ts + typePicker.ts — the type-picker stage. */
const STUDIO_PICKER: readonly ContractEntry[] = [
  vis('#pane-workshop .studio-hosted'),
  vis('.studio'),
  vis('.studio-head'),
  vis('.studio-body'),
  vis('.studio-cards'),
  vis('.studio-card[data-type="cabinet"]'),
  vis('.studio-card[data-type="board"]'),
  vis('.studio-card[data-type="freeform"]'),
];

/** src/ui/partstudio/index.ts + cabinetPanel.ts — the cabinet editor stage. */
const STUDIO_EDITOR: readonly ContractEntry[] = [
  vis('#pane-workshop .studio-hosted'),
  vis('.studio-name'),
  vis('.studio-type-badge'),
  vis('.studio-form'),
  vis('.studio-canvas'),
  vis('.zone-canvas'),
  vis('.studio-preview'),
  vis('.choice-btn'), // footprint picker (rect / chamfer / corner-L)
  vis('.studio-foot'),
  // Save and Revert died with the drafts (WS-SPEC WP 3.1) — the footer now
  // carries the part's own actions plus the live-apply caption.
  vis('.studio-delete'),
  vis('.studio-duplicate'),
  vis('.studio-live-note'),
];

/**
 * The export menu, toggled open by <ExportMenu/> in src/ui/react/Topbar.tsx.
 * `#btn-png`/`#btn-glb` kept their ids when WS-SPEC §2.3 folded them in here as
 * the last two entries — same buttons, one level deeper.
 */
const EXPORT_MENU: readonly ContractEntry[] = [
  vis('#export-menu.open'),
  vis('[data-export="cut"]'),
  vis('[data-export="buy"]'),
  vis('[data-export="sheet"]'),
  vis('[data-export="plan"]'),
  vis('#btn-png[data-export="png"]'),
  vis('#btn-glb[data-export="glb"]'),
  vis('[data-export="render"]'),
];

/** The settings menu, toggled open by <SettingsMenu/> in src/ui/react/Topbar.tsx.
 *  The app fixture forces window.__kpForceMac = true, so the mac-gated nav-input
 *  row is there for every spec run regardless of CI OS. */
const SETTINGS_MENU: readonly ContractEntry[] = [
  vis('#settings-menu.open'),
  vis('#navinput-group'),
  vis('#btn-navinput'),
  vis('#btn-shortcuts'), // WS-SPEC §5.5: the pointer route to the `?` sheet
];

/**
 * src/ui/react/ContextMenu.tsx — the canvas right-click menu (WS-SPEC §5.1).
 * Unlike every other group here, this one exists only WHILE the menu is open,
 * so it is asserted inside a step that opens it and closed again right after.
 */
const CONTEXT_MENU: readonly ContractEntry[] = [
  vis('#context-menu'),
  vis('#context-menu button[data-cmd="add-corner"]'),
  vis('#context-menu button[data-cmd="add-door"]'),
  vis('#context-menu .ctx-hint'),
];

/**
 * src/ui/react/ConfirmHost.tsx — the in-app confirm/prompt that replaced
 * `confirm()`/`prompt()`. Conditional like CONTEXT_MENU above: asserted inside a
 * step that raises it (File ▸ New) and cancelled again right after, so nothing
 * downstream sees a changed design. `#dialog-input` is prompt-only and belongs
 * to the calibrate flow, so it is not pinned here.
 */
const APP_DIALOG: readonly ContractEntry[] = [
  vis('#app-dialog'),
  vis('#app-dialog .modal-card'),
  vis('#dialog-cancel'),
  vis('#dialog-accept'),
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

test('DOM contract: selector table stays present across every pinned app state', async ({
  app,
}) => {
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

  // The room tools only exist in the Plan workspace (WS-SPEC §4.4); visit it,
  // assert, and come back to Furnish — the default every later step assumes.
  await test.step('plan workspace tools', async () => {
    await app.click('#ws-tab-plan');
    await assertContract(app, PLAN_TOOLS);
    await assertContract(app, CATALOG_PLAN); // WS-SPEC §4.3: door/window live here now

    // hint chip (WS-SPEC §5.2, WP 2.2): mounted as soon as a tool is armed,
    // gone as soon as it isn't — no pointer move needed for DOM presence.
    await app.click('#btn-measure');
    await assertContract(app, [present('#hint-chip-2d')]);
    await app.click('#btn-measure');
    await expect(app.locator('#hint-chip-2d')).toHaveCount(0);

    await app.click('#ws-tab-furnish');
    await expect(app.locator('#ws-tab-furnish')).toHaveClass(/active/);
  });

  // Workshop/output each swap the whole sidebar for their own content
  // (WS-SPEC §4.5); the swap must be reversible back to furnish's tab strip.
  await test.step('workshop/output sidebars', async () => {
    await app.click('#ws-tab-workshop');
    await assertContract(app, WORKSHOP_SIDEBAR);
    await expect(app.locator('#sidebar-tabs')).toHaveCount(0);
    // the canvas overlays belong to the two workspaces that draw on the
    // canvases; a workspace pane covers them here (WS-SPEC §2.3)
    await expect(app.locator('#view-toggle')).toHaveCount(0);
    await expect(app.locator('#btn-daynight')).toHaveCount(0);

    await app.click('#ws-tab-output');
    await assertContract(app, OUTPUT_SIDEBAR);
    await assertContract(app, OUTPUT_PANE);
    await expect(app.locator('#sidebar-tabs')).toHaveCount(0);
    await expect(app.locator('#view-toggle')).toHaveCount(0);
    await expect(app.locator('#btn-daynight')).toHaveCount(0);

    await app.click('#ws-tab-furnish');
    await expect(app.locator('#sidebar-tabs')).toBeVisible();
    await expect(app.locator('#view-toggle')).toBeVisible();
  });

  await test.step('catalog', async () => {
    await assertContract(app, CATALOG);
  });

  // Components tab: <OutlinePanel/> renders regardless of which sidebar tab
  // is active, so #outline already has content — switching tabs only flips
  // visibility. Switch back to Library before the catalog/studio steps below,
  // which click tiles that live under #tab-library.
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

  // ---- Part Studio: picker -> cabinet editor -> leave (no design mutation) ----
  // ＋ New part is a NAVIGATION now (WS-SPEC WP 1.6): it switches to the
  // Workshop workspace and the studio is built into that pane, not into a
  // document.body modal.
  await test.step('open Part Studio (picker)', async () => {
    await app.click('.cat-new');
    await expect(app.locator('#ws-tab-workshop')).toHaveClass(/active/);
    await assertContract(app, WORKSHOP_PANE);
    await assertContract(app, STUDIO_PICKER);
  });

  const partsBefore = await app.evaluate(() => window.__kp.store.design.customParts.length);

  await test.step('studio (cabinet editor)', async () => {
    await app.click('.studio-card[data-type="cabinet"]');
    await assertContract(app, STUDIO_EDITOR);
  });

  await test.step('leave the Workshop', async () => {
    // Under live-apply (WS-SPEC WP 3.1) picking a type IS the creation: the new
    // part is in the library from that click on, and leaving neither asks nor
    // takes it away. Nothing to confirm — the app has no native dialogs left.
    await app.click('#ws-tab-furnish');
    await expect(app.locator('#ws-tab-furnish')).toHaveClass(/active/);
    await expect(app.locator('#pane-workshop')).toHaveCount(0);
    await expect(app.locator('.studio')).toHaveCount(0);
    const partsAfter = await app.evaluate(() => window.__kp.store.design.customParts.length);
    expect(partsAfter).toBe(partsBefore + 1);
  });

  // ---- context menu (open over a wall, assert, dismiss) ----
  await test.step('canvas context menu', async () => {
    const p = await app.evaluate(() => {
      const kp = window.__kp;
      kp.plan.setViewport({ zoom: 60, panX: 120, panY: 120 });
      const v = kp.plan.viewport();
      const g = kp.store.allWalls()[0];
      const off = g.faceOffset - g.thickness / 2;
      const wx = g.a.x + g.dir.x * (g.len / 2) + g.inward.x * off;
      const wy = g.a.y + g.dir.y * (g.len / 2) + g.inward.y * off;
      return { x: wx * v.zoom + v.panX, y: wy * v.zoom + v.panY };
    });
    const box = (await app.locator('#canvas2d').boundingBox())!;
    await app.mouse.click(box.x + p.x, box.y + p.y, { button: 'right' });
    await assertContract(app, CONTEXT_MENU);
    await app.keyboard.press('Escape');
    await expect(app.locator('#context-menu')).toHaveCount(0);
    // a right-click SELECTS what it acts on (src/ui/react/ContextMenu.tsx), so
    // the wall it landed on is the live selection now — put the corner back,
    // because the assertion at the end of this test is that it survived.
    await app.evaluate((id) => window.__kp.store.select({ kind: 'corner', id }), cornerId);
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

  // ---- settings menu ----
  await test.step('open settings menu', async () => {
    await app.click('#btn-settings');
    await assertContract(app, SETTINGS_MENU);
  });

  await test.step('close settings menu', async () => {
    await app.click('#btn-settings');
    await expect(app.locator('#settings-menu.open')).toHaveCount(0);
  });

  // ---- app dialog (raise over File ▸ New, then cancel it) ----
  await test.step('app dialog', async () => {
    await app.click('#btn-new');
    await assertContract(app, APP_DIALOG);
    await app.click('#dialog-cancel');
    await expect(app.locator('#app-dialog')).toHaveCount(0);
    // Cancel is the whole point: the design (and the selection asserted below)
    // has to be exactly what it was before the dialog went up
    await expect.poll(() => app.evaluate(() => window.__kp.store.design.rooms.length)).toBe(1);
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
