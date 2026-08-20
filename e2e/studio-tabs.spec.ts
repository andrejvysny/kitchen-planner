import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * SIMPLE / ADVANCED IN THE PART STUDIO (WS-SPEC WP 3.3).
 *
 * The studio's form column is one rail with a filter over it: Simple shows
 * dimensions, the front-layout slot, the body toggles and the colours;
 * Advanced adds the footprint picker, the overhang numbers and — the reason
 * the split exists — the zone canvas with its splits, dividers and interior
 * drill-in.
 *
 * Four things live only in a browser and are what this suite is for:
 *  - the filter really removes the advanced column rather than hiding a copy
 *    of it (`.zone-canvas` is absent, not merely invisible);
 *  - live-apply still writes from the Simple tab — the filtered rail is the
 *    SAME rail, wired to the same `changed()`;
 *  - the tab is a session flag, so it survives switching to another part;
 *  - boards get no strip at all.
 *
 * The flag module itself is pinned in plain node by test/unit/studioTab.test.ts.
 */

const CABINET = 'base-drawers';
const OTHER_CABINET = 'base-cabinet';

const simpleTab = (page: Page) => page.locator('.studio-tab[data-tab="simple"]');
const advancedTab = (page: Page) => page.locator('.studio-tab[data-tab="advanced"]');

/** The Width box on the Dimensions section — Simple's first field. */
const widthBox = (page: Page) =>
  page.locator('.studio-form .prop-row', { hasText: 'Width' }).locator('input[type=number]');

/** Open a built-in through the Workshop sidebar, as WP 1.6/D4 routes it. */
async function openPart(page: Page, id: string): Promise<void> {
  await page.click('#ws-tab-workshop');
  await page.click(`.wsp-row[data-part-id="${id}"]`);
  await expect(page.locator('#pane-workshop .studio-body .studio-form')).toBeVisible();
  await expect(page.locator('.studio-name')).toHaveValue(/.+/);
}

test('a cabinet opens on Simple: dimensions and the front-layout slot, no zone machinery', async ({
  app,
}) => {
  await openPart(app, CABINET);

  await expect(app.locator('.studio-tabs')).toBeVisible();
  await expect(simpleTab(app)).toHaveClass(/active/);
  await expect(advancedTab(app)).not.toHaveClass(/active/);

  // what a novice gets…
  await expect(widthBox(app)).toBeVisible();
  await expect(app.locator('.studio-front-slot')).toBeVisible();
  await expect(app.locator('#studio-front-layouts')).toHaveCount(1);
  await expect(
    app.locator('.studio-form .prop-section', { hasText: 'Body' }).locator('input[type=checkbox]')
  ).not.toHaveCount(0);
  await expect(app.locator('.studio-form .swatches')).not.toHaveCount(0);

  // …and what is filtered OUT. Absent, not hidden: the zone canvas is a live
  // editor with a ResizeObserver, so Simple must not be a display:none copy.
  await expect(app.locator('.zone-canvas')).toHaveCount(0);
  await expect(app.locator('.zone-toolbar')).toHaveCount(0);
  await expect(app.locator('.foot-choice')).toHaveCount(0);
  await expect(app.locator('.studio-canvas')).toBeHidden();

  // the footer belongs to BOTH tabs — live-apply's caption is not an advanced
  // notion, and neither is a validation message
  await expect(app.locator('.studio-live-note')).toBeVisible();
  await expect(app.locator('.studio-validation')).toHaveCount(1);
});

test('editing Width on the Simple tab reaches the placed instance at once', async ({ app }) => {
  const itemId = await app.evaluate((defId) => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf(defId), 1.2, 1.2, 0);
    st.commit();
    st.select({ kind: 'none' });
    return it.id;
  }, CABINET);

  await openPart(app, CABINET);
  await expect(simpleTab(app)).toHaveClass(/active/);

  // mm is the default display unit (src/model/prefs.ts), so this is 700 mm
  await widthBox(app).fill('700');
  await widthBox(app).blur();

  // The DEF the instance resolves through is what live-apply moves — a placed
  // item keeps its own w/d/h override (CLAUDE.md), so that is the honest
  // assertion, and it is the same one e2e/live-apply.spec.ts makes for drawers.
  await expect
    .poll(() =>
      app.evaluate((id) => {
        const st = window.__kp.store;
        return st.partOf(st.itemById(id)!.defId)!.w;
      }, itemId)
    )
    .toBeCloseTo(0.7, 3);
});

test('Advanced brings back the zone canvas and the footprint picker', async ({ app }) => {
  await openPart(app, CABINET);
  await advancedTab(app).click();

  await expect(advancedTab(app)).toHaveClass(/active/);
  await expect(simpleTab(app)).not.toHaveClass(/active/);
  await expect(app.locator('.studio-canvas')).toBeVisible();
  await expect(app.locator('.zone-canvas')).toBeVisible();
  await expect(app.locator('.foot-choice')).toBeVisible();
  // the front-layout slot is Simple's; Advanced edits the tree itself
  await expect(app.locator('.studio-front-slot')).toHaveCount(0);
  // …and the shared half is still there
  await expect(widthBox(app)).toBeVisible();

  // the canvas is a real editor, not a picture: selecting the root zone brings
  // up its toolbar, which is what the Simple tab was hiding
  const box = (await app.locator('.zone-canvas').boundingBox())!;
  await app.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(app.locator('.zone-stepper')).toBeVisible();

  await simpleTab(app).click();
  await expect(app.locator('.zone-canvas')).toHaveCount(0);
});

test('the tab is a session choice: it follows you to the next part', async ({ app }) => {
  await openPart(app, CABINET);
  await advancedTab(app).click();
  await expect(app.locator('.zone-canvas')).toBeVisible();

  // a different part rebuilds the whole studio (open() closes first), so this
  // is exactly the case a field on PartStudio would have got wrong
  await app.click(`.wsp-row[data-part-id="${OTHER_CABINET}"]`);
  await expect(app.locator('.studio-name')).toHaveValue('Base cabinet');
  await expect(advancedTab(app)).toHaveClass(/active/);
  await expect(app.locator('.zone-canvas')).toBeVisible();

  // and out of the Workshop and back in
  await app.click('#wsp-back');
  await expect(app.locator('.studio')).toHaveCount(0);
  await openPart(app, CABINET);
  await expect(advancedTab(app)).toHaveClass(/active/);
});

test('a board part has no tab strip — there is no advanced half to hide', async ({ app }) => {
  await app.click('#ws-tab-workshop');
  await app.click('#wsp-new');
  await expect(app.locator('#pane-workshop .studio-hosted .studio-cards')).toBeVisible();
  await app.click('.studio-card[data-type="board"]');
  await expect(app.locator('#pane-workshop .studio-body .studio-form')).toBeVisible();

  await expect(app.locator('.studio-tabs')).toBeHidden();
  // the board's own polygon editor is not gated by anything
  await expect(app.locator('.poly-canvas')).toBeVisible();
});
