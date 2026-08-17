import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * THE LEFT SIDEBAR — React owns the tabs and the Variables panel (T3).
 *
 * What these specs cover that test/interact.mjs cannot: it only ever asserts
 * that #tab-components picks up `.active`, and it drives variables purely
 * through store mutators. The panel's own edit paths — the uncontrolled name
 * field, the swatch/material/toggle rows of src/ui/react/fields/, the roving
 * tablist — had no coverage at all, and they are exactly what the port could
 * silently break.
 *
 * The load-bearing invariant is the last spec: a field commits on the DOM's
 * native `change`, and a re-render triggered by ANY other edit must not touch
 * the field the user is typing in. ui.ts bought that with an
 * isEditingVariableName guard around a full innerHTML rebuild; React buys it
 * with reconciliation plus useSyncedValue's activeElement check.
 */

const TABS = ['library', 'components', 'variables'] as const;

interface TabState {
  tab: string;
  /** `.active` on the button */
  active: boolean;
  selected: string | null;
  /** `.active` on the panel — what test/interact.mjs asserts */
  panelActive: boolean;
  panelHidden: boolean;
}

/** The three tab buttons' state, in DOM order — one round trip per assertion. */
async function tabState(page: Page): Promise<TabState[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs button')].map((btn) => {
      const panel = document.getElementById(`tab-${btn.dataset.tab}`)!;
      return {
        tab: btn.dataset.tab as string,
        active: btn.classList.contains('active'),
        selected: btn.getAttribute('aria-selected'),
        panelActive: panel.classList.contains('active'),
        panelHidden: panel.hidden,
      };
    })
  );
}

/** What every button/panel pair looks like when `open` is the chosen tab. */
function expected(open: string): TabState[] {
  return TABS.map((tab) => ({
    tab,
    active: tab === open,
    selected: String(tab === open),
    panelActive: tab === open,
    panelHidden: tab !== open,
  }));
}

/** Open the Variables tab and add one variable; returns its id. */
async function addVariable(page: Page): Promise<string> {
  await page.click('#tab-btn-variables');
  await page.click('#variables-panel .prop-section > .btn-row button');
  await expect(page.locator('#variables-panel .var-item')).toHaveCount(1);
  return page.evaluate(() => window.__kp.store.design.variables[0].id);
}

/** Count 'history' emissions from here on — one per undo step. */
async function watchHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hist: number };
    w.__hist = 0;
    window.__kp.store.on('history', () => {
      w.__hist++;
    });
  });
}

const historyCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __hist: number }).__hist);

test.beforeEach(async ({ app }) => {
  // WS-SPEC §4.5: the tab strip is furnish's sidebar; every spec below assumes
  // it, so switch explicitly even though it's already the fixture's default.
  await app.click('#ws-tab-furnish');
});

test('a tab switch moves the class, the hidden attribute and aria-selected together', async ({
  app,
}) => {
  expect(await tabState(app)).toEqual(expected('library'));

  await app.click('#tab-btn-components');
  expect(await tabState(app)).toEqual(expected('components'));
  // #outline renders regardless of the tab — the switch
  // only ever changes visibility
  await expect(app.locator('#outline .ol-head')).toBeVisible();

  await app.click('#tab-btn-variables');
  expect(await tabState(app)).toEqual(expected('variables'));
  await expect(app.locator('#variables-panel .prop-section-title')).toHaveText('Variables');

  await app.click('#tab-btn-library');
  expect(await tabState(app)).toEqual(expected('library'));
  await expect(app.locator('#catalog-inner')).toBeVisible();
});

test('ArrowRight / ArrowLeft rove focus and selection around the tablist', async ({ app }) => {
  const focused = (): Promise<string | undefined> =>
    app.evaluate(() => (document.activeElement as HTMLElement | null)?.id);

  await app.click('#tab-btn-library');
  expect(await focused()).toBe('tab-btn-library');

  for (const tab of ['components', 'variables', 'library'] as const) {
    await app.keyboard.press('ArrowRight');
    expect(await focused(), `ArrowRight → ${tab}`).toBe(`tab-btn-${tab}`);
    expect(await tabState(app)).toEqual(expected(tab));
  }

  // and back the other way, wrapping past the first button
  for (const tab of ['variables', 'components', 'library'] as const) {
    await app.keyboard.press('ArrowLeft');
    expect(await focused(), `ArrowLeft → ${tab}`).toBe(`tab-btn-${tab}`);
    expect(await tabState(app)).toEqual(expected(tab));
  }
});

test('the variables panel adds, renames and deletes a variable', async ({ app }) => {
  const id = await addVariable(app);
  expect(await app.evaluate(() => window.__kp.store.design.variables[0].name)).toBe('Variable 1');
  await expect(app.locator('#variables-panel .var-name')).toHaveValue('Variable 1');

  // rename: type, then blur — the DOM's change event is the ONLY commit path
  await watchHistory(app);
  const name = app.locator('#variables-panel .var-name');
  await name.click();
  await app.keyboard.press('ControlOrMeta+a');
  await app.keyboard.type('Walnut fronts');
  expect(await historyCount(app), 'typing must not commit').toBe(0);

  await name.blur();
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.variables[0].name))
    .toBe('Walnut fronts');
  expect(await historyCount(app), 'one edit, one undo step').toBe(1);
  // the re-render this commit triggered writes the stored name back into the field
  await expect(name).toHaveValue('Walnut fronts');

  // a blank name falls back rather than committing an unnamed variable
  await name.click();
  await app.keyboard.press('ControlOrMeta+a');
  await app.keyboard.press('Delete');
  await name.blur();
  await expect(name).toHaveValue('Variable');

  // "New items use" only exists once a variable does, and drives defaultFrontVar
  await app.selectOption('#variables-panel select', id);
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.defaultFrontVar)).toBe(id);

  await app.click('#variables-panel .var-item .btn-row button.danger');
  await expect(app.locator('#variables-panel .var-item')).toHaveCount(0);
  expect(await app.evaluate(() => window.__kp.store.design.variables.length)).toBe(0);
  // the select goes with the last variable
  await expect(app.locator('#variables-panel select')).toHaveCount(0);
});

test('the swatch, material and rotate rows all commit through the store', async ({ app }) => {
  const id = await addVariable(app);
  const read = (): Promise<{ color: string; material?: string; materialRot?: boolean }> =>
    app.evaluate(() => {
      const v = window.__kp.store.design.variables[0];
      return { color: v.color, material: v.material, materialRot: v.materialRot };
    });

  // a literal swatch (FRONT_COLORS[3])
  await app.click('#variables-panel .var-item .swatches button[title="#31455a"]');
  await expect.poll(async () => (await read()).color).toBe('#31455a');

  // a textured material chip — and the rotate toggle it brings with it
  await expect(app.locator('#variables-panel .toggle-row')).toHaveCount(0);
  await app.click('#variables-panel .var-item .swatches button[title="Oak"]');
  await expect.poll(async () => (await read()).material).toBe('oak');
  await expect(app.locator('#variables-panel .toggle-row label').first()).toHaveText(
    'Rotate texture 90°'
  );

  // the checkbox is 0×0 (style.css hides it behind .track), so click the track
  await app.click('#variables-panel .toggle-row .track');
  await expect.poll(async () => (await read()).materialRot).toBe(true);

  // picking a plain colour drops a colour-hiding texture, so the colour shows
  await app.click('#variables-panel .var-item .swatches button[title="#f2f1ec"]');
  await expect.poll(async () => await read()).toEqual({ color: '#f2f1ec' });
  await expect(app.locator('#variables-panel .toggle-row')).toHaveCount(0);

  // bulk bind: every placed item's front slot points at the variable, and the
  // status bar says how many
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('base-cabinet'), 1.5, 1.0, 0);
    st.commit();
  });
  await app.click('#variables-panel .var-item .btn-row button:not(.danger)');
  expect(await app.evaluate(() => window.__kp.store.design.items[0].color)).toBe(`var:${id}`);
  await expect(app.locator('#status-hint')).toHaveText('Bound 1 item to "Variable 1"');
});

test('a name being typed survives a commit from elsewhere', async ({ app }) => {
  await addVariable(app);
  const name = app.locator('#variables-panel .var-name');

  await name.click();
  await app.keyboard.press('ControlOrMeta+a');
  await app.keyboard.type('Oak');

  // something else commits — day/night is the smallest edit that does — which
  // re-renders the panel while the caret is still in the field
  await watchHistory(app);
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.setNight(!st.design.scene.night);
    st.commit();
  });
  await expect.poll(() => historyCount(app)).toBe(1);

  const state = await app.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('#variables-panel .var-name')!;
    return {
      focused: document.activeElement === el,
      value: el.value,
      caret: el.selectionStart,
      stored: window.__kp.store.design.variables[0].name,
    };
  });
  expect(state.focused, 'the field must keep focus across the re-render').toBe(true);
  expect(state.value).toBe('Oak');
  expect(state.caret, 'and the caret its place').toBe(3);
  // nothing was committed by the typing itself
  expect(state.stored).toBe('Variable 1');

  // the edit still lands when the user finishes it
  await name.blur();
  await expect
    .poll(() => app.evaluate(() => window.__kp.store.design.variables[0].name))
    .toBe('Oak');
});

test('the sidebar swaps per workspace', async ({ app }) => {
  // workshop replaces the tab strip + three panels with the parts list
  // (WS-SPEC §4.5) — the Workshop canvas pane itself is WP 1.6, so a row
  // click today only switches workspace + sets the target.
  await app.click('#ws-tab-workshop');
  await expect(app.locator('#workshop-parts')).toBeVisible();
  await expect(app.locator('#sidebar-tabs')).toHaveCount(0);
  await expect(app.locator('.wsp-row.wsp-preset')).toHaveCount(14);

  // a design-local custom part shows up as its own (non-preset) row
  await app.evaluate(() => {
    const st = window.__kp.store;
    const copy = JSON.parse(JSON.stringify(st.partOf('base-cabinet')));
    copy.id = 'sidebar-e2e-part';
    copy.name = 'Sidebar E2E Part';
    st.upsertCustomPart(copy);
    st.commit();
  });
  const row = app.locator('.wsp-row[data-part-id="sidebar-e2e-part"]');
  await expect(row).toBeVisible();
  await expect(row).not.toHaveClass(/wsp-preset/);
  await expect(row).toContainText('Sidebar E2E Part');

  // "+ New part" stays inside the Workshop workspace
  await app.click('#wsp-new');
  await expect(app.locator('#ws-tab-workshop')).toHaveClass(/active/);

  // and the swap is reversible: furnish gets its three tabs back, library open
  await app.click('#ws-tab-furnish');
  await expect(app.locator('#sidebar-tabs')).toBeVisible();
  await expect(app.locator('#tab-btn-library')).toHaveClass(/active/);
  await expect(app.locator('#tab-library')).toBeVisible();
});
