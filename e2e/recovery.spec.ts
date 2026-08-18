import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * RECOVERY BANNER — the one piece of chrome the bootstrap used to build by
 * hand (`document.createElement` + `#app.prepend`). It is a component now, so
 * this spec is what pins the behaviour that move had to preserve.
 *
 * These tests do NOT use the `app` fixture: the whole point is the state of
 * localStorage BEFORE the app boots, and the fixture clears storage and resets
 * the design as part of setup.
 */

const DESIGN_KEY = 'interior-planner-design-v1';
const RECOVERY_KEY = 'interior-planner-design-recovery-v1';
/** Seeded on every boot below: a cleared profile is a first run (WP 2.5), and
 *  this spec is about the BANNER, not the tour. The corrupt-autosave cases
 *  could never show coach marks anyway (a stashed backup is not a first run),
 *  but the healthy-autosave case boots genuinely clean. */
const ONBOARDED_KEY = 'interior-planner-onboarded-v1';

/** A design payload that parses as JSON but can never sanitize (version 0). */
const CORRUPT = JSON.stringify({ version: 0, rooms: [], items: [] });

/** Boot with a corrupt autosave already in storage. */
async function bootCorrupt(page: Page, raw = CORRUPT): Promise<void> {
  await page.addInitScript(
    ([key, value, onboarded]) => {
      localStorage.clear();
      localStorage.setItem(key, value);
      localStorage.setItem(onboarded, '1');
    },
    [DESIGN_KEY, raw, ONBOARDED_KEY] as const
  );
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__kp?.store, undefined, { polling: 50 });
}

test('a corrupt autosave shows the banner as the FIRST child of #app', async ({ page }) => {
  await bootCorrupt(page);

  const banner = page.locator('.recovery-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Couldn't load your saved design");

  // position matters: the imperative version prepended it, so it sits above
  // the topbar rather than between the panes
  const firstChildClass = await page.evaluate(
    () => document.getElementById('app')!.firstElementChild!.className
  );
  expect(firstChildClass).toBe('recovery-banner');

  // the raw text was stashed, and the app fell back to a usable design
  expect(await page.evaluate((k) => localStorage.getItem(k), RECOVERY_KEY)).toBe(CORRUPT);
  expect(await page.evaluate(() => window.__kp.store.design.rooms.length)).toBeGreaterThan(0);
});

test('a healthy autosave shows no banner', async ({ page }) => {
  await page.addInitScript((k) => {
    localStorage.clear();
    localStorage.setItem(k, '1');
  }, ONBOARDED_KEY);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.__kp?.store, undefined, { polling: 50 });

  await expect(page.locator('.recovery-banner')).toHaveCount(0);
});

test('Download hands over the raw text and KEEPS the backup', async ({ page }) => {
  await bootCorrupt(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download backup' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('interior-design-backup.json');

  // deliberate asymmetry: downloading does not clear the backup, so a reload
  // still finds it — only Dismiss throws it away
  expect(await page.evaluate((k) => localStorage.getItem(k), RECOVERY_KEY)).toBe(CORRUPT);
  await expect(page.locator('.recovery-banner')).toBeVisible();
});

test('Dismiss removes the banner and clears the backup', async ({ page }) => {
  await bootCorrupt(page);

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.recovery-banner')).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), RECOVERY_KEY)).toBeNull();
});
