import { describe, expect, it } from 'vitest';
import { coarsePointer, hitRadius, PinchGesture, type Viewport } from '../../src/plan2d/pinch';

describe('coarsePointer / hitRadius', () => {
  it('is false under Vitest (no matchMedia global) so radii pass through unchanged', () => {
    // This module-level flag is read once at import time; Node has no
    // `matchMedia`, so the guarded `typeof` check must resolve to false
    // rather than throwing.
    expect(coarsePointer).toBe(false);
    expect(hitRadius(9)).toBe(9);
    expect(hitRadius(11)).toBe(11);
  });
});

describe('PinchGesture', () => {
  it('starts inactive: a single finger does not trigger the pinch', () => {
    const g = new PinchGesture();
    expect(g.down(1, { x: 0, y: 0 })).toBe(false);
    expect(g.overflowing).toBe(false);
  });

  it('starts the moment a 2nd finger lands', () => {
    const g = new PinchGesture();
    g.down(1, { x: 0, y: 0 });
    expect(g.down(2, { x: 100, y: 0 })).toBe(true);
  });

  it('flags a 3rd+ finger as overflow without restarting the gesture', () => {
    const g = new PinchGesture();
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 100, y: 0 });
    expect(g.down(3, { x: 50, y: 50 })).toBe(false);
    expect(g.overflowing).toBe(true);
  });

  it('tracks a finger only once it has been registered via down()', () => {
    const g = new PinchGesture();
    expect(g.has(1)).toBe(false);
    g.down(1, { x: 0, y: 0 });
    expect(g.has(1)).toBe(true);
    g.track(1, { x: 5, y: 5 }); // no-op assertion: must not throw
    g.up(1);
    expect(g.has(1)).toBe(false);
  });

  it('doubling the finger spread doubles zoom, keeping the pinch midpoint anchored', () => {
    const g = new PinchGesture();
    g.down(1, { x: 100, y: 200 });
    g.down(2, { x: 300, y: 200 }); // dist 200, mid (200,200)
    const v: Viewport = { zoom: 90, panX: 60, panY: 60 };

    // fingers spread to 400px apart (2x), midpoint unchanged at x=200
    g.track(1, { x: 0, y: 200 });
    g.track(2, { x: 400, y: 200 });
    const res = g.step(v, 15, 400)!;
    expect(res.zoom).toBeCloseTo(180, 5); // 90 * (400/200)

    // the world point that sat under the (unchanged) midpoint before the
    // pinch must still land under that same screen point after re-zooming
    const worldAtMid = (200 - v.panX) / v.zoom;
    const screenOfWorldAfter = worldAtMid * res.zoom + res.panX;
    expect(screenOfWorldAfter).toBeCloseTo(200, 5);
  });

  it('clamps zoom to the given bounds', () => {
    const g = new PinchGesture();
    g.down(1, { x: 0, y: 0 });
    g.down(2, { x: 10, y: 0 }); // dist 10
    g.track(1, { x: 0, y: 0 });
    g.track(2, { x: 10000, y: 0 }); // huge spread jump
    const res = g.step({ zoom: 90, panX: 0, panY: 0 }, 15, 400)!;
    expect(res.zoom).toBe(400);
  });

  it('returns null before two fingers are down', () => {
    const g = new PinchGesture();
    g.down(1, { x: 0, y: 0 });
    expect(g.step({ zoom: 90, panX: 0, panY: 0 }, 15, 400)).toBeNull();
  });
});
