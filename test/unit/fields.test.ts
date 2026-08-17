import { describe, expect, it } from 'vitest';
import { fromCm, fromDeg, toCm, toDeg } from '../../src/ui/react/fields/convert';
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

describe('length conversion (metres ↔ the cm box)', () => {
  it('shows whole centimetres, exactly as ui.ts numberRow did', () => {
    expect(toCm(0.6)).toBe(60);
    expect(toCm(2.4)).toBe(240);
    expect(toCm(0)).toBe(0);
    expect(toCm(-0.35)).toBe(-35);
  });

  it('rounds rather than truncates', () => {
    expect(toCm(0.4567)).toBe(46);
    expect(toCm(0.4549)).toBe(45);
    // floating-point metres that are not exact cm still land on an integer
    expect(Number.isInteger(toCm(1 / 3))).toBe(true);
  });

  it('takes typed centimetres back to metres', () => {
    expect(fromCm(60)).toBeCloseTo(0.6, 12);
    expect(fromCm(0)).toBe(0);
    expect(fromCm(-35)).toBeCloseTo(-0.35, 12);
  });

  it('round-trips any value already on a whole centimetre', () => {
    for (const m of [0, 0.02, 0.6, 1.25, 2.4, 12.34]) {
      expect(fromCm(toCm(m))).toBeCloseTo(m, 12);
    }
  });
});

describe('angle conversion (radians ↔ the degree box)', () => {
  it('normalizes to whole degrees in [0, 360)', () => {
    expect(toDeg(0)).toBe(0);
    expect(toDeg(Math.PI / 2)).toBe(90);
    expect(toDeg(Math.PI)).toBe(180);
    expect(toDeg(2 * Math.PI)).toBe(0);
  });

  it('wraps unbounded model rotations, in both directions', () => {
    expect(toDeg(-Math.PI / 2)).toBe(270);
    expect(toDeg(-2 * Math.PI)).toBe(0);
    expect(toDeg(5 * Math.PI)).toBe(180);
    expect(toDeg(-5 * Math.PI)).toBe(180);
  });

  it('takes typed degrees back to radians', () => {
    expect(fromDeg(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(fromDeg(0)).toBe(0);
    expect(fromDeg(-90)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('round-trips through the wrap: 270° in is 270° out', () => {
    expect(toDeg(fromDeg(270))).toBe(270);
    expect(toDeg(fromDeg(-90))).toBe(270);
  });
});
