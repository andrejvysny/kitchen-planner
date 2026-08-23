import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * THE CATALOG AND THE COMPONENTS OUTLINE — React owns both (T4).
 *
 * What these specs cover that test/interact.mjs cannot: it clicks catalog tiles
 * roughly fifteen times but never asserts what a tile DOES beyond the item
 * landing in the plan — no `.armed` marker, no toggle-off, no drawer close, no
 * keyboard path, and nothing at all about the ✎ button. On the outline side it
 * checks one group title and one row click; the group ORDER, the counts, the
 * empty-design shape and the Enter path are untested.
 *
 * The grouping rules themselves are unit-tested (test/unit/outlineModel.test.ts)
 * — what is left for a browser is the wiring: which store call a row makes and
 * which class it wears afterwards.
 */

/** Pin the plan transform, so world→screen below is exact rather than fitted. */
const VIEW = { zoom: 60, panX: 120, panY: 120 };

/** Move to a plan point and click it, the way a user reaches it. */
async function clickPlan(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
  const box = (await page.locator('#canvas2d').boundingBox())!;
  const p = { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

const armed = (page: Page): Promise<{ tool: string; def: string | null }> =>
  page.evaluate(() => ({ tool: window.__kp.editor.tool, def: window.__kp.editor.armedDefId }));

/** The whole outline as data: group titles with their counts and row labels. */
function outline(page: Page): Promise<{ total: string; groups: unknown[] }> {
  return page.evaluate(() => ({
    total: document.querySelector('#outline .ol-total')!.textContent!,
    groups: [...document.querySelectorAll('#outline .ol-group')].map((g) => ({
      title: g.querySelector('.ol-label')!.textContent,
      count: g.querySelector('.ol-count')!.textContent,
      rows: [...g.querySelectorAll('.ol-row')].map((r) => r.textContent!.trim()),
    })),
  }));
}

/** The design test/interact.mjs never builds: one of everything the outline groups. */
async function seed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('base-cabinet'), 1.0, 1.0, 0);
    st.addItem(st.defOf('fridge'), 2.0, 1.0, 0);
    st.addItem(st.defOf('base-cabinet'), 3.0, 1.0, 0);
    st.addItem(st.defOf(st.design.customParts[0].id), 1.5, 2.0, 0);
    st.addOpening(st.defOf('door'), st.allWalls()[0].id, 1.2);
    st.commit();
  });
  await page.click('#tab-btn-components');
}

test('a tile arms the place tool, marks itself and closes the drawer', async ({ app }) => {
  // the drawer handle is display:none above 900px, so open it programmatically:
  // the `.open` class is what a tile has to clear, whatever the viewport
  await app.evaluate(() => document.getElementById('btn-catalog')!.click());
  await expect(app.locator('#catalog')).toHaveClass(/open/);

  const tile = app.locator('.cat-item[data-def-id="base-cabinet"]');
  await tile.click();
  await expect(tile).toHaveClass(/armed/);
  expect(await armed(app)).toEqual({ tool: 'place', def: 'base-cabinet' });
  // exactly one tile wears the marker, and the drawer is out of the way
  await expect(app.locator('.cat-item.armed')).toHaveCount(1);
  await expect(app.locator('#catalog')).not.toHaveClass(/open/);

  // arming a second tile moves the marker rather than adding one
  // (fridge, not window: window moved to the Plan workspace only — WS-SPEC
  // §4.3 — and switching workspace itself drops the armed tool)
  const other = app.locator('.cat-item[data-def-id="fridge"]');
  await other.click();
  expect(await armed(app)).toEqual({ tool: 'place', def: 'fridge' });
  await expect(app.locator('.cat-item.armed')).toHaveCount(1);
  await expect(other).toHaveClass(/armed/);

  // clicking the armed tile again drops back to the resting state
  await other.click();
  expect(await armed(app)).toEqual({ tool: 'select', def: null });
  await expect(app.locator('.cat-item.armed')).toHaveCount(0);
});

test('Enter on a focused tile arms it, exactly as a click does', async ({ app }) => {
  const tile = app.locator('.cat-item[data-def-id="base-cabinet"]');
  await tile.focus();
  await app.keyboard.press('Enter');
  expect(await armed(app)).toEqual({ tool: 'place', def: 'base-cabinet' });
  await expect(tile).toHaveClass(/armed/);

  // Space is the other activation key a role="button" owes, and it toggles too
  await app.keyboard.press(' ');
  expect(await armed(app)).toEqual({ tool: 'select', def: null });
  await expect(app.locator('.cat-item.armed')).toHaveCount(0);
});

test('an armed tile places its def into the plan and disarms itself', async ({ app }) => {
  await app.click('.cat-item[data-def-id="base-cabinet"]');
  await clickPlan(app, 2.0, 1.5);

  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.items.map((i) => i.defId)))
    .toEqual(['base-cabinet']);
  // a plain click places once and lets go of the tool (Shift is the keep path)
  expect(await armed(app)).toEqual({ tool: 'select', def: null });
  await expect(app.locator('.cat-item.armed')).toHaveCount(0);

  // and the new item shows up in the outline under its catalog section
  await app.click('#tab-btn-components');
  expect(await outline(app)).toEqual({
    total: '1',
    groups: [
      { title: 'Rooms', count: '1', rows: ['Room 112.0 m²'] },
      { title: 'Kitchen · base units', count: '1', rows: ['Base cabinet'] },
    ],
  });
});

/**
 * Both catalog routes into the Part Studio are NAVIGATIONS now (WS-SPEC WP
 * 1.6): they switch to the Workshop workspace, where the studio is built into
 * #pane-workshop rather than into a body modal. Back returns to the workspace
 * the edit started from, and there is nothing to save on the way — WP 3.1 made
 * every field write straight through to the design.
 */
test('＋ New part opens the type picker; ✎ opens an existing part in the editor', async ({
  app,
}) => {
  const part = await app.evaluate(() => {
    const p = window.__kp.store.design.customParts[0];
    return { id: p.id, name: p.name };
  });

  // ＋ New part: the picker stage, and no part loaded yet
  await app.click('.cat-item.cat-new');
  await expect(app.locator('#ws-tab-workshop')).toHaveClass(/active/);
  await expect(app.locator('#pane-workshop .studio-hosted .studio-cards')).toBeVisible();
  expect(await app.locator('.studio-card').count()).toBeGreaterThanOrEqual(2);

  // Back leaves the Workshop for the workspace the edit started from
  await app.click('#wsp-back');
  await expect(app.locator('#ws-tab-furnish')).toHaveClass(/active/);
  await expect(app.locator('.studio')).toHaveCount(0);

  // ✎ on a custom part tile: the editor stage, that part's name in the field,
  // and the place tool dropped on the way in
  await app.click('.cat-item[data-def-id="base-cabinet"]');
  expect(await armed(app)).toEqual({ tool: 'place', def: 'base-cabinet' });
  await app.locator(`.cat-item-wrap:has([data-def-id="${part.id}"]) .cat-edit`).click();
  await expect(app.locator('#ws-tab-workshop')).toHaveClass(/active/);
  await expect(app.locator('#pane-workshop .studio-body .studio-form')).toBeVisible();
  await expect(app.locator('.studio-name')).toHaveValue(part.name);
  await expect(app.locator('.studio-live-note')).toBeVisible();
  expect(await armed(app)).toEqual({ tool: 'select', def: null });

  // renaming lands in the store on the spot — no Save button to press
  await app.locator('.studio-name').fill('Renamed part');
  await app.locator('.studio-name').blur();
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.customParts[0].name))
    .toBe('Renamed part');
  await expect(app.locator('#pane-workshop .studio')).toBeVisible();

  // ...and the tile's label once we are back where the tiles live
  await app.click('#wsp-back');
  await expect(app.locator('#ws-tab-furnish')).toHaveClass(/active/);
  await expect(app.locator('.studio')).toHaveCount(0);
  await expect(app.locator(`.cat-item[data-def-id="${part.id}"] span`)).toHaveText('Renamed part');
});

test('the outline groups a seeded design in display order, with counts', async ({ app }) => {
  await seed(app);
  const partName = await app.evaluate(() => window.__kp.store.design.customParts[0].name);

  expect(await outline(app)).toEqual({
    total: '5',
    groups: [
      // Rooms always leads, and it is not part of the total
      { title: 'Rooms', count: '1', rows: ['Room 112.0 m²'] },
      { title: 'Doors & windows', count: '1', rows: ['Door'] },
      { title: 'Kitchen · base units', count: '2', rows: ['Base cabinet', 'Base cabinet'] },
      { title: 'Appliances', count: '1', rows: ['Fridge / freezer'] },
      { title: 'My parts', count: '1', rows: [partName] },
    ],
  });
});

test('an empty design still leads with Rooms, then says nothing is placed', async ({ app }) => {
  await app.click('#tab-btn-components');
  expect(await outline(app)).toEqual({
    total: '0',
    groups: [{ title: 'Rooms', count: '1', rows: ['Room 112.0 m²'] }],
  });
  await expect(app.locator('#outline .ol-empty')).toHaveText('Nothing placed yet');
  // the note comes AFTER the Rooms group, never instead of it
  await expect(app.locator('#outline > *').nth(2)).toHaveClass('ol-empty');
});

test('an outline row selects its object, by click and by Enter', async ({ app }) => {
  await seed(app);
  const ids = await app.evaluate(() => ({
    items: window.__kp.store.design.items.map((i) => i.id),
    opening: window.__kp.store.design.openings[0].id,
  }));

  const rows = app.locator('#outline .ol-row:not(.room-row)');
  await rows.first().click();
  await expect
    .poll(() => app.evaluate(() => window.__kp.editor.selection))
    .toEqual({
      kind: 'opening',
      id: ids.opening,
    });
  await expect(rows.first()).toHaveClass(/active/);
  await expect(app.locator('#outline .ol-row.active:not(.room-row)')).toHaveCount(1);

  // keyboard: focus the next row and press Enter
  await rows.nth(1).focus();
  await app.keyboard.press('Enter');
  await expect
    .poll(() => app.evaluate(() => window.__kp.editor.selection))
    .toEqual({ kind: 'item', id: ids.items[0] });
  await expect(rows.nth(1)).toHaveClass(/active/);
});

test('a room row switches the active room and drops the selection', async ({ app }) => {
  const roomIds = await app.evaluate(() => {
    const st = window.__kp.store;
    st.addRoom({ against: { wallId: st.allWalls()[0].id }, d: 3 });
    const item = st.addItem(st.defOf('base-cabinet'), 1.0, 1.0, 0);
    st.commit();
    window.__kp.editor.select({ kind: 'item', id: item.id });
    return st.design.rooms.map((r) => r.id);
  });
  await app.click('#tab-btn-components');

  const rooms = app.locator('#outline .room-row');
  await expect(rooms).toHaveCount(2);
  // addRoom activates the room it made, so the marker starts on the second row
  await expect(rooms.nth(1)).toHaveClass(/active/);

  await rooms.nth(0).click();
  await expect.poll(() => app.evaluate(() => window.__kp.store.activeRoomId)).toBe(roomIds[0]);
  await expect(rooms.nth(0)).toHaveClass(/active/);
  await expect(rooms.nth(1)).not.toHaveClass(/active/);
  // switching rooms drops back to the room panel — the item selection goes
  expect(await app.evaluate(() => window.__kp.editor.selection)).toEqual({ kind: 'none' });

  // and Enter on a focused row does the same
  await rooms.nth(1).focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => app.evaluate(() => window.__kp.store.activeRoomId)).toBe(roomIds[1]);
});

// WS-SPEC §4.3: the search box filters tiles (case-insensitive, on def.label)
// within whichever workspace's sections are currently visible.
test('the search box filters catalog tiles by label', async ({ app }) => {
  const search = app.locator('#catalog-search');
  const cabinet = app.locator('.cat-item[data-def-id="base-cabinet"]');
  const sofa = app.locator('.cat-item[data-def-id="sofa"]');

  await expect(cabinet).toBeVisible();
  await expect(sofa).toBeVisible();

  await search.fill('cab');
  await expect(cabinet).toBeVisible();
  await expect(sofa).toHaveCount(0);

  await search.fill('');
  await expect(cabinet).toBeVisible();
  await expect(sofa).toBeVisible();

  await search.fill('zzzz');
  await expect(app.locator('.cat-empty')).toBeVisible();
  await expect(cabinet).toHaveCount(0);
});
