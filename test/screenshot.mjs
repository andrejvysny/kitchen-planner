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

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
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

// part studio
await page.click('#view-toggle button[data-view="split"]');
await page.waitForTimeout(300);
const newPart = await page.locator('.cat-new');
await newPart.click();
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/shot-studio.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// manufacturing export dialog — advance to a cabinet sheet so the shot shows
// the geometric drawing renderer (FRONT/SIDE/PLAN + dimensions + drill circles)
await page.click('#btn-manufacture');
await page.waitForTimeout(700);
await page.screenshot({ path: '/tmp/shot-manufacture-cover.png' });
for (let i = 0; i < 5; i++) {
  await page.click('.mfg-next');
  await page.waitForTimeout(120);
}
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/shot-manufacture.png' });

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
