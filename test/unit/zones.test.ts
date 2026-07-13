import { describe, expect, it } from 'vitest';
import type { Zone } from '../../src/model/types';
import {
  countLeaves,
  MAX_DEPTH,
  MAX_LEAVES,
  MIN_FRAC,
  mergeZone,
  normalizeZones,
  sanitizeZone,
  setDivider,
  splitZone,
  walkZones,
  zoneAtPath,
  zoneAtPoint,
} from '../../src/model/zones';

const leaf = (fill: Zone extends { fill: infer F } ? F : never = 'door' as never): Zone => ({
  kind: 'leaf',
  fill: fill as 'door',
});

describe('walkZones', () => {
  it('tiles the face exactly — areas sum, no gaps at seams', () => {
    const tree: Zone = {
      kind: 'split',
      dir: 'h',
      weights: [1, 2, 1],
      children: [
        leaf(),
        { kind: 'split', dir: 'v', weights: [1, 1], children: [leaf(), leaf()] },
        leaf(),
      ],
    };
    const rects = walkZones(tree, 0.8, 2.0);
    expect(rects).toHaveLength(4);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(0.8 * 2.0, 6);
    // the two v-split zones share the middle band
    const band = rects.filter((r) => Math.abs(r.h - 1.0) < 1e-6);
    expect(band).toHaveLength(2);
    expect(band[0].w + band[1].w).toBeCloseTo(0.8, 6);
  });

  it('zoneAtPoint finds nested leaves and zoneAtPath round-trips', () => {
    const tree: Zone = {
      kind: 'split',
      dir: 'v',
      weights: [1, 1],
      children: [leaf(), { kind: 'split', dir: 'h', weights: [1, 3], children: [leaf('drawers'), leaf('open')] }],
    };
    const hit = zoneAtPoint(tree, 1.0, 1.0, 0.75, 0.1);
    expect(hit).not.toBeNull();
    expect(hit!.leaf.fill).toBe('drawers');
    expect(zoneAtPath(tree, hit!.path)).toBe(hit!.leaf);
  });
});

describe('splitZone / mergeZone', () => {
  it('split then merge returns to a single leaf', () => {
    let tree: Zone = leaf();
    tree = splitZone(tree, [], 'h', 3);
    expect(countLeaves(tree)).toBe(3);
    tree = mergeZone(tree, [1]);
    expect(tree.kind).toBe('leaf');
  });

  it('same-direction splits become siblings (flat trees)', () => {
    let tree: Zone = splitZone(leaf(), [], 'h', 2);
    tree = splitZone(tree, [0], 'h', 2);
    expect(tree.kind).toBe('split');
    if (tree.kind === 'split') {
      expect(tree.children).toHaveLength(3);
      expect(tree.children.every((c) => c.kind === 'leaf')).toBe(true);
    }
  });

  it('enforces the leaf cap', () => {
    let tree: Zone = splitZone(leaf(), [], 'v', MAX_LEAVES);
    const before = countLeaves(tree);
    tree = splitZone(tree, [0], 'v', 2);
    expect(countLeaves(tree)).toBe(before);
  });

  it('enforces the depth cap', () => {
    let tree: Zone = leaf();
    let path: number[] = [];
    for (let i = 0; i < MAX_DEPTH + 2; i++) {
      tree = splitZone(tree, path, i % 2 ? 'h' : 'v', 2);
      path = [...path, 0];
    }
    const depth = (z: Zone): number => (z.kind === 'leaf' ? 0 : 1 + Math.max(...z.children.map(depth)));
    expect(depth(tree)).toBeLessThanOrEqual(MAX_DEPTH);
  });
});

describe('setDivider', () => {
  it('moves a cut and respects MIN_FRAC', () => {
    const tree = splitZone(leaf(), [], 'h', 2);
    setDivider(tree, [], 0, 0.7);
    if (tree.kind === 'split') {
      const total = tree.weights[0] + tree.weights[1];
      expect(tree.weights[0] / total).toBeCloseTo(0.7, 6);
    }
    setDivider(tree, [], 0, 0.001);
    if (tree.kind === 'split') {
      const total = tree.weights[0] + tree.weights[1];
      expect(tree.weights[0] / total).toBeCloseTo(MIN_FRAC, 6);
    }
  });
});

describe('normalizeZones / sanitizeZone', () => {
  it('flattens same-direction nesting and renormalizes weights', () => {
    const messy: Zone = {
      kind: 'split',
      dir: 'h',
      weights: [2, 2],
      children: [
        { kind: 'split', dir: 'h', weights: [1, 1], children: [leaf(), leaf()] },
        leaf(),
      ],
    };
    const out = normalizeZones(messy);
    expect(out.kind).toBe('split');
    if (out.kind === 'split') {
      expect(out.children).toHaveLength(3);
      expect(out.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
      expect(out.weights[0]).toBeCloseTo(0.25, 6);
    }
  });

  it('clamps drawer/shelf counts on leaves', () => {
    const out = normalizeZones({ kind: 'leaf', fill: 'drawers', drawers: 99 });
    expect(out).toEqual({ kind: 'leaf', fill: 'drawers', drawers: 5 });
  });

  it('sanitizeZone survives junk and depth bombs', () => {
    expect(sanitizeZone(null)).toEqual({ kind: 'leaf', fill: 'door' });
    expect(sanitizeZone({ kind: 'leaf', fill: 'nonsense' })).toEqual({ kind: 'leaf', fill: 'door' });
    expect(sanitizeZone({ kind: 'split', dir: 'h', weights: [], children: [] })).toEqual({
      kind: 'leaf',
      fill: 'door',
    });
    let bomb: unknown = { kind: 'leaf', fill: 'door' };
    for (let i = 0; i < 40; i++) {
      bomb = { kind: 'split', dir: i % 2 ? 'h' : 'v', weights: [1], children: [bomb] };
    }
    expect(sanitizeZone(bomb)).toEqual({ kind: 'leaf', fill: 'door' });
    const nan = sanitizeZone({ kind: 'split', dir: 'h', weights: [NaN, 1], children: [leaf(), leaf()] });
    if (nan.kind === 'split') {
      expect(nan.weights.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
    }
  });
});
