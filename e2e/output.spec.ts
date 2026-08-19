import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';

/**
 * THE OUTPUT WORKSPACE PANE (WP 1.8) — src/ui/react/OutputPane.tsx.
 *
 * Six cards, each a thin wrapper around a handler in
 * src/ui/react/exportActions.ts that the topbar's Export ▾ menu ALSO calls;
 * the point of this spec is proving the two surfaces stay byte-identical
 * (cut list) and that the pane can produce a file while it covers the
 * canvases — the 3D pane is `setActive(false)`'d underneath it, so a PNG
 * export only works if View3D.snapshotPNG flushes its own rebuild queue
 * first (see the CLAUDE.md note this pane's doc comment points at).
 */

test.beforeEach(async ({ app }) => {
  await app.click('#ws-tab-output');
  await expect(app.locator('#pane-output')).toBeVisible();
});

test('the cut list card matches the Export ▾ menu, byte for byte', async ({ app }) => {
  // a non-trivial design: one placed cabinet, same as the topbar's own export
  // scenarios in test/interact.mjs
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('base-cabinet'), 2.0, 1.0, 0);
    st.commit();
  });

  const [paneDownload] = await Promise.all([
    app.waitForEvent('download'),
    app.click('#out-card-cut button'),
  ]);
  const paneText = readFileSync(await paneDownload.path()).toString('utf-8');
  expect(paneDownload.suggestedFilename()).toBe('interior-cutlist.csv');
  expect(paneText).toContain('Base cabinet');

  // same design, same handler, via the topbar menu this time
  await app.click('#ws-tab-furnish');
  await app.click('#btn-export');
  const [menuDownload] = await Promise.all([
    app.waitForEvent('download'),
    app.click('[data-export="cut"]'),
  ]);
  const menuText = readFileSync(await menuDownload.path()).toString('utf-8');

  expect(paneText).toBe(menuText);
});

test('the PNG card saves a snapshot while the pane covers the 3D canvas', async ({ app }) => {
  const [download] = await Promise.all([
    app.waitForEvent('download'),
    app.click('#out-card-png button'),
  ]);
  expect(download.suggestedFilename()).toBe('interior-3d.png');

  // not a blank frame — proves View3D.snapshotPNG flushed the rebuild queue
  // even though `view3d.setActive(false)` covered the pane (CLAUDE.md)
  const buf = readFileSync(await download.path());
  expect(buf.length).toBeGreaterThan(20_000);
});

test('the GLB card disables its button while the export is in flight', async ({ app }) => {
  const btn = app.locator('#out-card-glb button');
  await expect(btn).toHaveText('Export GLB');

  // The busy window is one design's worth of GLTFExporter work — on a 4x3 room
  // with one cabinet that can be shorter than a poll interval, so polling for
  // 'Exporting…' is a race that passes or fails on machine speed. Record every
  // state the button passes THROUGH instead: React flushes `setGlbBusy(true)`
  // before `exportGlb` is awaited, so the transition is in the DOM regardless
  // of how briefly it stays there.
  await app.evaluate(() => {
    const el = document.querySelector('#out-card-glb button')!;
    const seen: string[] = [el.textContent ?? ''];
    (window as unknown as { __glbStates: string[] }).__glbStates = seen;
    new MutationObserver(() => {
      const t = el.textContent ?? '';
      if (t !== seen[seen.length - 1]) seen.push(t);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  });

  const [download] = await Promise.all([app.waitForEvent('download'), btn.click()]);
  expect(download.suggestedFilename()).toBe('interior.glb');

  await expect
    .poll(() => app.evaluate(() => (window as unknown as { __glbStates: string[] }).__glbStates))
    .toEqual(['Export GLB', 'Exporting…', 'Export GLB']);
  await expect(btn).toBeEnabled();
});
