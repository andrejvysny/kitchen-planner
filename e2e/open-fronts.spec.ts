import { expect, test } from './fixtures';

/**
 * Open/close preview of doors and drawers.
 *
 * These two checks are the ones that failed only on CI (run 30851502876):
 * `stepFrontPoses` used to advance a fixed fraction PER RENDERED FRAME, so the
 * pose needed 18-24 frames and the old runner's fixed 1200 ms sleep was really
 * a "sustain 15-20 fps" requirement that SwiftShader could not meet. The
 * animation is time-based now, and these assertions poll instead of sleeping.
 * Run with KP_CPU_THROTTLE-style starvation and they must still pass.
 */

/** Every motion unit of `itemId` has settled at the open (or closed) pose. */
async function expectPoseSettled(
  page: Parameters<typeof expect.poll>[0] extends never ? never : import('@playwright/test').Page,
  itemId: string,
  open: boolean
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (a) => {
            const entry = window.__kp.view.items.get(a.itemId);
            if (!entry) return false;
            let seen = 0;
            let settled = 0;
            entry.group.traverse((o) => {
              if (!o.userData.motionUnit) return;
              seen++;
              if (Math.abs((o.userData.openT as number) - (a.open ? 1 : 0)) < 0.001) settled++;
            });
            return seen > 0 && seen === settled;
          },
          { itemId, open }
        ),
      { message: `motion units settled ${open ? 'open' : 'closed'}`, timeout: 15_000 }
    )
    .toBe(true);
}

/** Place a base cabinet and return its id plus its first motion unit. */
async function placeCabinet(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const st = window.__kp.store;
    const item = st.addItem(st.defOf('base-cabinet'), 2.5, 1.0, 0);
    st.commit();
    const entry = window.__kp.view.items.get(item.id)!;
    let unit: { userData: Record<string, unknown>; rotation: { y: number } } | null = null;
    entry.group.traverse((o) => {
      if (!unit && o.userData.motionUnit) unit = o as never;
    });
    return {
      itemId: item.id,
      unit: (unit as never as { userData: { motionUnit: string } }).userData.motionUnit,
      groupUuid: entry.group.uuid,
      baseRot: (unit as never as { rotation: { y: number } }).rotation.y,
    };
  });
}

test('toggling a front opens it without a rebuild or a design change', async ({ app }) => {
  const cab = await placeCabinet(app);

  const designBefore = await app.evaluate(() => JSON.stringify(window.__kp.store.design));
  await app.evaluate((a) => window.__kp.store.openFronts.toggle(a.itemId, a.unit), cab);

  await expectPoseSettled(app, cab.itemId, true);

  const after = await app.evaluate((a) => {
    const entry = window.__kp.view.items.get(a.itemId)!;
    let rot = 0;
    entry.group.traverse((o) => {
      if (o.userData.motionUnit === a.unit) rot = o.rotation.y;
    });
    return { uuid: entry.group.uuid, rot, design: JSON.stringify(window.__kp.store.design) };
  }, cab);

  const OPEN_ANGLE = Math.PI * 0.55;
  // the pose is ephemeral view state: no rebuild, and the Design is untouched
  expect(after.uuid, 'item group was rebuilt').toBe(cab.groupUuid);
  expect(after.design, 'design mutated by a view toggle').toBe(designBefore);
  expect(Math.abs(after.rot - cab.baseRot)).toBeCloseTo(OPEN_ANGLE, 1);
});

test('the topbar master toggle opens then closes every front', async ({ app }) => {
  const cab = await placeCabinet(app);

  await app.click('#btn-openfronts');
  await expectPoseSettled(app, cab.itemId, true);
  expect(await app.evaluate(() => window.__kp.store.openFronts.allOpen)).toBe(true);

  await app.click('#btn-openfronts');
  await expectPoseSettled(app, cab.itemId, false);
  expect(await app.evaluate(() => window.__kp.store.openFronts.allOpen)).toBe(false);
});

test('an undo clears stale poses instead of carrying them across the swap', async ({ app }) => {
  const cab = await placeCabinet(app);
  await app.evaluate((a) => window.__kp.store.openFronts.toggle(a.itemId, a.unit), cab);
  await expectPoseSettled(app, cab.itemId, true);

  await app.evaluate(() => window.__kp.store.undo());

  expect(
    await app.evaluate((a) => window.__kp.store.openFronts.isOpen(a.itemId, a.unit), cab)
  ).toBe(false);
});
