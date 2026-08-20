import { chromium } from 'playwright';

const executablePath = process.env.KP_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

// WP 2.5: shots are of the APP, not of the first-run tour — seed the onboarded
// key before the page scripts run (this profile is otherwise brand new).
await page.addInitScript(() => {
  localStorage.setItem('interior-planner-onboarded-v1', '1');
});

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
// A brand-new profile boots EMPTY now (src/app/services.ts), and these shots
// are of a furnished plan — the multi-room step below even reads allWalls()[0].
// Seed through the same call the starter card's "Load sample design" makes.
await page.waitForFunction(() => !!window.__kp?.store, undefined, { polling: 50 });
await page.evaluate(() => {
  window.__kp.store.loadDemo();
  window.__kp.plan.zoomFit();
});
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/shot-split.png' });

// 3D-only view
await page.click('#view-toggle button[data-view="3d"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-3d.png' });

// night mode
await page.click('#btn-daynight');
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-night.png' });
await page.click('#btn-daynight');

// 2D view, select an item by clicking in plan
await page.click('#view-toggle button[data-view="2d"]');
await page.waitForTimeout(600);
const pane = await page.locator('#canvas2d').boundingBox();
await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2);
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/shot-2d.png' });

// part studio — the +New tile routes into the Workshop workspace, which hosts
// the studio over the canvases (no modal, no backdrop, Escape never closes)
await page.click('#view-toggle button[data-view="split"]');
await page.waitForTimeout(300);
const newPart = await page.locator('.cat-new');
await newPart.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/shot-studio.png' });

// multi-room: add a room against a wall, split view. "Back" is how you leave
// the Workshop now, and it returns to the workspace the +New tile came from.
await page.click('#wsp-back');
await page.waitForTimeout(400);
await page.click('#view-toggle button[data-view="split"]');
await page.waitForTimeout(300);
await page.evaluate(() => {
  const st = window.__kp.store;
  const wall0 = st.allWalls()[0];
  st.addRoom({ against: { wallId: wall0.id }, d: 3 });
  st.commit();
  window.__kp.plan.zoomFit();
});
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/shot-rooms.png' });

// one shot per workspace: the four task-focused modes the tabs switch between
await page.click('#ws-tab-plan');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/shot-ws-plan.png' });

await page.click('#ws-tab-furnish');
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/shot-ws-furnish.png' });

// the Workshop sidebar's preset rows open the studio in the pane
await page.click('#ws-tab-workshop');
await page.waitForTimeout(400);
await page.click('.wsp-row.wsp-preset');
await page.waitForTimeout(1800);
await page.screenshot({ path: '/tmp/shot-ws-workshop.png' });

await page.click('#ws-tab-output');
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/shot-ws-output.png' });

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
