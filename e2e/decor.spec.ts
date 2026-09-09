import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * SET DRESSING — the decor family and drop-to-surface.
 *
 * Three things are pinned here, all of them invisible from the code that
 * implements them: that a decor item placed over a worktop lands ON the
 * worktop rather than on the floor; that dragging it off brings it back down;
 * and that `#btn-decor` takes the whole family out of both canvases without
 * deleting anything.
 */

const VIEW = { zoom: 60, panX: 120, panY: 120 };

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
}

async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

/** A 60 cm base cabinet at (1, 1); returns its id and its worktop height. */
async function oneCabinet(page: Page): Promise<{ id: string; top: number }> {
  return page.evaluate(() => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf('base-cabinet'), 1, 1, 0);
    st.commit();
    return { id: it.id, top: it.elevation + it.h };
  });
}

const elevationOf = (page: Page, id: string): Promise<number> =>
  page.evaluate((i) => window.__kp.store.itemById(i)!.elevation, id);

const drawCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__kp.plan.debug().drawCount);

test('a decor item placed over a worktop rests ON it, not on the floor', async ({ app }) => {
  await pinViewport(app);
  const { top } = await oneCabinet(app);

  await app.click('.cat-item[data-def-id="decor-kettle"]');
  const p = await at(app, 1, 1);
  await app.mouse.click(p.x, p.y);

  const id = await app.evaluate(() => {
    const items = window.__kp.store.design.items;
    return items[items.length - 1].id;
  });
  expect(await elevationOf(app, id)).toBeCloseTo(top, 6);
});

test('the same item placed over bare floor rests at zero', async ({ app }) => {
  await pinViewport(app);
  await oneCabinet(app);

  await app.click('.cat-item[data-def-id="decor-kettle"]');
  const p = await at(app, 3, 2.4); // well clear of the cabinet
  await app.mouse.click(p.x, p.y);

  const id = await app.evaluate(() => {
    const items = window.__kp.store.design.items;
    return items[items.length - 1].id;
  });
  expect(await elevationOf(app, id)).toBe(0);
});

test('dragging a decor item off the counter drops it to the floor', async ({ app }) => {
  await pinViewport(app);
  const { top } = await oneCabinet(app);

  // seat a vase on the counter the way a place would
  const id = await app.evaluate(() => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf('decor-vase'), 1, 1, 0);
    st.updateItem(it.id, { elevation: st.surfaces().find((s) => s.kind === 'worktop')!.top });
    st.commit();
    return it.id;
  });
  expect(await elevationOf(app, id)).toBeCloseTo(top, 6);

  const from = await at(app, 1, 1);
  const to = await at(app, 3, 2.4);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(to.x, to.y, { steps: 12 });
  await app.mouse.up();

  await expect.poll(() => elevationOf(app, id)).toBe(0);
});

test('#btn-decor hides the family from both canvases without deleting it', async ({ app }) => {
  await pinViewport(app);
  await oneCabinet(app);
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('decor-kettle'), 1, 1, 0);
    st.addItem(st.defOf('decor-plant'), 3, 2.4, 0);
    st.commit();
  });

  // 3D carries a group per item; decor is two of them
  const meshCount = (): Promise<number> =>
    app.evaluate(() => {
      window.__kp.view.flushRebuild();
      return window.__kp.view.items.size;
    });
  const withDecor = await meshCount();

  const before = await drawCount(app);
  await app.click('#btn-decor');
  await expect.poll(() => drawCount(app)).toBeGreaterThan(before);

  expect(await meshCount()).toBe(withDecor - 2);
  // nothing was deleted — only hidden
  expect(await app.evaluate(() => window.__kp.store.design.items.length)).toBe(3);
  expect(await app.evaluate(() => window.__kp.editor.decorOn)).toBe(false);

  await app.click('#btn-decor');
  await expect.poll(() => meshCount()).toBe(withDecor);
});

test('every decor tile lives in the Furnish catalog, none in Plan', async ({ app }) => {
  await expect(app.locator('.cat-item[data-def-id="decor-kettle"]')).toBeVisible();
  await app.click('#ws-tab-plan');
  await expect(app.locator('.cat-item[data-def-id="decor-kettle"]')).toHaveCount(0);
});

test('Stage room fills the room and lands exactly one undo step', async ({ app }) => {
  await oneCabinet(app);
  const bare = await app.evaluate(() => window.__kp.store.design.items.length);

  await app.click('#btn-stage');
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.items.length))
    .toBeGreaterThan(bare);
  const staged = await app.evaluate(() => window.__kp.store.design.items.length);

  // ONE step back removes all of it — not one step per staged mug
  await app.keyboard.press('Control+z');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(bare);

  // and Clear removes it without touching the cabinet
  await app.keyboard.press('Control+Shift+z');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(staged);
  await app.click('#btn-unstage');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(bare);
});

test('restaging twice does not pile a second set of clutter on the first', async ({ app }) => {
  await oneCabinet(app);
  await app.click('#btn-stage');
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.items.length))
    .toBeGreaterThan(1);
  const once = await app.evaluate(() => window.__kp.store.design.items.length);

  await app.click('#btn-stage'); // the label now reads "Restage room"
  await expect.poll(() => app.evaluate(() => window.__kp.store.hasStaging())).toBe(true);
  const twice = await app.evaluate(() => window.__kp.store.design.items.length);
  expect(Math.abs(twice - once)).toBeLessThanOrEqual(3); // a re-roll, not a doubling
  expect(twice).toBeLessThan(once * 2);
});
