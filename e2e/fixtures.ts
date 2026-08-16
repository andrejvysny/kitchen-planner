import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared fixture for the ported specs.
 *
 * `test/interact.mjs` runs 104 checks against ONE long-lived page, so every
 * check inherits whatever state the previous 103 left behind and a failure
 * early on cascades. Each spec here gets a fresh page reset to a deterministic
 * empty 4x3 room, which is the whole point of the migration.
 */

/** The app has booted: store, plan and 3D view are live and a room exists. */
export async function bootReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const kp = window.__kp;
      return !!(kp && kp.store && kp.plan && kp.view && kp.store.design.rooms.length > 0);
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
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.items.length)).toBe(0);
}

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    // KITCHENP-13: the wheel/trackpad split is mac-gated, and the specs
    // dispatch synthetic wheel events regardless of the real OS.
    await page.addInitScript(() => {
      window.__kpForceMac = true;
    });
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
