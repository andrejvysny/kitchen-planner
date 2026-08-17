import { describe, expect, it } from 'vitest';
import { formatAngle, parseAngle } from '../../src/model/units';
import { wrapAngle } from '../../src/ui/react/fields/convert';
import { mixedValue } from '../../src/ui/react/fields/useMixedValue';

// The pure cores of src/ui/react/fields/ — the shared field set the props
// inspector is built from. Everything else in that directory is a React
// component that reaches for the app singletons and the DOM (e2e territory);
// these two modules are deliberately import-free so the arithmetic and the
// multi-selection rule can be pinned here, in plain node.

describe('mixedValue', () => {
  interface Row {
    w: number;
  }
  const w = (r: Row): number => r.w;

  it('reports nothing for an empty selection, and does not call it mixed', () => {
    expect(mixedValue([], w)).toEqual({ value: null, mixed: false });
  });

  it('passes a single item through', () => {
    expect(mixedValue([{ w: 0.6 }], w)).toEqual({ value: 0.6, mixed: false });
  });

  it('agrees when every item agrees', () => {
    expect(mixedValue([{ w: 0.6 }, { w: 0.6 }, { w: 0.6 }], w)).toEqual({
      value: 0.6,
      mixed: false,
    });
  });

  it('withholds a value as soon as one item differs', () => {
    expect(mixedValue([{ w: 0.6 }, { w: 0.9 }], w)).toEqual({ value: null, mixed: true });
    // the disagreement may be anywhere in the list, not just the second item
    expect(mixedValue([{ w: 0.6 }, { w: 0.6 }, { w: 0.45 }], w)).toEqual({
      value: null,
      mixed: true,
    });
  });

  it('treats two NaN reads as the same non-answer (Object.is, not ===)', () => {
    expect(mixedValue([{ w: NaN }, { w: NaN }], w)).toEqual({ value: NaN, mixed: false });
    expect(mixedValue([{ w: NaN }, { w: 1 }], w)).toEqual({ value: null, mixed: true });
  });

  it('reads through the accessor, so one field can span different shapes', () => {
    const items = [{ w: 0.6 }, { w: 0.6 }];
    expect(mixedValue(items, (r) => r.w * 2)).toEqual({ value: 1.2, mixed: false });
  });
});

describe('wrapAngle (the rotation box shows [0, 360), the model does not)', () => {
  const deg = (rad: number): string => formatAngle(wrapAngle(rad));

  it('leaves a direction already inside one turn alone', () => {
    expect(deg(0)).toBe('0');
    expect(deg(Math.PI / 2)).toBe('90');
    expect(deg(Math.PI)).toBe('180');
  });

  it('folds a full turn back to zero, from either side', () => {
    expect(deg(2 * Math.PI)).toBe('0');
    expect(deg(-2 * Math.PI)).toBe('0');
  });

  it('wraps unbounded model rotations, in both directions', () => {
    expect(deg(-Math.PI / 2)).toBe('270');
    expect(deg(5 * Math.PI)).toBe('180');
    expect(deg(-5 * Math.PI)).toBe('180');
  });

  it('round-trips what the box parses back into it', () => {
    expect(deg(parseAngle('270')!)).toBe('270');
    expect(deg(parseAngle('-90')!)).toBe('270');
    // degrees go through the same expression engine lengths do
    expect(deg(parseAngle('90+45')!)).toBe('135');
  });

  it('never returns a non-finite or out-of-range angle', () => {
    expect(wrapAngle(NaN)).toBe(0);
    expect(wrapAngle(Infinity)).toBe(0);
    for (const rad of [0, -1e-12, 1e-12, -7, 7, 1e6]) {
      const w = wrapAngle(rad);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(2 * Math.PI);
    }
  });
});
