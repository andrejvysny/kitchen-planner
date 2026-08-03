import { chromium } from 'playwright';

const baseUrl = process.env.KP_BASE_URL ?? 'http://localhost:4173/';
const executablePath = process.env.KP_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.accept());

// KITCHENP-13: force mac-gated wheel/trackpad handling on every platform (the
// checks below dispatch synthetic wheel events regardless of the real OS —
// see window.__kpForceMac in main.ts / setMacOverride in
// src/view3d/wheelInput.ts). addInitScript re-applies on every navigation
// (including the page.reload() calls later in this file), so one call here
// covers the whole run.
await page.addInitScript(() => {
  window.__kpForceMac = true;
});

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
// deterministic state: empty 4x3 room, no items
await page.evaluate(() => localStorage.clear());
await page.click('#btn-new');
await page.waitForTimeout(800);

const count = () => page.evaluate(() => window.__kp.store.design.items.length);
const worldToScreen = async (x, y) => {
  return page.evaluate(([wx, wy]) => {
    const p = window.__kp.plan;
    // access private fields via bracket (compiled JS keeps names)
    return { x: wx * p.zoom + p.panX, y: wy * p.zoom + p.panY };
  }, [x, y]);
};
const paneOffset = async () => {
  const bb = await page.locator('#canvas2d').boundingBox();
  return bb;
};

const n0 = await count();
const results = [];

// 0. measure tool (KITCHENP-9): toggle on, drag between two free interior
// points, read the distance back; it must not mutate the model.
await page.click('#btn-measure');
const measureState = await page.evaluate(() => ({
  on: window.__kp.plan.measureOn,
  active: document.getElementById('btn-measure').classList.contains('active'),
}));
const mbb = await paneOffset();
const mp1 = await worldToScreen(1.0, 1.0);
const mp2 = await worldToScreen(2.0, 1.5);
await page.mouse.move(mbb.x + mp1.x, mbb.y + mp1.y);
await page.mouse.down();
await page.mouse.move(mbb.x + mp2.x, mbb.y + mp2.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(120);
const measured = await page.evaluate(() => {
  const m = window.__kp.plan.measure;
  const d = m.a && m.b ? Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) : -1;
  return { d, items: window.__kp.store.design.items.length };
});
results.push([
  'measure tool: toggle + two-point distance',
  measureState.on &&
    measureState.active &&
    Math.abs(measured.d - Math.hypot(1.0, 0.5)) < 0.03 &&
    measured.items === n0,
]);
await page.keyboard.press('Escape'); // exit measure mode for the steps below
const measureOff = await page.evaluate(() => window.__kp.plan.measureOn);
results.push(['measure tool: Esc exits', measureOff === false]);

// 1. place a base cabinet near the bottom wall (should wall-snap + rotate)
await page.click('.cat-item[data-def-id="base-cabinet"]');
const bb = await paneOffset();
const target = await worldToScreen(2.0, 2.75); // inside the room, near the bottom wall of the 4x3 room
await page.mouse.click(bb.x + target.x, bb.y + target.y);
await page.waitForTimeout(300);
const n1 = await count();
results.push(['place base cabinet', n1 === n0 + 1]);

const placed = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { defId: it.defId, x: it.x, y: it.y, rot: it.rotation };
});
// v6 corners ARE the wall face: the bottom wall of the 4x3 room sits at
// y = 3, so a 60 cm deep unit centres on 3 - 0.3 = 2.7
results.push(['wall snap position', Math.abs(placed.y - 2.7) < 0.02]);
results.push(['wall snap rotation', Math.abs(Math.abs(placed.rot) - Math.PI) < 0.01]);

// 2. props panel shows the item
const title = await page.textContent('.props-title');
results.push(['props shows item', title === 'Base cabinet']);

// 2b. components outline lists the placed item under its type group + row selects it
// (outline lives on the "Components" sidebar tab — switch to it first)
await page.click('#sidebar-tabs button[data-tab="components"]');
await page.waitForTimeout(80);
results.push([
  'components tab shows outline, hides library',
  (await page.isVisible('#outline .ol-head')) && !(await page.isVisible('#catalog-inner')),
]);
const outline = await page.evaluate(() =>
  [...document.querySelectorAll('#outline .ol-group')].map((g) => ({
    title: g.querySelector('.ol-label')?.textContent?.trim(),
    rows: [...g.querySelectorAll('.ol-row')].map((r) => r.textContent.trim()),
  }))
);
const baseGroup = outline.find((g) => g.title === 'Kitchen · base units');
results.push([
  'outline lists item under type group',
  !!baseGroup && baseGroup.rows.includes('Base cabinet'),
]);
await page.evaluate(() => window.__kp.store.select({ kind: 'none' }));
await page.waitForTimeout(80);
// the outline now leads with a Rooms group — the first component row follows it
await page.click('#outline .ol-row:not(.room-row)');
await page.waitForTimeout(120);
const outlineSel = await page.evaluate(() => window.__kp.store.selection);
results.push([
  'outline row selects item',
  outlineSel.kind === 'item' && outlineSel.id === (await page.evaluate(() => {
    const items = window.__kp.store.design.items;
    return items[items.length - 1].id;
  })),
]);
// back to the Library tab for subsequent catalog placements
await page.click('#sidebar-tabs button[data-tab="library"]');
await page.waitForTimeout(80);

// 3. drag the item along the wall
const from = await worldToScreen(placed.x, placed.y);
await page.mouse.move(bb.x + from.x, bb.y + from.y);
await page.mouse.down();
await page.mouse.move(bb.x + from.x + 120, bb.y + from.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const moved = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { x: it.x, y: it.y };
});
results.push(['drag moved item', Math.abs(moved.x - placed.x) > 0.5 && Math.abs(moved.y - 2.7) < 0.02]);

// 4. undo restores
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const afterUndo = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return it.x;
});
results.push(['undo drag', Math.abs(afterUndo - placed.x) < 0.02]);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
results.push(['undo place', (await count()) === n0]);

// 5. place a window on the top wall
await page.click('.cat-item[data-def-id="window"]');
const wt = await worldToScreen(2.0, 0.0);
await page.mouse.click(bb.x + wt.x, bb.y + wt.y);
await page.waitForTimeout(200);
const openings = await page.evaluate(() => window.__kp.store.design.openings.length);
results.push(['place window', openings === 1]);

// 6. wall length edit via panel: select left wall, set length
await page.mouse.click(bb.x + (await worldToScreen(0.0, 1.0)).x, bb.y + (await worldToScreen(0.0, 1.0)).y);
await page.waitForTimeout(300);
const wallTitle = await page.textContent('.props-title');
const lenInput = page.locator('#props-inner input[type=number]').first();
await lenInput.fill('350');
await lenInput.press('Enter');
await page.waitForTimeout(300);
const area = await page.evaluate(() => window.__kp.store.floorArea());
results.push(['wall selected', wallTitle === 'Wall']);
results.push(['wall length edit', Math.abs(area - 4 * 3.5) < 0.05]);

// 7. rectangle resize via room panel
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const widthInput = page.locator('#props-inner input[type=number]').first();
await widthInput.fill('500');
await widthInput.press('Enter');
await page.waitForTimeout(300);
const rect = await page.evaluate(() => window.__kp.store.rectangleSize());
results.push(['room resize', rect && Math.abs(rect.w - 5) < 0.01 && Math.abs(rect.d - 3.5) < 0.01]);

// 8. create a custom part via studio (type picker → cabinet editor → save)
await page.click('.cat-new');
await page.waitForTimeout(600);
const pickerCards = await page.locator('.studio-card').count();
await page.click('.studio-card[data-type="cabinet"]');
await page.waitForTimeout(600);
await page.click('.studio-save');
await page.waitForTimeout(400);
const parts = await page.evaluate(() => window.__kp.store.design.customParts.length);
results.push(['save custom part', pickerCards >= 2 && parts === 2]); // sample + new

// 9. place the custom part
const partId = await page.evaluate(() => window.__kp.store.design.customParts[1].id);
await page.click(`.cat-item[data-def-id="${partId}"]`);
const ct = await worldToScreen(2.5, 2.0);
await page.mouse.click(bb.x + ct.x, bb.y + ct.y);
await page.waitForTimeout(300);
const lastDef = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  return items[items.length - 1]?.defId;
});
results.push(['place custom part', lastDef === partId]);

// 9b. freeform part: picker card, board list gates save, boards render + place
await page.keyboard.press('Escape');
await page.click('.cat-new');
await page.waitForTimeout(500);
await page.click('.studio-card[data-type="freeform"]');
await page.waitForTimeout(500);
const saveGated = await page.locator('.studio-save').isDisabled();
await page.click('.board-add');
await page.click('.board-add');
await page.waitForTimeout(300);
const saveOpen = await page.locator('.studio-save').isEnabled();
await page.click('.studio-save');
await page.waitForTimeout(400);
const ffState = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  const p = parts[parts.length - 1];
  return { count: parts.length, type: p.type, boards: p.type === 'freeform' ? p.boards.length : 0 };
});
const ffId = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  return parts[parts.length - 1].id;
});
await page.click(`.cat-item[data-def-id="${ffId}"]`);
const ffAt = await worldToScreen(3.6, 1.6);
await page.mouse.click(bb.x + ffAt.x, bb.y + ffAt.y);
await page.waitForTimeout(300);
const ffPlaced = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  return items[items.length - 1]?.defId;
});
results.push([
  'freeform part: gated save, boards, place',
  saveGated && saveOpen && ffState.count === 3 && ffState.type === 'freeform' && ffState.boards === 2 && ffPlaced === ffId,
]);
await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  window.__kp.store.deleteItem(items[items.length - 1].id);
  window.__kp.store.commit();
});

// 9c. worktop board: L preset, midpoint-drag adds a corner, cutout, polygon hit-test
await page.click('.cat-new');
await page.waitForTimeout(500);
await page.click('.studio-card[data-type="board"]');
await page.waitForTimeout(500);
await page.click('.studio-form .choice-btn:has-text("L-shape")');
await page.waitForTimeout(300);
// drag the midpoint of the bottom edge of the L (world (-0.31, -0.13)) downward
const pcBox = await page.locator('.poly-canvas').boundingBox();
const pcView = await page.evaluate(() => {
  const c = document.querySelector('.poly-canvas');
  return { w: c.clientWidth, h: c.clientHeight };
});
const pScale = Math.min((pcView.w * 0.78) / 2.4, (pcView.h * 0.78) / 1.5);
const pmx = pcBox.x + pcView.w / 2 + -0.31 * pScale;
const pmy = pcBox.y + pcView.h / 2 + -0.13 * pScale;
await page.mouse.move(pmx, pmy);
await page.mouse.down();
await page.mouse.move(pmx, pmy + 25, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
// cutout in the bottom band of the L
await page.click('.studio-form .board-add');
await page.waitForTimeout(200);
const yInput = page.locator('.studio-form .prop-section', { hasText: 'Selected cutout' }).locator('input').nth(1);
await yInput.fill('-44');
await yInput.press('Enter');
await page.waitForTimeout(200);
const saveOk = await page.locator('.studio-save').isEnabled();
await page.click('.studio-save');
await page.waitForTimeout(400);
const boardPart = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  const p = parts[parts.length - 1];
  return { id: p.id, type: p.type, corners: p.outline?.length, holes: p.holes?.length };
});
await page.click(`.cat-item[data-def-id="${boardPart.id}"]`);
const bAt = await worldToScreen(2.5, 1.6);
await page.mouse.click(bb.x + bAt.x, bb.y + bAt.y);
await page.waitForTimeout(250);
const boardItemId = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  window.__kp.store.updateItem(it.id, { x: 2.5, y: 1.6, rotation: 0 });
  window.__kp.store.commit();
  window.__kp.store.select({ kind: 'none' });
  return it.id;
});
// click inside the L's notch: bbox hit but polygon miss → must NOT select the board
const notch = await worldToScreen(2.5 - 0.6, 1.6 + 0.4);
await page.mouse.click(bb.x + notch.x, bb.y + notch.y);
await page.waitForTimeout(200);
const notchSel = await page.evaluate(() => {
  const s = window.__kp.store.selection;
  return s.kind === 'item' ? s.id : null;
});
// click inside the L's arm → selects the board
const arm = await worldToScreen(2.5 + 0.9, 1.6 + 0.3);
await page.mouse.click(bb.x + arm.x, bb.y + arm.y);
await page.waitForTimeout(200);
const armSel = await page.evaluate(() => {
  const s = window.__kp.store.selection;
  return s.kind === 'item' ? s.id : null;
});
results.push([
  'worktop board: preset+vertex+cutout, polygon hit-test',
  saveOk &&
    boardPart.type === 'board' &&
    boardPart.corners === 7 &&
    boardPart.holes === 1 &&
    notchSel !== boardItemId &&
    armSel === boardItemId,
]);
await page.evaluate((id) => {
  window.__kp.store.deleteItem(id);
  window.__kp.store.commit();
  window.__kp.store.select({ kind: 'none' });
}, boardItemId);
await page.keyboard.press('Escape');

// 9d. zone editor: select the default zone, split vertically, set fill, save
await page.click('.cat-new');
await page.waitForTimeout(500);
await page.click('.studio-card[data-type="cabinet"]');
await page.waitForTimeout(500);
const zcBox = await page.locator('.zone-canvas').boundingBox();
await page.mouse.click(zcBox.x + zcBox.width / 2, zcBox.y + zcBox.height / 2);
await page.waitForTimeout(200);
const splitEnabled = await page.locator('.zone-toolbar button:has-text("⬌ Split")').isEnabled();
await page.click('.zone-toolbar button:has-text("⬌ Split")');
await page.waitForTimeout(200);
await page.click('.zone-toolbar button:text-is("Door")');
await page.waitForTimeout(200);
await page.click('.studio-save');
await page.waitForTimeout(400);
const zonePart = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  const p = parts[parts.length - 1];
  return p.type === 'cabinet' ? p.face : null;
});
results.push([
  'zone editor: split + fill + save',
  splitEnabled &&
    zonePart &&
    zonePart.kind === 'split' &&
    zonePart.dir === 'v' &&
    zonePart.children.length === 2 &&
    zonePart.children[0].fill === 'door' &&
    zonePart.children[1].fill === 'drawers',
]);

// 9e. diagonal corner cabinet: footprint preset, corner placement, polygon hit-test
await page.click('.cat-new');
await page.waitForTimeout(500);
await page.click('.studio-card[data-type="cabinet"]');
await page.waitForTimeout(500);
await page.click('.foot-choice button:has-text("Diagonal corner")');
await page.waitForTimeout(300);
await page.click('.studio-save');
await page.waitForTimeout(400);
const cornerPart = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  const p = parts[parts.length - 1];
  return { id: p.id, fp: p.type === 'cabinet' ? p.footprint : null };
});
await page.click(`.cat-item[data-def-id="${cornerPart.id}"]`);
const cAt = await worldToScreen(0.5, 0.45);
await page.mouse.click(bb.x + cAt.x, bb.y + cAt.y);
await page.waitForTimeout(250);
const cornerItem = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  window.__kp.store.select({ kind: 'none' });
  return { id: it.id, x: it.x, y: it.y, rot: it.rotation };
});
// click the cut-off corner region (inside bbox, outside footprint) → not selected
const cutHit = await page.evaluate((ci) => {
  const local = { x: 0.37, y: 0.2 };
  return {
    x: ci.x + local.x * Math.cos(ci.rot) - local.y * Math.sin(ci.rot),
    y: ci.y + local.x * Math.sin(ci.rot) + local.y * Math.cos(ci.rot),
  };
}, cornerItem);
const cutPt = await worldToScreen(cutHit.x, cutHit.y);
await page.mouse.click(bb.x + cutPt.x, bb.y + cutPt.y);
await page.waitForTimeout(200);
const cutSel = await page.evaluate(() => {
  const s = window.__kp.store.selection;
  return s.kind === 'item' ? s.id : null;
});
const bodyPt = await worldToScreen(cornerItem.x, cornerItem.y);
await page.mouse.click(bb.x + bodyPt.x, bb.y + bodyPt.y);
await page.waitForTimeout(200);
const bodySel = await page.evaluate(() => {
  const s = window.__kp.store.selection;
  return s.kind === 'item' ? s.id : null;
});
const poseOk = Math.abs(Math.sin(cornerItem.rot * 2)) < 0.01; // snapped to a right-angle pose
results.push([
  'diagonal corner: preset + pose + polygon hit',
  cornerPart.fp?.kind === 'chamfer' &&
    cornerPart.fp.face === 'angled' &&
    poseOk &&
    cutSel !== cornerItem.id &&
    bodySel === cornerItem.id,
]);
await page.evaluate((id) => {
  window.__kp.store.deleteItem(id);
  window.__kp.store.commit();
  window.__kp.store.select({ kind: 'none' });
}, cornerItem.id);
await page.keyboard.press('Escape');

// 10. wall midpoint: click selects the wall, only a drag adds a corner
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const cornersBefore = await page.evaluate(() => window.__kp.store.activeRoom().corners.length);
const midWorld = await page.evaluate(() => {
  // the left wall (x = 0) — the right one can sit outside the un-refitted viewport
  const g = window.__kp.store.allWalls().find((w) => Math.abs(w.dir.x) < 1e-6 && w.a.x < 0.01);
  return { x: g.a.x + g.dir.x * (g.len / 2), y: g.a.y + g.dir.y * (g.len / 2) };
});
const mp = await worldToScreen(midWorld.x, midWorld.y);
await page.mouse.click(bb.x + mp.x, bb.y + mp.y);
await page.waitForTimeout(200);
const midClick = await page.evaluate(() => ({
  n: window.__kp.store.activeRoom().corners.length,
  sel: window.__kp.store.selection.kind,
}));
results.push(['midpoint click selects wall', midClick.n === cornersBefore && midClick.sel === 'wall']);
await page.mouse.move(bb.x + mp.x, bb.y + mp.y);
await page.mouse.down();
await page.mouse.move(bb.x + mp.x - 30, bb.y + mp.y, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
const midDrag = await page.evaluate(() => ({
  n: window.__kp.store.activeRoom().corners.length,
  sel: window.__kp.store.selection.kind,
}));
results.push(['midpoint drag adds corner', midDrag.n === cornersBefore + 1 && midDrag.sel === 'corner']);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
results.push(['undo midpoint drag', (await page.evaluate(() => window.__kp.store.activeRoom().corners.length)) === cornersBefore]);

// 11. dragging a corner inside-out must keep the CCW invariant + opening bounds
const ccw = await page.evaluate(() => {
  const st = window.__kp.store;
  const c0 = st.activeRoom().corners.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
  st.moveCorner(c0.id, 5.5, 4.5, false);
  st.commit();
  const pts = st.activeRoom().corners;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  const openingsOk = st.design.openings.every((o) => {
    const g = st.wallById(o.wallId);
    return g && o.offset >= 0 && o.offset <= g.len;
  });
  return { area: s / 2, openingsOk };
});
results.push(['corner flip keeps CCW invariant', ccw.area > 0 && ccw.openingsOk]);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);

// 12. pointercancel mid-drag commits the move and resets the gesture
const pcItem = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { id: it.id, x: it.x, y: it.y };
});
const pcFrom = await worldToScreen(pcItem.x, pcItem.y);
await page.mouse.move(bb.x + pcFrom.x, bb.y + pcFrom.y);
await page.mouse.down();
await page.mouse.move(bb.x + pcFrom.x + 60, bb.y + pcFrom.y, { steps: 5 });
await page.evaluate(() =>
  document.getElementById('canvas2d').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
);
await page.mouse.up();
await page.waitForTimeout(200);
const pcMoved = await page.evaluate((id) => window.__kp.store.itemById(id).x, pcItem.id);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const pcUndone = await page.evaluate((id) => window.__kp.store.itemById(id).x, pcItem.id);
results.push([
  'pointercancel commits drag',
  Math.abs(pcMoved - pcItem.x) > 0.2 && Math.abs(pcUndone - pcItem.x) < 0.02,
]);

// 13. clicking a stack of items cycles to the one underneath
const stackIds = await page.evaluate(() => {
  const st = window.__kp.store;
  const base = st.addItem(st.defOf('base-cabinet'), 1.0, 1.0, 0);
  const wall = st.addItem(st.defOf('wall-cabinet'), 1.0, 1.0, 0);
  st.commit();
  return { baseId: base.id, wallId: wall.id };
});
const sp = await worldToScreen(1.0, 1.0);
await page.mouse.click(bb.x + sp.x, bb.y + sp.y);
await page.waitForTimeout(150);
const cycleSel1 = await page.evaluate(() => window.__kp.store.selection.id);
await page.mouse.click(bb.x + sp.x, bb.y + sp.y);
await page.waitForTimeout(150);
const cycleSel2 = await page.evaluate(() => window.__kp.store.selection.id);
results.push([
  'click cycles stacked items',
  cycleSel1 === stackIds.wallId && cycleSel2 === stackIds.baseId,
]);
await page.evaluate((ids) => {
  const st = window.__kp.store;
  st.deleteItem(ids.wallId); // keep the base cabinet for the 3D pick test
  st.commit();
}, stackIds);

// 14. keyboard: R rotates, arrows nudge, Ctrl+D duplicates, Delete removes
const kbSetup = await page.evaluate(() => {
  const st = window.__kp.store;
  const it = st.addItem(st.defOf('table'), 2.0, 1.5, 0);
  st.commit();
  st.select({ kind: 'item', id: it.id });
  return { id: it.id, n: st.design.items.length };
});
await page.keyboard.press('r');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Control+d');
await page.waitForTimeout(150);
const kb = await page.evaluate((id) => {
  const st = window.__kp.store;
  const it = st.itemById(id);
  return { rot: it.rotation, x: it.x, n: st.design.items.length };
}, kbSetup.id);
await page.keyboard.press('Delete'); // removes the selected duplicate
await page.waitForTimeout(150);
const kbAfter = await page.evaluate((id) => {
  const st = window.__kp.store;
  return { n: st.design.items.length, origAlive: !!st.itemById(id) };
}, kbSetup.id);
results.push([
  'keyboard rotate + nudge',
  Math.abs(kb.rot - Math.PI / 2) < 0.01 && Math.abs(kb.x - 2.01) < 0.005,
]);
results.push([
  'keyboard duplicate + delete',
  kb.n === kbSetup.n + 1 && kbAfter.n === kbSetup.n && kbAfter.origAlive,
]);
await page.evaluate((id) => {
  const st = window.__kp.store;
  st.deleteItem(id);
  st.commit();
}, kbSetup.id);

// 15. door hinge/swing survives undo/redo
const doorId = await page.evaluate(() => {
  const st = window.__kp.store;
  const wall = st.allWalls()[0];
  const o = st.addOpening(st.defOf('door'), wall.id, wall.len / 2);
  st.updateOpening(o.id, { hinge: 'right', swing: 'out' });
  st.commit();
  return o.id;
});
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
await page.evaluate(() => window.__kp.store.redo());
await page.waitForTimeout(150);
const doorProps = await page.evaluate((id) => {
  const o = window.__kp.store.openingById(id);
  return !!o && o.hinge === 'right' && o.swing === 'out';
}, doorId);
results.push(['door hinge/swing persists', doorProps]);
await page.evaluate((id) => {
  const st = window.__kp.store;
  st.deleteOpening(id);
  st.commit();
}, doorId);

// 16. day/night toggle round-trips via scene.night
await page.evaluate(() => {
  window.__kp.store.setScene({ night: false });
  window.__kp.store.commit();
});
await page.click('#btn-daynight');
await page.waitForTimeout(120);
const night1 = await page.evaluate(() => window.__kp.store.design.scene.night);
await page.click('#btn-daynight');
await page.waitForTimeout(120);
const night2 = await page.evaluate(() => window.__kp.store.design.scene.night);
results.push(['day/night toggle', night1 === true && night2 === false]);

// 17. clicking an item in the 3D pane selects it
await page.keyboard.press('Escape');
// aim the camera straight at the cabinet from just in front of it — the
// two-room demo means the corner preset can put other furniture in the ray
await page.evaluate((ids) => {
  const it = window.__kp.store.itemById(ids.baseId);
  const { camera, controls } = window.__kp.view;
  camera.position.set(it.x, 1.2, it.y + 1.8);
  controls.target.set(it.x, 0.45, it.y);
  controls.update();
}, stackIds);
await page.waitForTimeout(250); // let a frame render so projections are current
const pick3d = await page.evaluate((ids) => {
  const it = window.__kp.store.itemById(ids.baseId);
  const p = window.__kp.view.worldToScreen(it.x, 0.4, it.y);
  return { id: it.id, ...p };
}, stackIds);
const bb3 = await page.locator('#canvas3d').boundingBox();
await page.mouse.click(bb3.x + pick3d.x, bb3.y + pick3d.y);
await page.waitForTimeout(200);
const sel3d = await page.evaluate(() => window.__kp.store.selection);
results.push(['3D click selects item', sel3d.kind === 'item' && sel3d.id === pick3d.id]);

// 17a. mouse navigation (KITCHENP-13): in 3D, middle-drag orbits (camera swings
// around a fixed target) and Shift+middle-drag pans (target travels with the
// camera). Both must leave the camera→target distance alone — that is the tell
// that neither one silently degraded into OrbitControls' default MIDDLE=DOLLY.
// Middle-button gestures must not touch the selection, and the camera is
// restored afterwards so later 3D steps still see the 'corner' preset framing.
const cam3d = () =>
  page.evaluate(() => {
    const { camera, controls } = window.__kp.view;
    return {
      pos: [camera.position.x, camera.position.y, camera.position.z],
      tgt: [controls.target.x, controls.target.y, controls.target.z],
      dist: camera.position.distanceTo(controls.target),
    };
  });
const navMidDrag = async (shift) => {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(bb3.x + bb3.width / 2, bb3.y + bb3.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bb3.x + bb3.width / 2 + 120, bb3.y + bb3.height / 2 + 60, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  if (shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  return cam3d();
};
const navMoved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const navA = await cam3d();
const navB = await navMidDrag(false);
results.push([
  '3D middle-drag orbits',
  navMoved(navA.pos, navB.pos) > 0.1 && navMoved(navA.tgt, navB.tgt) < 1e-6 && Math.abs(navA.dist - navB.dist) < 1e-3,
]);

const navC = await navMidDrag(true);
results.push([
  '3D shift+middle-drag pans',
  navMoved(navB.tgt, navC.tgt) > 0.1 && Math.abs(navB.dist - navC.dist) < 1e-3,
]);

// navigating with the middle button must never change what is selected
const navSel = await page.evaluate(() => window.__kp.store.selection);
results.push([
  '3D middle-drag keeps selection',
  navSel.kind === 'item' && navSel.id === pick3d.id,
]);

// back to the corner preset so later 3D steps see the standard framing
await page.evaluate(() => window.__kp.view.setPreset('corner'));
await page.waitForTimeout(200);

// 17d. wheel = zoom, swipe = pan (KITCHENP-13). These dispatch synthetic wheel
// events on purpose: Playwright's trusted mouse.wheel() emits a textbook
// deltaY 120 / wheelDeltaY -120 notch, which the old %120 heuristic already got
// right — that is exactly why this bug shipped past a green E2E run. A real
// macOS mouse notch goes through the OS acceleration curve and lands as a small
// delta whose wheelDeltaY is NOT a multiple of 120, which the old code read as a
// two-finger swipe and panned. `accel` reproduces that; `swipe` is the trackpad
// it must not break. The trackpad remap is mac-gated in app code, so this runs
// under a forced mac override (window.__kpForceMac, set via addInitScript at
// the top of this file) rather than a real-OS check — it now runs on every CI
// platform instead of only a macOS runner.
const sendWheel = (sel, init) =>
  page.evaluate(
    ([s, i]) => {
      document.querySelector(s).dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, ...i })
      );
    },
    [sel, init]
  );
// An accelerated mouse notch: vertical, whole-pixel, no clean 120 multiple.
const accel = { deltaX: 0, deltaY: 12 };
// A two-finger swipe: sub-pixel with sideways drift.
const swipe = { deltaX: 0.5, deltaY: 2.5 };

const setNav = (mode) => page.evaluate((m) => window.__kp.setNavInput(m), mode);
const plan2d = () => page.evaluate(() => ({ zoom: window.__kp.plan.zoom, panY: window.__kp.plan.panY }));

// --- 2D plan ---
await setNav('auto');
const z0 = await plan2d();
await sendWheel('#canvas2d', accel);
await page.waitForTimeout(150);
const z1 = await plan2d();
results.push(['2D accelerated mouse notch zooms', Math.abs(z1.zoom - z0.zoom) > 0.5]);

await setNav('auto');
const p0 = await plan2d();
await sendWheel('#canvas2d', swipe);
await page.waitForTimeout(150);
const p1 = await plan2d();
results.push([
  '2D trackpad swipe still pans',
  Math.abs(p1.panY - p0.panY) > 0.5 && Math.abs(p1.zoom - p0.zoom) < 1e-6,
]);

// --- 3D ---
await setNav('auto');
const c0 = await cam3d();
await sendWheel('#canvas3d', accel);
await page.waitForTimeout(150);
const c1 = await cam3d();
results.push(['3D accelerated mouse notch zooms', Math.abs(c1.dist - c0.dist) > 1e-3]);

await setNav('auto');
const c2 = await cam3d();
await sendWheel('#canvas3d', swipe);
await page.waitForTimeout(150);
const c3 = await cam3d();
results.push([
  '3D trackpad swipe still pans',
  navMoved(c2.tgt, c3.tgt) > 1e-4 && Math.abs(c2.dist - c3.dist) < 1e-3,
]);

// --- the manual override, which is the guaranteed fix for a high-resolution
// wheel that Auto cannot tell apart from a trackpad ---
await setNav('mouse');
const m0 = await plan2d();
await sendWheel('#canvas2d', swipe); // trackpad-shaped, but forced to mouse
await page.waitForTimeout(150);
const m1 = await plan2d();
// A 2.5px delta is a small dolly, so assert only that zoom moved — the pan
// path is the one that provably never touches zoom.
results.push(['Nav: Mouse forces zoom on swipe-shaped deltas', Math.abs(m1.zoom - m0.zoom) > 1e-6]);

await setNav('trackpad');
const t0 = await plan2d();
await sendWheel('#canvas2d', accel); // mouse-shaped, but forced to trackpad
await page.waitForTimeout(150);
const t1 = await plan2d();
results.push([
  'Nav: Trackpad forces pan on notch-shaped deltas',
  Math.abs(t1.panY - t0.panY) > 0.5 && Math.abs(t1.zoom - t0.zoom) < 1e-6,
]);

// the toggle cycles and persists
await setNav('auto');
await page.click('#btn-navinput');
const navLabel = await page.textContent('#btn-navinput');
const navStored = await page.evaluate(() => localStorage.getItem('interior-planner-nav-v1'));
results.push(['nav toggle cycles + persists', navLabel === 'Nav: Mouse' && navStored === 'mouse']);
await setNav('auto');

// 17b. per-item worktop material: chip in the "Worktop" props section paints the counter slab
const worktopChip = await page.evaluate(() => {
  const sec = [...document.querySelectorAll('.prop-section')].find(
    (s) => s.querySelector('.prop-section-title')?.textContent === 'Worktop'
  );
  const chip = sec?.querySelector('.swatch[title="Dark marble"]');
  if (!chip) return false;
  chip.click();
  return true;
});
await page.waitForTimeout(250);
const counterState = await page.evaluate((id) => {
  const it = window.__kp.store.itemById(id);
  let textured = false;
  window.__kp.view.items.get(id).group.traverse((o) => {
    const m = o.material;
    if (m?.color && `#${m.color.getHexString()}` === '#3c3f44' && m.map) textured = true;
  });
  return { mat: it.counterMaterial, textured };
}, stackIds.baseId);
results.push(['worktop chip sets counter material', worktopChip && counterState.mat === 'marble-dark']);
results.push(['worktop override renders textured slab', counterState.textured]);

// 17c. rotate toggle in the Worktop section rotates the texture 90°
await page.evaluate(() => {
  const sec = [...document.querySelectorAll('.prop-section')].find(
    (s) => s.querySelector('.prop-section-title')?.textContent === 'Worktop'
  );
  sec?.querySelector('.toggle-row input')?.click();
});
await page.waitForTimeout(250);
const rotState = await page.evaluate((id) => {
  const it = window.__kp.store.itemById(id);
  let rot = 0;
  window.__kp.view.items.get(id).group.traverse((o) => {
    const m = o.material;
    if (m?.color && `#${m.color.getHexString()}` === '#3c3f44' && m.map) rot = m.map.rotation;
  });
  return { flag: it.counterMaterialRot, rot };
}, stackIds.baseId);
results.push([
  'worktop rotate toggle rotates texture',
  rotState.flag === true && Math.abs(rotState.rot - Math.PI / 2) < 1e-6,
]);

// 17d. item front material rotation applies through the store, then reset
const frontRot = await page.evaluate(async (id) => {
  const st = window.__kp.store;
  st.updateItem(id, { material: 'oak', materialRot: true });
  st.commit();
  await new Promise((r) => requestAnimationFrame(r));
  let ok = false;
  window.__kp.view.items.get(id).group.traverse((o) => {
    const m = o.material;
    if (m?.map && `#${m.color.getHexString()}` === '#c9a87c' && Math.abs(m.map.rotation - Math.PI / 2) < 1e-6)
      ok = true;
  });
  st.updateItem(id, {
    material: undefined,
    materialRot: undefined,
    counterMaterial: undefined,
    counterMaterialRot: undefined,
  });
  st.commit();
  return ok;
}, stackIds.baseId);
results.push(['item material rotation applies', frontRot]);

// 17e. KITCHENP-12: picking a front COLOUR must drop a texture so the colour
// shows (else the surface is stuck on textures). Drive the real props UI.
await page.evaluate((id) => window.__kp.store.select({ kind: 'item', id }), stackIds.baseId);
await page.waitForTimeout(120);
const colourSection = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.prop-section')].findIndex(
      (s) => s.querySelector('.prop-section-title')?.textContent === 'Colour & material'
    )
  );
const secIdx = await colourSection();
const clickInColourSection = (sel) =>
  page.evaluate(
    ({ i, sel }) => {
      const s = document.querySelectorAll('.prop-section')[i];
      const el = s?.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    },
    { i: secIdx, sel }
  );
// apply Oak texture, then pick a plain colour swatch in the same section
const appliedTex = await clickInColourSection('.swatch[title="Oak"]');
await page.waitForTimeout(200);
const texturedBefore = await page.evaluate((id) => window.__kp.store.itemById(id).material, stackIds.baseId);
const pickedColour = await clickInColourSection('.swatch[title^="#"]');
await page.waitForTimeout(250);
const revert = await page.evaluate((id) => {
  const it = window.__kp.store.itemById(id);
  let mappedFronts = 0;
  window.__kp.view.items.get(id).group.traverse((o) => {
    if (o.material?.map) mappedFronts++; // any surviving texture on the item
  });
  return { material: it.material, colorIsHex: typeof it.color === 'string' && it.color[0] === '#', mappedFronts };
}, stackIds.baseId);
results.push([
  'front colour pick reverts a texture to plain colour',
  appliedTex && texturedBefore === 'oak' && pickedColour && revert.material === undefined && revert.colorIsHex,
]);
results.push(['reverted front renders untextured', revert.mappedFronts === 0]);

// 17f. tintable plastic keeps tinting on a colour pick (must NOT be dropped)
await clickInColourSection('.swatch[title="Matte plastic"]');
await page.waitForTimeout(180);
await clickInColourSection('.swatch[title^="#"]');
await page.waitForTimeout(180);
const plasticKept = await page.evaluate((id) => window.__kp.store.itemById(id).material, stackIds.baseId);
results.push(['tintable plastic survives a colour pick', plasticKept === 'plastic-matte']);
// reset so later assertions see a clean front
await page.evaluate((id) => {
  const st = window.__kp.store;
  st.updateItem(id, { material: undefined, materialRot: undefined });
  st.commit();
}, stackIds.baseId);

// 18. structural rebuilds must not leak GPU textures (fixture shadow maps)
const tex = await page.evaluate(async () => {
  const st = window.__kp.store;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const p = st.addItem(st.defOf('pendant'), 2.0, 1.0, 0);
  st.commit();
  await raf();
  await raf();
  const before = window.__kp.view.renderer.info.memory.textures;
  for (let i = 0; i < 15; i++) {
    st.notify({ structural: true });
    await raf();
    await raf();
  }
  const after = window.__kp.view.renderer.info.memory.textures;
  st.deleteItem(p.id);
  st.commit();
  return { before, after };
});
results.push(['no texture leak across rebuilds', tex.after - tex.before <= 2]);

// 19. snapshot PNG is not a blank frame
const pngLen = await page.evaluate(() => window.__kp.view.snapshotPNG().length);
results.push(['snapshot PNG non-blank', pngLen > 20000]);

// 20. GLB export for Blender
await page.keyboard.press('Escape');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('#btn-glb'),
]);
const path = await download.path();
const { readFileSync } = await import('fs');
const buf = readFileSync(path);
results.push(['glb export magic', buf.length > 2000 && buf.toString('ascii', 0, 4) === 'glTF']);

// 20a/20b. Export ▾ menu: cut list CSV (KITCHENP milestone 1 BOM export).
// One download covers both the header contract and a content check — a
// base cabinet was placed for the stacking test (13) and is still alive.
const openExportMenu = async () => {
  await page.click('#btn-export');
  await page.waitForTimeout(150);
};
await openExportMenu();
const [cutDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('[data-export="cut"]'),
]);
const cutText = readFileSync(await cutDownload.path()).toString('utf-8');
const cutFirstLine = cutText.replace(/^﻿/, '').split('\r\n')[0];
results.push([
  'cut list csv: filename + header contract',
  cutDownload.suggestedFilename() === 'interior-cutlist.csv' &&
    cutFirstLine ===
      'Room,Part,Panel,Role,Qty,Length (mm),Width (mm),Thickness (mm),Material,Colour,Finish,Shape,Area (m²),Notes,Outline (mm),Holes (mm)',
]);
results.push([
  'cut list csv lists the placed cabinet',
  cutText.includes('Base cabinet') && cutText.includes('carcass.left'),
]);

// 20c. shopping list CSV lists a bought product (a fridge, placed here since
// only manufactured cabinets survive from earlier tests at this point).
await page.evaluate(() => {
  const st = window.__kp.store;
  st.addItem(st.defOf('fridge'), 3.5, 2.5, 0);
  st.commit();
});
await openExportMenu();
const [buyDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('[data-export="buy"]'),
]);
const buyText = readFileSync(await buyDownload.path()).toString('utf-8');
results.push([
  'shopping list csv lists a bought product',
  buyDownload.suggestedFilename() === 'interior-shopping-list.csv' && buyText.includes('Fridge / freezer'),
]);

// 20d. Export ▾ → Printable sheet: window.open blocked (as a popup blocker
// would) falls back to a real file download, and the status hint says so.
// window.open is restored right after — scenario 35 below needs a real popup
// for the plan sheet.
await openExportMenu();
await page.evaluate(() => {
  window.__kpRealOpen = window.open;
  window.open = () => null;
});
const [sheetDownload] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('[data-export="sheet"]'),
]);
const sheetHint = await page.evaluate(() => document.getElementById('status-hint').textContent);
await page.evaluate(() => {
  window.open = window.__kpRealOpen;
  delete window.__kpRealOpen;
});
results.push([
  'printable sheet: blocked popup falls back to a download + status hint',
  sheetDownload.suggestedFilename() === 'interior-bom.html' &&
    sheetHint === 'Pop-ups are blocked — interior-bom.html downloaded instead',
]);

// 21. a pre-v5 autosave has no migration path: the app resets to a fresh
// design instead of crashing or half-loading it. A partial v5 payload is
// still repaired in place.
await page.evaluate(() => {
  localStorage.setItem(
    'interior-planner-design-v1',
    JSON.stringify({
      version: 1,
      corners: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 3, y: 0 },
        { id: 'c', x: 3, y: 2 },
      ],
    })
  );
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const resetFresh = await page.evaluate(() => {
  const d = window.__kp.store.design;
  // the old 3-corner v1 payload must NOT survive — demo design loads instead
  return d.version === 6 && d.rooms[0].corners.length === 4 && d.items.length > 0;
});
results.push(['pre-v5 autosave resets to a fresh design', resetFresh]);

await page.evaluate(() => {
  localStorage.setItem(
    'interior-planner-design-v1',
    JSON.stringify({
      version: 5,
      corners: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 3, y: 0 },
        { id: 'c', x: 3, y: 2 },
      ],
    })
  );
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const migrated = await page.evaluate(() => {
  const d = window.__kp.store.design;
  const room = d.rooms && d.rooms[0];
  return (
    Array.isArray(d.items) &&
    Array.isArray(d.openings) &&
    !!d.scene &&
    d.version === 6 &&
    d.rooms.length === 1 &&
    !!room.style &&
    room.corners.length === 3 &&
    // v5 corners were centrelines; the migration insets them by t/2 onto the
    // wall face — corner 'a' sits on the offset y = 0 edge, so y ≈ 0.05
    Math.abs(room.corners[0].y - 0.05) < 0.005 &&
    room.corners[0].x > 0.05
  );
});
results.push(['v5 autosave migrates to a single v6 room', migrated]);

// 22. per-wall visibility override forces wall groups shown/hidden in 3D
const wallVis = async (mode) => {
  await page.evaluate((m) => window.__kp.store.setAllWallVisibility(m), mode);
  await page.waitForTimeout(120); // let the render loop apply it
  return page.evaluate(() => {
    const groups = [];
    window.__kp.view['scene'].traverse((o) => {
      if (typeof o.name === 'string' && o.name.startsWith('Wall_')) groups.push(o.visible);
    });
    return groups;
  });
};
const shown = await wallVis('show');
const hidden = await wallVis('hide');
results.push([
  'wall visibility override show/hide',
  shown.length >= 3 && shown.every((v) => v === true) && hidden.every((v) => v === false),
]);
// back to auto so nothing leaks into later runs
await page.evaluate(() => window.__kp.store.setAllWallVisibility('auto'));

// 23. ceiling visibility override forces the ceiling shown/hidden in 3D
const ceilVis = async (mode) => {
  await page.evaluate((m) => window.__kp.store.setCeilingVisibility(m), mode);
  await page.waitForTimeout(120); // let the render loop apply it
  return page.evaluate(() => {
    let v = null;
    window.__kp.view['scene'].traverse((o) => {
      if (o.name === 'Ceiling') v = o.visible;
    });
    return v;
  });
};
const ceilShown = await ceilVis('show');
const ceilHidden = await ceilVis('hide');
results.push(['ceiling visibility override show/hide', ceilShown === true && ceilHidden === false]);
await page.evaluate(() => window.__kp.store.setCeilingVisibility('auto'));

// 24. wall elevation view: front view of one wall shows only wall-attached items
await page.keyboard.press('Escape');
await page.click('#btn-new');
await page.waitForTimeout(400);
const elevIds = await page.evaluate(() => {
  const st = window.__kp.store;
  // top wall of the empty 4x3 room (horizontal, y ~ 0)
  const g = st.allWalls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y < 0.01);
  const def = st.defOf('base-cabinet');
  const rot = Math.atan2(-g.inward.x, g.inward.y);
  const foot = { x: g.a.x + g.dir.x * (g.len / 2), y: g.a.y + g.dir.y * (g.len / 2) };
  const back = g.faceOffset + def.d / 2; // wall face → item centre
  const cab = st.addItem(def, foot.x + g.inward.x * back, foot.y + g.inward.y * back, rot);
  const table = st.addItem(st.defOf('table'), foot.x, 1.5, 0); // free-standing, centre of room
  st.commit();
  return { wallId: g.id, cab: cab.id, table: table.id };
});
await page.click('#mode2d-toggle button[data-2dmode="elev"]');
await page.waitForTimeout(200);
const elevView = await page.evaluate((ids) => {
  window.__kp.elev.setWall(ids.wallId);
  const d = window.__kp.elev.data();
  const elevVisible = getComputedStyle(document.getElementById('canvas-elev')).display !== 'none';
  const planHidden = getComputedStyle(document.getElementById('canvas2d')).display === 'none';
  return { ids: d.items.map((i) => i.id), elevVisible, planHidden };
}, elevIds);
results.push([
  'wall elevation shows wall items, hides free-standing',
  elevView.elevVisible &&
    elevView.planHidden &&
    elevView.ids.includes(elevIds.cab) &&
    !elevView.ids.includes(elevIds.table),
]);
// clicking the cabinet in the elevation selects it (edits via the props panel)
await page.evaluate(() => window.__kp.store.select({ kind: 'none' }));
const elevPos = await page.evaluate((ids) => {
  const v = window.__kp.elev;
  const row = v.data().items.find((i) => i.id === ids.cab);
  return { x: row.center * v.zoom + v.panX, y: v.panY - ((row.z0 + row.z1) / 2) * v.zoom };
}, elevIds);
const bbElev = await page.locator('#canvas-elev').boundingBox();
await page.mouse.click(bbElev.x + elevPos.x, bbElev.y + elevPos.y);
await page.waitForTimeout(150);
const elevSel = await page.evaluate(() => {
  const s = window.__kp.store.selection;
  return s.kind === 'item' ? s.id : null;
});
results.push(['elevation click selects item', elevSel === elevIds.cab]);
await page.click('#mode2d-toggle button[data-2dmode="plan"]');

// 24. design variables — create, bind a cabinet AND a wall to one token,
//     edit it live, undo, and confirm the binding survives a reload.
const varScenario = await page.evaluate(() => {
  const st = window.__kp.store;
  st.select({ kind: 'none' });
  const cab = st.addItem(st.defOf('base-cabinet'), 1.0, 0.4, 0);
  const wallId = st.allWalls()[0].id;
  const v = st.addVariable({ name: 'Theme', color: '#123456' });
  st.updateItem(cab.id, { color: 'var:' + v.id });
  st.setRoomStyle({ wallColor: 'var:' + v.id });
  st.commit();
  return { cabId: cab.id, wallId, varId: v.id };
});
// does the resolved hex reach both the cabinet front slab and the wall meshes?
const readVarColors = (arg) =>
  page.evaluate(({ cabId, expected }) => {
    const has = (root) => {
      let found = false;
      root.traverse((o) => {
        const m = o.material;
        if (m && m.color && `#${m.color.getHexString()}` === expected) found = true;
      });
      return found;
    };
    const cabGroup = window.__kp.view.items.get(cabId).group;
    let wall = false;
    window.__kp.view['scene'].traverse((o) => {
      if (o.name && /^Wall_/.test(o.name) && has(o)) wall = true;
    });
    return { cab: has(cabGroup), wall };
  }, arg);

const boundA = await readVarColors({ cabId: varScenario.cabId, expected: '#123456' });
results.push(['variable binds cabinet + wall to one colour', boundA.cab && boundA.wall]);

await page.evaluate((vid) => {
  const st = window.__kp.store;
  st.updateVariable(vid, { color: '#654321' });
  st.commit();
}, varScenario.varId);
const editedB = await readVarColors({ cabId: varScenario.cabId, expected: '#654321' });
results.push(['editing a variable re-themes every bound slot live', editedB.cab && editedB.wall]);

await page.evaluate(() => window.__kp.store.undo());
const undoneA = await readVarColors({ cabId: varScenario.cabId, expected: '#123456' });
results.push(['undo restores the previous variable colour', undoneA.cab && undoneA.wall]);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const persisted = await page.evaluate(() => {
  const d = window.__kp.store.design;
  const cab = d.items.find((i) => typeof i.color === 'string' && i.color.startsWith('var:'));
  return {
    hasVar: d.variables.length >= 1 && d.variables[0].color === '#123456',
    cabBound: !!cab,
    wallBound: d.rooms[0].style.wallColor.startsWith('var:'),
  };
});
results.push([
  'variable binding + value persist across reload',
  persisted.hasVar && persisted.cabBound && persisted.wallBound,
]);

// 25. "Customize part…" forks a preset into My parts and repoints the instance.
const customizeScenario = await page.evaluate(() => {
  const st = window.__kp.store;
  const item = st.addItem(st.defOf('base-cabinet'), 1.5, 1.5, 0);
  st.commit();
  st.select({ kind: 'item', id: item.id });
  return { itemId: item.id, partsBefore: st.design.customParts.length };
});
await page.waitForTimeout(300);
const custBtn = page.locator('#props-inner button', { hasText: 'Customize part…' });
const custVisible = await custBtn.count();
await custBtn.click();
await page.waitForTimeout(400);
const studioOpen = await page.locator('.studio-save').count();
await page.click('.studio-save');
await page.waitForTimeout(400);
const customized = await page.evaluate((arg) => {
  const st = window.__kp.store;
  const item = st.itemById(arg.itemId);
  return {
    forked: !!item && item.defId !== 'base-cabinet',
    partsGrew: st.design.customParts.length === arg.partsBefore + 1,
    resolves: !!item && !!st.partOf(item.defId),
  };
}, customizeScenario);
results.push([
  'customize forks the preset into My parts for this instance only',
  custVisible === 1 && studioOpen === 1 && customized.forked && customized.partsGrew && customized.resolves,
]);
await page.evaluate((id) => {
  const st = window.__kp.store;
  st.deleteItem(id);
  st.commit();
}, customizeScenario.itemId);

// 26. open-front preview: toggling a door rotates its pivot group WITHOUT a
// geometry rebuild, never touches the design, and the topbar master works.
const openScenario = await page.evaluate(() => {
  const st = window.__kp.store;
  const item = st.addItem(st.defOf('base-cabinet'), 2.5, 1.0, 0);
  st.commit();
  const entry = window.__kp.view.items.get(item.id);
  const unitGroup = (() => {
    let found = null;
    entry.group.traverse((o) => {
      if (!found && o.userData.motionUnit) found = o;
    });
    return found;
  })();
  const designJson = JSON.stringify(st.design);
  st.openFronts.toggle(item.id, unitGroup.userData.motionUnit);
  return {
    itemId: item.id,
    unit: unitGroup.userData.motionUnit,
    uuidBefore: entry.group.uuid,
    baseRot: unitGroup.rotation.y,
    designUntouched: JSON.stringify(st.design) === designJson,
  };
});
await page.waitForTimeout(1200); // let the lerp settle
const opened = await page.evaluate((arg) => {
  const entry = window.__kp.view.items.get(arg.itemId);
  let rot = 0;
  entry.group.traverse((o) => {
    if (o.userData.motionUnit === arg.unit) rot = o.rotation.y;
  });
  return { uuidAfter: entry.group.uuid, rot };
}, openScenario);
const OPEN_ANGLE = Math.PI * 0.55;
results.push([
  'dblclick-style toggle opens a door without rebuild or design change',
  openScenario.designUntouched &&
    opened.uuidAfter === openScenario.uuidBefore &&
    Math.abs(Math.abs(opened.rot - openScenario.baseRot) - OPEN_ANGLE) < 0.05,
]);

await page.click('#btn-openfronts'); // master open
await page.waitForTimeout(1200);
const masterOpen = await page.evaluate(() => {
  const st = window.__kp.store;
  let anyOpen = false;
  for (const [, entry] of window.__kp.view.items) {
    entry.group.traverse((o) => {
      if (o.userData.motionUnit && Math.abs(o.userData.openT - 1) < 0.01) anyOpen = true;
    });
  }
  return { all: st.openFronts.allOpen, anyOpen };
});
await page.click('#btn-openfronts'); // close again
await page.waitForTimeout(1200);
const masterClosed = await page.evaluate(() => !window.__kp.store.openFronts.allOpen);
results.push(['topbar Open fronts master toggle works', masterOpen.all && masterOpen.anyOpen && masterClosed]);
await page.evaluate((id) => {
  const st = window.__kp.store;
  st.deleteItem(id);
  st.commit();
}, openScenario.itemId);

// 27. interior drill-in editor: dblclick a zone → add a drawer → the part's
// interior becomes explicit custom elements with exact positions.
await page.click('.cat-new');
await page.waitForTimeout(300);
await page.click('.studio-card[data-type="cabinet"]');
await page.waitForTimeout(400);
{
  const zc = await page.locator('.zone-canvas').boundingBox();
  // default new cabinet = 2-drawer stack zone; split first so we get a door zone
  await page.mouse.click(zc.x + zc.width / 2, zc.y + zc.height / 2);
  await page.waitForTimeout(200);
  await page.click('.zone-toolbar button:has-text("Door")');
  await page.waitForTimeout(200);
  await page.mouse.dblclick(zc.x + zc.width / 2, zc.y + zc.height / 2);
  await page.waitForTimeout(300);
}
const interiorToolbar = await page.locator('.zone-toolbar button', { hasText: '← Done' }).count();
await page.click('.zone-toolbar button:has-text("＋ Drawer")');
await page.waitForTimeout(200);
await page.click('.zone-toolbar button:has-text("← Done")');
await page.waitForTimeout(200);
await page.click('.studio-save');
await page.waitForTimeout(400);
const interiorSaved = await page.evaluate(() => {
  const parts = window.__kp.store.design.customParts;
  const part = parts[parts.length - 1];
  if (part.type !== 'cabinet') return { ok: false };
  const leaf = part.face.kind === 'leaf' ? part.face : null;
  const interior = leaf?.interior;
  return {
    ok:
      !!interior &&
      interior.mode === 'custom' &&
      interior.elements.some((e) => e.kind === 'drawerBox') &&
      interior.elements.every((e) => Number.isFinite(e.y)),
    partId: part.id,
  };
});
results.push(['interior drill-in adds an explicit drawer box', interiorToolbar === 1 && interiorSaved.ok]);
if (interiorSaved.partId) {
  await page.evaluate((id) => {
    const st = window.__kp.store;
    st.deleteCustomPart(id);
    st.commit();
  }, interiorSaved.partId);
}

// 28. counter appliance lifecycle: sink mounts on a cabinet, follows the host,
// cuts a hole in its worktop, dies with the host, and undo restores both.
const applScenario = await page.evaluate(() => {
  const st = window.__kp.store;
  const host = st.addItem(st.defOf('base-cabinet'), 2.6, 1.4, 0);
  st.updateItem(host.id, { w: 0.8 });
  const sink = st.addItem(st.defOf('appl-sink'), 2.6, 1.4, 0);
  st.setAttachment(sink.id, { kind: 'counter', hostId: host.id, u: 0, v: 0 });
  st.commit();
  const sinkItem = st.itemById(sink.id);
  // the host's worktop panel is now a prism with a hole
  let worktopIsPrism = false;
  const entry = window.__kp.view.items.get(host.id);
  entry.group.traverse((o) => {
    if (o.userData.role === 'worktop' && o.geometry?.type === 'ExtrudeGeometry') worktopIsPrism = true;
  });
  return {
    hostId: host.id,
    sinkId: sink.id,
    mounted: sinkItem.elevation > 0.85 && !!sinkItem.attach,
    worktopIsPrism,
  };
});
const applFollow = await page.evaluate((arg) => {
  const st = window.__kp.store;
  st.updateItem(arg.hostId, { x: 3.0 });
  st.commit();
  return Math.abs(st.itemById(arg.sinkId).x - 3.0) < 1e-6;
}, applScenario);
const applCascade = await page.evaluate((arg) => {
  const st = window.__kp.store;
  st.deleteItem(arg.hostId);
  st.commit();
  const gone = !st.itemById(arg.hostId) && !st.itemById(arg.sinkId);
  st.undo();
  const restored = !!st.itemById(arg.hostId) && !!st.itemById(arg.sinkId)?.attach;
  st.deleteItem(arg.hostId);
  st.commit();
  return gone && restored;
}, applScenario);
results.push([
  'sink mounts into a worktop, follows and dies with its host',
  applScenario.mounted && applScenario.worktopIsPrism && applFollow && applCascade,
]);

// 29. zone appliance: the demo tower hosts an oven in its niche; the niche is
// sized by the zone tree and a second claimant is rejected by the sanitizer.
await page.evaluate(() => {
  const st = window.__kp.store;
  const oven = st.design.items.find((i) => i.defId === 'appl-oven' && i.attach?.kind === 'zone');
  // this runs on the post-step-21 state (3-corner repaired design) — place fresh
  const tower = st.design.customParts.find((p) => p.name === 'Appliance tower');
  if (oven) return { fromDemo: true, sized: oven.w > 0.4 && oven.h > 0.4 };
  return { fromDemo: false, hasTowerPart: !!tower };
});
const zoneApplFresh = await page.evaluate(() => {
  const st = window.__kp.store;
  // build a tower part + host + oven in the current design
  const part = {
    id: 'tower-e2e',
    name: 'Tower E2E',
    type: 'cabinet',
    w: 0.6,
    d: 0.6,
    h: 2.2,
    elevation: 0,
    color: '#8a9683',
    accentColor: '#c9a87c',
    footprint: { kind: 'rect' },
    plinth: true,
    worktop: false,
    face: {
      kind: 'split',
      dir: 'h',
      weights: [0.5, 0.3, 0.2],
      children: [
        { kind: 'leaf', fill: 'door' },
        { kind: 'leaf', fill: 'appliance' },
        { kind: 'leaf', fill: 'door' },
      ],
    },
  };
  st.upsertCustomPart(part);
  const host = st.addItem(st.defOf('tower-e2e'), 2.0, 1.0, 0);
  const oven = st.addItem(st.defOf('appl-oven'), 2.0, 1.0, 0);
  st.setAttachment(oven.id, { kind: 'zone', hostId: host.id, path: [1] });
  st.commit();
  const o = st.itemById(oven.id);
  const sized = !!o.attach && o.w > 0.5 && o.elevation > 0.9; // niche starts above the bottom door
  // move the host — the oven rides along
  st.updateItem(host.id, { x: 2.6 });
  const follows = Math.abs(st.itemById(oven.id).x - 2.6) < 1e-6;
  st.deleteItem(host.id);
  st.deleteCustomPart('tower-e2e');
  st.commit();
  return sized && follows;
});
results.push(['oven slots into an appliance niche and rides the tower', zoneApplFresh]);

// 30. multi-room UI (N1-N3, N12): the add-room tool, click-to-activate,
// the Rooms group in the outline, and the elevation following the active room.
await page.keyboard.press('Escape');
await page.click('#btn-new'); // deterministic single 4x3 room, no items
await page.waitForTimeout(600);
// pin the viewport so both rooms are on-canvas whatever the pane size is
await page.evaluate(() => {
  const p = window.__kp.plan;
  p.zoom = 30;
  p.panX = 20;
  p.panY = 40;
  p.requestDraw();
});
const roomBb = await paneOffset();
const clickWorld = async (x, y) => {
  const s = await worldToScreen(x, y);
  await page.mouse.move(roomBb.x + s.x, roomBb.y + s.y); // hover first, as a user would
  await page.mouse.click(roomBb.x + s.x, roomBb.y + s.y);
  await page.waitForTimeout(200);
};

// N1 — the tool arms, previews and drops a free-standing room clear of the first
await page.click('#btn-room');
const roomToolArmed = await page.evaluate(() => ({
  on: window.__kp.plan.roomToolOn,
  active: document.getElementById('btn-room').classList.contains('active'),
}));
await clickWorld(8.0, 1.5); // ~4 m clear of the 4x3 room's right wall
const added = await page.evaluate(() => {
  const st = window.__kp.store;
  const rooms = st.design.rooms;
  return {
    n: rooms.length,
    activeIsNew: st.activeRoomId === rooms[rooms.length - 1].id,
    sel: st.selection.kind,
    toolOff: window.__kp.plan.roomToolOn === false,
    shared: st.allWalls().some((w) => w.shared),
  };
});
results.push([
  'add room tool places a second room',
  roomToolArmed.on &&
    roomToolArmed.active &&
    added.n === 2 &&
    added.activeIsNew &&
    added.sel === 'none' &&
    added.toolOff &&
    !added.shared,
]);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
results.push([
  'undo removes the added room',
  (await page.evaluate(() => window.__kp.store.design.rooms.length)) === 1,
]);
await page.evaluate(() => window.__kp.store.redo());
await page.waitForTimeout(300);

// N2 — clicking floor switches rooms; clicking the active one changes nothing;
// a drag past the pan threshold pans instead of switching.
const roomIds = await page.evaluate(() => window.__kp.store.design.rooms.map((r) => r.id));
await clickWorld(8.0, 1.5); // inside the second room
const switched = await page.evaluate(() => ({
  active: window.__kp.store.activeRoomId,
  sel: window.__kp.store.selection.kind,
}));
await clickWorld(8.0, 1.5); // again, already active
const restated = await page.evaluate(() => ({
  active: window.__kp.store.activeRoomId,
  sel: window.__kp.store.selection.kind,
}));
await clickWorld(2.0, 1.5); // inside the first room
const switchedBack = await page.evaluate(() => window.__kp.store.activeRoomId);
results.push([
  'clicking a room activates it',
  switched.active === roomIds[1] &&
    switched.sel === 'none' &&
    restated.active === roomIds[1] &&
    restated.sel === 'none' &&
    switchedBack === roomIds[0],
]);
const panFrom = await worldToScreen(8.0, 1.5); // empty floor of the INACTIVE room
const panBefore = await page.evaluate(() => window.__kp.plan.panX);
await page.mouse.move(roomBb.x + panFrom.x, roomBb.y + panFrom.y);
await page.mouse.down();
await page.mouse.move(roomBb.x + panFrom.x + 60, roomBb.y + panFrom.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
const panned = await page.evaluate(() => ({
  panX: window.__kp.plan.panX,
  active: window.__kp.store.activeRoomId,
}));
results.push([
  'dragging empty space pans without switching rooms',
  Math.abs(panned.panX - panBefore) > 40 && panned.active === roomIds[0],
]);

// N3 — the outline lists both rooms and switches between them
await page.click('#sidebar-tabs button[data-tab="components"]');
await page.waitForTimeout(120);
const roomsGroup = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#outline .ol-group')].find(
    (x) => x.querySelector('.ol-label')?.textContent === 'Rooms'
  );
  if (!g) return null;
  const rows = [...g.querySelectorAll('.ol-row')];
  return {
    first: true,
    leads: document.querySelector('#outline .ol-group') === g,
    names: rows.map((r) => r.querySelector('.room-row-name').textContent),
    activeIdx: rows.findIndex((r) => r.classList.contains('active')),
  };
});
await page.evaluate(() => {
  // click the row that is NOT the active one
  const g = [...document.querySelectorAll('#outline .ol-group')].find(
    (x) => x.querySelector('.ol-label')?.textContent === 'Rooms'
  );
  [...g.querySelectorAll('.ol-row')].find((r) => !r.classList.contains('active')).click();
});
await page.waitForTimeout(200);
const outlineSwitched = await page.evaluate(() => window.__kp.store.activeRoomId);
results.push([
  'outline lists rooms and switches',
  !!roomsGroup &&
    roomsGroup.leads &&
    roomsGroup.names.length === 2 &&
    roomsGroup.activeIdx === 0 &&
    outlineSwitched === roomIds[1],
]);
await page.click('#sidebar-tabs button[data-tab="library"]');

// N12 — the elevation nav cycles only the active room's walls
await page.click('#mode2d-toggle button[data-2dmode="elev"]');
await page.waitForTimeout(300);
const elevRoomOf = () =>
  page.evaluate(() => {
    const st = window.__kp.store;
    const w = st.wallById(window.__kp.elev.wallId);
    return { room: w ? w.roomId : null, active: st.activeRoomId, label: document.getElementById('wall-label').textContent };
  });
const elevWalk = [];
for (let i = 0; i < 5; i++) {
  await page.click('#btn-wall-next');
  await page.waitForTimeout(120);
  elevWalk.push(await elevRoomOf());
}
await page.evaluate((id) => window.__kp.store.setActiveRoom(id), roomIds[0]);
await page.waitForTimeout(250);
const elevAfterSwitch = await elevRoomOf();
results.push([
  'elevation follows the active room',
  elevWalk.every((e) => e.room === roomIds[1]) &&
    elevWalk[0].label.includes(' / 4') &&
    elevAfterSwitch.room === roomIds[0] &&
    elevAfterSwitch.active === roomIds[0],
]);
await page.click('#mode2d-toggle button[data-2dmode="plan"]');

// N4 — per-room style isolation: styling one room must not bleed into the
// other, and the two Floor meshes must carry distinct material colours.
await page.click('#btn-new');
await page.waitForTimeout(300);
const n4 = await page.evaluate(() => {
  const st = window.__kp.store;
  const before = st.design.rooms[0].style.floorColor;
  const r2 = st.addRoom();
  st.commit();
  st.setRoomStyle({ floorColor: '#123456' }, r2.id);
  st.commit();
  return {
    room1Unchanged: st.design.rooms[0].style.floorColor === before,
    room2Color: st.design.rooms[1].style.floorColor,
  };
});
await page.waitForTimeout(300);
const n4floors = await page.evaluate(() => {
  const colors = [];
  window.__kp.view['scene'].traverse((o) => {
    if (o.name === 'Floor' && o.material && o.material.color) colors.push('#' + o.material.color.getHexString());
  });
  return colors;
});
results.push([
  'per-room style isolation',
  n4.room1Unchanged &&
    n4.room2Color === '#123456' &&
    n4floors.length === 2 &&
    n4floors.includes('#123456') &&
    new Set(n4floors).size === 2,
]);

// N5 — a shared partition is built exactly once, under its owner.
await page.click('#btn-new');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const st = window.__kp.store;
  const wall0 = st.allWalls()[0];
  st.addRoom({ against: { wallId: wall0.id }, d: 3 });
  st.commit();
});
await page.waitForTimeout(400);
const n5 = await page.evaluate(() => {
  const st = window.__kp.store;
  const totalWalls = st.allWalls().length;
  const sharedWalls = st.allWalls().filter((w) => w.shared);
  const owners = sharedWalls.filter((w) => w.shared.owner).length;
  let groups = 0;
  window.__kp.view['scene'].traverse((o) => {
    if (/^Wall_\d+$/.test(o.name)) groups++;
  });
  return { totalWalls, sharedLen: sharedWalls.length, owners, groups };
});
results.push([
  'partition renders once',
  n5.groups === n5.totalWalls - 1 && n5.sharedLen === 2 && n5.owners === 1,
]);

// N6 — placing a catalog item near the far wall of the second room snaps it
// flush to that wall, facing into room 2, and stamps room 2 as its roomId.
await page.click('#btn-new');
await page.waitForTimeout(300);
const n6fixture = await page.evaluate(() => {
  const st = window.__kp.store;
  const wall0 = st.allWalls()[0];
  const r2 = st.addRoom({ against: { wallId: wall0.id }, d: 3 });
  st.commit();
  window.__kp.plan.zoomFit();
  const walls2 = st.wallsOf(r2.id);
  const sharedIdx = walls2.findIndex((w) => w.shared);
  const far = walls2[(sharedIdx + 2) % 4]; // the wall opposite the shared one
  return {
    room2: r2.id,
    far: { ax: far.a.x, ay: far.a.y, bx: far.b.x, by: far.b.y, inx: far.inward.x, iny: far.inward.y },
  };
});
await page.waitForTimeout(200);
await page.click('.cat-item[data-def-id="base-cabinet"]');
const bb6 = await paneOffset();
const midX6 = (n6fixture.far.ax + n6fixture.far.bx) / 2;
const midY6 = (n6fixture.far.ay + n6fixture.far.by) / 2;
const clickPt6 = { x: midX6 + n6fixture.far.inx * 0.25, y: midY6 + n6fixture.far.iny * 0.25 };
const screenPt6 = await worldToScreen(clickPt6.x, clickPt6.y);
await page.mouse.click(bb6.x + screenPt6.x, bb6.y + screenPt6.y);
await page.waitForTimeout(300);
const n6placed = await page.evaluate((fx) => {
  const st = window.__kp.store;
  const items = st.design.items;
  const it = items[items.length - 1];
  const expectedRot = Math.atan2(-fx.far.inx, fx.far.iny);
  const diff = (((it.rotation - expectedRot + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return { roomId: it.roomId, rotOk: Math.abs(diff) < 0.05 };
}, n6fixture);
results.push([
  'item snaps in the second room',
  n6placed.roomId === n6fixture.room2 && n6placed.rotOk,
]);

// N7 — each room's ceiling sits at that room's own wallHeight.
await page.click('#btn-new');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const st = window.__kp.store;
  const wall0 = st.allWalls()[0];
  const r2 = st.addRoom({ against: { wallId: wall0.id }, d: 3 });
  st.commit();
  st.setRoomStyle({ wallHeight: 2.2 }, r2.id);
  st.commit();
});
await page.waitForTimeout(400);
const n7ceilings = await page.evaluate(() => {
  const ys = [];
  window.__kp.view['scene'].traverse((o) => {
    if (o.name === 'Ceiling') ys.push(o.position.y);
  });
  return ys.sort((a, b) => a - b);
});
results.push([
  'per-room ceiling height',
  n7ceilings.length === 2 && Math.abs(n7ceilings[0] - 2.2) < 0.01 && Math.abs(n7ceilings[1] - 2.6) < 0.01,
]);

// N8 — wall-visibility overrides are scoped to the room they were set on.
await page.click('#btn-new');
await page.waitForTimeout(300);
const n8 = await page.evaluate(() => {
  const st = window.__kp.store;
  const r1 = st.design.rooms[0];
  const r2 = st.addRoom(); // freestanding — no partition to complicate ownership
  st.commit();
  st.setActiveRoom(r1.id);
  st.setAllWallVisibility('show', r2.id); // deterministic baseline (not camera-dependent 'auto')
  st.setAllWallVisibility('hide', r1.id);
  st.commit();
  return { r1: r1.id, r2: r2.id };
});
await page.waitForTimeout(300);
const n8vis = await page.evaluate(() =>
  window.__kp.view['walls'].map((w) => ({ roomId: w.roomId, visible: w.group.visible }))
);
results.push([
  'wall visibility is per room',
  n8vis.some((w) => w.roomId === n8.r1) &&
    n8vis.some((w) => w.roomId === n8.r2) &&
    n8vis.filter((w) => w.roomId === n8.r1).every((w) => w.visible === false) &&
    n8vis.filter((w) => w.roomId === n8.r2).every((w) => w.visible === true),
]);

// N9 — deleteRoom cascades the deleted room's items and, when the deleted
// room OWNS a partition (the earlier room in design.rooms always does — see
// store.ts deleteRoom / rooms.ts allWalls), re-homes that partition's door
// onto the surviving twin instead of dropping it. A door on a wall the
// deleted room does NOT own would instead survive untouched on the owner —
// this fixture exercises the re-home branch by deleting the owning room.
await page.click('#btn-new');
await page.waitForTimeout(300);
const n9setup = await page.evaluate(() => {
  const st = window.__kp.store;
  const wall0 = st.allWalls()[0];
  const room1 = st.design.rooms[0]; // earlier in design.rooms[] => owns the partition
  const room2 = st.addRoom({ against: { wallId: wall0.id }, d: 3 });
  st.commit();
  const item = st.addItem(st.defOf('base-cabinet'), 1, 1); // lands inside room1
  st.commit();
  const partitionWallId = st.wallsOf(room1.id).find((w) => w.shared).id;
  const door = st.addOpening(st.defOf('door'), partitionWallId, 1);
  st.commit();
  const twinWallId = st.wallTwin(partitionWallId).id;
  return { room1: room1.id, room2: room2.id, itemId: item.id, doorId: door.id, doorWallBefore: door.wallId, twinWallId };
});
const n9del = await page.evaluate((fx) => {
  const st = window.__kp.store;
  const result = st.deleteRoom(fx.room1);
  st.commit();
  const doorAfter = st.openingById(fx.doorId);
  return {
    result,
    roomsLen: st.design.rooms.length,
    remainingRoom: st.design.rooms[0].id,
    itemGone: !st.itemById(fx.itemId),
    doorSurvives: !!doorAfter,
    doorWallAfter: doorAfter ? doorAfter.wallId : null,
  };
}, n9setup);
results.push([
  'delete room cascades items and re-homes the partition door',
  n9del.roomsLen === 1 &&
    n9del.remainingRoom === n9setup.room2 &&
    n9del.itemGone &&
    n9del.doorSurvives &&
    n9del.doorWallAfter === n9setup.twinWallId &&
    n9del.doorWallAfter !== n9setup.doorWallBefore,
]);

// N10 — a migrated v5 design keeps behaving like a v6 one: wall-length edit,
// rectangle resize and wall-snap placement all still work post-migration
// (same mechanics as tests 6/7/1, replayed against the migrated geometry).
await page.evaluate(() => {
  localStorage.setItem(
    'interior-planner-design-v1',
    JSON.stringify({
      version: 5,
      corners: [
        { id: 'c0', x: 0, y: 0 },
        { id: 'c1', x: 4, y: 0 },
        { id: 'c2', x: 4, y: 3 },
        { id: 'c3', x: 0, y: 3 },
      ],
    })
  );
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const n10setup = await page.evaluate(() => {
  window.__kp.plan.zoomFit();
  const st = window.__kp.store;
  return { version: st.design.version, rect: st.rectangleSize() };
});
results.push(['v5 payload migrates to an editable v6 rectangle', n10setup.version === 6 && !!n10setup.rect]);

const bb10 = await paneOffset();
const leftMid10 = await page.evaluate(() => {
  const st = window.__kp.store;
  const g = st.allWalls().find((w) => Math.abs(w.dir.x) < 1e-6 && w.a.x < 1);
  return { x: g.a.x + g.dir.x * (g.len / 2), y: g.a.y + g.dir.y * (g.len / 2) };
});
const leftScr10 = await worldToScreen(leftMid10.x, leftMid10.y);
await page.mouse.click(bb10.x + leftScr10.x, bb10.y + leftScr10.y);
await page.waitForTimeout(300);
const wallTitle10 = await page.textContent('.props-title');
const lenInput10 = page.locator('#props-inner input[type=number]').first();
await lenInput10.fill('300');
await lenInput10.press('Enter');
await page.waitForTimeout(300);
const area10 = await page.evaluate(() => window.__kp.store.floorArea());
results.push([
  'wall length edit on a migrated design',
  wallTitle10 === 'Wall' && Math.abs(area10 - n10setup.rect.w * 3.0) < 0.05,
]);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const widthInput10 = page.locator('#props-inner input[type=number]').first();
await widthInput10.fill('450');
await widthInput10.press('Enter');
await page.waitForTimeout(300);
const rect10 = await page.evaluate(() => window.__kp.store.rectangleSize());
results.push([
  'rectangle resize on a migrated design',
  !!rect10 && Math.abs(rect10.w - 4.5) < 0.01 && Math.abs(rect10.d - 3.0) < 0.01,
]);

await page.click('.cat-item[data-def-id="base-cabinet"]');
const bottomWall10 = await page.evaluate(() => {
  const st = window.__kp.store;
  return st.allWalls().reduce((best, w) => (w.a.y + w.b.y > best.a.y + best.b.y ? w : best));
});
const aimPt10 = {
  x: (bottomWall10.a.x + bottomWall10.b.x) / 2 + bottomWall10.inward.x * 0.25,
  y: (bottomWall10.a.y + bottomWall10.b.y) / 2 + bottomWall10.inward.y * 0.25,
};
const aimScr10 = await worldToScreen(aimPt10.x, aimPt10.y);
await page.mouse.click(bb10.x + aimScr10.x, bb10.y + aimScr10.y);
await page.waitForTimeout(300);
const placed10 = await page.evaluate((bw) => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  const expected = {
    x: (bw.a.x + bw.b.x) / 2 + bw.inward.x * (it.d / 2),
    y: (bw.a.y + bw.b.y) / 2 + bw.inward.y * (it.d / 2),
  };
  return Math.hypot(it.x - expected.x, it.y - expected.y);
}, bottomWall10);
results.push(['wall-snap placement on a migrated design', placed10 < 0.05]);

// N11 — measuring between a corner of room 1 and a corner of room 2 reports
// the true cross-room distance and never touches the model.
await page.click('#btn-new');
await page.waitForTimeout(300);
const n11fixture = await page.evaluate(() => {
  const st = window.__kp.store;
  const r2 = st.addRoom(); // freestanding, 1 m clear of room 1
  st.commit();
  window.__kp.plan.zoomFit();
  const c1 = st.design.rooms[0].corners[0];
  const c2 = r2.corners[0];
  return {
    itemsBefore: st.design.items.length,
    p1: { x: c1.x, y: c1.y },
    p2: { x: c2.x, y: c2.y },
    dist: Math.hypot(c2.x - c1.x, c2.y - c1.y),
  };
});
await page.waitForTimeout(200);
await page.click('#btn-measure');
const bb11 = await paneOffset();
const s1 = await worldToScreen(n11fixture.p1.x, n11fixture.p1.y);
const s2 = await worldToScreen(n11fixture.p2.x, n11fixture.p2.y);
await page.mouse.click(bb11.x + s1.x, bb11.y + s1.y);
await page.waitForTimeout(100);
await page.mouse.click(bb11.x + s2.x, bb11.y + s2.y);
await page.waitForTimeout(150);
const n11measured = await page.evaluate(() => {
  const m = window.__kp.plan.measure;
  const d = m.a && m.b ? Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) : -1;
  return { d, items: window.__kp.store.design.items.length };
});
results.push([
  'measure across rooms',
  Math.abs(n11measured.d - n11fixture.dist) < 0.03 && n11measured.items === n11fixture.itemsBefore,
]);
await page.keyboard.press('Escape');

// N12 — bedroom set: a bed backs onto a wall like any wall-placed unit, and
// the wardrobe preset carries its hanging rail all the way into the 3D scene.
await page.click('#btn-new');
await page.waitForTimeout(500);
await page.evaluate(() => window.__kp.plan.zoomFit());
await page.waitForTimeout(150);
await page.click('.cat-item[data-def-id="bed-double"]');
const bb12 = await paneOffset();
// 2 m deep bed in the 4x3 room: its snapped centre IS (2.0, 2.0)
const bedScr = await worldToScreen(2.0, 2.0);
await page.mouse.click(bb12.x + bedScr.x, bb12.y + bedScr.y);
await page.waitForTimeout(300);
const bed12 = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { defId: it.defId, y: it.y, d: it.d, rot: it.rotation };
});
results.push([
  'bed places against a wall',
  bed12.defId === 'bed-double' &&
    Math.abs(bed12.y - (3 - bed12.d / 2)) < 0.02 &&
    Math.abs(Math.abs(bed12.rot) - Math.PI) < 0.01,
]);

const wardrobe12 = await page.evaluate(() => {
  const st = window.__kp.store;
  const it = st.addItem(st.defOf('wardrobe'), 0.6, 0.4);
  st.commit();
  return it.defId;
});
await page.waitForTimeout(400);
const rails12 = await page.evaluate(() => {
  let n = 0;
  window.__kp.view['scene'].traverse((o) => {
    if (o.userData.role === 'rail') n++;
  });
  return n;
});
results.push(['wardrobe preset carries its hanging rail', wardrobe12 === 'wardrobe' && rails12 === 1]);

// N13 — living-room set: a rug ignores wall snapping entirely, a TV refuses to
// place away from a wall, and the sofa's seats stepper drives its width.
await page.click('#btn-new');
await page.waitForTimeout(500);
await page.evaluate(() => window.__kp.plan.zoomFit());
await page.waitForTimeout(150);
const bb13 = await paneOffset();

// (a) free placement: the rug stays on the 1 cm grid where it was clicked,
// while a wall-placed item of the same depth would be pulled to y = 2.30
await page.click('.cat-item[data-def-id="rug"]');
const rugScr = await worldToScreen(2.0, 2.2);
await page.mouse.click(bb13.x + rugScr.x, bb13.y + rugScr.y);
await page.waitForTimeout(250);
const rug13 = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { defId: it.defId, y: it.y, d: it.d };
});
results.push([
  'rug never snaps to a wall',
  rug13.defId === 'rug' &&
    Math.abs(rug13.y - 2.2) < 0.02 &&
    Math.abs(rug13.y - (3 - rug13.d / 2)) > 0.05,
]);

// (b) the TV is wall-mounted: a mid-room click places nothing at all
const before13 = await count();
await page.click('.cat-item[data-def-id="tv"]');
const midScr = await worldToScreen(2.0, 1.0);
await page.mouse.click(bb13.x + midScr.x, bb13.y + midScr.y);
await page.waitForTimeout(200);
const midCount13 = await count();
const wallScr = await worldToScreen(2.0, 0.12);
await page.mouse.click(bb13.x + wallScr.x, bb13.y + wallScr.y);
await page.waitForTimeout(250);
const tv13 = await page.evaluate(() => {
  const items = window.__kp.store.design.items;
  const it = items[items.length - 1];
  return { n: items.length, defId: it.defId, y: it.y, d: it.d, rot: it.rotation, elev: it.elevation };
});
results.push([
  'tv requires a wall',
  midCount13 === before13 &&
    tv13.n === before13 + 1 &&
    tv13.defId === 'tv' &&
    Math.abs(tv13.elev - 1.0) < 1e-6 &&
    Math.abs(tv13.y - tv13.d / 2) < 0.02 &&
    Math.abs(tv13.rot) < 0.01,
]);

// (c) the seats stepper is width-driving (widthPer), through the props panel
await page.click('.cat-item[data-def-id="sofa"]');
const sofaScr = await worldToScreen(0.5, 1.0);
await page.mouse.click(bb13.x + sofaScr.x, bb13.y + sofaScr.y);
await page.waitForTimeout(300);
await page.locator('.prop-row', { hasText: 'Seats' }).locator('.stepper button').nth(1).click();
await page.waitForTimeout(300);
const sofa13 = await page.evaluate(() => {
  const it = window.__kp.store.design.items.find((i) => i.defId === 'sofa');
  return it ? { seats: it.params?.seats, w: it.w } : null;
});
results.push([
  'sofa seats stepper drives width',
  !!sofa13 && sofa13.seats === 4 && Math.abs(sofa13.w - 4 * 0.69) < 0.001,
]);

// ---------------------------------------------------------------------------
// M3 — spatial checks engine (src/model/checks.ts): overlap / through-wall /
// work-triangle E2E. Reload onto a clean demoDesign() baseline first — by
// this point in the suite autosave holds a heavily mutated tree, and #btn-new
// gives an emptyDesign(), not the demo (the only design carrying the shipped
// sink/hob 70 cm work-triangle hint).
// ---------------------------------------------------------------------------
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 31. moving one demo cabinet onto another raises an 'overlap' error naming
// both, surfaces in the status bar, and undo clears it back to the baseline
// (the one deliberate work-triangle info hint the demo ships with).
const overlapIds = await page.evaluate(() => {
  const st = window.__kp.store;
  const [a, b] = st.design.items.filter((i) => i.defId === 'wall-cabinet');
  st.updateItem(b.id, { x: a.x, y: a.y });
  st.commit();
  return { aId: a.id, bId: b.id };
});
await page.waitForTimeout(150);
const overlapAfter = await page.evaluate((ids) => {
  const st = window.__kp.store;
  const w = st.warnings().find((x) => x.kind === 'overlap');
  return {
    ok:
      !!w &&
      w.severity === 'error' &&
      new Set(w.itemIds).size === 2 &&
      w.itemIds.includes(ids.aId) &&
      w.itemIds.includes(ids.bId),
    status: document.getElementById('status-info').textContent,
  };
}, overlapIds);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const overlapUndone = await page.evaluate(() => ({
  kinds: window.__kp.store.warnings().map((w) => w.kind),
  status: document.getElementById('status-info').textContent,
}));
results.push([
  'overlap warning appears and clears',
  overlapAfter.ok &&
    overlapAfter.status.includes('issue') &&
    overlapUndone.kinds.length === 1 &&
    overlapUndone.kinds[0] === 'workTriangle' &&
    !overlapUndone.status.includes('issue'),
]);

// 32. shoving the demo fridge into the shared partition raises a 'throughWall'
// error and paints the fridge with the error emissive tint in 3D (selection
// cleared first so the selection-green tint cannot win instead); undo clears it.
await page.evaluate(() => window.__kp.store.select({ kind: 'none' }));
const fridgeId = await page.evaluate(() => {
  const st = window.__kp.store;
  const fridge = st.design.items.find((i) => i.defId === 'fridge');
  st.updateItem(fridge.id, { x: fridge.x + 0.5 });
  st.commit();
  return fridge.id;
});
await page.waitForTimeout(200);
const throughWallAfter = await page.evaluate((id) => {
  const st = window.__kp.store;
  const w = st.warnings().find((x) => x.kind === 'throughWall' && x.itemIds[0] === id);
  let tinted = false;
  window.__kp.view.items.get(id).group.traverse((o) => {
    const m = o.material;
    if (m?.emissive && `#${m.emissive.getHexString()}` === '#c0392b') tinted = true;
  });
  return { ok: !!w && w.severity === 'error', tinted };
}, fridgeId);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
const throughWallUndone = await page.evaluate(() => window.__kp.store.warnings().map((w) => w.kind));
results.push([
  'through-wall flags on drag out',
  throughWallAfter.ok &&
    throughWallAfter.tinted &&
    throughWallUndone.length === 1 &&
    throughWallUndone[0] === 'workTriangle',
]);

// 33. #btn-checks toggles plan.checksOn (and its active class) so warn/info
// findings join the 2D overlay; errors are drawn regardless (canvas pixels are
// brittle to assert — state + class only, per plan2d.ts drawChecks).
await page.click('#btn-checks');
await page.waitForTimeout(120);
const checksOnState = await page.evaluate(() => ({
  on: window.__kp.plan.checksOn,
  active: document.getElementById('btn-checks').classList.contains('active'),
}));
await page.click('#btn-checks');
await page.waitForTimeout(120);
const checksOffState = await page.evaluate(() => ({
  on: window.__kp.plan.checksOn,
  active: document.getElementById('btn-checks').classList.contains('active'),
}));
results.push([
  'checks toggle reveals info findings in 2D',
  checksOnState.on === true &&
    checksOnState.active === true &&
    checksOffState.on === false &&
    checksOffState.active === false,
]);

// 34. the demo's baseline hint: sink and hob sit 70 cm apart, under the 120 cm
// shortest work-triangle leg — info severity, spelled out in cm, and (unlike
// errors/warns) never counted in the status bar's issue total.
const triangleWarning = await page.evaluate(() => {
  const st = window.__kp.store;
  const w = st.warnings().find((x) => x.kind === 'workTriangle');
  return {
    severity: w?.severity,
    detail: w?.detail ?? '',
    status: document.getElementById('status-info').textContent,
  };
});
results.push([
  'work triangle hint lists three legs',
  triangleWarning.severity === 'info' &&
    /Sink→hob|sink/i.test(triangleWarning.detail) &&
    triangleWarning.detail.includes('cm') &&
    !triangleWarning.status.includes('issue'),
]);

// 35. Export ▾ → Plan sheet (milestone 4c): a self-contained print document
// with the true-scale plan rendered offscreen as a PNG data URL and the item
// schedule built from the same BOM rows the CSV exports use.
await page.keyboard.press('Escape');
await openExportMenu();
const [planPopup] = await Promise.all([
  page.waitForEvent('popup', { timeout: 20000 }),
  page.click('[data-export="plan"]'),
]);
await planPopup.waitForLoadState('load');
await planPopup.waitForFunction(
  () => {
    const img = document.querySelector('img.plan');
    return !!img && img.complete && img.naturalWidth > 0;
  },
  null,
  { timeout: 20000 }
);
const sheet = await planPopup.evaluate(() => {
  const img = document.querySelector('img.plan');
  return {
    title: document.title,
    src: img.getAttribute('src').slice(0, 14),
    natW: img.naturalWidth,
    natH: img.naturalHeight,
    widthMm: img.style.width,
    rows: document.querySelectorAll('table tbody tr').length,
    meta: document.querySelector('.meta').textContent,
    body: document.body.textContent,
  };
});
await planPopup.close();
results.push([
  'plan sheet: true-scale plan image + item schedule',
  sheet.title === 'Interior plan' &&
    sheet.src === 'data:image/png' &&
    sheet.natW > 500 &&
    sheet.natH > 200 &&
    /^\d+mm$/.test(sheet.widthMm) &&
    sheet.meta.includes('Scale 1:50') &&
    sheet.rows > 5 &&
    sheet.body.includes('Item schedule'),
]);

// 36. draw-room tool (F2): click an L-shaped ring corner by corner, cancel one
// with Esc, and close a real one on its first vertex.
await page.keyboard.press('Escape');
await page.click('#btn-new'); // deterministic single 4x3 room, no items
await page.waitForTimeout(600);
await page.evaluate(() => {
  const p = window.__kp.plan;
  p.zoom = 30;
  p.panX = 20;
  p.panY = 40;
  p.requestDraw();
});
const drawBb = await paneOffset();
const clickAt = async (x, y) => {
  const s = await worldToScreen(x, y);
  await page.mouse.move(drawBb.x + s.x, drawBb.y + s.y); // hover first, as a user would
  await page.mouse.click(drawBb.x + s.x, drawBb.y + s.y);
  await page.waitForTimeout(120);
};

await page.click('#btn-draw-room');
const drawArmed = await page.evaluate(() => ({
  on: window.__kp.plan.drawRoomOn,
  active: document.getElementById('btn-draw-room').classList.contains('active'),
  measureOff: window.__kp.plan.measureOn === false,
}));
// Esc drops the ring in progress first, and only then the tool itself
await clickAt(7, 1);
await clickAt(9, 1);
await page.keyboard.press('Escape');
const ringCancelled = await page.evaluate(() => ({
  ring: window.__kp.plan.drawRing(),
  on: window.__kp.plan.drawRoomOn,
  rooms: window.__kp.store.design.rooms.length,
}));
results.push([
  'draw-room tool arms; Esc discards the ring before the tool',
  drawArmed.on &&
    drawArmed.active &&
    drawArmed.measureOff &&
    ringCancelled.ring === null &&
    ringCancelled.on === true &&
    ringCancelled.rooms === 1,
]);

// an L clear of the 4x3 room at the origin, closed on its first corner
for (const [x, y] of [[7, 1], [12, 1], [12, 6], [10, 6], [10, 4], [7, 4]]) await clickAt(x, y);
const midRing = await page.evaluate(() => {
  const r = window.__kp.plan.drawRing();
  return { pts: r ? r.pts.length : 0, rooms: window.__kp.store.design.rooms.length };
});
await clickAt(7, 1);
const drawn = await page.evaluate(() => {
  const st = window.__kp.store;
  const r = st.design.rooms[st.design.rooms.length - 1];
  return {
    n: st.design.rooms.length,
    corners: r.corners.length,
    area: st.floorArea(r.id),
    active: st.activeRoomId === r.id,
    toolOff: window.__kp.plan.drawRoomOn === false,
    ortho: r.corners.every((c, i) => {
      const b = r.corners[(i + 1) % r.corners.length];
      return Math.abs(c.x - b.x) < 1e-6 || Math.abs(c.y - b.y) < 1e-6;
    }),
  };
});
results.push([
  'draw-room tool clicks out an L-shaped room',
  midRing.pts === 6 &&
    midRing.rooms === 1 &&
    drawn.n === 2 &&
    drawn.corners === 6 &&
    drawn.ortho &&
    Math.abs(drawn.area - 19) < 1 &&
    drawn.active &&
    drawn.toolOff,
]);
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
results.push([
  'undo removes the drawn room',
  (await page.evaluate(() => window.__kp.store.design.rooms.length)) === 1,
]);

// 37. auto-share (F1): a free-standing room dropped near an existing one snaps
// flush and the contact becomes a partition — no "attach to wall" step.
await page.click('#btn-new');
await page.waitForTimeout(600);
await page.evaluate(() => {
  const p = window.__kp.plan;
  p.zoom = 30;
  p.panX = 20;
  p.panY = 40;
  p.requestDraw();
});
await page.click('#btn-room');
// 2.1 m clear of the right wall, so the tool takes the FREE branch, but the
// ghost's left side is within snapping reach of that wall's line
const flushGhost = await (async () => {
  const s = await worldToScreen(6.1, 1.5);
  await page.mouse.move(drawBb.x + s.x, drawBb.y + s.y);
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const g = window.__kp.plan.roomGhost;
    return { attached: g ? g.attached : null, flush: g ? g.flush : null, x: g ? g.poly[0].x : -1 };
  });
})();
await clickAt(6.1, 1.5);
const welded = await page.evaluate(() => {
  const st = window.__kp.store;
  const shared = st.allWalls().filter((w) => w.shared);
  return {
    rooms: st.design.rooms.length,
    shared: shared.length,
    owners: shared.filter((w) => w.shared.owner).length,
    len: shared.length ? shared[0].len : 0,
    corners: st.design.rooms.map((r) => r.corners.length),
  };
});
results.push([
  'a free room dropped flush shares the wall it touches',
  flushGhost.attached === false &&
    flushGhost.flush === true &&
    Math.abs(flushGhost.x - 4) < 1e-6 &&
    welded.rooms === 2 &&
    welded.shared === 2 &&
    welded.owners === 1 &&
    Math.abs(welded.len - 3) < 1e-6 &&
    welded.corners.every((n) => n === 4),
]);

let pass = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
console.log(`${pass}/${results.length} passed`);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(pass === results.length && !errors.length ? 0 : 1);
