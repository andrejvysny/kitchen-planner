import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * FIT TO ROOM (D3) — the user-facing entry points only. `src/model/fit.ts`
 * (the pure alcove/ceiling math) and the store wiring (`setItemFit`,
 * `syncDerived`, `updateItem`'s flag-clear rule) are exercised elsewhere;
 * this spec drives the two ROUTES a user has to them — the context menu's
 * "Fit to alcove" entry and the inspector's two toggles — and checks the
 * undo/redo/manual-edit contract end to end.
 *
 * Everything polls store state; no sleeps.
 */

/** Pin the plan transform, so world→screen below is exact rather than fitted. */
const VIEW = { zoom: 60, panX: 120, panY: 120 };

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
}

/** Page coordinates of a plan world point, under the pinned transform. */
async function planAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

async function rightClickPlan(page: Page, x: number, y: number): Promise<void> {
  const p = await planAt(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

const menu = (page: Page) => page.locator('#context-menu');
const entry = (page: Page, cmd: string) => page.locator(`#context-menu button[data-cmd="${cmd}"]`);

/**
 * Place a base cabinet flush against the room's first wall, centred on it —
 * the exact pose `src/model/snapping.ts`'s `snapItem` back-to-wall branch
 * would compute for a drag that landed there. Replicated by hand because this
 * spec drives the store directly rather than a drag gesture, and `fitItem`
 * needs a genuinely wall-hugging pose (rotation + back-face distance) to
 * match the item to the wall at all.
 */
async function placeAgainstWall(page: Page): Promise<{ id: string; x: number; y: number }> {
  return page.evaluate(() => {
    const st = window.__kp.store;
    const def = st.defOf('base-cabinet');
    const wall = st.allWalls()[0];
    const off = wall.faceOffset + def.d / 2;
    const tt = wall.len / 2;
    const foot = { x: wall.a.x + wall.dir.x * tt, y: wall.a.y + wall.dir.y * tt };
    const x = foot.x + wall.inward.x * off;
    const y = foot.y + wall.inward.y * off;
    const rotation = Math.atan2(-wall.inward.x, wall.inward.y);
    const item = st.addItem(def, x, y, rotation);
    st.commit();
    return { id: item.id, x, y };
  });
}

test.describe('fit to room', () => {
  test.beforeEach(async ({ app }) => {
    await app.click('#ws-tab-plan');
    await pinViewport(app);
  });

  test('"Fit to alcove" spans the item, and undo/redo/manual-edit follow the flag rules', async ({
    app,
  }) => {
    const { id, x, y } = await placeAgainstWall(app);
    const before = await app.evaluate((i) => {
      const it = window.__kp.store.itemById(i)!;
      return { w: it.w, h: it.h };
    }, id);

    await rightClickPlan(app, x, y);
    await expect(menu(app)).toBeVisible();
    await expect(entry(app, 'fit-room')).toHaveText(/Fit to alcove/);
    // right-clicking selects what it acts on — the same guard every other
    // item entry relies on
    await expect
      .poll(() => app.evaluate(() => window.__kp.editor.selection))
      .toEqual({ kind: 'item', id });

    await entry(app, 'fit-room').click();
    await expect(menu(app)).toHaveCount(0);

    // width grew to span the alcove (the room's two side walls, with nothing
    // else in the way) — well past a "nudged a little" margin
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.w, id))
      .toBeGreaterThan(before.w + 1.0);
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.width, id)).toBe('walls');

    const expectedH = await app.evaluate((i) => {
      const it = window.__kp.store.itemById(i)!;
      const room = window.__kp.store.activeRoom()!;
      return room.style.wallHeight - it.elevation;
    }, id);
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.h, id))
      .toBeCloseTo(expectedH, 5);
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.height, id)).toBe(
      'ceiling'
    );

    // the resize + both flags are ONE commit — one undo restores the whole
    // pre-fit pose, flags included
    await app.evaluate(() => window.__kp.store.undo());
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.w, id))
      .toBeCloseTo(before.w, 5);
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.h, id)).toBeCloseTo(
      before.h,
      5
    );
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.fit, id)).toBeUndefined();

    // redo lands back on the fitted pose — undo/redo are a full design-swap
    // ('reset'), so the selection is gone and has to be picked up again
    // before the inspector has anything to edit
    await app.evaluate(() => window.__kp.store.redo());
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.width, id))
      .toBe('walls');
    await app.evaluate((i) => window.__kp.editor.select({ kind: 'item', id: i }), id);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Base cabinet');

    // a manual width edit is an override: it clears fit.width, and — because
    // the patch never touched h — leaves fit.height exactly where it was
    const width = app.locator('#props-inner input[data-unit]').first();
    await width.fill('900');
    await width.press('Enter');

    await expect
      .poll(() => app.evaluate((i) => Math.round(window.__kp.store.itemById(i)!.w * 1000), id))
      .toBe(900);
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.width, id))
      .toBeUndefined();
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.height, id)).toBe(
      'ceiling'
    );
  });

  test('the inspector toggles read and write the same fit flags', async ({ app }) => {
    const { id } = await placeAgainstWall(app);
    await app.evaluate((i) => window.__kp.editor.select({ kind: 'item', id: i }), id);
    await expect(app.locator('#props-inner .props-title')).toHaveText('Base cabinet');

    const widthToggle = app.locator('#props-inner .toggle-row', { hasText: 'Width to walls' });
    const heightToggle = app.locator('#props-inner .toggle-row', {
      hasText: 'Height to ceiling',
    });
    // both live inside Dimensions — no new section, per the inspector's pinned list
    await expect(app.locator('#props-inner .prop-section-title').first()).toHaveText('Dimensions');
    await expect(widthToggle).toBeVisible();
    await expect(heightToggle).toBeVisible();

    // the checkbox itself is visually hidden (ToggleRow draws `.track`), so
    // the click lands on the visible span — same as e2e/sidebar.spec.ts
    await widthToggle.locator('.track').click();
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.width, id))
      .toBe('walls');
    expect(
      await app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.height, id)
    ).toBeUndefined();

    await heightToggle.locator('.track').click();
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.fit?.height, id))
      .toBe('ceiling');

    // switching both back off drops the `fit` object entirely, matching the
    // sanitizer's own empty-object rule
    await widthToggle.locator('.track').click();
    await heightToggle.locator('.track').click();
    await expect
      .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.fit, id))
      .toBeUndefined();
  });
});
