import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * THE WARDROBE EDITOR (Part Studio).
 *
 * WardrobeCanvas (src/ui/partstudio/wardrobeCanvas.ts) is a front-elevation
 * editor for a fitted run of columns — its own thing, not a zone tree — but
 * it is LIVE-APPLY exactly like the cabinet editor (CLAUDE.md, WS-SPEC WP
 * 3.1): every edit writes straight into `design.customParts` through
 * `store.updateCustomPart`, so a placed instance, the 3D scene and undo all
 * follow it with no Save/Revert step. This suite drives it the way a user
 * would — clicks and drags on the canvas, not store shortcuts — and reads
 * back through the SAME e2e dataset seams `WardrobeCanvas.writeSeams` writes
 * on every draw (`dividers`/`sections`/`chips`, all in canvas CSS px), which
 * is what keeps the coordinates here honest instead of re-deriving the
 * canvas' own view transform.
 */

const PRESET = 'wardrobe-fitted'; // src/model/presets.ts — the 4-column bedroom preset

interface SectionRect {
  c: number;
  s: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WardrobeSeams {
  /** the canvas' own top-left, so every rect below can be turned into a click point */
  rect: { x: number; y: number };
  dividers: number[];
  sections: SectionRect[];
  chips: number[];
}

/**
 * The canvas position and its e2e dataset seams, read in ONE round trip so
 * they describe the same paint — a separate `boundingBox()` call could race
 * a ResizeObserver redraw between the two.
 */
async function wardrobeSeams(page: Page): Promise<WardrobeSeams> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#studio-wardrobe-canvas')!;
    const r = canvas.getBoundingClientRect();
    const ds = canvas.dataset;
    return {
      rect: { x: r.left, y: r.top },
      dividers: ds.dividers ? ds.dividers.split(',').map(Number) : [],
      sections: ds.sections ? (JSON.parse(ds.sections) as SectionRect[]) : [],
      chips: ds.chips ? ds.chips.split(',').map(Number) : [],
    };
  });
}

/** id of the most recently created design-local custom part. */
const newestPartId = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const parts = window.__kp.store.design.customParts;
    return parts[parts.length - 1].id;
  });

/** Open a brand-new wardrobe part through the type picker; returns its id. */
async function openNewWardrobe(page: Page): Promise<string> {
  await page.click('#ws-tab-workshop');
  await page.click('#wsp-new');
  const card = page.locator('.studio-card[data-type="wardrobe"]');
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#studio-wardrobe-canvas')).toBeVisible();
  return newestPartId(page);
}

/** Open a preset (or an already design-local part) through the Workshop sidebar row. */
async function openPartInWorkshop(page: Page, id: string): Promise<void> {
  await page.click('#ws-tab-workshop');
  await page.click(`.wsp-row[data-part-id="${id}"]`);
  await expect(page.locator('#studio-wardrobe-canvas')).toBeVisible();
}

const columnCount = (page: Page, id: string): Promise<number> =>
  page.evaluate((pid) => {
    const p = window.__kp.store.partOf(pid);
    return p && p.type === 'wardrobe' ? p.columns.length : -1;
  }, id);

const columnWidths = (page: Page, id: string): Promise<(number | 'fill')[]> =>
  page.evaluate((pid) => {
    const p = window.__kp.store.partOf(pid);
    return p && p.type === 'wardrobe' ? p.columns.map((c) => c.w) : [];
  }, id);

const columnDoor = (page: Page, id: string, c: number): Promise<string | null> =>
  page.evaluate(
    (a) => {
      const p = window.__kp.store.partOf(a.pid);
      return p && p.type === 'wardrobe' ? (p.columns[a.c]?.door ?? null) : null;
    },
    { pid: id, c }
  );

const sectionKind = (page: Page, id: string, c: number, s: number): Promise<string | null> =>
  page.evaluate(
    (a) => {
      const p = window.__kp.store.partOf(a.pid);
      return p && p.type === 'wardrobe' ? (p.columns[a.c]?.sections[a.s]?.kind ?? null) : null;
    },
    { pid: id, c, s }
  );

const frontKind = (page: Page, id: string): Promise<string | null> =>
  page.evaluate((pid) => {
    const p = window.__kp.store.partOf(pid);
    return p && p.type === 'wardrobe' ? p.front.kind : null;
  }, id);

const frontPanels = (page: Page, id: string): Promise<number | null> =>
  page.evaluate((pid) => {
    const p = window.__kp.store.partOf(pid);
    return p && p.type === 'wardrobe' && p.front.kind === 'sliding' ? p.front.panels : null;
  }, id);

/** Place one instance of a def, selection-free, undo-committed — mirrors e2e/live-apply.spec.ts. */
async function placeInstance(page: Page, defId: string): Promise<string> {
  return page.evaluate((id) => {
    const st = window.__kp.store;
    const it = st.addItem(st.defOf(id), 1.2, 1.2, 0);
    st.commit();
    window.__kp.editor.select({ kind: 'none' });
    return it.id;
  }, defId);
}

/** How many sliding/hinging fronts the item's live 3D mesh group carries — e2e/live-apply.spec.ts's helper. */
const motionUnits = (page: Page, itemId: string): Promise<number> =>
  page.evaluate((id) => {
    const entry = window.__kp.view.items.get(id);
    if (!entry) return -1;
    let n = 0;
    entry.group.traverse((o) => {
      if (o.userData.motionUnit) n++;
    });
    return n;
  }, itemId);

/** Ctrl+Z inside the studio is the global command, not a text field's own undo — blur first. */
const blurActive = (page: Page): Promise<void> =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/**
 * Click column `c`'s door chip until its door value cycles.
 *
 * `writeSeams` (wardrobeCanvas.ts) deliberately gives a spec the chip's X
 * centre only — its Y band sits a small, fixed distance (plinth height + one
 * carcass board) below the run's floor line, which is NOT part of the e2e
 * seam contract ("a spec never has to re-derive the view transform"). So
 * this scans downward from the lowest section's own bottom edge — the
 * closest px reference the seams do give — instead of reconstructing that
 * offset from the canvas' private layout constants.
 */
async function clickDoorChip(page: Page, id: string, c: number): Promise<void> {
  const before = await columnDoor(page, id, c);
  const seam = await wardrobeSeams(page);
  const chipX = seam.rect.x + seam.chips[c];
  const baseY = seam.rect.y + Math.max(...seam.sections.map((r) => r.y + r.h));
  for (let dy = 0; dy <= 90; dy += 5) {
    await page.mouse.click(chipX, baseY + dy);
    if ((await columnDoor(page, id, c)) !== before) return;
  }
  throw new Error('door chip click never cycled the door — scan range too small');
}

test('the type picker opens a wardrobe on a 2-column run', async ({ app }) => {
  const id = await openNewWardrobe(app);
  await expect.poll(() => columnCount(app, id)).toBe(2);
});

test('the fitted preset opens with its 4 columns, canvas visible on the Simple tab', async ({
  app,
}) => {
  await openPartInWorkshop(app, PRESET);

  // the deliberate difference from a cabinet (WS-SPEC WP 3.3): a wardrobe has
  // no canned front-layout tile to stand in for the column canvas, so it
  // stays on screen on BOTH sub-tabs
  await expect(app.locator('.studio-tab[data-tab="simple"]')).toHaveClass(/active/);
  await expect(app.locator('#studio-wardrobe-canvas')).toBeVisible();

  await expect.poll(() => columnCount(app, PRESET)).toBe(4);
});

test('dragging a column divider resizes live; one Ctrl+Z undoes the whole drag', async ({
  app,
}) => {
  const id = await openNewWardrobe(app);

  const seam = await wardrobeSeams(app);
  expect(seam.dividers.length).toBeGreaterThan(0);
  expect(seam.sections.length).toBeGreaterThan(0);
  const divX = seam.rect.x + seam.dividers[0];
  const midY = seam.rect.y + seam.sections[0].y + seam.sections[0].h / 2;

  const before = await columnWidths(app, id);

  await app.mouse.move(divX, midY);
  await app.mouse.down();
  for (let i = 1; i <= 8; i++) await app.mouse.move(divX + i * 5, midY);
  await app.mouse.up();

  // the drag committed a real change…
  await expect.poll(() => columnWidths(app, id)).not.toEqual(before);

  // …as mid-drag TRANSIENT ticks, which take no undo step of their own — one
  // Ctrl+Z is enough to unwind the whole gesture back to where it started
  await blurActive(app);
  await app.keyboard.press('Control+z');

  await expect.poll(() => columnWidths(app, id)).toEqual(before);
});

test('the section popover switches a kind live', async ({ app }) => {
  const id = await openNewWardrobe(app);
  const seam = await wardrobeSeams(app);
  const rect = seam.sections[0];
  expect(await sectionKind(app, id, rect.c, rect.s)).toBe('hanging');

  await app.mouse.click(seam.rect.x + rect.x + rect.w / 2, seam.rect.y + rect.y + rect.h / 2);
  await expect(app.locator('.studio-wardrobe-pop')).toBeVisible();

  await app.click('.studio-wardrobe-kind[data-kind="drawers"]');
  await expect.poll(() => sectionKind(app, id, rect.c, rect.s)).toBe('drawers');

  await app.keyboard.press('Escape');
  await expect(app.locator('.studio-wardrobe-pop')).toHaveCount(0);
});

test('the front choice switches sliding/hinged live, driving the door chips', async ({ app }) => {
  const id = await openNewWardrobe(app);
  expect(await frontKind(app, id)).toBe('hinged');

  await app.locator('.studio-wardrobe-front button', { hasText: 'Sliding 2' }).click();
  await expect.poll(() => frontKind(app, id)).toBe('sliding');
  expect(await frontPanels(app, id)).toBe(2);
  // sliding fronts carry no door — the per-column chip band disappears
  await expect.poll(async () => (await wardrobeSeams(app)).chips).toEqual([]);

  await app.locator('.studio-wardrobe-front button', { hasText: 'Hinged' }).click();
  await expect.poll(() => frontKind(app, id)).toBe('hinged');
  const seam = await wardrobeSeams(app);
  expect(seam.chips.length).toBeGreaterThan(0);
  expect(await columnDoor(app, id, 0)).toBe('auto');

  await clickDoorChip(app, id, 0);
  expect(await columnDoor(app, id, 0)).toBe('none');
});

test('a front switch reaches the 3D scene of a placed instance', async ({ app }) => {
  const id = await openNewWardrobe(app);
  const itemId = await placeInstance(app, id);

  await app.evaluate(() => window.__kp.view.flushRebuild());
  const before = await motionUnits(app, itemId);
  expect(before).toBeGreaterThan(0);

  await app.locator('.studio-wardrobe-front button', { hasText: 'Sliding 2' }).click();
  await expect.poll(() => frontKind(app, id)).toBe('sliding');

  await app.evaluate(() => window.__kp.view.flushRebuild());
  await expect.poll(() => motionUnits(app, itemId)).not.toBe(before);
});

test('undoing a popover kind change restores the previous kind', async ({ app }) => {
  const id = await openNewWardrobe(app);
  const seam = await wardrobeSeams(app);
  const rect = seam.sections[0];
  const original = await sectionKind(app, id, rect.c, rect.s);
  expect(original).toBe('hanging');

  await app.mouse.click(seam.rect.x + rect.x + rect.w / 2, seam.rect.y + rect.y + rect.h / 2);
  await expect(app.locator('.studio-wardrobe-pop')).toBeVisible();
  await app.click('.studio-wardrobe-kind[data-kind="drawers"]');
  await expect.poll(() => sectionKind(app, id, rect.c, rect.s)).toBe('drawers');

  await blurActive(app);
  await app.keyboard.press('Control+z');

  await expect.poll(() => sectionKind(app, id, rect.c, rect.s)).toBe(original);
});

test('Custom… on a section drops into the shared interior drill-in', async ({ app }) => {
  await openNewWardrobe(app);
  const seam = await wardrobeSeams(app);
  const rect = seam.sections[0];

  await app.mouse.click(seam.rect.x + rect.x + rect.w / 2, seam.rect.y + rect.y + rect.h / 2);
  await expect(app.locator('.studio-wardrobe-pop')).toBeVisible();
  await app.click('.studio-wardrobe-kind[data-kind="custom"]');

  // the SAME InteriorEditor the cabinet's zone canvas drill-in uses
  // (src/ui/partstudio/interiorEditor.ts) — proven by its toolbar, not by name
  const toolbar = app.locator('.studio-wardrobe .zone-toolbar');
  await expect(toolbar.locator('button', { hasText: '← Done' })).toBeVisible();
  await expect(toolbar.locator('button', { hasText: '＋ Shelf' })).toBeVisible();
  await expect(toolbar.locator('button', { hasText: '＋ Rail' })).toBeVisible();

  await app.keyboard.press('Escape');

  await expect(app.locator('#studio-wardrobe-canvas')).toBeVisible();
  await expect(toolbar.locator('button', { hasText: '＋ Shelf' })).toHaveCount(0);
  await expect(toolbar.locator('button', { hasText: '＋ Column' })).toBeVisible();
});
