import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * MOUNT LIFECYCLE — the gate the React migration needs before any view can be
 * rendered by a component.
 *
 * Plan2D, ElevationView and View3D each expose attach(canvas)/detach()/dispose().
 * A StrictMode double-mount calls attach → detach → attach on the SAME canvas,
 * so the contract asserted here is:
 *  - detach() leaves no store subscription behind (`store.handlerCount`, the
 *    test seam on Store) and no frame loop running,
 *  - attach() restores exactly the baseline — never one handler more,
 *  - attach() on the canvas the view already holds is a no-op,
 *  - none of it throws: the `app` fixture fails the test on any uncaught
 *    pageerror, which is what covers "mutate the store while a view is
 *    detached".
 *
 * Everything polls or steps rAF explicitly; no sleeps. The notify used to wake
 * the views is `setScene`, deliberately NON-structural: it reaches every
 * subscriber without paying for a 3D rebuild on the software GL these specs run
 * on. Only the View3D test, whose subject IS the rebuild, adds items.
 */

/** Baseline subscription counts, taken before any detach. */
async function counts(page: Page): Promise<{ change: number; selection: number }> {
  return page.evaluate(() => ({
    change: window.__kp.store.handlerCount('change'),
    selection: window.__kp.store.handlerCount('selection'),
  }));
}

/** A cheap public mutation: patch global lighting, notify every subscriber. */
async function nudge(page: Page, brightness: number): Promise<void> {
  await page.evaluate((b) => window.__kp.store.setScene({ brightness: b }), brightness);
}

/** Let two animation frames pass, so any queued draw has certainly run. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

test('Plan2D detach stops drawing and unsubscribes; attach restores both', async ({ app }) => {
  const base = await counts(app);

  await app.evaluate(() => window.__kp.plan.detach());
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });

  // a change a detached view must neither hear nor draw
  await nudge(app, 1.1);
  await twoFrames(app);
  const idle = await app.evaluate(() => window.__kp.plan.debug().drawCount);
  await twoFrames(app);
  expect(
    await app.evaluate(() => window.__kp.plan.debug().drawCount),
    'a detached plan kept drawing'
  ).toBe(idle);

  await app.evaluate(() =>
    window.__kp.plan.attach(document.getElementById('canvas2d') as HTMLCanvasElement)
  );
  expect(await counts(app), 'attach leaked or dropped a subscription').toEqual(base);

  // draws resume: settle the frame attach() itself queues, then notify again
  await twoFrames(app);
  const resumed = await app.evaluate(() => window.__kp.plan.debug().drawCount);
  await nudge(app, 1.2);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.debug().drawCount), {
      message: 'a re-attached plan never drew again',
    })
    .toBeGreaterThan(resumed);

  // re-attaching the canvas it already holds is a no-op
  await app.evaluate(() =>
    window.__kp.plan.attach(document.getElementById('canvas2d') as HTMLCanvasElement)
  );
  expect(await counts(app), 'a repeated attach double-subscribed').toEqual(base);

  // dispose() detaches for good; calling it twice must still be harmless
  await app.evaluate(() => {
    window.__kp.plan.dispose();
    window.__kp.plan.dispose();
  });
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });
});

test('ElevationView detach unsubscribes; attach restores the baseline', async ({ app }) => {
  const base = await counts(app);

  await app.evaluate(() => window.__kp.elev.detach());
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });

  // no listener, no observer, no frame — and no throw on a store change either
  await nudge(app, 1.1);
  await twoFrames(app);

  await app.evaluate(() =>
    window.__kp.elev.attach(document.getElementById('canvas-elev') as HTMLCanvasElement)
  );
  expect(await counts(app), 'attach leaked or dropped a subscription').toEqual(base);

  await app.evaluate(() =>
    window.__kp.elev.attach(document.getElementById('canvas-elev') as HTMLCanvasElement)
  );
  expect(await counts(app), 'a repeated attach double-subscribed').toEqual(base);

  // still live: the re-attached view resolves the active room's wall again
  await app.evaluate(() => window.__kp.elev.setActive(true));
  expect(await app.evaluate(() => window.__kp.elev.data() !== null)).toBe(true);

  // dispose() detaches for good; calling it twice must still be harmless
  await app.evaluate(() => {
    window.__kp.elev.dispose();
    window.__kp.elev.dispose();
  });
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });
});

/**
 * The Workshop pane COVERS the canvases, it does not replace them (WS-SPEC WP
 * 1.6). If it ever unmounted #canvas2d/#canvas3d instead, every view would go
 * through a detach/attach round trip and the WebGL context would be rebuilt —
 * so the assertion is that nothing moved at all: same subscriptions, same
 * curtain, same renderer, on the way in AND on the way out.
 */
test('a Workshop round trip leaves the canvases and their subscriptions untouched', async ({
  app,
}) => {
  const base = await counts(app);

  await app.click('#ws-tab-workshop');
  await expect(app.locator('#pane-workshop .studio')).toBeVisible();
  expect(await counts(app), 'entering the Workshop moved a subscription').toEqual(base);
  expect(
    await app.evaluate(() => document.querySelectorAll('#canvas2d, #canvas3d').length),
    'the Workshop pane unmounted a canvas'
  ).toBe(2);
  expect(
    await app.evaluate(() => document.querySelectorAll('.gl-lost').length),
    'the 3D view was re-attached, not covered'
  ).toBe(1);

  await app.click('#wsp-back');
  await expect(app.locator('#pane-workshop')).toHaveCount(0);
  expect(await counts(app), 'leaving the Workshop moved a subscription').toEqual(base);

  // both views are live again: the 3D renderer still owns its context, and the
  // plan still redraws on a store change
  expect(await app.evaluate(() => window.__kp.view.snapshotPNG().slice(0, 15))).toBe(
    'data:image/png;'
  );
  await twoFrames(app);
  const resumed = await app.evaluate(() => window.__kp.plan.debug().drawCount);
  await nudge(app, 1.15);
  await expect
    .poll(() => app.evaluate(() => window.__kp.plan.debug().drawCount), {
      message: 'the plan stopped drawing after a Workshop visit',
    })
    .toBeGreaterThan(resumed);
});

test('View3D survives a detach/attach cycle with the same canvas', async ({ app }) => {
  const base = await counts(app);

  await app.evaluate(() => window.__kp.view.detach());
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });

  // an item added while detached is heard by nobody: the scene comes back stale
  // and must catch up on the next flush
  await app.evaluate(() => {
    const st = window.__kp.store;
    st.addItem(st.defOf('base-cabinet'), 2.0, 1.0, 0);
    st.commit();
  });
  await twoFrames(app);

  await app.evaluate(() =>
    window.__kp.view.attach(document.getElementById('canvas3d') as HTMLCanvasElement)
  );
  expect(await counts(app), 'attach leaked or dropped a subscription').toEqual(base);

  const scene = await app.evaluate(() => {
    window.__kp.view.flushRebuild();
    return { built: window.__kp.view.items.size, items: window.__kp.store.design.items.length };
  });
  expect(scene.items, 'nothing was placed to rebuild').toBeGreaterThan(0);
  expect(scene.built, 'the re-attached scene did not catch up with the design').toBe(scene.items);

  // second attach with the SAME canvas: no-op, renderer and subscriptions kept
  await app.evaluate(() =>
    window.__kp.view.attach(document.getElementById('canvas3d') as HTMLCanvasElement)
  );
  expect(await counts(app), 'a repeated attach double-subscribed').toEqual(base);

  // the renderer was never rebuilt on this canvas: it still renders, and the
  // context-loss curtain bindCanvas() appends exists exactly once
  expect(await app.evaluate(() => window.__kp.view.snapshotPNG().slice(0, 15))).toBe(
    'data:image/png;'
  );
  expect(
    await app.evaluate(() => document.querySelectorAll('.gl-lost').length),
    'attach rebuilt the GL side on a canvas it already held'
  ).toBe(1);

  // the store link is live again: a further item reaches the scene
  const added = await app.evaluate(() => {
    const st = window.__kp.store;
    const item = st.addItem(st.defOf('wall-cabinet'), 1.0, 0.4, 0);
    st.commit();
    return item.id;
  });
  await expect
    .poll(() => app.evaluate((id) => window.__kp.view.items.has(id), added), {
      message: 'a re-attached 3D view stopped tracking the store',
    })
    .toBe(true);

  // dispose() = detach + GPU teardown, and takes the curtain with it
  await app.evaluate(() => {
    window.__kp.view.dispose();
    window.__kp.view.dispose();
  });
  expect(await counts(app)).toEqual({ change: base.change - 1, selection: base.selection - 1 });
  expect(await app.evaluate(() => document.querySelectorAll('.gl-lost').length)).toBe(0);
});
