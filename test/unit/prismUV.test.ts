import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { prism } from '../../src/view3d/meshKit';

/**
 * prism() side-wall UVs are (arc length along the contour, extrusion depth) in
 * metres — the scaleBoxUV convention. Three's stock ExtrudeGeometry UVs project
 * u onto the dominant axis, so a diagonal wall came out cos-compressed; these
 * tests pin the metric parameterization the render pipeline's texture scale
 * (1 / tileMeters) depends on.
 */

const EPS = 1e-6;

interface Tri {
  idx: [number, number, number];
  span: number;
}

function build(poly: { x: number; y: number }[], h: number, holes?: { x: number; y: number }[][]) {
  const g = new THREE.Group();
  const mesh = prism(g, poly, h, new THREE.MeshStandardMaterial(), 0, holes);
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const side: Tri[] = [];
  const cap: Tri[] = [];
  for (let t = 0; t < pos.count; t += 3) {
    const zs = [pos.getZ(t), pos.getZ(t + 1), pos.getZ(t + 2)];
    const span = Math.max(...zs) - Math.min(...zs);
    (span < EPS ? cap : side).push({ idx: [t, t + 1, t + 2], span });
  }
  return { pos, uv, side, cap };
}

const rect = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 0.6 },
  { x: 0, y: 0.6 },
];

describe('prism side-wall UVs', () => {
  it('v equals extrusion depth and u stays within the contour perimeter', () => {
    const { pos, uv, side } = build(rect, 0.04);
    const perimeter = 2 * (2 + 0.6);
    expect(side.length).toBeGreaterThan(0);
    for (const tri of side) {
      for (const k of tri.idx) {
        expect(uv.getY(k)).toBeCloseTo(pos.getZ(k), 6);
        expect(uv.getX(k)).toBeGreaterThanOrEqual(-EPS);
        expect(uv.getX(k)).toBeLessThanOrEqual(perimeter + EPS);
      }
    }
  });

  it('each wall spans exactly its edge length in u', () => {
    const { pos, uv, side } = build(rect, 0.04);
    // group side triangles by the wall they lie on (constant x or constant y)
    const spanOfWall = new Map<string, { min: number; max: number; len: number }>();
    for (const tri of side) {
      const xs = tri.idx.map((k) => pos.getX(k));
      const ys = tri.idx.map((k) => pos.getY(k));
      const constX = Math.max(...xs) - Math.min(...xs) < EPS;
      const key = constX ? `x${xs[0].toFixed(4)}` : `y${ys[0].toFixed(4)}`;
      const len = constX ? 0.6 : 2;
      const us = tri.idx.map((k) => uv.getX(k));
      const cur = spanOfWall.get(key) ?? { min: Infinity, max: -Infinity, len };
      cur.min = Math.min(cur.min, ...us);
      cur.max = Math.max(cur.max, ...us);
      spanOfWall.set(key, cur);
    }
    expect(spanOfWall.size).toBe(4);
    for (const wall of spanOfWall.values()) {
      expect(wall.max - wall.min).toBeCloseTo(wall.len, 5);
    }
  });

  it('a diagonal wall gets its true length, not an axis projection', () => {
    const triPoly = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const { pos, uv, side } = build(triPoly, 0.1);
    // hypotenuse triangles: centroid off both axes
    let hypSpan = 0;
    for (const tri of side) {
      const cx = tri.idx.reduce((s, k) => s + pos.getX(k), 0) / 3;
      const cy = tri.idx.reduce((s, k) => s + pos.getY(k), 0) / 3;
      if (cx > 0.1 && cy > 0.1) {
        const us = tri.idx.map((k) => uv.getX(k));
        hypSpan = Math.max(hypSpan, Math.max(...us) - Math.min(...us));
      }
    }
    expect(hypSpan).toBeCloseTo(Math.SQRT2, 5);
  });

  it('hole walls parameterize against the hole contour, caps keep shape-space UVs', () => {
    const hole = [
      { x: 0.5, y: 0.1 },
      { x: 1.5, y: 0.1 },
      { x: 1.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ];
    const { pos, uv, side, cap } = build(rect, 0.04, [hole]);
    const holePerimeter = 2 * (1 + 0.4);
    // inner-wall vertices sit strictly inside the outline
    const inner = side.filter((tri) =>
      tri.idx.every((k) => {
        const x = pos.getX(k);
        const y = pos.getY(k);
        return x > EPS && x < 2 - EPS && y > EPS && y < 0.6 - EPS;
      })
    );
    expect(inner.length).toBeGreaterThan(0);
    for (const tri of inner) {
      for (const k of tri.idx) {
        expect(uv.getX(k)).toBeLessThanOrEqual(holePerimeter + EPS);
      }
    }
    for (const tri of cap) {
      for (const k of tri.idx) {
        expect(uv.getX(k)).toBeCloseTo(pos.getX(k), 6);
        expect(uv.getY(k)).toBeCloseTo(pos.getY(k), 6);
      }
    }
  });
});
