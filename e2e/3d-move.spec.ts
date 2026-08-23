import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * DIRECT MANIPULATION IN 3D.
 *
 * Dragging the body of the item that is ALREADY selected moves it across the
 * floor, through the same `snapItem` path the translate gizmo uses. Dragging
 * anything else — empty space, a wall, or an item that is not the selected one
 * — still orbits the camera, which is what every 3D view in the world does and
 * what the first click on an item must keep doing.
 *
 * The arithmetic is exact rather than fitted because of the TOP preset: the
 * pixel a FLOOR point projects to is the pixel whose ray hits that same floor
 * point, so a drag between two projected floor points is a drag by exactly
 * their world delta — and from straight above, those pixels sit over the
 * item's own body, which is what the press has to hit.
 */

/** Test cabinet footprint: wide enough to grab well clear of the gizmo handles. */
const CAB_W = 2.4;
const CAB_D = 1.6;

/**
 * Where the drag grabs, as a floor offset from the item centre (metres).
 * Inside the footprint (half-extents 1.2 x 0.8) and outside every translate
 * picker: those cones reach ~1.17 m along each world axis with a radius of
 * ~0.28 m at 0.85 m out, so 0.5 m off-axis clears them by ~0.22 m.
 */
const GRAB = { x: -0.85, y: 0.5 };

/** How far the gesture drags, in metres — clear of every wall snap band. */
const DELTA = { x: 0.4, y: -0.3 };

/** Enough pointer samples that ONE stray inspector subscription would show up. */
const DRAG_STEPS = 40;

interface Placed {
  id: string;
  x: number;
  y: number;
}

const pose = (page: Page, id: string): Promise<{ x: number; y: number }> =>
  page.evaluate((i) => {
    const it = window.__kp.store.itemById(i)!;
    return { x: it.x, y: it.y };
  }, id);

const moving = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.__kp.view.movingItemId);

const commits = (page: Page): Promise<number> =>
  page.evaluate(() => window.__kp.debug.renderCounts.propsBody ?? 0);

const version = (page: Page, ch: 'transient' | 'history'): Promise<number> =>
  page.evaluate((c) => window.__kp.bridge.getVersion(c as 'transient'), ch);

const camPos = (page: Page): Promise<{ x: number; y: number; z: number }> =>
  page.evaluate(() => window.__kp.view.cameraPose().position);

/**
 * A wide cabinet at the centre of the fixture room, framed by `preset`, and
 * selected or not as the case under test needs. Deliberately free-standing in
 * the middle of the floor: `snapItem` only rounds a free pose to the 1 cm grid,
 * so the drag's landing spot is the drag's own arithmetic.
 */
async function placeCabinet(
  page: Page,
  opts: { select: boolean; preset: 'top' | 'corner' }
): Promise<Placed> {
  return page.evaluate(
    (a) => {
      const kp = window.__kp;
      const st = kp.store;
      const corners = st.design.rooms[0].corners;
      const c = corners.reduce(
        (s, k) => ({ x: s.x + k.x / corners.length, y: s.y + k.y / corners.length }),
        { x: 0, y: 0 }
      );
      const item = st.addItem(st.defOf('base-cabinet'), c.x, c.y, 0);
      st.updateItem(item.id, { w: a.w, d: a.d });
      st.commit();
      window.__kp.editor.select(a.select ? { kind: 'item', id: item.id } : { kind: 'none' });
      kp.view.setPreset(a.preset as 'top');
      kp.view.flushRebuild();
      return { id: item.id, x: item.x, y: item.y };
    },
    { w: CAB_W, d: CAB_D, select: opts.select, preset: opts.preset }
  );
}

/** Page coordinates of the pixel whose ray hits the floor point (x, y). */
async function floorPx(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas3d').boundingBox())!;
  const s = await page.evaluate((p) => window.__kp.view.worldToScreen(p.x, 0, p.y), { x, y });
  expect(s.x, 'floor point projected off-canvas').toBeGreaterThan(0);
  expect(s.x).toBeLessThan(box.width);
  expect(s.y, 'floor point projected off-canvas').toBeGreaterThan(0);
  expect(s.y).toBeLessThan(box.height);
  return { x: box.x + s.x, y: box.y + s.y };
}

/** Page coordinates of the item's own centre, half its height up. */
async function bodyPx(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas3d').boundingBox())!;
  const s = await page.evaluate((i) => {
    const it = window.__kp.store.itemById(i)!;
    // the item group only — a wall in front of it cannot steal the pick
    return window.__kp.view.worldToScreen(it.x, it.h / 2, it.y);
  }, id);
  return { x: box.x + s.x, y: box.y + s.y };
}

async function dragTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = DRAG_STEPS
): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps
    );
  }
}

test('dragging the selected item moves it by the world delta, in one undo step', async ({
  app,
}) => {
  // ~21s solo on SwiftShader; blows the 60s budget under full-suite
  // parallelism, like the coach-marks walks. slow() triples the timeout.
  test.slow();
  const cab = await placeCabinet(app, { select: true, preset: 'top' });
  const from = await floorPx(app, cab.x + GRAB.x, cab.y + GRAB.y);
  const to = await floorPx(app, cab.x + GRAB.x + DELTA.x, cab.y + GRAB.y + DELTA.y);

  const historyBefore = await version(app, 'history');

  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  // the press landed on the body — not on a gizmo handle, not on empty space
  expect(await moving(app), 'no free-move gesture began').toBe(cab.id);

  await dragTo(app, from, to);
  await app.mouse.up();
  expect(await moving(app), 'the gesture outlived its pointerup').toBe(null);

  // the grab offset is preserved, so the ITEM moved by the same delta the
  // cursor did — a jump-to-cursor would land it on the cursor instead
  const after = await pose(app, cab.id);
  expect(Math.abs(after.x - (cab.x + DELTA.x)), `x landed at ${after.x}`).toBeLessThan(0.02);
  expect(Math.abs(after.y - (cab.y + DELTA.y)), `y landed at ${after.y}`).toBeLessThan(0.02);

  // one gesture, ONE undo step — the transient writes in between are not history
  expect(await version(app, 'history'), 'the drag was not one undo step').toBe(historyBefore + 1);

  await app.evaluate(() => window.__kp.store.undo());
  const undone = await pose(app, cab.id);
  expect(undone.x).toBeCloseTo(cab.x, 6);
  expect(undone.y).toBeCloseTo(cab.y, 6);
});

test('dragging an UNSELECTED item orbits the camera and leaves the item alone', async ({ app }) => {
  test.slow(); // see the first test's note
  const cab = await placeCabinet(app, { select: false, preset: 'corner' });
  const before = await camPos(app);
  const poseBefore = await pose(app, cab.id);

  const from = await bodyPx(app, cab.id);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();

  // today's behaviour, unchanged: the first press only selects
  expect(await moving(app), 'an unselected item started a move gesture').toBe(null);
  expect(
    await app.evaluate(() => {
      const sel = window.__kp.editor.selection;
      return sel.kind === 'item' ? sel.id : sel.kind;
    })
  ).toBe(cab.id);

  await dragTo(app, from, { x: from.x + 90, y: from.y + 45 });
  await app.mouse.up();

  // the camera went somewhere (damping settles over frames, so poll)…
  await expect
    .poll(
      async () => {
        const p = await camPos(app);
        return Math.hypot(p.x - before.x, p.y - before.y, p.z - before.z);
      },
      { message: 'the drag neither orbited nor moved anything' }
    )
    .toBeGreaterThan(0.2);
  // …and the item did not: byte-identical, not merely close
  expect(await pose(app, cab.id)).toEqual(poseBefore);
});

test('a 3D move never re-renders the inspector, and commits once at the end', async ({ app }) => {
  test.slow(); // see the first test's note
  const cab = await placeCabinet(app, { select: true, preset: 'top' });
  const from = await floorPx(app, cab.x + GRAB.x, cab.y + GRAB.y);
  const to = await floorPx(app, cab.x + GRAB.x + DELTA.x, cab.y + GRAB.y + DELTA.y);

  // press first: a press can select, and a selection is exactly what this panel
  // is supposed to rebuild for. The count is taken from after it.
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();
  expect(await moving(app), 'no free-move gesture began').toBe(cab.id);

  const before = await commits(app);
  const transientBefore = await version(app, 'transient');

  await dragTo(app, from, to);

  // the store notified at pointer rate…
  expect(
    (await version(app, 'transient')) - transientBefore,
    'the drag produced no transient notifications'
  ).toBeGreaterThanOrEqual(DRAG_STEPS / 2);
  // …and the inspector did not commit a single render
  expect(await commits(app), 'PropsBody re-rendered during a 3D drag').toBe(before);

  await app.mouse.up();
  // the gesture end commits, so exactly one rebuild is allowed to land
  await expect.poll(() => commits(app)).toBeGreaterThan(before);
});
