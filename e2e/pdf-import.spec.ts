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
    return (
      r && { jpeg: r.src.startsWith('data:image/jpeg'), visible: r.u.visible, scale: r.u.scale }
    );
  });
  expect(u).toMatchObject({ jpeg: true, visible: true });
  expect(u!.scale).toBeGreaterThan(0);

  // and the inspector's Reference-photo section now offers the live controls
  await expect(app.locator('.underlay-calibrate')).toBeVisible();
});

/**
 * The calibrate question is the app's own dialog (src/ui/react/ConfirmHost.tsx),
 * so it takes an EXPRESSION in the preferred unit like every inspector length
 * box, and a bad answer keeps it open instead of throwing the two-click gesture
 * away — which is what the native `prompt()` it replaced did.
 */
test('calibrating asks for the real length, rejects a bad answer in place, and takes an expression', async ({
  app,
}) => {
  await app.setInputFiles('#underlay-input', FIXTURE);
  await expect(app.locator('.pdf-page[data-page="1"]')).toBeVisible();
  await app.click('.pdf-page[data-page="1"]');
  await expect(app.locator('#pdf-picker')).toHaveCount(0);

  // placing a reference ARMS calibrate: an uncalibrated plan traces wrong
  await expect.poll(() => app.evaluate(() => window.__kp.editor.tool)).toBe('calibrate');
  const before = await app.evaluate(() => window.__kp.store.underlayRef()!.u.scale);
  const zoom = await app.evaluate(() => window.__kp.plan.viewport().zoom);

  const box = (await app.locator('#canvas2d').boundingBox())!;
  const y = box.y + box.height / 2;
  await app.mouse.click(box.x + 60, y);
  await app.mouse.click(box.x + 210, y);
  // the import's zoom-to-fit has landed by now; if it had not, the two clicks
  // would not be 150 px / zoom apart in world space and the ratio below is junk
  expect(await app.evaluate(() => window.__kp.plan.viewport().zoom)).toBe(zoom);

  await expect(app.locator('#app-dialog')).toBeVisible();
  await app.fill('#dialog-input', 'over there somewhere');
  await app.click('#dialog-accept');
  await expect(app.locator('.dialog-error')).toBeVisible();
  await expect(app.locator('#app-dialog')).toBeVisible();
  expect(await app.evaluate(() => window.__kp.store.underlayRef()!.u.scale)).toBe(before);

  // '1200*2' in the default unit (mm) — the same parseLength every field uses
  await app.fill('#dialog-input', '1200*2');
  await app.keyboard.press('Enter');
  await expect(app.locator('#app-dialog')).toHaveCount(0);
  const after = await app.evaluate(() => window.__kp.store.underlayRef()!.u.scale);
  // the marked span now measures 2.4 m, so the photo grew by 2.4 / its old span
  expect(after / before).toBeCloseTo((2.4 * zoom) / 150, 6);
});

test('cancelling the calibrate dialog leaves the reference scale alone', async ({ app }) => {
  await app.setInputFiles('#underlay-input', FIXTURE);
  await expect(app.locator('.pdf-page[data-page="1"]')).toBeVisible();
  await app.click('.pdf-page[data-page="1"]');
  await expect.poll(() => app.evaluate(() => window.__kp.editor.tool)).toBe('calibrate');
  const before = await app.evaluate(() => window.__kp.store.underlayRef()!.u.scale);

  const box = (await app.locator('#canvas2d').boundingBox())!;
  const y = box.y + box.height / 2;
  await app.mouse.click(box.x + 60, y);
  await app.mouse.click(box.x + 210, y);

  await expect(app.locator('#app-dialog')).toBeVisible();
  // Escape is handled in the capture phase, so it answers the dialog and does
  // NOT also reach the tool underneath
  await app.keyboard.press('Escape');
  await expect(app.locator('#app-dialog')).toHaveCount(0);
  expect(await app.evaluate(() => window.__kp.store.underlayRef()!.u.scale)).toBe(before);
  // the tool is released by the ANSWER, not by the second click — and Escape
  // answering the dialog must not also have cancelled anything else
  await expect.poll(() => app.evaluate(() => window.__kp.editor.tool)).toBe('select');
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
