import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * MULTI-SELECTION (M18) — the gestures that grow and shrink the selection, and
 * the two rules underneath them: a multi-selection is ITEMS-ONLY (a wall, a
 * corner or an opening always replaces), and the PRIMARY is the last entity
 * added, which is what the inspector titles itself after and what a drag snaps.
 *
 * The selection lives on EditorState, so every assertion reads
 * `window.__kp.editor` — `store.selection` no longer exists.
 */

const VIEW = { zoom: 60, panX: 120, panY: 120 };

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
}

/** A click with Shift held — `mouse.click` takes no modifiers, the keyboard does. */
async function shiftClick(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
}

async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

/** Three 60 cm base cabinets in a row along y = 1, at x = 1.0 / 2.0 / 3.0. */
async function threeCabinets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const st = window.__kp.store;
    const def = st.defOf('base-cabinet');
    const ids = [1.0, 2.0, 3.0].map((x) => st.addItem(def, x, 1.0, 0).id);
    st.commit();
    return ids;
  });
}

const heldIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__kp.editor.selectedItemIds());

const primary = (page: Page): Promise<unknown> => page.evaluate(() => window.__kp.editor.selection);

test.beforeEach(async ({ app }) => {
  await app.click('#ws-tab-furnish');
  await pinViewport(app);
});

test('Shift-click adds items, and clicking one again drops it', async ({ app }) => {
  const [a, b, c] = await threeCabinets(app);

  const pa = await at(app, 1.0, 1.0);
  await app.mouse.click(pa.x, pa.y);
  await expect.poll(() => heldIds(app)).toEqual([a]);

  const pb = await at(app, 2.0, 1.0);
  await shiftClick(app, pb);
  const pc = await at(app, 3.0, 1.0);
  await shiftClick(app, pc);
  await expect.poll(() => heldIds(app)).toEqual([a, b, c]);
  // the primary is the LAST one added
  await expect.poll(() => primary(app)).toEqual({ kind: 'item', id: c });

  // Shift-clicking a held item removes it, and the primary falls back
  await shiftClick(app, pc);
  await expect.poll(() => heldIds(app)).toEqual([a, b]);
  await expect.poll(() => primary(app)).toEqual({ kind: 'item', id: b });
});

test('a plain click on one member collapses the selection to it', async ({ app }) => {
  const [a, b] = await threeCabinets(app);
  await app.evaluate(
    (ids) => window.__kp.editor.selectRefs(ids.map((id) => ({ kind: 'item', id }) as const)),
    [a, b]
  );

  const pa = await at(app, 1.0, 1.0);
  await app.mouse.click(pa.x, pa.y);
  await expect.poll(() => heldIds(app)).toEqual([a]);
});

test('a wall REPLACES a multi-selection — mixed kinds are never held', async ({ app }) => {
  const [a, b] = await threeCabinets(app);
  await app.evaluate(
    (ids) => window.__kp.editor.selectRefs(ids.map((id) => ({ kind: 'item', id }) as const)),
    [a, b]
  );
  await expect.poll(() => heldIds(app)).toHaveLength(2);

  // the top wall of the 4x3 room runs along y = 0
  const w = await at(app, 2.0, 0.0);
  await shiftClick(app, w);

  await expect.poll(() => app.evaluate(() => window.__kp.editor.selection.kind)).toBe('wall');
  await expect.poll(() => app.evaluate(() => window.__kp.editor.entities.length)).toBe(1);
});

test('dragging empty space rubber-bands everything fully inside it', async ({ app }) => {
  const [a, b] = await threeCabinets(app);

  // a band around the first two cabinets only; the third sits outside it
  const from = await at(app, 0.4, 0.4);
  const to = await at(app, 2.5, 1.6);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(to.x, to.y, { steps: 8 });
  await app.mouse.up();

  await expect.poll(() => heldIds(app)).toEqual([a, b]);
});

test('a band that only clips an item does not take it', async ({ app }) => {
  await threeCabinets(app);

  // ends halfway through the first cabinet: touched, not enclosed
  const from = await at(app, 0.4, 0.4);
  const to = await at(app, 1.0, 1.6);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(to.x, to.y, { steps: 8 });
  await app.mouse.up();

  await expect.poll(() => heldIds(app)).toEqual([]);
});

test('Shift while banding unions with what is already held', async ({ app }) => {
  const [a, b, c] = await threeCabinets(app);

  const pc = await at(app, 3.0, 1.0);
  await app.mouse.click(pc.x, pc.y);
  await expect.poll(() => heldIds(app)).toEqual([c]);

  const from = await at(app, 0.4, 0.4);
  const to = await at(app, 2.5, 1.6);
  await app.keyboard.down('Shift');
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(to.x, to.y, { steps: 8 });
  await app.mouse.up();
  await app.keyboard.up('Shift');

  await expect.poll(() => heldIds(app)).toEqual([c, a, b]);
});

test('a click on empty floor still clears the selection', async ({ app }) => {
  const [a] = await threeCabinets(app);
  const pa = await at(app, 1.0, 1.0);
  await app.mouse.click(pa.x, pa.y);
  await expect.poll(() => heldIds(app)).toEqual([a]);

  const empty = await at(app, 3.6, 2.6);
  await app.mouse.click(empty.x, empty.y);
  await expect.poll(() => app.evaluate(() => window.__kp.editor.selection.kind)).toBe('none');
});

test('right-drag still pans, now that the left button bands', async ({ app }) => {
  await threeCabinets(app);
  const before = await app.evaluate(() => window.__kp.plan.viewport().panX);

  const from = await at(app, 1.0, 2.5);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down({ button: 'right' });
  await app.mouse.move(from.x + 80, from.y, { steps: 6 });
  await app.mouse.up({ button: 'right' });

  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.viewport().panX))
    .toBeCloseTo(before + 80, 0);
  await expect.poll(() => heldIds(app)).toEqual([]);
});

test('Ctrl+A takes every item in the active room', async ({ app }) => {
  const ids = await threeCabinets(app);
  await app.locator('#canvas2d').click({ position: { x: 5, y: 5 } });
  await app.keyboard.press('Control+a');
  await expect.poll(() => heldIds(app)).toEqual(ids);
});

test('dragging one member moves the whole set, and only the primary snaps', async ({ app }) => {
  const [a, b, c] = await threeCabinets(app);
  await app.evaluate(
    (ids) => window.__kp.editor.selectRefs(ids.map((id) => ({ kind: 'item', id }) as const)),
    [a, b, c]
  );

  const before = await app.evaluate(() => {
    const st = window.__kp.store;
    return st.design.items.map((it) => ({ id: it.id, x: it.x, y: it.y }));
  });

  // press the middle cabinet and drag it 1 m to the right, well clear of a wall
  const from = await at(app, 2.0, 1.0);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  await app.mouse.move(from.x + 60, from.y, { steps: 10 });
  await app.mouse.up();

  const after = await app.evaluate(() => {
    const st = window.__kp.store;
    return st.design.items.map((it) => ({ id: it.id, x: it.x, y: it.y }));
  });

  const dx = (id: string): number =>
    after.find((i) => i.id === id)!.x - before.find((i) => i.id === id)!.x;
  expect(dx(b)).toBeGreaterThan(0.5);
  // the set is rigid: every member took the SAME delta the dragged one did
  expect(dx(a)).toBeCloseTo(dx(b), 6);
  expect(dx(c)).toBeCloseTo(dx(b), 6);
  // the set survives the drag; pressing b promoted it to primary, which is
  // what made it the one that snapped
  await expect.poll(() => heldIds(app).then((ids) => [...ids].sort())).toEqual([a, b, c].sort());
  await expect.poll(() => primary(app)).toEqual({ kind: 'item', id: b });
});

test('R turns the set about its middle, and one undo puts it back', async ({ app }) => {
  const ids = await threeCabinets(app);
  await app.evaluate(
    (list) => window.__kp.editor.selectRefs(list.map((id) => ({ kind: 'item', id }) as const)),
    ids
  );
  const before = await app.evaluate(() =>
    window.__kp.store.design.items.map((it) => ({ id: it.id, x: it.x, y: it.y, r: it.rotation }))
  );

  await app.keyboard.press('r');

  const after = await app.evaluate(() =>
    window.__kp.store.design.items.map((it) => ({ id: it.id, x: it.x, y: it.y, r: it.rotation }))
  );
  // the middle one is the centre of the set, so it stays put and only turns
  const mid = (list: typeof before, id: string) => list.find((i) => i.id === id)!;
  expect(mid(after, ids[1]).x).toBeCloseTo(mid(before, ids[1]).x, 6);
  expect(mid(after, ids[1]).r).toBeCloseTo(mid(before, ids[1]).r + Math.PI / 2, 6);
  // the outer two swing round it
  expect(mid(after, ids[0]).y).not.toBeCloseTo(mid(before, ids[0]).y, 2);

  await app.keyboard.press('Control+z');
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.items.map((it) => it.rotation)))
    .toEqual(before.map((i) => i.r));
});

test('Delete removes every held item in ONE undo step', async ({ app }) => {
  const ids = await threeCabinets(app);
  await app.evaluate(
    (list) => window.__kp.editor.selectRefs(list.map((id) => ({ kind: 'item', id }) as const)),
    ids
  );

  await app.keyboard.press('Delete');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(0);

  await app.keyboard.press('Control+z');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(3);
});

test('Ctrl+D duplicates the whole set and selects the copies', async ({ app }) => {
  const ids = await threeCabinets(app);
  await app.evaluate(
    (list) => window.__kp.editor.selectRefs(list.map((id) => ({ kind: 'item', id }) as const)),
    ids
  );

  await app.keyboard.press('Control+d');
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(6);

  const held = await heldIds(app);
  expect(held).toHaveLength(3);
  for (const id of held) expect(ids).not.toContain(id);
});
