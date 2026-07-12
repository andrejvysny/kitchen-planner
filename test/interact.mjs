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

// 8. create a custom part via studio
await page.click('.cat-new');
await page.waitForTimeout(800);
await page.click('.studio-save');
await page.waitForTimeout(400);
const parts = await page.evaluate(() => window.__kp.store.design.customParts.length);
results.push(['save custom part', parts === 2]); // sample + new

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

// 16. night toggle round-trips
await page.click('#btn-daynight');
await page.waitForTimeout(120);
const night1 = await page.evaluate(() => window.__kp.store.design.scene.night);
await page.click('#btn-daynight');
await page.waitForTimeout(120);
const night2 = await page.evaluate(() => window.__kp.store.design.scene.night);
results.push(['night toggle', night1 === true && night2 === false]);

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

let pass = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
console.log(`${pass}/${results.length} passed`);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(pass === results.length && !errors.length ? 0 : 1);
