import { expect, test } from './fixtures';

/**
 * LAYOUT GEOMETRY — the before/after gate for the React shell port.
 *
 * test/interact.mjs drives ~60 checks by mouse position, so every pixel of the
 * boot layout is load-bearing: a stray wrapper div or a reordered flex child
 * moves the canvases and silently breaks them. This spec pins the boot
 * geometry of the app frame at the config's 1600x950 viewport, so porting
 * index.html's markup into JSX has to reproduce it node-for-node.
 *
 * The numbers below are measured, not derived — they come from the pre-React
 * markup and must survive the port unchanged.
 */

/** Boot boxes at 1600x950, in CSS px. */
const BOXES: Record<string, { x: number; y: number; width: number; height: number }> = {
  app: { x: 0, y: 0, width: 1600, height: 950 },
  topbar: { x: 0, y: 0, width: 1600, height: 46 },
  workspace: { x: 0, y: 46, width: 1600, height: 879 },
  catalog: { x: 0, y: 46, width: 216, height: 879 },
  canvases: { x: 216, y: 46, width: 1134, height: 879 },
  pane2d: { x: 216, y: 46, width: 566.5, height: 879 },
  pane3d: { x: 783.5, y: 46, width: 566.5, height: 879 },
  canvas2d: { x: 216, y: 46, width: 566.5, height: 879 },
  canvas3d: { x: 783.5, y: 46, width: 566.5, height: 879 },
  props: { x: 1350, y: 46, width: 250, height: 879 },
  statusbar: { x: 0, y: 925, width: 1600, height: 25 },
};

/** ±2px: enough slack for font/scrollbar jitter, far less than any real drift. */
const TOL = 2;

test('boot layout geometry is unchanged', async ({ app }) => {
  for (const [id, want] of Object.entries(BOXES)) {
    const box = await app.locator(`#${id}`).boundingBox();
    expect(box, `#${id} has no box`).not.toBeNull();
    expect(Math.abs(box!.x - want.x), `#${id} x`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(box!.y - want.y), `#${id} y`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(box!.width - want.width), `#${id} width`).toBeLessThanOrEqual(TOL);
    expect(Math.abs(box!.height - want.height), `#${id} height`).toBeLessThanOrEqual(TOL);
  }

  // the elevation canvas shares #pane2d with the plan and is hidden at boot —
  // no box at all, which is what the 2D/elev sub-toggle flips
  expect(await app.locator('#canvas-elev').boundingBox(), '#canvas-elev is visible at boot').toBe(
    null
  );
});

test('the app frame is the only thing under <body>', async ({ app }) => {
  // #app is what src/style.css keys the 100vh flex column on, and the recovery
  // banner prepends into it. React may host it, but nothing else may sit
  // beside it in the flow and push it down.
  const frame = await app.evaluate(() => {
    const el = document.getElementById('app')!;
    return {
      offsetTop: el.getBoundingClientRect().top,
      order: [...el.children].map((c) => c.id),
    };
  });

  expect(frame.offsetTop, '#app is not flush with the viewport top').toBe(0);
  expect(frame.order, "#app's children changed order").toEqual([
    'topbar',
    'workspace',
    'statusbar',
  ]);
});
