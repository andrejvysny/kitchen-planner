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

/* ---------------- "Place in room": the Workshop's route to the plan ---------------- */

/** Pin the plan transform, so world→screen below is exact rather than fitted. */
const VIEW = { zoom: 60, panX: 120, panY: 120 };

/** Page coordinates of a plan world point, under the pinned transform. */
async function planAt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  await page.evaluate((v) => window.__kp.plan.setViewport(v), VIEW);
  const box = (await page.locator('#canvas2d').boundingBox())!;
  return { x: box.x + x * VIEW.zoom + VIEW.panX, y: box.y + y * VIEW.zoom + VIEW.panY };
}

const armedState = (page: Page): Promise<{ tool: string; def: string | null }> =>
  page.evaluate(() => ({ tool: window.__kp.editor.tool, def: window.__kp.editor.armedDefId }));

/**
 * Press "Place in room" and wait until the Workshop pane is actually gone —
 * it covers #canvases, so clicking the plan before it unmounts would land on
 * the pane instead of the canvas.
 */
async function placeInRoom(page: Page): Promise<void> {
  await page.click('#studio-place-btn');
  await expect.poll(() => page.evaluate(() => window.__kp.workspace())).toBe('furnish');
  await expect(page.locator('#pane-workshop')).toHaveCount(0);
}

/**
 * A wardrobe is BUILT-IN furniture, so it is measured to the alcove it lands
 * in rather than bought at a catalog width (store.addItem seeds `item.fit`).
 * These three drive that end to end: the Workshop button that arms it, the
 * ghost that previews the stretch, and the placement that commits it.
 *
 * The room is the fixture's deterministic 4 x 3, and `wardrobe-fitted` is
 * 3.0 m wide — so "fitted" is visible as a full metre of growth, not a nudge.
 */
test('“Place in room” lands in Furnish with the part armed', async ({ app }) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);
  // armed exactly the way a catalog tile arms it — same editor state
  await expect.poll(() => armedState(app)).toEqual({ tool: 'place', def: PRESET });
});

test('the armed ghost stretches to the alcove before the click', async ({ app }) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);

  const natural = await app.evaluate((id) => window.__kp.store.defOf(id).w, PRESET);
  expect(natural).toBeCloseTo(3.0, 5);

  // off the wall first: nothing to fit against, so the ghost is the def's own
  const away = await planAt(app, 2, 1.5);
  await app.mouse.move(away.x, away.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().ghost?.w))
    .toBeUndefined();

  // back-to-wall: the ghost previews the width the click will actually produce
  const atWall = await planAt(app, 2, 0.35);
  await app.mouse.move(atWall.x, atWall.y);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.overlayState().ghost?.w ?? 0))
    .toBeGreaterThan(natural);
});

test('placing it against a wall fits the width to the alcove and the height to the ceiling', async ({
  app,
}) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);

  const p = await planAt(app, 2, 0.35);
  await app.mouse.move(p.x, p.y);
  await app.mouse.click(p.x, p.y);

  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(1);

  const placed = await app.evaluate(() => {
    const st = window.__kp.store;
    const it = st.design.items[0];
    const room = st.activeRoom()!;
    const xs = room.corners.map((c) => c.x);
    return {
      w: it.w,
      h: it.h,
      fit: it.fit,
      // the room is an exterior rectangle, so its X extent IS the alcove the
      // top wall offers — no wall-ordering assumption needed
      span: Math.max(...xs) - Math.min(...xs),
      ceilH: room.style.wallHeight - it.elevation,
    };
  });

  expect(placed.fit).toEqual({ width: 'walls', height: 'ceiling' });
  expect(placed.w).toBeGreaterThan(3.0); // grew past its catalog width
  expect(placed.w).toBeCloseTo(placed.span, 3);
  expect(placed.h).toBeCloseTo(placed.ceilH, 5);
});

/* ---------------- the free-segment band under the ghost ---------------- */

/**
 * A wall is not one alcove: a doorway, its swing, a window or a neighbouring
 * unit cuts it into FREE SEGMENTS, and the armed run may only claim the one
 * under the cursor. These pin the band the plan draws for that (`ghostSegment`,
 * src/plan2d/renderPlan.ts) and the placement that follows it.
 *
 * The trap they exist to catch: `snapItem` clamps the snapped pose's t to
 * `[w / 2, len − w / 2]` so a wide def cannot hang off either end of its wall.
 * Reading the segment off that pose instead of off the RAW pointer projection
 * makes every stretch inside the margin unreachable — a 3 m def on a 4 m wall
 * would answer with the same middle segment wherever in the outer 1.5 m the
 * cursor actually is.
 */

interface WallRef {
  id: string;
  len: number;
}

/** The fixture room's y = 0 wall — the one every placement test here hugs. */
const topWall = (page: Page): Promise<WallRef> =>
  page.evaluate(() => {
    const g = window.__kp.store
      .allWalls()
      .find((wl) => Math.abs(wl.a.y) < 1e-6 && Math.abs(wl.b.y) < 1e-6)!;
    return { id: g.id, len: g.len };
  });

/** Hang a door on `wallId` centred at `t`; hands back its two jambs in wall-t. */
const addDoor = (page: Page, wallId: string, t: number): Promise<{ lo: number; hi: number }> =>
  page.evaluate(
    (a) => {
      const st = window.__kp.store;
      const o = st.addOpening(st.defOf('door'), a.wallId, a.t);
      st.commit();
      return { lo: o.offset - o.width / 2, hi: o.offset + o.width / 2 };
    },
    { wallId, t }
  );

/**
 * Page point for a 0.6 m-deep run standing back-to-`wallId` at along-wall
 * distance `t` — dead on the wall face, so `snapItem` cannot prefer a
 * perpendicular neighbour near a corner.
 */
async function wallHover(page: Page, wallId: string, t: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(
    (a) => {
      const g = window.__kp.store.allWalls().find((wl) => wl.id === a.wallId)!;
      const off = g.faceOffset + 0.3;
      return {
        x: g.a.x + g.dir.x * a.t + g.inward.x * off,
        y: g.a.y + g.dir.y * a.t + g.inward.y * off,
      };
    },
    { wallId, t }
  );
  return planAt(page, p.x, p.y);
}

const ghostSegment = (page: Page) =>
  page.evaluate(() => window.__kp.plan.overlayState().ghostSegment);

const ghostWidth = (page: Page): Promise<number | undefined> =>
  page.evaluate(() => window.__kp.plan.overlayState().ghost?.w);

/** Arm the preset with a door already on the top wall; hands back both. */
async function armedWithDoor(page: Page): Promise<{ wall: WallRef; lo: number; hi: number }> {
  await openPartInWorkshop(page, PRESET);
  const wall = await topWall(page);
  const jambs = await addDoor(page, wall.id, 1.2); // 0.9 m wide → jambs at 0.75 / 1.65
  await placeInRoom(page);
  return { wall, ...jambs };
}

test('the ghost stops at a doorway instead of spanning the wall', async ({ app }) => {
  const { wall, lo } = await armedWithDoor(app);

  const p = await wallHover(app, wall.id, 0.4);
  await app.mouse.move(p.x, p.y);

  await expect.poll(async () => (await ghostSegment(app))?.tooNarrow).toBe(false);
  const seg = (await ghostSegment(app))!;
  expect(seg.wallId).toBe(wall.id);
  // the free stretch is the wall UP TO the near jamb — a door's swing sector
  // spans exactly its own opening, so the jamb is the whole stop
  expect(seg.t0).toBeCloseTo(0, 3);
  expect(seg.t1).toBeCloseTo(lo, 3);
  expect(seg.t1 - seg.t0).toBeLessThan(wall.len);
  // and the ghost promises exactly that stretch, not the catalog width
  expect(await ghostWidth(app)).toBeCloseTo(lo, 3);
});

test('the segment moves with the cursor, read off the RAW pointer t', async ({ app }) => {
  const { wall, lo, hi } = await armedWithDoor(app);

  // 40 cm from either END of the wall — both inside the clamp band, so a
  // segment read off the snapped pose would answer the same stretch twice
  const left = await wallHover(app, wall.id, 0.4);
  await app.mouse.move(left.x, left.y);
  await expect.poll(async () => (await ghostSegment(app))?.t1).toBeCloseTo(lo, 3);
  const near = (await ghostSegment(app))!;

  const right = await wallHover(app, wall.id, wall.len - 0.4);
  await app.mouse.move(right.x, right.y);
  await expect.poll(async () => (await ghostSegment(app))?.t0).toBeCloseTo(hi, 3);
  const far = (await ghostSegment(app))!;

  expect(far.t0).toBeGreaterThan(near.t1); // the band jumped the doorway
  expect(far.t1).toBeCloseTo(wall.len, 3);
  expect(near.t0).toBeCloseTo(0, 3);
});

test('an untyped click fills the segment the band highlighted', async ({ app }) => {
  const { wall, hi } = await armedWithDoor(app);

  const p = await wallHover(app, wall.id, wall.len - 0.4);
  await app.mouse.move(p.x, p.y);
  await expect.poll(async () => (await ghostSegment(app))?.t0).toBeCloseTo(hi, 3);
  await app.mouse.click(p.x, p.y);

  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(1);
  const placed = await app.evaluate(() => {
    const it = window.__kp.store.design.items[0];
    return { w: it.w, fit: it.fit };
  });
  // it SHRANK from its 3.0 m catalog width into the 2.35 m past the door, and
  // kept asking to be fitted — nothing was typed, so nothing overrode the axis
  expect(placed.fit?.width).toBe('walls');
  expect(placed.w).toBeCloseTo(wall.len - hi, 3);
});

/* ---------------- the placement HUD: a typed run width (P3) ---------------- */

/**
 * `#place-hud` (src/ui/react/CanvasOverlays.tsx) is the wall tool's
 * `#draw-hud` one level narrower: width only, because the free segment
 * already fixed the position. Digits reach it through `place.digit*`
 * (src/editor/keyboard/bindings.ts), gated on `placeInputActive` — an armed
 * def AND a ghost that has actually landed on a free segment — exactly like
 * `armedWithDoor`'s clean-wall siblings above, just with keystrokes added.
 */
const placeHudValue = (page: Page) => page.locator('#place-hud .place-hud-value');

test('a typed width places exactly that width, centred', async ({ app }) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);
  const wall = await topWall(app);
  const t = wall.len / 2;
  const p = await wallHover(app, wall.id, t);
  await app.mouse.move(p.x, p.y);
  await expect.poll(async () => (await ghostSegment(app))?.t1).toBeCloseTo(wall.len, 3);

  await app.keyboard.press('9');
  await app.keyboard.press('0');
  await app.keyboard.press('0');
  await expect(placeHudValue(app)).toHaveText('900');

  await app.mouse.click(p.x, p.y);
  await expect.poll(() => app.evaluate(() => window.__kp.store.design.items.length)).toBe(1);

  const placed = await app.evaluate(() => {
    const it = window.__kp.store.design.items[0];
    return { w: it.w, fitWidth: it.fit?.width, fitHeight: it.fit?.height, x: it.x, y: it.y };
  });
  expect(placed.w).toBeCloseTo(0.9, 3);
  // the typed width overrode that axis — `updateItem`'s existing rule drops
  // fit.width and keeps fit.height, exactly as an untyped fit never would
  expect(placed.fitWidth).toBeUndefined();
  expect(placed.fitHeight).toBe('ceiling');

  // it lands on the SEGMENT's centre — the same point an untyped fill would —
  // not wherever along the wall the cursor happened to be
  const centre = await app.evaluate(
    (a) => {
      const st = window.__kp.store;
      const g = st.allWalls().find((wl) => wl.id === a.wallId)!;
      const off = g.faceOffset + st.defOf(a.presetId).d / 2;
      return {
        x: g.a.x + g.dir.x * a.t + g.inward.x * off,
        y: g.a.y + g.dir.y * a.t + g.inward.y * off,
      };
    },
    { wallId: wall.id, t, presetId: PRESET }
  );
  expect(placed.x).toBeCloseTo(centre.x, 3);
  expect(placed.y).toBeCloseTo(centre.y, 3);
});

test('Escape clears the typed width before disarming', async ({ app }) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);
  const wall = await topWall(app);
  const p = await wallHover(app, wall.id, wall.len / 2);
  await app.mouse.move(p.x, p.y);
  await expect.poll(async () => (await ghostSegment(app))?.t1).toBeCloseTo(wall.len, 3);

  await app.keyboard.press('9');
  await app.keyboard.press('0');
  await app.keyboard.press('0');
  await expect(placeHudValue(app)).toHaveText('900');

  // first Escape: still armed, but the typed width is gone — the value falls
  // back to the free span instead
  await app.keyboard.press('Escape');
  await expect.poll(() => armedState(app)).toEqual({ tool: 'place', def: PRESET });
  await expect(placeHudValue(app)).not.toHaveText('900');

  // second Escape: the box was already empty, so this one disarms
  await app.keyboard.press('Escape');
  await expect.poll(() => armedState(app)).toEqual({ tool: 'select', def: null });
});

test('#draw-hud and #place-hud never coexist', async ({ app }) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);
  const wall = await topWall(app);
  const p = await wallHover(app, wall.id, wall.len / 2);
  await app.mouse.move(p.x, p.y);
  await expect(app.locator('#place-hud')).toBeVisible();
  await expect(app.locator('#draw-hud')).toHaveCount(0);

  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape');
  await expect.poll(() => armedState(app)).toEqual({ tool: 'select', def: null });
  await expect(app.locator('#place-hud')).toHaveCount(0);

  // the wall tool only renders in the Plan workspace (WS-SPEC §4.4)
  await app.click('#ws-tab-plan');
  await app.click('#btn-draw-room');
  const a = await planAt(app, 0.5, 0.5);
  await app.mouse.move(a.x, a.y);
  await app.mouse.click(a.x, a.y);
  const b = await planAt(app, 2, 1.5);
  await app.mouse.move(b.x, b.y);
  await expect(app.locator('#draw-hud')).toBeVisible();
  await expect(app.locator('#place-hud')).toHaveCount(0);
});

/* ---------------- adopting the instance's dims on the way into the Workshop ---------------- */

/**
 * A wardrobe's def and its placed instance are allowed to disagree: the column
 * canvas lays the run out at `part.w`, while a FITTED instance took its width
 * from the wall segment it landed in. Opening that instance in the Workshop
 * therefore reconciles first (`store.adoptItemDims`), or the editor would draw
 * a 3.0 m run for a wardrobe that is really 4 m wide and every column the user
 * sized would be sized against the wrong total.
 */

const partDim = (page: Page, id: string, k: 'w' | 'd' | 'h'): Promise<number | null> =>
  page.evaluate((a) => window.__kp.store.partOf(a.id)?.[a.k] ?? null, { id, k });

/**
 * Per-column widths as the canvas actually drew them, in CSS px, from the
 * `sections` seam (a column with several sections contributes the same width
 * more than once, so take the max per column index).
 */
async function columnPx(page: Page): Promise<number[]> {
  const seam = await wardrobeSeams(page);
  const px: number[] = [];
  for (const r of seam.sections) px[r.c] = Math.max(px[r.c] ?? 0, r.w);
  return px;
}

/**
 * Select a placed item and take its props-panel route into the Workshop —
 * "Edit in Workshop…" for a design-local part, "Customize in Workshop…" for a
 * preset (which forks first). Returns the def the item resolves to AFTER the
 * trip, which the adopt may have forked.
 */
async function editItemInWorkshop(page: Page, itemId: string): Promise<string> {
  await page.evaluate((id) => {
    window.__kp.setWorkspace('furnish');
    window.__kp.editor.select({ kind: 'item', id });
  }, itemId);
  const btn = page.locator('#props-inner button', { hasText: /in Workshop…$/ });
  await expect(btn).toHaveCount(1);
  await btn.click();
  await expect(page.locator('#studio-wardrobe-canvas')).toBeVisible();
  return page.evaluate((id) => window.__kp.store.itemById(id)!.defId, itemId);
}

/** Place the armed preset back-to-wall and hand back the fitted instance. */
async function placeFittedOnWall(page: Page): Promise<{ id: string; w: number; h: number }> {
  const p = await planAt(page, 2, 0.35);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => window.__kp.store.design.items.length)).toBe(1);
  return page.evaluate(() => {
    const it = window.__kp.store.design.items[0];
    return { id: it.id, w: it.w, h: it.h };
  });
}

test('opening a placed wardrobe shows the width it was FITTED to, not the catalog one', async ({
  app,
}) => {
  await openPartInWorkshop(app, PRESET);
  await placeInRoom(app);
  const placed = await placeFittedOnWall(app);
  expect(placed.w).toBeGreaterThan(3.0); // it grew into the alcove

  const defId = await editItemInWorkshop(app, placed.id);
  await expect.poll(() => partDim(app, defId, 'w')).toBeCloseTo(placed.w, 6);
  expect(await partDim(app, defId, 'h')).toBeCloseTo(placed.h, 6);
  // depth was never fitted, so it is still the preset's own
  expect(await partDim(app, defId, 'd')).toBeCloseTo(0.6, 6);
});

test('the adopted width lands in the FILL column; the fixed columns are untouched', async ({
  app,
}) => {
  await openPartInWorkshop(app, PRESET);
  // c2 is the 'fill' one; c1/c3 are 0.75 and c4 is 0.5
  expect(await columnWidths(app, PRESET)).toEqual([0.75, 'fill', 0.75, 0.5]);
  const before = await columnPx(app);
  const beforeShare = before[1] / before.reduce((a, b) => a + b, 0);

  await placeInRoom(app);
  const placed = await placeFittedOnWall(app);
  const defId = await editItemInWorkshop(app, placed.id);

  // the column LIST is untouched — only the total it is solved against moved
  expect(await columnWidths(app, defId)).toEqual([0.75, 'fill', 0.75, 0.5]);

  const after = await columnPx(app);
  const afterShare = after[1] / after.reduce((a, b) => a + b, 0);
  expect(afterShare).toBeGreaterThan(beforeShare + 0.05);
  // ...and the fixed columns kept their proportion to each other, so none of
  // the extra width leaked into them
  expect(after[0] / after[3]).toBeCloseTo(before[0] / before[3], 2);
});

test('a def shared by two wardrobes FORKS on adopt; the other copy keeps its own width', async ({
  app,
}) => {
  const id = await openNewWardrobe(app); // design-local, 2 m wide
  const ids = await app.evaluate((pid) => {
    const st = window.__kp.store;
    const a = st.addItem(st.defOf(pid), 1.0, 1.5, 0);
    const b = st.addItem(st.defOf(pid), 3.0, 1.5, 0);
    // an explicit w/h edit drops the fit flags, so these are exactly the sizes
    st.updateItem(a.id, { w: 1.6, h: 2.2 });
    st.updateItem(b.id, { w: 1.2, h: 2.3 });
    st.commit();
    return { a: a.id, b: b.id };
  }, id);

  const forkId = await editItemInWorkshop(app, ids.a);
  expect(forkId).not.toBe(id);

  const after = await app.evaluate(
    (arg) => {
      const st = window.__kp.store;
      return {
        bDef: st.itemById(arg.b)!.defId,
        forkW: st.partOf(st.itemById(arg.a)!.defId)!.w,
        origW: st.partOf(arg.id)!.w,
        bW: st.itemById(arg.b)!.w,
      };
    },
    { ...ids, id }
  );

  expect(after.bDef).toBe(id); // the twin still resolves to the shared def…
  expect(after.origW).toBeCloseTo(2, 6); // …whose width 1.6 never reached
  expect(after.bW).toBeCloseTo(1.2, 6);
  expect(after.forkW).toBeCloseTo(1.6, 6);
});
