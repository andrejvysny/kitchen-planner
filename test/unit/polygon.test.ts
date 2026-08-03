import { describe, expect, it } from 'vitest';
import {
  angleClose,
  obbCorners,
  obbOverlap,
  pointInPolygon,
  polygonBounds,
  polygonIsSimple,
  polygonsOverlap,
  sectorPolygon,
  signedArea,
  type Obb,
} from '../../src/model/geometry';
import { footprintPolygon, newBoardPart, normalizeBoardOutline } from '../../src/model/parts';

const L = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
];

describe('polygon utilities', () => {
  it('pointInPolygon handles concave shapes and edges', () => {
    expect(pointInPolygon({ x: -0.5, y: 0.5 }, L)).toBe(true);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, L)).toBe(false); // in the notch
    expect(pointInPolygon({ x: 0.5, y: -0.5 }, L)).toBe(true);
    expect(pointInPolygon({ x: 1, y: -0.5 }, L)).toBe(true); // on an edge
    expect(pointInPolygon({ x: 2, y: 0 }, L)).toBe(false);
  });

  it('polygonIsSimple rejects self-intersections', () => {
    expect(polygonIsSimple(L)).toBe(true);
    const bowtie = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(polygonIsSimple(bowtie)).toBe(false);
  });

  it('polygonBounds', () => {
    expect(polygonBounds(L)).toEqual({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
  });
});

describe('oriented boxes (SAT)', () => {
  const box = (cx: number, cy: number, w = 0.6, d = 0.6, r = 0): Obb => ({ cx, cy, w, d, rot: r });

  it('reports the minimum penetration depth of axis-aligned boxes', () => {
    // two 0.6 boxes 0.5 apart along x => 0.1 of overlap on that axis
    const hit = obbOverlap(box(0, 0), box(0.5, 0));
    expect(hit?.depth).toBeCloseTo(0.1, 6);
    // pushing them together along y as well: the smaller axis wins
    expect(obbOverlap(box(0, 0), box(0.5, 0.58))?.depth).toBeCloseTo(0.02, 6);
  });

  it('treats exact edge-to-edge contact as disjoint', () => {
    expect(obbOverlap(box(0, 0), box(0.6, 0))).toBeNull(); // flush neighbours
    expect(obbOverlap(box(0, 0), box(0.61, 0))).toBeNull();
    // a caller-level 5 mm shrink turns a 4 mm overlap into a miss
    expect(obbOverlap(box(0, 0), box(0.596, 0))?.depth).toBeCloseTo(0.004, 6);
    expect(obbOverlap(box(0, 0, 0.59, 0.59), box(0.596, 0, 0.59, 0.59))).toBeNull();
  });

  it('handles rotated pairs (hit and near miss)', () => {
    const a = box(0, 0, 1, 0.6, Math.PI / 6); // 30°
    // centre-to-centre 0.35 along the rotated width axis: 0.65 of width overlap
    // but the untouched 0.6 depth axis is the shallower one
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    expect(obbOverlap(a, box(0.35 * c, 0.35 * s, 1, 0.6, Math.PI / 6))?.depth).toBeCloseTo(0.6, 6);
    // slid a full width apart along the same axis: exactly flush => no hit
    expect(obbOverlap(a, box(1 * c, 1 * s, 1, 0.6, Math.PI / 6))).toBeNull();
    // an axis-aligned box tucked past the rotated one's corner
    expect(obbOverlap(a, box(0.9, -0.6, 0.4, 0.4))).toBeNull();
    expect(obbOverlap(a, box(0.55, -0.25, 0.4, 0.4))).not.toBeNull();
  });

  it('obbCorners round-trips through the polygon path', () => {
    const pts = obbCorners(box(1, 2, 1, 0.5, Math.PI / 2));
    expect(pts).toHaveLength(4);
    expect(signedArea(pts)).toBeCloseTo(0.5, 6); // area survives rotation
    expect(pointInPolygon({ x: 1, y: 2 }, pts)).toBe(true);
    // rotated 90°: the 1 m width now runs along y
    expect(pointInPolygon({ x: 1, y: 2.45 }, pts)).toBe(true);
    expect(pointInPolygon({ x: 1.4, y: 2 }, pts)).toBe(false);
  });
});

describe('polygonsOverlap', () => {
  const sq = (cx: number, cy: number, h = 0.5) => [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ];

  it('detects crossing edges, containment and misses', () => {
    expect(polygonsOverlap(sq(0, 0), sq(0.5, 0.5))).toBe(true); // crossing edges
    expect(polygonsOverlap(sq(0, 0), sq(0, 0, 0.2))).toBe(true); // fully inside
    expect(polygonsOverlap(sq(0, 0, 0.2), sq(0, 0))).toBe(true); // inside, swapped
    expect(polygonsOverlap(sq(0, 0), sq(2, 0))).toBe(false);
  });

  it('reports touching polygons as overlapping (callers shrink first)', () => {
    expect(polygonsOverlap(sq(0, 0), sq(1, 0))).toBe(true); // shared edge
    expect(polygonsOverlap(sq(0, 0, 0.495), sq(1, 0, 0.495))).toBe(false);
  });

  it('uses the true outline of a notched footprint', () => {
    // the L keeps its notch clear: a small square in the cut-out misses it
    expect(polygonsOverlap(L, sq(0.5, 0.5, 0.3))).toBe(false);
    expect(polygonsOverlap(L, sq(-0.5, 0.5, 0.3))).toBe(true);
  });
});

describe('sectorPolygon', () => {
  it('is a fan of segs + 2 points spanning the requested arc', () => {
    const s = sectorPolygon({ x: 0, y: 0 }, 1, 0, Math.PI / 2);
    expect(s).toHaveLength(10); // centre + 9 arc points
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[1].x).toBeCloseTo(1, 6);
    expect(s[1].y).toBeCloseTo(0, 6);
    expect(s[9].x).toBeCloseTo(0, 6);
    expect(s[9].y).toBeCloseTo(1, 6);
    // inside the quarter, outside the other three
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, s)).toBe(true);
    expect(pointInPolygon({ x: -0.5, y: 0.5 }, s)).toBe(false);
    expect(pointInPolygon({ x: 0.9, y: 0.9 }, s)).toBe(false); // beyond the radius
    expect(sectorPolygon({ x: 0, y: 0 }, 1, 0, Math.PI / 2, 4)).toHaveLength(6);
  });

  it('sweeps backwards when a1 < a0', () => {
    const s = sectorPolygon({ x: 0, y: 0 }, 1, Math.PI, Math.PI / 2);
    expect(pointInPolygon({ x: -0.5, y: 0.5 }, s)).toBe(true);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, s)).toBe(false);
  });
});

describe('angleClose', () => {
  it('folds the difference into [0, π] and wraps at 2π', () => {
    expect(angleClose(0, 0.01)).toBe(true);
    expect(angleClose(0, 0.2)).toBe(false);
    expect(angleClose(0, 2 * Math.PI - 0.01)).toBe(true);
    expect(angleClose(-Math.PI, Math.PI)).toBe(true);
    expect(angleClose(0, 0.2, 0.3)).toBe(true);
  });
});

describe('board outlines', () => {
  it('normalizeBoardOutline enforces CCW, recenters and refreshes dims', () => {
    const part = newBoardPart();
    part.outline = [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ];
    normalizeBoardOutline(part);
    expect(signedArea(part.outline)).toBeGreaterThan(0);
    const b = polygonBounds(part.outline);
    expect(b.minX).toBeCloseTo(-1);
    expect(b.maxX).toBeCloseTo(1);
    expect(part.w).toBeCloseTo(2);
    expect(part.d).toBeCloseTo(1);
  });

  it('footprintPolygon scales board outlines to instance dims', () => {
    const part = newBoardPart(); // 1.2 × 0.6 rect outline
    const poly = footprintPolygon(part, 2.4, 0.6)!;
    const b = polygonBounds(poly);
    expect(b.maxX - b.minX).toBeCloseTo(2.4);
    expect(b.maxY - b.minY).toBeCloseTo(0.6);
  });
});

describe('cabinet footprints', () => {
  it('chamfer polygons cut the requested corner', () => {
    const base = {
      id: 'p',
      name: 'p',
      type: 'cabinet' as const,
      w: 1,
      d: 1,
      h: 0.9,
      elevation: 0,
      color: '#fff',
      accentColor: '#c9a87c',
      plinth: true,
      worktop: false,
      face: { kind: 'leaf' as const, fill: 'door' as const },
    };
    const left = footprintPolygon(
      { ...base, footprint: { kind: 'chamfer', corner: 'left', cx: 0.4, cz: 0.4, face: 'angled' } },
      1,
      1
    )!;
    expect(left).toHaveLength(5);
    expect(polygonIsSimple(left)).toBe(true);
    // front-left corner (-0.5, 0.5) is cut away
    expect(pointInPolygon({ x: -0.45, y: 0.45 }, left)).toBe(false);
    expect(pointInPolygon({ x: 0.45, y: 0.45 }, left)).toBe(true);

    const right = footprintPolygon(
      { ...base, footprint: { kind: 'chamfer', corner: 'right', cx: 0.4, cz: 0.4, face: 'angled' } },
      1,
      1
    )!;
    expect(pointInPolygon({ x: 0.45, y: 0.45 }, right)).toBe(false);
    expect(pointInPolygon({ x: -0.45, y: 0.45 }, right)).toBe(true);
  });

  it('cornerL polygons notch the requested side', () => {
    const base = {
      id: 'p',
      name: 'p',
      type: 'cabinet' as const,
      w: 1,
      d: 1,
      h: 0.9,
      elevation: 0,
      color: '#fff',
      accentColor: '#c9a87c',
      plinth: true,
      worktop: false,
      face: { kind: 'leaf' as const, fill: 'door' as const },
    };
    const leftNotch = footprintPolygon(
      { ...base, footprint: { kind: 'cornerL', notch: 'left', nw: 0.4, nd: 0.4, face2: 'panel' } },
      1,
      1
    )!;
    expect(leftNotch).toHaveLength(6);
    expect(pointInPolygon({ x: -0.4, y: 0.4 }, leftNotch)).toBe(false);
    expect(pointInPolygon({ x: 0.4, y: 0.4 }, leftNotch)).toBe(true);
    expect(pointInPolygon({ x: -0.4, y: -0.4 }, leftNotch)).toBe(true);
  });
});
