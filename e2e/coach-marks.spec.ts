import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SHORTCUTS, SHORTCUT_GROUPS } from '../src/ui/shortcuts';

/**
 * FIRST-RUN TOUR + SHORTCUT SHEET (WS-SPEC §5.5, WP 2.5).
 *
 * Like e2e/recovery.spec.ts, this file does NOT use the `app` fixture: the
 * subject is the state of localStorage BEFORE the app boots, and that fixture
 * both clears storage and SEEDS the onboarded key precisely so no other spec
 * ever meets the tour. Here a fresh Playwright context — which starts with an
 * empty origin storage — IS the first run.
 *
 * The cheatsheet tests seed the key themselves, for the same reason every other
 * suite does: coach marks take every press, so a tour on screen would swallow
 * the clicks under test.
 */

const ONBOARDED_KEY = 'interior-planner-onboarded-v1';
const WORKSPACE_KEY = 'interior-planner-workspace-v1';

/** The store is live — enough to read `__kp` and to have painted the shell. */
async function booted(page: Page): Promise<void> {
  await page.waitForFunction(() => !!window.__kp?.store, undefined, { polling: 50 });
}

/** Boot as a returning user: the tour already seen, storage otherwise empty. */
async function bootOnboarded(page: Page): Promise<void> {
  await page.addInitScript((k) => localStorage.setItem(k, '1'), ONBOARDED_KEY);
  await page.goto('/', { waitUntil: 'networkidle' });
  await booted(page);
}

test.describe('first-run coach marks', () => {
  test('a brand-new profile lands in Plan and walks three marks exactly once', async ({ page }) => {
    // Two full boots + a three-mark walk: legitimately outlives the 60s budget
    // under full-suite parallelism on SwiftShader. slow() triples the timeout.
    test.slow();
    await page.goto('/', { waitUntil: 'networkidle' });
    await booted(page);

    // WS-SPEC §5.5: a first run starts in Plan, not in the persisted default
    expect(await page.evaluate(() => window.__kp.workspace())).toBe('plan');
    await expect(page.locator('#ws-tab-plan')).toHaveClass(/active/);

    // mark 1 of 3
    await expect(page.locator('#coach-marks')).toBeVisible();
    await expect(page.locator('.coach-mark[data-step="0"]')).toBeVisible();
    await expect(page.locator('.coach-mark')).toContainText('Work moves left to right');
    // the flag is written when the tour ENDS, not when it starts
    expect(await page.evaluate((k) => localStorage.getItem(k), ONBOARDED_KEY)).toBeNull();

    // dismiss-anywhere: any press on the backdrop advances
    await page.mouse.click(800, 700);
    await expect(page.locator('.coach-mark[data-step="1"]')).toBeVisible();
    await expect(page.locator('.coach-mark')).toContainText('Everything you can place');

    await page.mouse.click(800, 700);
    await expect(page.locator('.coach-mark[data-step="2"]')).toBeVisible();
    await expect(page.locator('.coach-mark')).toContainText('Whatever you select');

    await page.mouse.click(800, 700);
    await expect(page.locator('#coach-marks')).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), ONBOARDED_KEY)).toBe('1');

    // second visit: no tour, and Plan persisted like any other switch
    await page.reload({ waitUntil: 'networkidle' });
    await booted(page);
    await expect(page.locator('#coach-marks')).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), WORKSPACE_KEY)).toBe('plan');
    expect(await page.evaluate(() => window.__kp.workspace())).toBe('plan');
  });

  test('Skip ends the tour on the first mark', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });
    await booted(page);

    await expect(page.locator('.coach-mark[data-step="0"]')).toBeVisible();
    await page.click('.coach-skip');
    await expect(page.locator('#coach-marks')).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), ONBOARDED_KEY)).toBe('1');
  });

  test('a returning profile never sees the tour, and keeps its workspace', async ({ page }) => {
    await bootOnboarded(page);
    await expect(page.locator('#coach-marks')).toHaveCount(0);
    // the persisted default, untouched by the first-run override
    expect(await page.evaluate(() => window.__kp.workspace())).toBe('furnish');
  });
});

test.describe('shortcut cheatsheet', () => {
  test('? opens the sheet, and Escape closes it WITHOUT cancelling the tool', async ({ page }) => {
    test.slow(); // boot + tool + sheet round-trips: see the first-run walk's note
    await bootOnboarded(page);

    // arm a tool first: Escape over an open sheet must belong to the sheet
    await page.click('#btn-measure');
    expect(await page.evaluate(() => window.__kp.editor.isTool('measure'))).toBe(true);

    await page.keyboard.press('?');
    await expect(page.locator('#cheatsheet')).toBeVisible();
    await expect(page.locator('.cheatsheet-title')).toHaveText('Keyboard & mouse');

    // the sheet is exactly src/ui/shortcuts.ts, rendered
    await expect(page.locator('#cheatsheet .cheatsheet-row')).toHaveCount(SHORTCUTS.length);
    await expect(page.locator('#cheatsheet .cheatsheet-group-title')).toHaveText([
      ...SHORTCUT_GROUPS,
    ]);

    await page.keyboard.press('Escape');
    await expect(page.locator('#cheatsheet')).toHaveCount(0);
    expect(await page.evaluate(() => window.__kp.editor.isTool('measure'))).toBe(true);

    // and now that the sheet is gone, Escape is the tool's again
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__kp.editor.isTool('select'))).toBe(true);
  });

  test('? toggles, and a press outside the panel closes it', async ({ page }) => {
    test.slow(); // see the first-run walk's note
    await bootOnboarded(page);

    await page.keyboard.press('?');
    await expect(page.locator('#cheatsheet')).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.locator('#cheatsheet')).toHaveCount(0);

    await page.keyboard.press('?');
    await expect(page.locator('#cheatsheet')).toBeVisible();
    // a press on the PANEL keeps it open; only the backdrop closes
    await page.click('.cheatsheet-title');
    await expect(page.locator('#cheatsheet')).toBeVisible();
    await page.mouse.click(20, 900); // backdrop, clear of the centred panel
    await expect(page.locator('#cheatsheet')).toHaveCount(0);
  });

  test('a ? typed into a field is a question mark, not the sheet', async ({ page }) => {
    await bootOnboarded(page);

    const name = page.locator('#props-inner .room-name');
    await name.click();
    await page.keyboard.press('End'); // caret lands wherever the click did
    await page.keyboard.press('?');
    await expect(page.locator('#cheatsheet')).toHaveCount(0);
    await expect(name).toHaveValue(/\?$/);
  });

  test('the settings menu opens the same sheet', async ({ page }) => {
    test.slow(); // see the first-run walk's note
    await bootOnboarded(page);

    await page.click('#btn-settings');
    await page.click('#btn-shortcuts');
    await expect(page.locator('#cheatsheet')).toBeVisible();
    // the entry closes its own menu, like every other entry in there
    await expect(page.locator('#settings-menu.open')).toHaveCount(0);

    await page.click('#btn-cheatsheet-close');
    await expect(page.locator('#cheatsheet')).toHaveCount(0);
  });
});
