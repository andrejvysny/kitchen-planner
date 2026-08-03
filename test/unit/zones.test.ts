import { describe, expect, it } from 'vitest';
import type { Zone, ZoneFill } from '../../src/model/types';
import {
  cabinetTreeFromCounts,
  countLeaves,
  MAX_DEPTH,
  MAX_LEAVES,
  MIN_FRAC,
  mergeZone,
  normalizeZones,
  sanitizeZone,
  setDivider,
  splitZone,
  walkSplits,
  walkZones,
  zoneAtPath,
  zoneAtPoint,
} from '../../src/model/zones';

const leaf = (fill: ZoneFill = 'door'): Zone => ({
  kind: 'leaf',
  fill,
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
      children: [
        leaf(),
        { kind: 'split', dir: 'h', weights: [1, 3], children: [leaf('drawers'), leaf('open')] },
      ],
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
    const depth = (z: Zone): number =>
      z.kind === 'leaf' ? 0 : 1 + Math.max(...z.children.map(depth));
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
      children: [{ kind: 'split', dir: 'h', weights: [1, 1], children: [leaf(), leaf()] }, leaf()],
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
    expect(sanitizeZone({ kind: 'leaf', fill: 'nonsense' })).toEqual({
      kind: 'leaf',
      fill: 'door',
    });
    expect(sanitizeZone({ kind: 'split', dir: 'h', weights: [], children: [] })).toEqual({
      kind: 'leaf',
      fill: 'door',
    });
    let bomb: unknown = { kind: 'leaf', fill: 'door' };
    for (let i = 0; i < 40; i++) {
      bomb = { kind: 'split', dir: i % 2 ? 'h' : 'v', weights: [1], children: [bomb] };
    }
    expect(sanitizeZone(bomb)).toEqual({ kind: 'leaf', fill: 'door' });
    const nan = sanitizeZone({
      kind: 'split',
      dir: 'h',
      weights: [NaN, 1],
      children: [leaf(), leaf()],
    });
    if (nan.kind === 'split') {
      expect(nan.weights.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
    }
  });
});

describe('cabinetTreeFromCounts', () => {
  it('builds the classic drawers/doors/open stack bottom→top', () => {
    const tree = cabinetTreeFromCounts({ drawers: 2, doors: 2, shelves: 1 });
    if (tree.kind !== 'split') throw new Error('expected split');
    expect(tree.dir).toBe('h');
    expect(tree.children.map((c) => (c.kind === 'leaf' ? c.fill : 'split'))).toEqual([
      'drawers',
      'doorPair',
      'open',
    ]);
    const drawers = tree.children[0];
    if (drawers.kind === 'leaf') expect(drawers.drawers).toBe(2);
  });

  it('single section collapses to a bare leaf; empty counts fall back to a door', () => {
    const only = cabinetTreeFromCounts({ drawers: 3, doors: 0, shelves: 0 });
    expect(only).toEqual({ kind: 'leaf', fill: 'drawers', drawers: 3 });
    expect(cabinetTreeFromCounts({ drawers: 0, doors: 0, shelves: 0 })).toEqual({
      kind: 'leaf',
      fill: 'door',
    });
    const single = cabinetTreeFromCounts({ drawers: 0, doors: 1, shelves: 0 });
    expect(single).toEqual({ kind: 'leaf', fill: 'door' });
  });

  it('normalizes cleanly — weights positive, tree valid for walkZones', () => {
    const tree = normalizeZones(cabinetTreeFromCounts({ drawers: 4, doors: 1, shelves: 3 }));
    const rects = walkZones(tree, 0.6, 0.9);
    expect(rects.length).toBe(countLeaves(tree));
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(0.6 * 0.9);
  });
});

describe('interior + hinge round-trip', () => {
  it('normalizeZones carries interior and hinge through the leaf rebuild', () => {
    const tree: Zone = {
      kind: 'split',
      dir: 'h',
      weights: [1, 1],
      children: [
        {
          kind: 'leaf',
          fill: 'door',
          hinge: 'right',
          interior: { mode: 'auto', shelves: 2, innerDrawers: 1 },
        },
        {
          kind: 'leaf',
          fill: 'open',
          interior: { mode: 'custom', elements: [{ kind: 'shelf', y: 0.3 }] },
        },
      ],
    };
    const out = normalizeZones(tree);
    if (out.kind !== 'split') throw new Error('expected split');
    const [door, open] = out.children;
    if (door.kind !== 'leaf' || open.kind !== 'leaf') throw new Error('expected leaves');
    expect(door.hinge).toBe('right');
    expect(door.interior).toEqual({ mode: 'auto', shelves: 2, innerDrawers: 1 });
    expect(open.interior).toEqual({ mode: 'custom', elements: [{ kind: 'shelf', y: 0.3 }] });
  });

  it('sanitizeZone shims the legacy open-leaf shelf count into an auto interior', () => {
    const legacy = { kind: 'leaf', fill: 'open', shelves: 3 };
    const out = sanitizeZone(legacy);
    if (out.kind !== 'leaf') throw new Error('expected leaf');
    expect(out.interior).toEqual({ mode: 'auto', shelves: 3, innerDrawers: 0 });
    expect((out as { shelves?: number }).shelves).toBeUndefined();
  });

  it('hinge only survives on door leaves; junk hinge is dropped', () => {
    const pair = sanitizeZone({ kind: 'leaf', fill: 'doorPair', hinge: 'left' });
    if (pair.kind !== 'leaf') throw new Error('expected leaf');
    expect(pair.hinge).toBeUndefined();
    const junk = sanitizeZone({ kind: 'leaf', fill: 'door', hinge: 'sideways' });
    if (junk.kind !== 'leaf') throw new Error('expected leaf');
    expect(junk.hinge).toBeUndefined();
  });
});

describe('walkSplits', () => {
  it('yields one boundary per divider with correct segments', () => {
    const tree: Zone = {
      kind: 'split',
      dir: 'v',
      weights: [1, 1, 2],
      children: [
        leaf(),
        leaf(),
        { kind: 'split', dir: 'h', weights: [1, 1], children: [leaf(), leaf()] },
      ],
    };
    const bs = walkSplits(tree, 1.0, 0.8);
    // 3 v-children → 2 vertical boundaries; nested h-split → 1 horizontal
    expect(bs).toHaveLength(3);
    const [v0, v1, h0] = bs;
    expect(v0.dir).toBe('v');
    expect(v0.x).toBeCloseTo(0.25);
    expect(v0.len).toBeCloseTo(0.8);
    expect(v1.x).toBeCloseTo(0.5);
    expect(h0.dir).toBe('h');
    expect(h0.y).toBeCloseTo(0.4);
    expect(h0.x).toBeCloseTo(0.5);
    expect(h0.len).toBeCloseTo(0.5);
  });
});
