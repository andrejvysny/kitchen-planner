import { describe, expect, it } from 'vitest';
import { pointInPolygon, polygonBounds, polygonIsSimple, signedArea } from '../../src/model/geometry';
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
