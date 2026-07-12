import { chromium } from 'playwright';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

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

// 10. GLB export for Blender
await page.keyboard.press('Escape');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.click('#btn-glb'),
]);
const path = await download.path();
const { readFileSync } = await import('fs');
const buf = readFileSync(path);
results.push(['glb export magic', buf.length > 2000 && buf.toString('ascii', 0, 4) === 'glTF']);

let pass = 0;
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (ok) pass++;
}
console.log(`${pass}/${results.length} passed`);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
process.exit(pass === results.length && !errors.length ? 0 : 1);
