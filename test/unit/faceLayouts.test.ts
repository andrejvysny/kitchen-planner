import { describe, expect, it } from 'vitest';
import { FACE_LAYOUTS } from '../../src/model/faceLayouts';
import {
  MAX_DEPTH,
  MAX_LEAVES,
  MIN_FRAC,
  countLeaves,
  normalizeZones,
} from '../../src/model/zones';
import type { Zone } from '../../src/model/types';

function depth(z: Zone): number {
  return z.kind === 'leaf' ? 0 : 1 + Math.max(...z.children.map(depth));
}

function minFrac(z: Zone): number {
  return z.kind === 'leaf' ? Infinity : Math.min(...z.weights);
}

describe('FACE_LAYOUTS', () => {
  it('has 8 canned layouts with unique ids', () => {
    expect(FACE_LAYOUTS).toHaveLength(8);
    expect(new Set(FACE_LAYOUTS.map((l) => l.id)).size).toBe(8);
  });

  for (const layout of FACE_LAYOUTS) {
    describe(layout.id, () => {
      it('is unchanged by normalizeZones (already in canonical form)', () => {
        const tree = layout.face();
        expect(normalizeZones(tree)).toEqual(tree);
      });

      it('holds the leaf/depth/weight caps', () => {
        const tree = layout.face();
        expect(countLeaves(tree)).toBeLessThanOrEqual(MAX_LEAVES);
        expect(depth(tree)).toBeLessThanOrEqual(MAX_DEPTH);
        expect(minFrac(tree)).toBeGreaterThanOrEqual(MIN_FRAC);
      });

      it('builds a fresh tree object on every call', () => {
        const a = layout.face();
        const b = layout.face();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
        if (a.kind === 'split' && b.kind === 'split') {
          expect(a.children).not.toBe(b.children);
          expect(a.weights).not.toBe(b.weights);
        }
        // mutating one call's result must never leak into the next call's
        if (a.kind === 'leaf') a.fill = 'panel';
        else a.weights[0] = 0.999;
        expect(layout.face()).toEqual(b);
      });
    });
  }
});
