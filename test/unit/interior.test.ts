import { describe, expect, it } from 'vitest';
import {
  defaultInterior,
  drawerBoxDims,
  MIN_ELEM_SPACE,
  resolveInterior,
  sanitizeInterior,
  SLIDE_CLEAR,
} from '../../src/model/interior';
import type { Interior } from '../../src/model/types';

describe('resolveInterior', () => {
  it('auto: shelves spread evenly over the cavity', () => {
    const els = resolveInterior({ mode: 'auto', shelves: 2, innerDrawers: 0 }, 0.8);
    expect(els).toHaveLength(2);
    expect(els.every((e) => e.kind === 'shelf')).toBe(true);
    const gap = els[1].y - els[0].y;
    expect(gap).toBeGreaterThan(0.2);
    expect(els[0].y).toBeGreaterThan(0.1);
    expect(els[1].y).toBeLessThan(0.7);
  });

  it('auto: inner drawers stack from the bottom, shelves fill the remainder', () => {
    const els = resolveInterior({ mode: 'auto', shelves: 1, innerDrawers: 2 }, 0.8);
    const boxes = els.filter((e) => e.kind === 'drawerBox');
    const shelves = els.filter((e) => e.kind === 'shelf');
    expect(boxes).toHaveLength(2);
    expect(shelves).toHaveLength(1);
    expect(boxes[0].y).toBeLessThan(boxes[1].y);
    expect(shelves[0].y).toBeGreaterThan(boxes[1].y);
  });

  it('custom: clamps into the cavity, sorts, drops overlaps deterministically', () => {
    const interior: Interior = {
      mode: 'custom',
      elements: [
        { kind: 'shelf', y: 0.5 },
        { kind: 'shelf', y: 0.51 }, // overlaps the previous — dropped
        { kind: 'shelf', y: -3 }, // clamps to the bottom margin
        { kind: 'drawerBox', y: 0.2, h: 0.15 },
      ],
    };
    const els = resolveInterior(interior, 0.8);
    expect(els.map((e) => e.kind)).toEqual(['shelf', 'drawerBox', 'shelf']);
    expect(els[0].y).toBeCloseTo(MIN_ELEM_SPACE);
    expect(els[2].y).toBeCloseTo(0.5);
  });

  it('custom: keeps hanging rails as rails (no drawerBox coercion)', () => {
    const interior: Interior = {
      mode: 'custom',
      elements: [
        { kind: 'rail', y: 1.6 },
        { kind: 'shelf', y: 1.68 },
      ],
    };
    const els = resolveInterior(interior, 2.0);
    expect(els.map((e) => e.kind)).toEqual(['rail', 'shelf']);
    expect(els[0]).toEqual({ kind: 'rail', y: 1.6 });
  });

  it('custom: a rail too close to a shelf falls to the same overlap rule', () => {
    const tight = resolveInterior(
      {
        mode: 'custom',
        elements: [
          { kind: 'rail', y: 1.6 },
          { kind: 'shelf', y: 1.62 },
        ],
      },
      2.0
    );
    // 2 cm apart — the lowest wins, exactly like shelf/shelf
    expect(tight).toEqual([{ kind: 'rail', y: 1.6 }]);
    const loose = resolveInterior(
      {
        mode: 'custom',
        elements: [
          { kind: 'rail', y: 1.6 },
          { kind: 'shelf', y: 1.68 },
        ],
      },
      2.0
    );
    expect(loose).toHaveLength(2);
  });

  it('degenerate cavities resolve to nothing (inverted clamp range)', () => {
    expect(resolveInterior({ mode: 'auto', shelves: 3, innerDrawers: 0 }, 0.08)).toEqual([]);
    expect(
      resolveInterior({ mode: 'custom', elements: [{ kind: 'shelf', y: 0.05 }] }, 0.1)
    ).toEqual([]);
    expect(resolveInterior(undefined, 1)).toEqual([]);
  });
});

describe('drawerBoxDims', () => {
  it('box width leaves slide clearance on both sides of the cavity', () => {
    const dims = drawerBoxDims(0.5, 0.15, 0.5)!;
    expect(dims.boxW).toBeCloseTo(0.5 - SLIDE_CLEAR * 2);
    expect(dims.boxD).toBeCloseTo(0.48);
    expect(dims.travel).toBeCloseTo(0.45);
  });

  it('returns null when the cavity cannot hold a functional box', () => {
    expect(drawerBoxDims(0.1, 0.15, 0.5)).toBeNull(); // too narrow
    expect(drawerBoxDims(0.5, 0.03, 0.5)).toBeNull(); // too shallow a front
    expect(drawerBoxDims(0.5, 0.15, 0.1)).toBeNull(); // no depth
  });
});

describe('defaultInterior / sanitizeInterior', () => {
  it('closed and open fills default to one auto shelf; drawers/panel to none', () => {
    for (const fill of ['door', 'doorPair', 'glass', 'open'] as const) {
      expect(defaultInterior(fill)).toEqual({ mode: 'auto', shelves: 1, innerDrawers: 0 });
    }
    expect(defaultInterior('drawers')).toBeUndefined();
    expect(defaultInterior('panel')).toBeUndefined();
  });

  it('repairs parsed interiors and rejects junk', () => {
    expect(sanitizeInterior({ mode: 'auto', shelves: 99, innerDrawers: -2 })).toEqual({
      mode: 'auto',
      shelves: 6,
      innerDrawers: 0,
    });
    expect(
      sanitizeInterior({
        mode: 'custom',
        elements: [
          { kind: 'shelf', y: 0.3 },
          { kind: 'drawerBox', y: 0.1, h: 9 },
          { kind: 'shelf', y: 'x' },
          'junk',
        ],
      })
    ).toEqual({
      mode: 'custom',
      elements: [
        { kind: 'shelf', y: 0.3 },
        { kind: 'drawerBox', y: 0.1, h: 0.4 },
      ],
    });
    // rails must survive a save/load round-trip — a missing branch here would
    // silently drop every wardrobe rail on reload or on "Customize in Workshop…"
    expect(
      sanitizeInterior({
        mode: 'custom',
        elements: [
          { kind: 'rail', y: 1.6 },
          { kind: 'rail', y: 'x' },
        ],
      })
    ).toEqual({ mode: 'custom', elements: [{ kind: 'rail', y: 1.6 }] });
    expect(sanitizeInterior('x')).toBeUndefined();
    expect(sanitizeInterior({ mode: 'weird' })).toBeUndefined();
  });
});
