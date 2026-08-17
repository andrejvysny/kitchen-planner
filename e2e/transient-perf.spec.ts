import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * THE TRANSIENT RULE, as an executable assertion.
 *
 * CLAUDE.md: a mid-gesture `notify({transient: true})` fires at pointer rate
 * and must NOT rebuild the properties panel. src/ui/ui.ts honoured that by
 * reaching across the document for `input[data-cls=…]` and writing the six
 * dragged values by hand (refreshTransientInputs). The React inspector honours
 * it by subscribing only to 'selection' / 'history' / 'activeRoom', and by
 * letting the individual live fields listen to 'transient' and write into
 * their own uncontrolled node (src/ui/react/fields/useLiveValue.ts).
 *
 * Neither arrangement is visible in the DOM — both end with the right number
 * in the box — so the assertion has to be about renders, and that needs a
 * counter the page hands out: `window.__kp.debug.renderCounts` (see
 * src/ui/react/debugCounters.ts).
 *
 * The gesture is measured in transient NOTIFICATIONS rather than in seconds: a
 * wall-clock drag would be a sleep, which this suite does not do (CLAUDE.md —
 * E2E waits poll, never sleep), and the notification count is what the rule is
 * actually about.
 */

/** Pin the plan transform, so world→screen below is exact rather than fitted. */
const VIEW = { zoom: 60, panX: 120, panY: 120 };

/** Enough pointer samples that ONE stray subscription would show up loudly. */
const DRAG_STEPS = 60;

/** Page coordinates of a plan world point, under the pinned transform. */
async function at(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

const commits = (page: Page): Promise<number> =>
  page.evaluate(() => window.__kp.debug.renderCounts.propsBody ?? 0);

const version = (page: Page, ch: 'transient' | 'history'): Promise<number> =>
  page.evaluate((c) => window.__kp.bridge.getVersion(c as 'transient'), ch);

test('dragging an item never re-renders the inspector, yet its fields follow', async ({ app }) => {
  await app.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);

  const pose = await app.evaluate(() => {
    const st = window.__kp.store;
    const item = st.addItem(st.defOf('base-cabinet'), 2.0, 1.5, 0);
    st.commit();
    st.select({ kind: 'item', id: item.id });
    return { id: item.id, x: item.x, y: item.y };
  });

  const posX = app.locator('#props-inner input[data-cls="pos-x"]');
  await expect(posX).toHaveCount(1);
  const shownBefore = await posX.inputValue();

  // press on the item FIRST: a press is also a selection, and a selection is
  // exactly the kind of event this panel is supposed to rebuild for. The count
  // is taken from there, so what it measures is the drag and nothing else.
  const from = await at(app, pose.x, pose.y);
  await app.mouse.move(from.x, from.y);
  await app.mouse.down();

  const before = await commits(app);
  const transientBefore = await version(app, 'transient');

  for (let i = 1; i <= DRAG_STEPS; i++) await app.mouse.move(from.x + i, from.y + i * 0.5);

  // mid-gesture: the store has notified many times over…
  expect(
    (await version(app, 'transient')) - transientBefore,
    'the drag produced no transient notifications — the gesture missed the item'
  ).toBeGreaterThanOrEqual(DRAG_STEPS / 2);

  // …the panel has not committed a single render…
  expect(await commits(app), 'PropsBody re-rendered during a drag').toBe(before);

  // …and the position box has followed the item anyway.
  const live = await app.evaluate((id) => {
    const it = window.__kp.store.itemById(id)!;
    const box = document.querySelector<HTMLInputElement>('#props-inner input[data-cls="pos-x"]')!;
    return { model: it.x, shown: box.value };
  }, pose.id);
  expect(live.shown, 'the live field never moved').not.toBe(shownBefore);
  expect(Math.abs(Number(live.shown) / 100 - live.model)).toBeLessThan(0.02);

  await app.mouse.up();

  // the gesture end commits, so exactly one rebuild is allowed to land
  await expect.poll(() => commits(app)).toBeGreaterThan(before);
});

test('a slider drag re-renders nothing either, and lands one undo step at the end', async ({
  app,
}) => {
  const slider = app.locator('#props-inner .prop-row', { hasText: 'Brightness' }).locator('input');
  await expect(slider).toHaveCount(1);
  // the Lighting section sits below the fold of a long room panel, and
  // boundingBox() reports where the element IS, not where it could be
  await slider.scrollIntoViewIfNeeded();
  const track = (await slider.boundingBox())!;

  const before = await commits(app);
  const historyBefore = await version(app, 'history');
  await app.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await app.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await app.mouse.move(track.x + track.width / 2 + i, track.y + track.height / 2);
  }

  // the scene followed the thumb, live, without the panel rebuilding under it
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.scene.brightness))
    .toBeGreaterThan(1);
  expect(await commits(app), 'PropsBody re-rendered while a slider moved').toBe(before);
  // …and no undo step has been taken yet: a slider is ONE gesture, not twenty
  expect(await version(app, 'history')).toBe(historyBefore);

  await app.mouse.up();
  await expect.poll(() => version(app, 'history')).toBe(historyBefore + 1);
});
