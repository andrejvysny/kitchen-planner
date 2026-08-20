import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * LIVE-APPLY IN THE WORKSHOP (WS-SPEC WP 3.1).
 *
 * The Part Studio has no Save, no Revert and no dirty guard any more: every
 * field writes straight through `store.updateCustomPart`, so the plan, the 3D
 * scene and the placed instances follow the edit, and Ctrl+Z is the way back.
 *
 * Three things are only observable in a browser and are what this suite is for:
 *  - a preset opened in the Workshop MATERIALIZES as a design-local shadow
 *    under its own id, so the instances already placed from it follow;
 *  - undo lands while the studio is still open, and the editor shows the
 *    reverted value rather than a stale draft;
 *  - leaving after merely LOOKING at a preset removes the shadow again, while
 *    leaving after an edit keeps it.
 *
 * The store mutations behind all three are unit-tested in
 * test/unit/livePart.test.ts; what is left for here is the wiring.
 */

const PRESET = 'base-drawers'; // a root `drawers` leaf — the toolbar stepper edits it

/** The design-local shadow of `PRESET`, or null while the preset is untouched. */
const shadow = (page: Page): Promise<{ drawers: number } | null> =>
  page.evaluate((id) => {
    const p = window.__kp.store.customPartById(id);
    return p && p.type === 'cabinet' && p.face.kind === 'leaf'
      ? { drawers: p.face.drawers ?? 0 }
      : null;
  }, PRESET);

/** What a PLACED instance resolves its def to — the thing the user sees in 3D. */
const placedDrawers = (page: Page, itemId: string): Promise<number> =>
  page.evaluate((id) => {
    const st = window.__kp.store;
    const part = st.partOf(st.itemById(id)!.defId)!;
    return part.type === 'cabinet' && part.face.kind === 'leaf' ? (part.face.drawers ?? 0) : 0;
  }, itemId);

/** Place one instance of the preset and leave it selected-free in the design. */
async function placePreset(page: Page): Promise<string> {
  const id = await page.evaluate((defId) => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf(defId), 1.2, 1.2, 0);
    st.commit();
    st.select({ kind: 'none' });
    return it.id;
  }, PRESET);
  return id;
}

/** Open the preset in the Workshop through its sidebar row, and select its zone. */
async function openPresetInWorkshop(page: Page): Promise<void> {
  await page.click('#ws-tab-workshop');
  await page.click(`.wsp-row[data-part-id="${PRESET}"]`);
  await expect(page.locator('#pane-workshop .studio-body .studio-form')).toBeVisible();
}

/** Click the middle of the zone canvas so the root leaf's toolbar appears. */
async function selectRootZone(page: Page): Promise<void> {
  const box = (await page.locator('.zone-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.zone-stepper')).toBeVisible();
}

const stepDrawers = (page: Page): Promise<void> =>
  page.locator('.zone-stepper', { hasText: 'Drawers' }).locator('button').nth(1).click();

/** How many sliding/hinging fronts the item's live 3D mesh group carries. */
const motionUnits = (page: Page, itemId: string): Promise<number> =>
  page.evaluate((id) => {
    // `view.items` flushes the queued rebuild itself, so this reads the scene
    // the user would see even though the Workshop pane is covering it
    const entry = window.__kp.view.items.get(id);
    if (!entry) return -1;
    let n = 0;
    entry.group.traverse((o) => {
      if (o.userData.motionUnit) n++;
    });
    return n;
  }, itemId);

test('editing a preset in the Workshop reaches its placed instances at once', async ({ app }) => {
  const itemId = await placePreset(app);
  expect(await placedDrawers(app, itemId)).toBe(3);
  expect(await shadow(app)).toBeNull();
  const fronts = await motionUnits(app, itemId);
  expect(fronts).toBeGreaterThan(0);

  await openPresetInWorkshop(app);
  // opening MATERIALIZES: the preset is deep-frozen and lives outside the
  // design, so the studio edits a design-local shadow under the SAME id (D4)
  await expect.poll(() => shadow(app)).toEqual({ drawers: 3 });

  await selectRootZone(app);
  await stepDrawers(app);

  // no Save was pressed and the studio never left: the def, and the instance
  // resolving through it, are already at 4
  await expect.poll(() => shadow(app)).toEqual({ drawers: 4 });
  await expect.poll(() => placedDrawers(app, itemId)).toBe(4);
  // …and the 3D scene really did rebuild off it: one more drawer front
  await expect.poll(() => motionUnits(app, itemId)).toBe(fronts + 1);
});

test('Ctrl+Z reverts the edit with the studio still open, showing the old value', async ({
  app,
}) => {
  const itemId = await placePreset(app);
  await openPresetInWorkshop(app);
  await selectRootZone(app);
  await stepDrawers(app);
  await expect.poll(() => shadow(app)).toEqual({ drawers: 4 });

  // the studio is a workspace pane, not a modal: the global key map reaches it
  // (WP 3.1 / decision D2 removed the suppression that used to eat this). The
  // blur only defeats the OTHER gate — a Ctrl+Z inside a text field is the
  // field's own undo, and that one is deliberately untouched.
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.keyboard.press('Control+z');

  await expect.poll(() => placedDrawers(app, itemId)).toBe(3);
  // the editor is still up, on the same part, and reads the REVERTED value
  await expect(app.locator('#pane-workshop .studio-body .studio-form')).toBeVisible();
  await expect(app.locator('.studio-name')).toHaveValue('Drawer unit');
  await selectRootZone(app);
  await expect(app.locator('.zone-stepper', { hasText: 'Drawers' }).locator('span')).toHaveText(
    '3'
  );
});

test('leaving after only LOOKING at a preset discards the shadow; an edit keeps it', async ({
  app,
}) => {
  const before = await app.evaluate(() => window.__kp.store.design.customParts.length);

  await openPresetInWorkshop(app);
  await expect.poll(() => shadow(app)).not.toBeNull();
  await app.click('#wsp-back');
  await expect(app.locator('.studio')).toHaveCount(0);
  // discard-if-pristine: browsing the built-ins leaves nothing in "My parts"
  await expect.poll(() => shadow(app)).toBeNull();
  expect(await app.evaluate(() => window.__kp.store.design.customParts.length)).toBe(before);

  await openPresetInWorkshop(app);
  await selectRootZone(app);
  await stepDrawers(app);
  await app.click('#wsp-back');
  await expect(app.locator('.studio')).toHaveCount(0);
  await expect.poll(() => shadow(app)).toEqual({ drawers: 4 });
  expect(await app.evaluate(() => window.__kp.store.design.customParts.length)).toBe(before + 1);
});
