import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * TOOL STATE — EditorState is the single source of truth, Plan2D's six tool
 * fields are read-only mirrors of it, and the four tool buttons are React
 * components projecting the same state.
 *
 * What these specs cover that test/interact.mjs cannot: the seams the migration
 * created. `syncFromEditor()`'s leaving-tool cleanup (which replaced
 * closeOtherTools), the entry resets the setX() delegates still owe when the
 * editor no-ops, the `.active` round-trip through React, and the null-safety of
 * resolving a stale armed def id.
 *
 * Everything polls or asserts synchronously reachable state — no sleeps. The
 * ring/measure gestures use SINGLE clicks at well-separated points, so no
 * dblclick folding is possible and no pacing beat is needed.
 */

/** Pin the plan transform, so world→screen below is exact rather than fitted. */
const VIEW = { zoom: 60, panX: 120, panY: 120 };

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
}

/** Page coordinates of a plan world point, under the pinned transform. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

/** Move to a plan point and click it, the way a user reaches it. */
async function clickPlan(page: Page, x: number, y: number): Promise<void> {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

// WS-SPEC §4.4: the wall tool only renders in the Plan workspace, and the
// fixture boots into Furnish (the persisted default with cleared storage).
// Every spec here exercises plan-editing tools, so start each in Plan.
test.beforeEach(async ({ app }) => {
  await app.click('#ws-tab-plan');
  await expect(app.locator('#btn-draw-room')).toBeVisible();
  // the tab and window.__kp.workspace() are the same state, not two of them
  expect(await app.evaluate(() => window.__kp.workspace())).toBe('plan');
});

const toolState = (page: Page) => page.evaluate(() => window.__kp.plan.toolState());
const editorTool = (page: Page) => page.evaluate(() => window.__kp.editor.tool);
const isActive = (page: Page, sel: string) =>
  page.evaluate((s) => document.querySelector(s)!.classList.contains('active'), sel);

test('the tool buttons project editor state and round-trip their .active class', async ({
  app,
}) => {
  await app.click('#btn-draw-room');
  expect(await editorTool(app)).toBe('drawRoom');
  expect(await isActive(app, '#btn-draw-room')).toBe(true);

  // a second tool takes the single gesture slot; the first gives it up
  await app.click('#btn-measure');
  expect(await editorTool(app)).toBe('measure');
  expect(await isActive(app, '#btn-measure')).toBe(true);
  expect(await isActive(app, '#btn-draw-room')).toBe(false);

  // clicking the armed tool again drops back to the resting state
  await app.click('#btn-measure');
  expect(await editorTool(app)).toBe('select');
  expect(await isActive(app, '#btn-measure')).toBe(false);

  // ⚠ is a display layer, not a tool: orthogonal to whatever is armed
  await app.click('#btn-draw-room');
  await app.click('#btn-checks');
  expect(await isActive(app, '#btn-checks')).toBe(true);
  expect(await editorTool(app)).toBe('drawRoom');
  expect(await toolState(app)).toMatchObject({ draw: true, checks: true });

  await app.click('#btn-checks');
  expect(await isActive(app, '#btn-checks')).toBe(false);
  expect(await editorTool(app)).toBe('drawRoom');
});

test('toolState() mirrors the editor for every tool', async ({ app }) => {
  const cases = [
    ['drawRoom', { draw: true }],
    ['measure', { measure: true }],
    ['calibrate', { calibrate: true }],
  ] as const;

  for (const [tool, expected] of cases) {
    await app.evaluate((t) => window.__kp.editor.setTool(t), tool);
    const st = await toolState(app);
    expect(st, tool).toMatchObject({
      armedDefId: null,
      measure: false,
      calibrate: false,
      draw: false,
      ...expected,
    });
  }

  await app.evaluate(() => window.__kp.editor.setTool('place', 'base-cabinet'));
  expect(await toolState(app)).toMatchObject({ armedDefId: 'base-cabinet', measure: false });

  await app.evaluate(() => window.__kp.editor.setTool('select'));
  expect(await toolState(app)).toMatchObject({ armedDefId: null, draw: false });
});

test('re-arming the draw tool mid-ring drops the ring it was building', async ({ app }) => {
  await pinViewport(app);
  await app.click('#btn-draw-room');
  await clickPlan(app, 6, 1); // one corner, clear of the 4x3 room

  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().drawRing?.pts.length))
    .toBe(1);

  // the editor no-ops on an identical tool, so the ENTRY RESET in the delegate
  // is the only thing that can clear the ring — this is what pins it
  await app.evaluate(() => window.__kp.plan.setDrawRoom(true));
  expect(await app.evaluate(() => window.__kp.plan.overlayState().drawRing)).toBe(null);
  expect(await editorTool(app)).toBe('drawRoom');
  expect(await app.evaluate(() => window.__kp.store.design.rooms.length)).toBe(1);
});

test('switching tools clears the overlay of the tool being left', async ({ app }) => {
  await pinViewport(app);

  // measure: one click opens a span, then the wall tool takes the slot
  await app.click('#btn-measure');
  await clickPlan(app, 1, 1);
  await expect
    .poll(() => app.evaluate(() => !!window.__kp.plan.overlayState().measure.a))
    .toBe(true);

  await app.click('#btn-draw-room');
  expect(await app.evaluate(() => window.__kp.plan.overlayState().measure)).toMatchObject({
    a: null,
    b: null,
    measuring: false,
  });

  // wall tool: a ring in progress goes when the tool does
  await clickPlan(app, 6, 1);
  await expect
    .poll(() => app.evaluate(() => !!window.__kp.plan.overlayState().drawRing))
    .toBe(true);
  await app.click('#btn-measure');
  expect(await app.evaluate(() => window.__kp.plan.overlayState().drawRing)).toBe(null);
});

test('Escape walks the tools in order, and the draw ring goes before its tool', async ({ app }) => {
  await pinViewport(app);

  // armed catalog def (door: a Plan-workspace tile — WS-SPEC §4.3 — since
  // this whole spec's beforeEach lives in Plan and base-cabinet no longer
  // renders there)
  await app.click('.cat-item[data-def-id="door"]');
  expect(await editorTool(app)).toBe('place');
  await app.keyboard.press('Escape');
  expect(await editorTool(app)).toBe('select');

  for (const [btn, tool] of [
    ['#btn-measure', 'measure'],
    ['#btn-draw-room', 'drawRoom'],
  ] as const) {
    await app.click(btn);
    expect(await editorTool(app)).toBe(tool);
    await app.keyboard.press('Escape');
    expect(await editorTool(app)).toBe('select');
    expect(await isActive(app, btn)).toBe(false);
  }

  // two-stage: the ring first, the tool only once the ring is empty
  await app.click('#btn-draw-room');
  await clickPlan(app, 6, 1);
  await expect
    .poll(() => app.evaluate(() => !!window.__kp.plan.overlayState().drawRing))
    .toBe(true);

  await app.keyboard.press('Escape');
  expect(await app.evaluate(() => window.__kp.plan.overlayState().drawRing)).toBe(null);
  expect(await editorTool(app)).toBe('drawRoom');
  expect(await isActive(app, '#btn-draw-room')).toBe(true);

  await app.keyboard.press('Escape');
  expect(await editorTool(app)).toBe('select');
  expect(await isActive(app, '#btn-draw-room')).toBe(false);

  // nothing armed: Escape deselects instead
  await app.evaluate(() => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf('base-cabinet'), 2, 2.6, 0);
    st.select({ kind: 'item', id: it.id });
    st.commit();
  });
  await app.keyboard.press('Escape');
  expect(await app.evaluate(() => window.__kp.store.selection.kind)).toBe('none');
});

test('an armed def whose part is deleted under the tool never throws', async ({ app }) => {
  // arm a real custom part, then delete it out from under the armed tool
  const partId = await app.evaluate(() => {
    const st = window.__kp.store;
    const copy = JSON.parse(JSON.stringify(st.partOf('base-cabinet')));
    copy.id = 'doomed-part';
    copy.name = 'Doomed';
    st.upsertCustomPart(copy);
    st.commit();
    window.__kp.plan.setArmed(st.defOf('doomed-part'));
    return copy.id as string;
  });
  expect(await toolState(app)).toMatchObject({ armedDefId: partId });

  await app.evaluate((id) => window.__kp.store.deleteCustomPart(id), partId);
  // the def object the tool was handed still serves the ghost — the point is
  // that resolving it again does not go through the throwing store.defOf path
  await app.evaluate(() => window.__kp.editor.setChecks(true));
  expect(await editorTool(app)).toBe('place');

  // an id nobody ever handed to setArmed, and that resolves nowhere: null, not a throw
  await app.evaluate(() => window.__kp.editor.setTool('place', 'no-such-def-at-all'));
  expect(await toolState(app)).toMatchObject({ armedDefId: null });
  expect(await app.evaluate(() => window.__kp.plan.armedDef)).toBe(null);

  await app.evaluate(() => window.__kp.editor.setTool('select'));
  // the fixture fails this test on any uncaught pageerror, which is the assertion
});

test('the 2D/elevation toggle and the wall nav still drive the elevation view', async ({ app }) => {
  await app.click('#mode2d-toggle button[data-2dmode="elev"]');
  await expect(app.locator('#pane2d')).toHaveClass(/elev-mode/);
  expect(await isActive(app, '#mode2d-toggle button[data-2dmode="elev"]')).toBe(true);
  expect(await isActive(app, '#mode2d-toggle button[data-2dmode="plan"]')).toBe(false);

  const label = () => app.evaluate(() => window.__kp.elev.wallLabel());
  const first = await label();
  await app.click('#btn-wall-next');
  expect(await label()).not.toBe(first);
  // #wall-label is written by ElevationView's callback, never re-rendered away
  expect(await app.locator('#wall-label').textContent()).toBe(await label());

  await app.click('#btn-wall-prev');
  expect(await label()).toBe(first);

  await app.click('#mode2d-toggle button[data-2dmode="plan"]');
  await expect(app.locator('#pane2d')).not.toHaveClass(/elev-mode/);
  expect(await isActive(app, '#mode2d-toggle button[data-2dmode="plan"]')).toBe(true);
});

test('arming survives inside a workspace and dies across a switch', async ({ app }) => {
  await app.click('#btn-draw-room');
  expect(await editorTool(app)).toBe('drawRoom');

  // chrome interactions inside the same workspace leave the tool alone
  await app.click('#btn-zoom-in');
  expect(await editorTool(app)).toBe('drawRoom');

  // a workspace switch is a task change (WS-SPEC I3): the tool resets to
  // select, the mirrors follow, and the plan-only button leaves the DOM
  await app.click('#ws-tab-furnish');
  expect(await editorTool(app)).toBe('select');
  expect((await toolState(app)).draw).toBe(false);
  await expect(app.locator('#btn-draw-room')).toHaveCount(0);
});

test('the status hint renders from the shell store', async ({ app }) => {
  await app.click('#btn-measure');
  await expect(app.locator('#status-hint')).toContainText('measure');

  await app.click('#btn-draw-room');
  await expect(app.locator('#status-hint')).toContainText('Drag a rectangle');

  await app.keyboard.press('Escape');
  await expect(app.locator('#status-hint')).toContainText('Drag corners');
});

// WP 2.2: the floating cursor chip, deliberately redundant with #status-hint.
test('the hint chip follows the pointer while a tool is armed', async ({ app }) => {
  await pinViewport(app);
  await app.click('#btn-draw-room');

  const p = await at(app, 6, 5); // mid-canvas, clear of the corner clusters
  await app.mouse.move(p.x, p.y);

  const chip = app.locator('#hint-chip-2d');
  await expect(chip).toContainText('Drag a rectangle');
  await expect(chip).toHaveCSS('opacity', '1');
  // pointer-events:none is what keeps this from ever stealing a canvas click
  await expect(chip).toHaveCSS('pointer-events', 'none');

  await app.keyboard.press('Escape');
  expect(await editorTool(app)).toBe('select');
  await expect(app.locator('#hint-chip-2d')).toHaveCount(0);
});

// WP 2.3 (WS-SPEC §5.3): pure-paint hover pre-highlight in select mode — no
// store writes, so this only ever asserts overlayState()/debug(), never the
// design. The fresh room is a 4x3 rectangle at (0,0)-(4,0)-(4,3)-(0,3), so
// (2,0) is the south wall's midpoint handle and (1,0) is bare wall, clear of
// both the midpoint and corner hit radii at this zoom.
test('hover pre-highlights a handle, then a wall, then clears over empty floor', async ({
  app,
}) => {
  await pinViewport(app);

  const mid = await at(app, 2, 0);
  await app.mouse.move(mid.x, mid.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().hover.handle?.kind))
    .toBe('midpoint');
  expect(await app.evaluate(() => window.__kp.plan.overlayState().hover.wallId)).toBe(null);

  const before = await app.evaluate(() => window.__kp.plan.debug().drawCount);

  const wallPt = await at(app, 1, 0);
  await app.mouse.move(wallPt.x, wallPt.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().hover.wallId))
    .not.toBe(null);
  expect(await app.evaluate(() => window.__kp.plan.overlayState().hover.handle)).toBe(null);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.debug().drawCount))
    .toBeGreaterThan(before);

  const floor = await at(app, 2, 1.5);
  await app.mouse.move(floor.x, floor.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().hover))
    .toEqual({ handle: null, wallId: null });
});

/*
 * M15 — the snap engine's UI surface. These assert through `overlayState().snap`
 * and `toolState().snapGrid`, both of which are projections of pure model code
 * pinned in test/unit/snapEngine.test.ts; what can only be checked HERE is that
 * the plan actually feeds the engine the live zoom and the live modifiers.
 */

test('the wall tool reports what it snapped to, and Alt suppresses it in place', async ({
  app,
}) => {
  await pinViewport(app);
  await app.click('#btn-draw-room');

  // the fresh room's NE corner is (4, 0); its wall centreline sits half a
  // thickness outside, so hovering just off it must resolve to real geometry
  const near = await at(app, 4.1, 1);
  await app.mouse.move(near.x, near.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().snap?.kind))
    .toBeTruthy();
  const snapped = await app.evaluate(() => window.__kp.plan.overlayState().snap!.kind);
  expect(snapped).not.toBe('free');

  // Alt is a POINTER modifier watched on window, so it must take effect without
  // the mouse moving at all — that is the whole point of the keydown listener
  await app.keyboard.down('Alt');
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().snap?.kind))
    .toBe('free');
  expect(await app.evaluate(() => window.__kp.plan.overlayState().snap!.guides)).toEqual([]);

  await app.keyboard.up('Alt');
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().snap?.kind))
    .not.toBe('free');

  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape');
});

test('the snap reach is screen-relative, so zooming in escapes a snap', async ({ app }) => {
  await app.click('#btn-draw-room');

  // the SAME world point, 100 mm off the corner, at two zooms: in reach when
  // 100 mm is a few pixels, out of reach once it is tens of them
  await app.evaluate(() => window.__kp.plan.setViewport({ zoom: 40, panX: 120, panY: 120 }));
  const far = await app.evaluate(() => {
    const v = window.__kp.plan.viewport();
    return { x: 4.1 * v.zoom + v.panX, y: 0 * v.zoom + v.panY };
  });
  const box = (await app.locator('#canvas2d').boundingBox())!;
  await app.mouse.move(box.x + far.x, box.y + far.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().snap?.kind))
    .toBe('endpoint');

  await app.evaluate(() => window.__kp.plan.setViewport({ zoom: 400, panX: 120, panY: 120 }));
  const close = await app.evaluate(() => {
    const v = window.__kp.plan.viewport();
    return { x: 4.1 * v.zoom + v.panX, y: 0 * v.zoom + v.panY };
  });
  await app.mouse.move(box.x + close.x, box.y + close.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().snap?.kind))
    .not.toBe('endpoint');

  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape');
});

test('the grid step is a tool preference, and Off means no rounding', async ({ app }) => {
  await app.click('#btn-draw-room');
  await expect(app.locator('#btn-grid-step')).toBeVisible();

  expect(await app.evaluate(() => window.__kp.plan.toolState().snapGrid)).toBe(0.05);
  await app.selectOption('#btn-grid-step', { label: 'Grid off' });
  await expect.poll(() => app.evaluate(() => window.__kp.plan.toolState().snapGrid)).toBe(null);
  await app.selectOption('#btn-grid-step', { label: 'Grid 10 mm' });
  await expect.poll(() => app.evaluate(() => window.__kp.plan.toolState().snapGrid)).toBe(0.01);

  // and it is a preference, not design data: it survives no undo step
  expect(await app.evaluate(() => window.__kp.store.design.rooms.length)).toBeGreaterThan(0);
  await app.keyboard.press('Escape');
});

test('the dimension HUD shows length and angle, and Tab moves between them', async ({ app }) => {
  await pinViewport(app);
  await app.click('#btn-draw-room');

  await expect(app.locator('#draw-hud')).toHaveCount(0); // nothing pending yet

  await clickPlan(app, 6, 1);
  const p = await at(app, 8, 2.5);
  await app.mouse.move(p.x, p.y);
  await expect(app.locator('#draw-hud')).toBeVisible();
  await expect(app.locator('.draw-hud-field[data-field="length"]')).toHaveClass(/active/);

  await app.keyboard.press('Tab');
  await expect(app.locator('.draw-hud-field[data-field="angle"]')).toHaveClass(/active/);

  // typing an angle re-aims the pending segment WITHOUT waiting for a move
  await app.keyboard.press('9');
  await app.keyboard.press('0');
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().drawRing?.hover?.x))
    .toBeCloseTo(6, 6);

  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape');
  await expect(app.locator('#draw-hud')).toHaveCount(0);
});
