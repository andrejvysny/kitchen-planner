import { expect, resetEmpty, test } from './fixtures';

/**
 * EMPTY-STATE AIDS (WS-SPEC §5.4, WP 2.4) — the starter card in Plan, the
 * furnish nudge, and the Workshop parts caption.
 *
 * WS-SPEC's "Plan, no rooms (possible after New)" trigger IS reachable:
 * `emptyDesign()` ships zero rooms and `#btn-new` lands on it (baba3e7). That
 * is exactly what <PlanStarterCard/> gates on — `workspace === 'plan' && tool
 * === 'select' && rooms.length === 0 && !underlayRef()`
 * (src/ui/react/EmptyState.tsx L38-42). The shared `app` fixture SEEDS one room
 * because every other spec needs one, so the card's tests call `resetEmpty`
 * first to get back to the zero-room design.
 *
 * <FurnishNudge/> is a different condition — `workspace === 'furnish' &&
 * items.length === 0` — and says nothing about rooms, which is why its tests do
 * not clear the fixture's room.
 *
 * These two components are new, so they own their ids outright — no
 * dom-contract.spec.ts row: both are conditional (never present at every
 * boot the way that table's rows are), and this file already pins their
 * markup end to end.
 */

test('plan starter card shows with no rooms, hides while a tool is armed, and returns on Escape', async ({
  app,
}) => {
  await resetEmpty(app);
  await app.click('#ws-tab-plan');
  await expect(app.locator('#plan-starter')).toBeVisible();
  await expect(app.locator('#plan-starter')).toContainText('Start with a room');

  const card = app.locator('#plan-starter');
  await card.getByRole('button', { name: 'Draw a room' }).click();
  await expect(app.locator('#plan-starter')).toHaveCount(0);
  expect(await app.evaluate(() => window.__kp.editor.tool)).toBe('drawRoom');

  await app.keyboard.press('Escape');
  expect(await app.evaluate(() => window.__kp.editor.tool)).toBe('select');
  await expect(app.locator('#plan-starter')).toBeVisible();
});

test('the photo-import button on the starter card does the right thing', async ({ app }) => {
  await resetEmpty(app);
  await app.click('#ws-tab-plan');
  const card = app.locator('#plan-starter');

  // "Import a floor plan photo…" is a proxy click onto the hidden file input
  await expect(app.locator('#plan-starter')).toBeVisible();
  const [chooser] = await Promise.all([
    app.waitForEvent('filechooser'),
    card.getByRole('button', { name: /Import a floor plan photo/ }).click(),
  ]);
  expect(chooser).toBeTruthy();
});

/**
 * The two aids answer DIFFERENT questions, and each retires on its own answer:
 * the card asks for a room and goes once one exists (items are irrelevant to
 * it), the nudge asks for something placed and goes once an item exists (rooms
 * are irrelevant to it).
 */
test('a room retires the starter card, an item retires the furnish nudge', async ({ app }) => {
  await resetEmpty(app);
  await app.click('#ws-tab-plan');
  await expect(app.locator('#plan-starter')).toBeVisible();

  // a ROOM is the card's condition — nothing else clears it
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addRoom();
    st.commit();
  });
  await expect(app.locator('#plan-starter')).toHaveCount(0);

  // the nudge is still up: it counts ITEMS, and there are none yet
  await app.click('#ws-tab-furnish');
  await expect(app.locator('#furnish-nudge')).toBeVisible();

  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('base-cabinet'), 2, 2.6, 0);
    st.commit();
  });
  await expect(app.locator('#furnish-nudge')).toHaveCount(0);
});

test('furnish nudge shows on a pristine design, dismisses, and stays dismissed across a workspace round trip', async ({
  app,
}) => {
  // the fixture's own reset lands in Furnish (the persisted default with
  // cleared storage) on a pristine design — no navigation needed to see it
  expect(await app.evaluate(() => window.__kp.workspace())).toBe('furnish');
  await expect(app.locator('#plan-starter')).toHaveCount(0); // Plan-only, never here
  const nudge = app.locator('#furnish-nudge');
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText('Pick something from the library');

  await nudge.getByRole('button', { name: 'Dismiss' }).click();
  await expect(nudge).toHaveCount(0);

  // a session flag, not design data: switching away and back keeps it hidden
  await app.click('#ws-tab-plan');
  await app.click('#ws-tab-furnish');
  await expect(app.locator('#furnish-nudge')).toHaveCount(0);
});

test('workshop parts panel adds the ownership caption under the existing empty-state line', async ({
  app,
}) => {
  // a fresh shared library always seeds one sample part (Store.sharedLibrary());
  // clear it so design.customParts is genuinely empty, the condition both
  // caption lines share
  await app.evaluate(() => {
    const st = window.__kp.store;
    for (const p of [...st.design.customParts]) st.deleteCustomPart(p.id);
    st.commit();
  });

  await app.click('#ws-tab-workshop');
  const captions = app.locator('#workshop-parts .cat-empty');
  await expect(captions).toHaveCount(2);
  await expect(captions.nth(0)).toContainText('Nothing here yet');
  await expect(captions.nth(1)).toContainText(
    'Cabinets here are fully yours — fronts, drawers, interiors.'
  );
});
