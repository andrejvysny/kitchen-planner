/**
 * The print sheet's scale maths. Only the pure half is testable headless —
 * `planImage` needs a real canvas, so the offscreen render and the composed
 * document are covered by the E2E 'plan sheet' scenario instead.
 */

import { describe, expect, it } from 'vitest';
import {
  CSS_DPI,
  DEFAULT_DPI,
  DEFAULT_SCALE,
  designBounds,
  fitScale,
  PAGE_H_MM,
  PAGE_W_MM,
  planLayout,
  PLAN_MARGIN_M,
  PRINT_OPTS,
  pxPerMeter,
  type Bounds,
} from '../../src/print/sheet';
import { demoDesign, emptyDesign } from '../../src/model/store';

/** A 4 × 3 m room at the origin — the same shell `emptyDesign` builds. */
const ROOM: Bounds = { minX: 0, minY: 0, maxX: 4, maxY: 3 };

describe('print scale', () => {
  it('1:50 at 150 dpi is 118.11 device px per metre', () => {
    expect(pxPerMeter(DEFAULT_SCALE, DEFAULT_DPI)).toBeCloseTo(118.1102, 3);
    // and exactly 1000/scale mm of paper per metre, whatever the density
    expect(pxPerMeter(50, 300)).toBeCloseTo(pxPerMeter(50, 150) * 2, 6);
  });

  it('halving the scale halves the pixels per metre', () => {
    expect(pxPerMeter(100, DEFAULT_DPI)).toBeCloseTo(pxPerMeter(50, DEFAULT_DPI) / 2, 6);
  });
});

describe('planLayout', () => {
  const l = planLayout(ROOM, DEFAULT_SCALE, DEFAULT_DPI);

  it('adds the drawing margin on all four sides', () => {
    // 4 × 3 m + 0.6 m each side → 5.2 × 4.2 m of drawing
    expect(l.wMm).toBeCloseTo(104, 6); // 5.2 m at 1:50
    expect(l.hMm).toBeCloseTo(84, 6); // 4.2 m at 1:50
  });

  it('sizes the canvas at the requested density', () => {
    expect(l.wPx).toBe(Math.round(5.2 * pxPerMeter(DEFAULT_SCALE, DEFAULT_DPI)));
    expect(l.hPx).toBe(Math.round(4.2 * pxPerMeter(DEFAULT_SCALE, DEFAULT_DPI)));
    expect(l.wPx).toBe(614);
    expect(l.hPx).toBe(496);
  });

  it('the CSS viewport times the dpr is the device density', () => {
    expect(l.dpr).toBeCloseTo(DEFAULT_DPI / CSS_DPI, 9);
    expect(l.view.zoom * l.dpr).toBeCloseTo(pxPerMeter(DEFAULT_SCALE, DEFAULT_DPI), 6);
    expect(l.view.cssW * l.dpr).toBeCloseTo(l.wPx, 0);
  });

  it('pans so the margin sits between the page edge and the room', () => {
    // world x = minX must land exactly one margin in from the left edge
    expect(l.view.panX / l.view.zoom).toBeCloseTo(PLAN_MARGIN_M, 9);
    expect(l.view.panY / l.view.zoom).toBeCloseTo(PLAN_MARGIN_M, 9);
  });

  it('keeps the margin when the design is offset from the origin', () => {
    const off = planLayout({ minX: 10, minY: -4, maxX: 14, maxY: -1 }, DEFAULT_SCALE, DEFAULT_DPI);
    expect(off.wPx).toBe(l.wPx);
    expect(off.hPx).toBe(l.hPx);
    // world 10 → the margin, in CSS px
    expect(10 * off.view.zoom + off.view.panX).toBeCloseTo(PLAN_MARGIN_M * off.view.zoom, 6);
  });

  it('widens the margin at small scales so the labels still fit', () => {
    const small = planLayout(ROOM, 200, DEFAULT_DPI);
    const marginM = small.view.panX / small.view.zoom;
    expect(marginM).toBeGreaterThan(PLAN_MARGIN_M);
    // …but never less than 26 CSS px of clear space
    expect(marginM * small.view.zoom).toBeGreaterThanOrEqual(26 - 1e-9);
  });
});

describe('fitScale', () => {
  it('prints a normal room at 1:50', () => {
    expect(fitScale(ROOM)).toBe(50);
    expect(fitScale(designBounds(demoDesign()))).toBe(50);
    expect(fitScale(designBounds(emptyDesign()))).toBe(50);
  });

  it('steps down rather than overflowing the page', () => {
    const wide: Bounds = { minX: 0, minY: 0, maxX: 30, maxY: 12 };
    const scale = fitScale(wide);
    expect(scale).toBeGreaterThan(50);
    const l = planLayout(wide, scale, DEFAULT_DPI);
    expect(l.wMm).toBeLessThanOrEqual(PAGE_W_MM);
    expect(l.hMm).toBeLessThanOrEqual(PAGE_H_MM);
  });

  it('takes the first ladder step that fits, not a safer one', () => {
    // 12 × 8 m + margins = 264 × 184 mm at 1:50 — just inside A4 landscape
    expect(fitScale({ minX: 0, minY: 0, maxX: 12, maxY: 8 })).toBe(50);
  });
});

describe('designBounds', () => {
  it('spans every room, not just the active one', () => {
    const b = designBounds(demoDesign());
    // the demo is a kitchen plus a bedroom hung off its east wall
    expect(b.maxX - b.minX).toBeGreaterThan(6);
    expect(b.maxY - b.minY).toBeGreaterThan(3);
  });

  it('falls back to a stub for a room-less design', () => {
    expect(designBounds({ ...emptyDesign(), rooms: [] })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
    });
  });
});

describe('PRINT_OPTS', () => {
  it('turns every interactive layer off and lights all rooms equally', () => {
    expect(PRINT_OPTS).toEqual({
      // the tracing photo is a reference, never part of the printed drawing
      underlay: false,
      handles: false,
      guides: false,
      ghosts: false,
      measure: false,
      checks: false,
      roomEmphasis: false,
    });
  });
});
