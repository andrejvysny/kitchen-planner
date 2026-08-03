import { describe, expect, it } from 'vitest';
import {
  initialUnderlay,
  sanitizeUnderlay,
  underlayHits,
  underlayPixel,
  underlayScaleFrom,
  UNDERLAY_START_WIDTH,
} from '../../src/model/underlay';
import type { Underlay } from '../../src/model/types';

const U = (patch: Partial<Underlay> = {}): Underlay => ({
  x: 1,
  y: 2,
  scale: 0.005,
  rotation: 0,
  opacity: 0.5,
  visible: true,
  locked: false,
  ...patch,
});

describe('sanitizeUnderlay', () => {
  it('keeps a well-formed transform verbatim', () => {
    const u = U({ rotation: 0.3, opacity: 0.25, locked: true });
    expect(sanitizeUnderlay({ ...u })).toEqual(u);
  });

  it('drops the field when any placement number is unusable', () => {
    expect(sanitizeUnderlay(undefined)).toBeUndefined();
    expect(sanitizeUnderlay('x')).toBeUndefined();
    expect(sanitizeUnderlay({})).toBeUndefined();
    expect(sanitizeUnderlay(U({ scale: NaN }))).toBeUndefined();
    expect(sanitizeUnderlay(U({ scale: 0 }))).toBeUndefined();
    expect(sanitizeUnderlay(U({ scale: -0.01 }))).toBeUndefined();
    expect(sanitizeUnderlay(U({ x: Infinity }))).toBeUndefined();
    expect(sanitizeUnderlay(U({ rotation: NaN }))).toBeUndefined();
    expect(sanitizeUnderlay({ ...U(), y: '3' })).toBeUndefined();
  });

  it('clamps opacity instead of dropping, and defaults a missing one', () => {
    expect(sanitizeUnderlay(U({ opacity: -1 }))!.opacity).toBe(0);
    expect(sanitizeUnderlay(U({ opacity: 4 }))!.opacity).toBe(1);
    const noOp = { ...U() } as Record<string, unknown>;
    delete noOp.opacity;
    expect(sanitizeUnderlay(noOp)!.opacity).toBe(0.5);
  });

  it('accepts only literal booleans for the flags', () => {
    const raw = { ...U(), visible: 'yes', locked: 'yes' };
    expect(sanitizeUnderlay(raw)).toMatchObject({ visible: true, locked: false });
    expect(sanitizeUnderlay({ ...U(), visible: false })!.visible).toBe(false);
  });
});

describe('initialUnderlay', () => {
  it('lays the photo out ~8 m wide, centred on the given point', () => {
    const u = initialUnderlay(1600, 800, { x: 2, y: 3 });
    expect(1600 * u.scale).toBeCloseTo(UNDERLAY_START_WIDTH);
    // x/y name the TOP-LEFT, so the centre is half a span further on
    expect(u.x + (1600 * u.scale) / 2).toBeCloseTo(2);
    expect(u.y + (800 * u.scale) / 2).toBeCloseTo(3);
    expect(u.visible).toBe(true);
    expect(u.locked).toBe(false);
  });
});

describe('underlayScaleFrom', () => {
  it('rescales so the clicked span measures the entered length', () => {
    // 2 m apart on screen at 0.005 m/px => 400 image px apart; those 400 px
    // are really 3 m => 0.0075 m/px
    expect(underlayScaleFrom(2, 0.005, 3)).toBeCloseTo(0.0075);
    // idempotent when the span already measures what it should
    expect(underlayScaleFrom(2, 0.005, 2)).toBeCloseTo(0.005);
  });

  it('is the exact inverse: re-measuring the same span gives the entered length', () => {
    const old = 0.004;
    const dWorld = 1.37;
    const real = 2.5;
    const next = underlayScaleFrom(dWorld, old, real);
    const pixels = dWorld / old; // the span in image pixels never changes
    expect(pixels * next).toBeCloseTo(real);
  });

  it('leaves the scale alone for degenerate input', () => {
    expect(underlayScaleFrom(0, 0.005, 3)).toBe(0.005);
    expect(underlayScaleFrom(-1, 0.005, 3)).toBe(0.005);
    expect(underlayScaleFrom(2, 0.005, 0)).toBe(0.005);
    expect(underlayScaleFrom(NaN, 0.005, 3)).toBe(0.005);
    expect(underlayScaleFrom(2, 0.005, NaN)).toBe(0.005);
  });
});

describe('underlayPixel / underlayHits', () => {
  it('maps the top-left anchor to pixel 0,0 and back', () => {
    const u = U();
    expect(underlayPixel(u, { x: 1, y: 2 })).toEqual({ x: 0, y: 0 });
    const p = underlayPixel(u, { x: 1 + 0.05, y: 2 + 0.01 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(2);
  });

  it('inverts a rotated placement', () => {
    const u = U({ x: 0, y: 0, rotation: Math.PI / 2, scale: 0.01 });
    // +x in image space rotates onto +y in the world
    const p = underlayPixel(u, { x: 0, y: 1 });
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(0);
  });

  it('hit-tests the image rectangle', () => {
    const u = U({ x: 0, y: 0, scale: 0.01 }); // 100 px = 1 m
    expect(underlayHits(u, 200, 100, { x: 0.5, y: 0.5 })).toBe(true);
    expect(underlayHits(u, 200, 100, { x: 2, y: 1 })).toBe(true); // exact corner
    expect(underlayHits(u, 200, 100, { x: 2.01, y: 0.5 })).toBe(false);
    expect(underlayHits(u, 200, 100, { x: -0.01, y: 0.5 })).toBe(false);
    expect(underlayHits(u, 200, 100, { x: 0.5, y: 1.5 })).toBe(false);
  });
});
