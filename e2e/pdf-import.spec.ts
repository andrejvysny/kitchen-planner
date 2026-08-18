import { expect, test } from './fixtures';

/**
 * PDF → tracing reference (src/ui/pdfImport.ts + <PdfPagePicker/>).
 *
 * A floor plan usually arrives as a PDF and usually as one sheet of several,
 * so the import is two steps and the picker is the first of them. What this
 * spec pins is that seam: the file input takes a PDF at all, the picker names
 * every page, and choosing one lands the SAME underlay an imported photo
 * would — `placeUnderlay` is shared, and this is what keeps it that way.
 *
 * The fixture is a hand-built 3-page PDF (e2e/fixtures/plan.pdf) rather than a
 * real plan: pdf.js only has to prove it rasterizes pages, and a tiny
 * deterministic file keeps the suite fast and the repo small.
 */

const FIXTURE = 'e2e/fixtures/plan.pdf';

test.beforeEach(async ({ app }) => {
  await app.click('#ws-tab-plan');
});

test('picking a PDF opens the page chooser, not the underlay', async ({ app }) => {
  await app.setInputFiles('#underlay-input', FIXTURE);

  const picker = app.locator('#pdf-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('h2')).toHaveText('Choose the page to trace');
  await expect(picker.locator('.props-sub').first()).toContainText('3 pages');
  await expect(picker.locator('.pdf-page[data-page]')).toHaveCount(3);

  // nothing has been placed yet — the choice is still open
  expect(await app.evaluate(() => window.__kp.store.underlayRef())).toBe(null);
});

test('choosing a page places it as the tracing reference', async ({ app }) => {
  await app.setInputFiles('#underlay-input', FIXTURE);
  await expect(app.locator('.pdf-page[data-page="2"]')).toBeVisible();
  await app.click('.pdf-page[data-page="2"]');

  await expect(app.locator('#pdf-picker')).toHaveCount(0);
  const u = await app.evaluate(() => {
    const r = window.__kp.store.underlayRef();
    return r && { jpeg: r.src.startsWith('data:image/jpeg'), visible: r.u.visible, scale: r.u.scale };
  });
  expect(u).toMatchObject({ jpeg: true, visible: true });
  expect(u!.scale).toBeGreaterThan(0);

  // and the inspector's Reference-photo section now offers the live controls
  await expect(app.locator('.underlay-calibrate')).toBeVisible();
});

test('Escape and the ✕ close the picker without placing anything', async ({ app }) => {
  await app.setInputFiles('#underlay-input', FIXTURE);
  await expect(app.locator('#pdf-picker')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('#pdf-picker')).toHaveCount(0);
  expect(await app.evaluate(() => window.__kp.store.underlayRef())).toBe(null);

  await app.setInputFiles('#underlay-input', FIXTURE);
  await app.click('#pdf-picker .modal-close');
  await expect(app.locator('#pdf-picker')).toHaveCount(0);
  expect(await app.evaluate(() => window.__kp.store.underlayRef())).toBe(null);
});
