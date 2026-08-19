import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * CONTEXT MENU (WS-SPEC §5.1, WP 2.1) — the wiring, not the matrix.
 *
 * Which entries a hit earns is decided by the pure model and asserted as a
 * table in test/unit/contextMenuModel.test.ts. What can only be checked with a
 * browser is what this spec covers: that a right-click on a canvas resolves to
 * the RIGHT hit, that invoking an entry runs the mutation it names, and that
 * the popup dismisses.
 *
 * Everything polls or asserts store state — no sleeps.
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

/**
 * The world point at the middle of wall `index`'s SLAB — `wallPoint(g, len/2)`
 * pushed onto the band centre (renderPlan's `bandCenter`), which is where
 * Plan2D's own wall hit test is centred.
 */
async function wallMid(page: Page, index = 0): Promise<{ x: number; y: number; id: string }> {
  return page.evaluate((i) => {
    const g = window.__kp.store.allWalls()[i];
    const off = g.faceOffset - g.thickness / 2;
    const t = g.len / 2;
    return {
      id: g.id,
      x: g.a.x + g.dir.x * t + g.inward.x * off,
      y: g.a.y + g.dir.y * t + g.inward.y * off,
    };
  }, index);
}

/**
 * Right-click a plan WORLD point. The page-coordinate assertion is not
 * ceremony: a point that projects off the canvas would silently "pass" a
 * no-menu expectation while never reaching the handler at all.
 */
async function rightClickPlan(page: Page, x: number, y: number): Promise<void> {
  const box = (await page.locator('#canvas2d').boundingBox())!;
  const p = await planAt(page, x, y);
  expect(p.x - box.x, 'plan point is off-canvas').toBeGreaterThan(0);
  expect(p.x - box.x, 'plan point is off-canvas').toBeLessThan(box.width);
  expect(p.y - box.y, 'plan point is off-canvas').toBeLessThan(box.height);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

/** Place a base cabinet clear of every wall and return its id. */
async function placeCabinet(page: Page, x = 2, y = 1.5): Promise<string> {
  return page.evaluate(
    (p) => {
      const st = window.__kp.store;
      const item = st.addItem(st.defOf('base-cabinet'), p.x, p.y, 0);
      st.commit();
      return item.id;
    },
    { x, y }
  );
}

const menu = (page: Page) => page.locator('#context-menu');
const entry = (page: Page, cmd: string) => page.locator(`#context-menu button[data-cmd="${cmd}"]`);

test.describe('plan canvas', () => {
  test.beforeEach(async ({ app }) => {
    await app.click('#ws-tab-plan');
    await expect(app.locator('#btn-draw-room')).toBeVisible();
    await pinViewport(app);
  });

  test('right-clicking a wall offers "Add corner here", and it splits the wall', async ({
    app,
  }) => {
    const w = await wallMid(app);
    const before = await app.evaluate(() => window.__kp.store.activeRoom().corners.length);

    await rightClickPlan(app, w.x, w.y);

    await expect(menu(app)).toBeVisible();
    await expect(entry(app, 'add-corner')).toHaveText(/Add corner here/);
    // the entry teaches the gesture that already does the same thing
    await expect(entry(app, 'add-corner').locator('.ctx-hint')).toHaveText('double-click');
    // right-click selects what it acts on
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.selection))
      .toEqual({ kind: 'wall', id: w.id });

    await entry(app, 'add-corner').click();

    await expect(menu(app)).toHaveCount(0);
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.activeRoom().corners.length))
      .toBe(before + 1);
    expect(await app.evaluate(() => window.__kp.store.selection.kind)).toBe('corner');
  });

  test('Escape closes the menu and leaves the design alone', async ({ app }) => {
    const w = await wallMid(app);
    const before = await app.evaluate(() => JSON.stringify(window.__kp.store.design));

    await rightClickPlan(app, w.x, w.y);
    await expect(menu(app)).toBeVisible();

    await app.keyboard.press('Escape');

    await expect(menu(app)).toHaveCount(0);
    expect(await app.evaluate(() => JSON.stringify(window.__kp.store.design))).toBe(before);
  });

  test('right-clicking an item offers Duplicate, and it adds one item', async ({ app }) => {
    const id = await placeCabinet(app);
    const item = await app.evaluate((i) => {
      const it = window.__kp.store.itemById(i)!;
      return { x: it.x, y: it.y };
    }, id);

    await rightClickPlan(app, item.x, item.y);

    await expect(menu(app)).toBeVisible();
    await expect(entry(app, 'duplicate').locator('.ctx-hint')).toHaveText('Ctrl+D');
    await expect(entry(app, 'delete')).toHaveClass(/danger/);

    await entry(app, 'duplicate').click();

    await expect(menu(app)).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(2);
  });

  test('right-clicking bare floor offers the room actions, and a shape preset applies', async ({
    app,
  }) => {
    await rightClickPlan(app, 2, 1.5);

    await expect(menu(app)).toBeVisible();
    // one room, and it is already the active one: both conditional entries are
    // omitted rather than shown disabled
    await expect(entry(app, 'activate-room')).toHaveCount(0);
    await expect(entry(app, 'delete-room')).toHaveCount(0);
    await expect(entry(app, 'rename-room')).toBeVisible();

    await entry(app, 'shape-l').click();

    await expect(menu(app)).toHaveCount(0);
    await expect
      .poll(() => app.evaluate(() => window.__kp.store.activeRoom().corners.length))
      .toBe(6);
  });

  test('the two "…" entries open the field they name', async ({ app }) => {
    const w = await wallMid(app);
    await rightClickPlan(app, w.x, w.y);
    await entry(app, 'wall-length').click();

    // the entry promises an edit, so it has to land the caret in the box —
    // this is the one coupling between the menu and the inspector's markup
    await expect(app.locator('#props-inner input[data-cls="wall-len"]')).toBeFocused();

    await rightClickPlan(app, 2, 1.5);
    await entry(app, 'rename-room').click();
    await expect(app.locator('#props-inner .room-name')).toBeFocused();
  });

  test('"Wall colour…" lands on the room section that owns the finish', async ({ app }) => {
    // #section-walls is a FURNISH room-panel section (roomSections.ts): finishes
    // moved out of Plan when the room panel was split per workspace, and the
    // plan canvas is right-clickable in both. See the PRODUCT NOTE below.
    await app.click('#ws-tab-furnish');

    const w = await wallMid(app);
    await rightClickPlan(app, w.x, w.y);
    await entry(app, 'wall-colour').click();

    await expect(menu(app)).toHaveCount(0);
    // wall finishes are a room-level style here, so the honest destination is
    // the room panel's Walls section — which means dropping the selection
    await expect.poll(() => app.evaluate(() => window.__kp.store.selection.kind)).toBe('none');
    await expect(app.locator('#section-walls')).toBeVisible();
  });

  /**
   * 'Wall colour…' is FURNISH-ONLY by model decision now: its destination
   * (#section-walls) is a Furnish room-panel section, so contextMenuModel.ts
   * omits the row in Plan rather than shipping a dead entry. The matrix is
   * pinned in test/unit/contextMenuModel.test.ts; the test above pins the
   * working wiring.
   */

  test('"Add door" arms the placement tool with the door def', async ({ app }) => {
    const w = await wallMid(app);
    await rightClickPlan(app, w.x, w.y);
    await entry(app, 'add-door').click();

    await expect(menu(app)).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => window.__kp.editor.tool)).toBe('place');
    expect(await app.evaluate(() => window.__kp.editor.armedDefId)).toBe('door');
    await app.keyboard.press('Escape');
  });

  test('"Edit in Workshop" forks a preset instance and opens it there', async ({ app }) => {
    const id = await placeCabinet(app);
    const partsBefore = await app.evaluate(() => window.__kp.store.design.customParts.length);
    const item = await app.evaluate((i) => {
      const it = window.__kp.store.itemById(i)!;
      return { x: it.x, y: it.y };
    }, id);

    await rightClickPlan(app, item.x, item.y);
    await entry(app, 'edit-workshop').click();

    await expect.poll(() => app.evaluate(() => window.__kp.workspace())).toBe('workshop');
    // same guard as the props panel's "Customize part…": a preset forks first,
    // so only this instance becomes editable
    expect(await app.evaluate(() => window.__kp.store.design.customParts.length)).toBe(
      partsBefore + 1
    );
    expect(await app.evaluate((i) => window.__kp.store.itemById(i)!.defId, id)).not.toBe(
      'base-cabinet'
    );
  });

  test('a second room gets "Make active room" and "Delete room"', async ({ app }) => {
    // two rooms side by side; addRoom activates the new one, so room 1 is the
    // INACTIVE one the right-click below lands on
    await app.evaluate(() => {
      const st = window.__kp.store;
      st.addRoom({ at: { x: 6, y: 0 }, w: 3, d: 3 });
      st.commit();
    });

    await rightClickPlan(app, 2, 1.5);

    await expect(menu(app)).toBeVisible();
    await expect(entry(app, 'activate-room')).toBeVisible();
    await expect(entry(app, 'delete-room')).toHaveClass(/danger/);

    await entry(app, 'activate-room').click();

    await expect(menu(app)).toHaveCount(0);
    // the active room is ephemeral view state — activating one is not an edit
    const roomId = await app.evaluate(() => window.__kp.store.design.rooms[0].id);
    await expect.poll(() => app.evaluate(() => window.__kp.store.activeRoomId)).toBe(roomId);

    // and the danger entry does what it says (the app fixture accepts dialogs)
    await rightClickPlan(app, 2, 1.5);
    await entry(app, 'delete-room').click();
    await expect.poll(() => app.evaluate(() => window.__kp.store.design.rooms.length)).toBe(1);
  });

  test('right-clicking outside every room offers the wall tool, and arming it switches the tool', async ({
    app,
  }) => {
    await rightClickPlan(app, 4.6, 1.5); // clear of the 4x3 room and of its wall band

    await expect(menu(app)).toBeVisible();
    // one creation entry now — the drag/click gestures are both this tool
    await expect(entry(app, 'add-room')).toHaveCount(0);
    await entry(app, 'draw-room').click();

    await expect(menu(app)).toHaveCount(0);
    expect(await app.evaluate(() => window.__kp.editor.tool)).toBe('drawRoom');
    await app.keyboard.press('Escape'); // leave the tool as this spec found it
    await expect.poll(() => app.evaluate(() => window.__kp.editor.tool)).toBe('select');
  });
});

test('outside every room in Furnish there is no menu at all', async ({ app }) => {
  // the fixture boots into Furnish, where the empty-floor entries are Plan's
  expect(await app.evaluate(() => window.__kp.workspace())).toBe('furnish');
  await pinViewport(app);

  await rightClickPlan(app, 4.6, 1.5); // clear of the 4x3 room and of its wall band

  // nothing to assert a transition against, so poll the store for a beat first
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.debug().drawCount))
    .toBeGreaterThan(0);
  await expect(menu(app)).toHaveCount(0);
});

test('right-clicking an item in the 3D view rotates it through the same command', async ({
  app,
}) => {
  const id = await placeCabinet(app);

  const target = await app.evaluate((i) => {
    const it = window.__kp.store.itemById(i)!;
    // project the item's own centre; pickItem raycasts the item group only, so
    // a wall in front of it cannot steal the hit
    return window.__kp.view.worldToScreen(it.x, it.h / 2, it.y);
  }, id);

  const box = (await app.locator('#canvas3d').boundingBox())!;
  expect(target.x, '3D projection landed off-canvas').toBeGreaterThan(0);
  expect(target.x).toBeLessThan(box.width);

  const before = await app.evaluate((i) => window.__kp.store.itemById(i)!.rotation, id);
  await app.mouse.click(box.x + target.x, box.y + target.y, { button: 'right' });

  await expect(menu(app)).toBeVisible();
  await expect(entry(app, 'rotate90').locator('.ctx-hint')).toHaveText('R');
  // 3D picks items and nothing else — no wall or room entries here
  await expect(entry(app, 'add-corner')).toHaveCount(0);

  await entry(app, 'rotate90').click();

  await expect(menu(app)).toHaveCount(0);
  await expect
    .poll(() => app.evaluate((i) => window.__kp.store.itemById(i)!.rotation, id))
    .toBeCloseTo(before + Math.PI / 2, 3);
});
