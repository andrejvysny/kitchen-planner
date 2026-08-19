import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared fixture for the ported specs.
 *
 * `test/interact.mjs` runs 104 checks against ONE long-lived page, so every
 * check inherits whatever state the previous 103 left behind and a failure
 * early on cascades. Each spec here gets a fresh page reset to a deterministic
 * empty 4x3 room, which is the whole point of the migration.
 */

/**
 * The app has booted: store, plan and 3D view are live. Deliberately does NOT
 * require a room — `#btn-new` has produced a ZERO-room design since the
 * zero-room New flow (baba3e7), so a room-count wait here deadlocks every
 * spec. `resetDesign` seeds the room explicitly instead.
 */
export async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const kp = window.__kp;
      return !!(kp && kp.store && kp.plan && kp.view);
    },
    undefined,
    { timeout: 30_000, polling: 50 }
  );
}

/** Reset to the deterministic single empty 4x3 room, no items. */
export async function resetDesign(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await page.click('#btn-new');
  await bootReady(page);
  // New is zero-room by design; seed the deterministic 4x3 room the specs
  // assume, through the same addRoom() a real "Add a room" click would use.
  await page.evaluate(() => {
    const st = window.__kp.store;
    if (st.design.rooms.length === 0) {
      st.addRoom();
      st.commit();
    }
  });
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.rooms.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.items.length)).toBe(0);
}

/**
 * Reset to a genuinely EMPTY design: zero rooms, zero items, no underlay.
 *
 * `#btn-new` has produced a zero-room design since baba3e7, so this is what a
 * user gets from File ▸ New — and it is the literal state the Plan starter card
 * gates on (src/ui/react/EmptyState.tsx). `resetDesign` seeds a room on top of
 * it because almost every other spec needs one; the empty-state specs need it
 * gone again, which is all this does.
 */
export async function resetEmpty(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await page.click('#btn-new');
  await bootReady(page);
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.rooms.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.items.length)).toBe(0);
}

/** The open workspace: a DEVICE preference, read once at import. */
export const WORKSPACE_KEY = 'interior-planner-workspace-v1';

/**
 * Re-boot the app so its FIRST PAINT is in `ws`, then reset to the fixture's
 * deterministic room.
 *
 * Clicking `#ws-tab-plan` also works now (PropsBody subscribes to the
 * 'workspace' channel since the staleness fix), but this helper pins the other
 * real path: the shell's FIRST PAINT with the preference already persisted,
 * which is what a returning user gets. Specs that pin the per-workspace room
 * panel (src/ui/react/props/roomSections.ts) use it so the panel under test is
 * the one the app OPENED on, not one arrived at mid-session.
 */
export async function bootInWorkspace(page: Page, ws: 'plan' | 'furnish'): Promise<void> {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [WORKSPACE_KEY, ws] as [
    string,
    string,
  ]);
  await page.reload({ waitUntil: 'networkidle' });
  await bootReady(page);
  await resetDesign(page);
  await expect.poll(() => page.evaluate(() => window.__kp.workspace())).toBe(ws);
}

/**
 * WP 2.5: a cleared profile is, by definition, a FIRST RUN — coach marks over
 * the shell and the Plan workspace forced. Every spec here clears storage (see
 * `resetDesign`), so without this seed the whole suite would boot into the
 * tour. `addInitScript` re-runs before the page scripts on EVERY navigation,
 * which is what also covers the specs that reload mid-test.
 *
 * e2e/coach-marks.spec.ts is the one suite that deliberately omits it.
 */
export const ONBOARDED_KEY = 'interior-planner-onboarded-v1';

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    // KITCHENP-13: the wheel/trackpad split is mac-gated, and the specs
    // dispatch synthetic wheel events regardless of the real OS.
    await page.addInitScript(() => {
      window.__kpForceMac = true;
    });
    await page.addInitScript((k) => localStorage.setItem(k, '1'), ONBOARDED_KEY);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('dialog', (d) => void d.accept());

    await page.goto('/', { waitUntil: 'networkidle' });
    await bootReady(page);
    await resetDesign(page);

    await use(page);

    // an uncaught page error is a failure even when every assertion passed
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});

export { expect };
