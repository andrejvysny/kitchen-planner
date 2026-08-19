import { describe, expect, it } from 'vitest';
import { dist, lineIntersection } from '../../src/model/geometry';
import {
  contextMaterial,
  DEFAULT_SNAP_CONFIG,
  resolveSnap,
  type SnapConfig,
  type SnapContext,
  type SnapKind,
  type SnapSegment,
} from '../../src/model/snap';
import type { Point } from '../../src/model/types';

/**
 * The snap engine, entirely headless. Everything here is the pure half of what
 * the plan gestures do — the point of the module is that the wall tool, the
 * measure tool, the drag rectangle and the corner drag can all be reasoned
 * about here rather than through a canvas.
 */

/** A 4×3 rectangle of centreline segments, corners at (0,0) and (4,3). */
const RECT: SnapSegment[] = [
  { a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, wallId: 'w0' },
  { a: { x: 4, y: 0 }, b: { x: 4, y: 3 }, wallId: 'w1' },
  { a: { x: 4, y: 3 }, b: { x: 0, y: 3 }, wallId: 'w2' },
  { a: { x: 0, y: 3 }, b: { x: 0, y: 0 }, wallId: 'w3' },
];

function ctx(over: Partial<SnapContext> = {}, segments = RECT): SnapContext {
  return { ...contextMaterial(segments), chain: [], anchor: null, ...over };
}

/** zoom 100 px/m ⇒ point reach 0.12 m, line reach 0.08 m (both under the clamp). */
function cfg(over: Partial<SnapConfig> = {}): SnapConfig {
  return { ...DEFAULT_SNAP_CONFIG, zoom: 100, ...over };
}

/** Only these kinds may fire — keeps a case about the thing it is about. */
const only = (...k: SnapKind[]): ReadonlySet<SnapKind> => new Set(k);

/** `digits` is toBeCloseTo's decimal places — 9 means sub-nanometre, i.e. exact. */
const near = (a: Point, b: Point, digits = 9): void => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};

describe('point candidates', () => {
  it('a segment endpoint within reach wins, and lands exactly on it', () => {
    const r = resolveSnap({ x: 4.03, y: 0.02 }, ctx(), cfg());
    expect(r.kind).toBe('endpoint');
    near(r.p, { x: 4, y: 0 });
  });

  it('a segment midpoint fires, and is beaten by an endpoint at equal distance', () => {
    const mid = resolveSnap({ x: 2, y: 0.02 }, ctx(), cfg({ enabled: only('midpoint') }));
    expect(mid.kind).toBe('midpoint');
    near(mid.p, { x: 2, y: 0 });

    // (0.02, 0.02) is equidistant from the corner (0,0) and irrelevant to any
    // midpoint; put both in reach and the heavier weight has to win
    const both = resolveSnap(
      { x: 0.02, y: 0.02 },
      ctx(),
      cfg({ enabled: only('endpoint', 'midpoint') })
    );
    expect(both.kind).toBe('endpoint');
  });

  it('two centrelines crossing produce their exact intersection', () => {
    // an L of two segments that stop short of each other: the corner they WOULD
    // make is the useful point, and neither one's endpoint is near it
    const l: SnapSegment[] = [
      { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
      { a: { x: 5, y: 1 }, b: { x: 5, y: 4 } },
    ];
    const r = resolveSnap({ x: 5.02, y: 0.02 }, ctx({}, l), cfg({ enabled: only('intersection') }));
    expect(r.kind).toBe('intersection');
    near(r.p, { x: 5, y: 0 });
    expect(r.guides).toHaveLength(2);
  });

  it('a chain vertex three back is a valid target — not just the previous one', () => {
    // chain[0] is the CLOSE target and has its own kind, so the plain-endpoint
    // case is asserted on an interior vertex
    const chain = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 5 },
      { x: 9, y: 5 },
    ];
    const c = ctx({ chain, anchor: chain[4] }, []);
    const r = resolveSnap({ x: 1.02, y: 1.02 }, c, cfg({ enabled: only('endpoint') }));
    expect(r.kind).toBe('endpoint');
    near(r.p, { x: 1, y: 1 });
  });

  it('the ring start is a CLOSE target, and it outranks a wall corner on top of it', () => {
    const chain = [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
      { x: 6, y: 5 },
    ];
    // an existing wall ends on the very same point — the tie that used to stop
    // a room drawn against a neighbour from ever closing
    const c = ctx({ chain, anchor: chain[2] }, [{ a: { x: 1, y: 1 }, b: { x: 1, y: -3 } }]);
    const r = resolveSnap({ x: 1.02, y: 1.02 }, c, cfg());
    expect(r.kind).toBe('close');
    near(r.p, { x: 1, y: 1 });
  });

  it('a chain under 3 points has no close target — there is no loop yet', () => {
    const chain = [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
    ];
    const c = ctx({ chain, anchor: chain[1] }, []);
    const r = resolveSnap({ x: 1.02, y: 1.02 }, c, cfg());
    expect(r.kind).toBe('endpoint');
  });

  it('a mitred junction outranks the segment ends flanking it', () => {
    // the two ends sit half a thickness off along either axis; the junction is
    // where the centrelines actually meet, and is the only correct target
    const c = ctx(
      { junctions: [{ x: 4.05, y: -0.05 }] },
      [
        { a: { x: 4.05, y: 0 }, b: { x: 4.05, y: 3 } },
        { a: { x: 0, y: -0.05 }, b: { x: 4, y: -0.05 } },
      ]
    );
    const r = resolveSnap({ x: 4.04, y: -0.04 }, c, cfg());
    expect(r.kind).toBe('junction');
    near(r.p, { x: 4.05, y: -0.05 });
  });

  it('the anchor itself is never a target — that would be a zero-length wall', () => {
    const chain = [
      { x: 1, y: 1 },
      { x: 6, y: 1 },
    ];
    const c = ctx({ chain, anchor: chain[1] }, []);
    const r = resolveSnap({ x: 6.01, y: 1.01 }, c, cfg({ enabled: only('endpoint') }));
    expect(r.kind).not.toBe('endpoint');
  });
});

describe('line candidates', () => {
  it('aligns horizontally with a reference point far off screen', () => {
    const r = resolveSnap({ x: 40, y: 0.02 }, ctx(), cfg({ enabled: only('align') }));
    expect(r.kind).toBe('align');
    expect(r.p.y).toBeCloseTo(0, 9);
    expect(r.p.x).toBeCloseTo(40, 9); // the OTHER axis is untouched
    expect(r.guides).toHaveLength(1);
  });

  it('lying on a wall reads as onSegment, past its end as extension', () => {
    const on = resolveSnap(
      { x: 2, y: 0.02 },
      ctx(),
      cfg({ enabled: only('onSegment', 'extension') })
    );
    expect(on.kind).toBe('onSegment');
    const past = resolveSnap(
      { x: 6, y: 0.02 },
      ctx(),
      cfg({ enabled: only('onSegment', 'extension') })
    );
    expect(past.kind).toBe('extension');
    expect(past.p.y).toBeCloseTo(0, 9);
  });

  it('holds the pending segment square to the previous one, whatever its heading', () => {
    // a 30° wall — no multiple of 15° absolute would give a square corner here
    const a = { x: 0, y: 0 };
    const b = { x: Math.cos(Math.PI / 6) * 2, y: Math.sin(Math.PI / 6) * 2 };
    const c = ctx({ chain: [a, b], anchor: b }, []);
    // aim roughly perpendicular to a→b, i.e. 30° + 90° = 120°
    const aim = {
      x: b.x + Math.cos((2 * Math.PI) / 3) * 2,
      y: b.y + Math.sin((2 * Math.PI) / 3) * 2,
    };
    const r = resolveSnap(
      { x: aim.x + 0.02, y: aim.y },
      c,
      cfg({ enabled: only('perpendicular', 'parallel') })
    );
    expect(r.kind).toBe('perpendicular');
    const dot = (r.p.x - b.x) * (b.x - a.x) + (r.p.y - b.y) * (b.y - a.y);
    expect(dot).toBeCloseTo(0, 6);
  });

  it('two crossing constraints are intersected, not just projected onto', () => {
    // vertical alignment with the corner at x=4, AND the 90° angle lock off an
    // anchor at y=1 — the answer is exactly (4, 1), which neither alone gives
    const c = ctx({ chain: [{ x: 1, y: 1 }], anchor: { x: 1, y: 1 } });
    const r = resolveSnap({ x: 4.02, y: 1.02 }, c, cfg({ enabled: only('align', 'angle') }));
    expect(r.kinds).toHaveLength(2);
    near(r.p, { x: 4, y: 1 });
    // only the ALIGN half earns a guide: the angle line radiates from the
    // anchor, so its guide would sit exactly under the rubber-banded segment
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0].kind).toBe('align');
  });

  it('the angle lock is a MODE, not a proximity snap — it fires however far off the ray', () => {
    // 3 m out at ~20°, i.e. ~0.26 m off the nearest 15° ray: far beyond any
    // reach, but the lock must still hold the segment on the ray
    const c = ctx({ chain: [{ x: 0, y: 0 }], anchor: { x: 0, y: 0 } }, []);
    const aim = { x: Math.cos(0.35) * 3, y: Math.sin(0.35) * 3 };
    const r = resolveSnap(aim, c, cfg({ enabled: only('angle') }));
    expect(r.kind).toBe('angle');
    const step = Math.PI / 12;
    const a = Math.atan2(r.p.y, r.p.x);
    expect(Math.abs(a - Math.round(a / step) * step)).toBeLessThan(1e-9);
  });

  it('but a real snap in reach still outranks the lock, as it always did', () => {
    const c = ctx({ chain: [{ x: 1, y: 1 }], anchor: { x: 1, y: 1 } });
    const r = resolveSnap({ x: 4.02, y: 0.02 }, c, cfg({ enabled: only('endpoint', 'angle') }));
    expect(r.kind).toBe('endpoint');
    near(r.p, { x: 4, y: 0 });
  });

  it('an alignment PARALLEL to the locked ray never overrides it', () => {
    // regression: a wall midpoint at y=1.5 sat within reach of a cursor at
    // y=1.35, so an `align` beat the lock on weight alone and tilted a segment
    // the user had explicitly asked to be flat
    const seg: SnapSegment[] = [{ a: { x: 4, y: 0 }, b: { x: 4, y: 3 } }];
    const c = ctx({ chain: [{ x: 7, y: 1 }], anchor: { x: 7, y: 1 } }, seg);
    const r = resolveSnap({ x: 10, y: 1.35 }, c, cfg({ zoom: 30 }));
    expect(r.kind).toBe('angle');
    expect(r.p.y).toBeCloseTo(1, 9);
  });

  it('but a NON-parallel alignment still combines with the lock', () => {
    const seg: SnapSegment[] = [{ a: { x: 4, y: 0 }, b: { x: 4, y: 3 } }];
    const c = ctx({ chain: [{ x: 7, y: 1 }], anchor: { x: 7, y: 1 } }, seg);
    // near x=4 (the wall's own vertical line) and roughly flat from the anchor
    const r = resolveSnap({ x: 4.03, y: 1.1 }, c, cfg({ zoom: 30 }));
    expect(r.kinds).toContain('angle');
    near(r.p, { x: 4, y: 1 });
  });

  it('a near alignment reference outranks a far one on the same line', () => {
    const seg: SnapSegment[] = [
      { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, // degenerate: contributes ends only
      { a: { x: 9.9, y: 5 }, b: { x: 9.9, y: 5 } },
    ];
    const c = ctx({}, seg);
    // both references share y=5-ish; the near one is 0.1 m away, the far 10 m
    const r = resolveSnap(
      { x: 10, y: 5.02 },
      {
        ...c,
        points: [
          { p: { x: 9.9, y: 5 }, kind: 'endpoint' },
          { p: { x: 0, y: 5 }, kind: 'endpoint' },
        ],
      },
      cfg({ enabled: only('align') })
    );
    expect(r.guides[0].a.x).toBeCloseTo(9.9, 9);
  });

  it('draws no guide for a constraint radiating from the anchor', () => {
    // it would land exactly under the pending segment the ring already draws
    const c = ctx({ chain: [{ x: 0, y: 0 }], anchor: { x: 0, y: 0 } }, []);
    const r = resolveSnap({ x: 3, y: 0.4 }, c, cfg({ enabled: only('angle') }));
    expect(r.kind).toBe('angle');
    expect(r.guides).toEqual([]);
  });

  it('never crosses two constraints that share an origin — that IS the anchor', () => {
    // ⊥-to-previous and the angle lock are both anchored at the same vertex, so
    // crossing them would land the pending vertex on the vertex it starts from
    const a = { x: 0, y: 0 };
    const b = { x: 2, y: 0 };
    const c = ctx({ chain: [a, b], anchor: b }, []);
    const r = resolveSnap({ x: 2.01, y: 1.5 }, c, cfg());
    expect(dist(r.p, b)).toBeGreaterThan(0.5);
  });

  it('a single line with nothing to cross projects the cursor onto it', () => {
    const c = ctx({}, [{ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }]);
    const r = resolveSnap({ x: 5, y: 0.03 }, c, cfg({ enabled: only('onSegment') }));
    expect(r.kinds).toEqual(['onSegment']);
    near(r.p, { x: 5, y: 0 });
  });
});

describe('reach', () => {
  it('is screen-relative: the same world offset snaps zoomed out and misses zoomed in', () => {
    const p = { x: 4.1, y: 0 }; // 100 mm from the corner
    const out = resolveSnap(p, ctx(), cfg({ zoom: 50, enabled: only('endpoint') }));
    const inn = resolveSnap(p, ctx(), cfg({ zoom: 400, enabled: only('endpoint') }));
    expect(out.kind).toBe('endpoint'); // 12px/50 = 0.24 m reach
    expect(inn.kind).not.toBe('endpoint'); // 12px/400 = 0.03 m reach
  });

  it('is clamped, so zooming far out never turns a snap into a metre-wide magnet', () => {
    // at 5 px/m an unclamped 12 px reach would be 2.4 m
    const r = resolveSnap({ x: 4.5, y: 0 }, ctx(), cfg({ zoom: 5, enabled: only('endpoint') }));
    expect(r.kind).not.toBe('endpoint');
    const inside = resolveSnap(
      { x: 4.2, y: 0 },
      ctx(),
      cfg({ zoom: 5, enabled: only('endpoint') })
    );
    expect(inside.kind).toBe('endpoint'); // 0.2 m < maxWorldReach 0.25
  });
});

describe('fallbacks and gates', () => {
  it('falls back to the grid only when nothing else fired', () => {
    const r = resolveSnap({ x: 20.031, y: 20.024 }, ctx(), cfg());
    expect(r.kind).toBe('grid');
    near(r.p, { x: 20.05, y: 20 }); // .031 rounds up, .024 rounds down
  });

  it('a null grid step leaves a free point untouched', () => {
    const p = { x: 20.031, y: 20.024 };
    const r = resolveSnap(p, ctx(), cfg({ gridStep: null }));
    expect(r.kind).toBe('free');
    near(r.p, p);
  });

  it('suppressed is the identity — the grid is suppressed too', () => {
    const p = { x: 4.001, y: 0.001 };
    const r = resolveSnap(p, ctx(), cfg({ suppressed: true }));
    expect(r).toEqual({ p, kind: 'free', kinds: [], guides: [] });
  });

  it('never returns more guides than maxGuides', () => {
    const c = ctx({ chain: [{ x: 1, y: 1 }], anchor: { x: 1, y: 1 } });
    for (const max of [0, 1, 2, 3]) {
      const r = resolveSnap({ x: 4.02, y: 1.02 }, c, cfg({ maxGuides: max }));
      expect(r.guides.length).toBeLessThanOrEqual(max);
    }
  });

  it('every guide it does return names a constraint that actually applied', () => {
    const c = ctx({ chain: [{ x: 1, y: 1 }], anchor: { x: 1, y: 1 } });
    const r = resolveSnap({ x: 4.02, y: 1.02 }, c, cfg({ enabled: only('align', 'angle') }));
    for (const g of r.guides) expect(r.kinds).toContain(g.kind);
  });
});

describe('lineIntersection', () => {
  it('crosses INFINITE lines, where segmentIntersection would report a miss', () => {
    const p = lineIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 1 }, { x: 0, y: 1 });
    near(p!, { x: 5, y: 0 });
  });

  it('is null for parallel lines', () => {
    expect(
      lineIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 3 }, { x: 2, y: 0 })
    ).toBeNull();
  });
});
