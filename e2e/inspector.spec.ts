import type { Page } from '@playwright/test';
import { bootInWorkspace, expect, test } from './fixtures';

/**
 * THE PROPERTIES INSPECTOR — the shape of every selection panel, pinned.
 *
 * Written BEFORE the item / wall / opening / corner panels became components,
 * against the markup src/ui/ui.ts emitted, so the port has something to be
 * measured against beyond "test/interact.mjs is still green". interact.mjs
 * reaches into this panel by ordinal — `.prop-section` index, the FIRST
 * `input` of the room panel, the `.toggle-row input` of the Worktop section —
 * and none of those couplings are visible from the code they constrain. This
 * spec makes them explicit: a section renamed, reordered, added or dropped
 * fails here with the diff spelled out, instead of failing there as an
 * unrelated-looking geometry assertion.
 *
 * Everything is driven through window.__kp so the panel under test is the only
 * UI in the loop.
 */

/** The `.prop-section` titles of the current panel, in DOM order. */
async function sections(app: Page): Promise<string[]> {
  return app.locator('#props-inner .prop-section-title').allTextContents();
}

/** Select something and wait for the panel to be the one that belongs to it. */
async function selectAndSettle(
  app: Page,
  sel: { kind: string; id: string },
  firstSection: string
): Promise<void> {
  await app.evaluate((s) => window.__kp.store.select(s as never), sel);
  await expect.poll(() => sections(app)).toContain(firstSection);
}

/** Place one catalog item, select it, and return its id. */
async function place(app: Page, defId: string, x: number, y: number): Promise<string> {
  const id = await app.evaluate(
    ({ defId, x, y }) => {
      const st = window.__kp.store;
      const item = st.addItem(st.defOf(defId), x, y, 0);
      st.commit();
      st.select({ kind: 'item', id: item.id });
      return item.id;
    },
    { defId, x, y }
  );
  await expect.poll(() => app.locator('#props-inner .props-title').textContent()).not.toBe(null);
  return id;
}

/**
 * The no-selection room panel is WORKSPACE-SCOPED — src/ui/react/props/
 * roomSections.ts `WORKSPACE_ROOM_SECTIONS` is the registry, Plan owning the
 * floor-plan STRUCTURE and Furnish the FINISH — so "the room panel" is two
 * panels and each gets its own list pinned below.
 *
 * Both tests reach their workspace through `bootInWorkspace`, not a tab click:
 * see that helper's note in e2e/fixtures.ts for why the two are not the same
 * thing here.
 */
test('the Plan room panel is the no-selection panel, section for section', async ({ app }) => {
  await bootInWorkspace(app, 'plan');

  // A fresh 4x3 room is clean, so there is no Checks section between the photo
  // and Size — that section only exists when runChecks() has something to say.
  // `identity` and `tip` bracket the list and carry no .prop-section-title.
  await expect
    .poll(() => sections(app))
    .toEqual(['Rooms', 'Reference photo', 'Size', 'Room shape', 'Ceiling', 'Actions']);
  await expect(app.locator('#props-inner .props-empty-tip')).toHaveCount(1);

  // the room panel's title IS its rename field, so there is no .props-title
  await expect(app.locator('#props-inner .props-title')).toHaveCount(0);
  await expect(app.locator('#props-inner .room-name')).toHaveValue('Room 1');

  // test/interact.mjs edits the room's width through the FIRST numeric field
  // in the panel — that ordinal is a contract, so name what it lands on.
  const firstRow = app.locator('#props-inner .prop-row').filter({ has: app.locator('input') });
  await expect(firstRow.first().locator('label')).toHaveText('Width');

  // no photo imported: the section is the importer, and the opacity slider
  // (the only other input it can show) is absent
  await expect(
    app.locator('#props-inner .btn-row button', { hasText: 'Import photo…' })
  ).toHaveCount(1);
  await expect(app.locator('#props-inner input[type=range]')).toHaveCount(0);

  // the finish sections belong to the other workspace, the room list to this one
  await expect(app.locator('#section-walls')).toHaveCount(0);
  await expect(app.locator('#props-inner .room-row')).toHaveCount(1);
});

test('the Furnish room panel is the finish half of the same registry', async ({ app }) => {
  // the fixture already boots into Furnish (the persisted default with cleared
  // storage), so this is the panel the app opens on
  expect(await app.evaluate(() => window.__kp.workspace())).toBe('furnish');

  await expect.poll(() => sections(app)).toEqual(['Walls', 'Floor', 'Worktops', 'Lighting']);
  await expect(app.locator('#props-inner .props-title')).toHaveCount(0);
  await expect(app.locator('#props-inner input[type=range]')).toHaveCount(3); // the three Lighting sliders

  // the context menu's "Wall colour…" destination lives here, not in Plan
  await expect(app.locator('#section-walls')).toBeVisible();
  // …and Plan's structure sections do not
  await expect(app.locator('#props-inner .room-name')).toHaveCount(0);
  await expect(app.locator('#props-inner .room-row')).toHaveCount(0);
});

test('a room row switches rooms without leaving the room panel', async ({ app }) => {
  await bootInWorkspace(app, 'plan'); // the room switcher is a Plan section

  const second = await app.evaluate(() => {
    const st = window.__kp.store;
    const room = st.addRoom({ against: { wallId: st.allWalls()[0].id }, d: 3 })!;
    st.commit();
    return room.id;
  });

  const rows = app.locator('#props-inner .room-row');
  await expect(rows).toHaveCount(2);
  await rows
    .filter({ hasNot: app.locator('.active') })
    .first()
    .click();

  await expect.poll(() => app.evaluate(() => window.__kp.store.activeRoomId)).not.toBe(second);
  await expect.poll(() => app.evaluate(() => window.__kp.store.selection.kind)).toBe('none');
  await expect(app.locator('#props-inner .room-row.active')).toHaveCount(1);
});

/**
 * The regression the isEditingRoomName guard used to buy: an edit landing from
 * anywhere else must not yank the field the caret sits in.
 */
test('the room name field survives a re-render while it holds the caret', async ({ app }) => {
  await bootInWorkspace(app, 'plan'); // the rename field is Plan's `identity` section

  const name = app.locator('#props-inner .room-name');
  await name.click();
  await name.fill('Galley');

  // an unrelated commit — the panel re-renders around the focused field
  await app.evaluate(() => {
    window.__kp.store.setRoomStyle({ wallHeight: 2.7 });
    window.__kp.store.commit();
  });

  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Galley');

  await name.press('Enter');
  await expect.poll(() => app.evaluate(() => window.__kp.store.activeRoom().name)).toBe('Galley');
});

test('a cabinet shows dimensions, position, both colour slots and its worktop', async ({ app }) => {
  await place(app, 'base-cabinet', 2.0, 1.0);

  await expect(app.locator('#props-inner .props-title')).toHaveText('Base cabinet');
  await expect(app.locator('#props-inner .props-sub').first()).toHaveText('Catalog item');
  await expect
    .poll(() => sections(app))
    .toEqual(['Dimensions', 'Position', 'Colour & material', 'Accent', 'Worktop', 'Actions']);

  // the three transient fields test/interact.mjs and dom-contract.spec.ts pin
  await expect(app.locator('#props-inner input[data-cls="pos-x"]')).toHaveCount(1);
  await expect(app.locator('#props-inner input[data-cls="pos-y"]')).toHaveCount(1);
  await expect(app.locator('#props-inner input[data-cls="rot"]')).toHaveCount(1);

  // interact.mjs drives the per-item worktop through this exact pair
  const worktop = app
    .locator('#props-inner .prop-section')
    .filter({ has: app.locator('.prop-section-title', { hasText: /^Worktop$/ }) });
  await expect(worktop.locator('.swatch[title="Dark marble"]')).toHaveCount(1);
  await expect(worktop.locator('.toggle-row input')).toHaveCount(0); // no pattern yet, no rotate row

  // a preset is forkable, so the actions offer the customize path
  await expect(app.locator('#props-inner button', { hasText: 'Customize part…' })).toHaveCount(1);
});

test('a parametric item shows its stepper, and a clashing one leads with Checks', async ({
  app,
}) => {
  await place(app, 'sofa', 1.0, 2.0);

  // Checks leads the panel: it is the reason the selection is interesting
  await expect
    .poll(() => sections(app))
    .toEqual(['Checks', 'Dimensions', 'Position', 'Configuration', 'Colour & material', 'Actions']);
  await expect(app.locator('#props-inner .check-row').first()).toBeVisible();

  // the seats stepper is width-driving; interact.mjs clicks its second button
  const seats = app.locator('#props-inner .prop-row', { hasText: 'Seats' });
  await expect(seats.locator('.stepper button')).toHaveCount(2);
  await seats.locator('.stepper button').nth(1).click();
  await expect
    .poll(() =>
      app.evaluate(
        () => window.__kp.store.design.items.find((i) => i.defId === 'sofa')?.params?.seats
      )
    )
    .toBe(4);
});

test('a light fixture gains a Light section', async ({ app }) => {
  await place(app, 'pendant', 1.0, 1.0);
  await expect
    .poll(() => sections(app))
    .toEqual(['Dimensions', 'Position', 'Colour & material', 'Light', 'Actions']);
  await expect(app.locator('#props-inner .toggle-row', { hasText: 'On' })).toHaveCount(1);
});

test('wall, opening and corner panels keep their sections and their data-cls fields', async ({
  app,
}) => {
  const wallId = await app.evaluate(() => window.__kp.store.allWalls()[0].id);
  await selectAndSettle(app, { kind: 'wall', id: wallId }, 'Visibility');
  await expect(app.locator('#props-inner .props-title')).toHaveText('Wall');
  await expect.poll(() => sections(app)).toEqual(['Size', 'Visibility', 'Shape']);

  const doorId = await app.evaluate((wId) => {
    const st = window.__kp.store;
    const wall = st.wallById(wId)!;
    const o = st.addOpening(st.defOf('door'), wall.id, wall.len / 2);
    st.commit();
    return o.id;
  }, wallId);
  await selectAndSettle(app, { kind: 'opening', id: doorId }, 'Swing');
  await expect(app.locator('#props-inner .props-title')).toHaveText('Door');
  await expect.poll(() => sections(app)).toEqual(['Size', 'Swing', 'Actions']);
  await expect(app.locator('#props-inner input[data-cls="opening-off"]')).toHaveCount(1);

  const winId = await app.evaluate((wId) => {
    const st = window.__kp.store;
    const wall = st.wallById(wId)!;
    const o = st.addOpening(st.defOf('window'), wall.id, wall.len / 4);
    st.commit();
    return o.id;
  }, wallId);
  await app.evaluate((id) => window.__kp.store.select({ kind: 'opening', id }), winId);
  await expect(app.locator('#props-inner .props-title')).toHaveText('Window');
  await expect.poll(() => sections(app)).toEqual(['Size', 'Actions']); // no swing on a window

  const cornerId = await app.evaluate(() => window.__kp.store.design.rooms[0].corners[0].id);
  await selectAndSettle(app, { kind: 'corner', id: cornerId }, 'Position');
  await expect(app.locator('#props-inner .props-title')).toHaveText('Corner');
  await expect.poll(() => sections(app)).toEqual(['Position', 'Actions']);
  await expect(app.locator('#props-inner input[data-cls="corner-x"]')).toHaveCount(1);
  await expect(app.locator('#props-inner input[data-cls="corner-y"]')).toHaveCount(1);
});

test('dropping the selection returns to the room panel', async ({ app }) => {
  await bootInWorkspace(app, 'plan'); // .room-name is how the room panel is recognised

  await place(app, 'base-cabinet', 2.0, 1.0);
  await expect(app.locator('#props-inner .props-title')).toHaveText('Base cabinet');

  await app.evaluate(() => window.__kp.store.select({ kind: 'none' }));
  await expect(app.locator('#props-inner .props-title')).toHaveCount(0);
  await expect(app.locator('#props-inner .room-name')).toHaveCount(1);
});
