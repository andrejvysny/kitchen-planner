import { chromium } from 'playwright';

const executablePath = process.env.KP_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.accept());

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
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
// bottom wall of 4x3 room: inner face at y = 3 - 0.05; item center should be ~3 - 0.05 - 0.3 = 2.65
results.push(['wall snap position', Math.abs(placed.y - 2.65) < 0.02]);
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
const baseGroup = outline.find((g) => g.title === 'Base units');
results.push([
  'outline lists item under type group',
  !!baseGroup && baseGroup.rows.includes('Base cabinet'),
]);
await page.evaluate(() => window.__kp.store.select({ kind: 'none' }));
await page.waitForTimeout(80);
await page.click('#outline .ol-row');
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
results.push(['drag moved item', Math.abs(moved.x - placed.x) > 0.5 && Math.abs(moved.y - 2.65) < 0.02]);

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
const cornersBefore = await page.evaluate(() => window.__kp.store.design.corners.length);
const midWorld = await page.evaluate(() => {
  // the left wall (x = 0) — the right one can sit outside the un-refitted viewport
  const g = window.__kp.store.walls().find((w) => Math.abs(w.dir.x) < 1e-6 && w.a.x < 0.01);
  return { x: g.a.x + g.dir.x * (g.len / 2), y: g.a.y + g.dir.y * (g.len / 2) };
});
const mp = await worldToScreen(midWorld.x, midWorld.y);
await page.mouse.click(bb.x + mp.x, bb.y + mp.y);
await page.waitForTimeout(200);
const midClick = await page.evaluate(() => ({
  n: window.__kp.store.design.corners.length,
  sel: window.__kp.store.selection.kind,
}));
results.push(['midpoint click selects wall', midClick.n === cornersBefore && midClick.sel === 'wall']);
await page.mouse.move(bb.x + mp.x, bb.y + mp.y);
await page.mouse.down();
await page.mouse.move(bb.x + mp.x - 30, bb.y + mp.y, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(200);
const midDrag = await page.evaluate(() => ({
  n: window.__kp.store.design.corners.length,
  sel: window.__kp.store.selection.kind,
}));
results.push(['midpoint drag adds corner', midDrag.n === cornersBefore + 1 && midDrag.sel === 'corner']);
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
results.push(['undo midpoint drag', (await page.evaluate(() => window.__kp.store.design.corners.length)) === cornersBefore]);

// 11. dragging a corner inside-out must keep the CCW invariant + opening bounds
const ccw = await page.evaluate(() => {
  const st = window.__kp.store;
  const c0 = st.design.corners.reduce((a, b) => (Math.hypot(a.x, a.y) < Math.hypot(b.x, b.y) ? a : b));
  st.moveCorner(c0.id, 5.5, 4.5, false);
  st.commit();
  const pts = st.design.corners;
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
  const wall = st.walls()[0];
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
const pick3d = await page.evaluate((ids) => {
  const st = window.__kp.store;
  const it = st.itemById(ids.baseId);
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

// restore the pre-navigation camera for the steps below
await page.evaluate((c) => {
  const { camera, controls } = window.__kp.view;
  camera.position.set(...c.pos);
  controls.target.set(...c.tgt);
  controls.update();
}, navA);
await page.waitForTimeout(200);

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
  sec.querySelector('.toggle-row input').click();
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

// 21. a partial autosave (missing items/openings/room/scene) is repaired on load
await page.evaluate(() => {
  localStorage.setItem(
    'kitchen-planner-design-v1',
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
const repaired = await page.evaluate(() => {
  const d = window.__kp.store.design;
  return (
    Array.isArray(d.items) &&
    Array.isArray(d.openings) &&
    !!d.room &&
    !!d.scene &&
    d.corners.length === 3
  );
});
results.push(['corrupt autosave repaired on load', repaired]);

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
  const g = st.walls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y < 0.01);
  const def = st.defOf('base-cabinet');
  const t = st.design.room.wallThickness;
  const rot = Math.atan2(-g.inward.x, g.inward.y);
  const foot = { x: g.a.x + g.dir.x * (g.len / 2), y: g.a.y + g.dir.y * (g.len / 2) };
  const cab = st.addItem(def, foot.x + g.inward.x * (t / 2 + def.d / 2), foot.y + g.inward.y * (t / 2 + def.d / 2), rot);
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
  const wallId = st.walls()[0].id;
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
    wallBound: d.room.wallColor.startsWith('var:'),
  };
});
results.push([
  'variable binding + value persist across reload',
  persisted.hasVar && persisted.cabBound && persisted.wallBound,
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
