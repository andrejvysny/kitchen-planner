import { describe, expect, it } from 'vitest';
import { planarFaces, type FaceSegment } from '../../src/model/faces';
import { signedArea } from '../../src/model/geometry';
import type { Point } from '../../src/model/types';

/**
 * The planar subdivision the wall tool closes a chain with. It replaced a walk
 * along ONE room's corner ring, which could only ever close a chain against the
 * single room it started and ended on — so from the second room onward, where a
 * new room's two ends land on two DIFFERENT rooms, a perfectly closed region
 * committed as free-standing walls.
 */

const seg = (ax: number, ay: number, bx: number, by: number, chain = false): FaceSegment => ({
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  chain,
});

const boxSegs = (x0: number, y0: number, x1: number, y1: number, chain = false): FaceSegment[] => [
  seg(x0, y0, x1, y0, chain),
  seg(x1, y0, x1, y1, chain),
  seg(x1, y1, x0, y1, chain),
  seg(x0, y1, x0, y0, chain),
];

/** Bounded faces only — the unbounded one is the single negative-area walk. */
const bounded = (segs: FaceSegment[]): { area: number; onChain: boolean; ring: Point[] }[] =>
  planarFaces(segs)
    .filter((f) => f.area > 1e-9)
    .sort((a, b) => a.area - b.area);

describe('planarFaces', () => {
  it('a closed box is one bounded face plus the outer one', () => {
    const faces = planarFaces(boxSegs(0, 0, 4, 3));
    expect(faces.filter((f) => f.area > 1e-9).length).toBe(1);
    expect(faces.filter((f) => f.area < -1e-9).length).toBe(1);
    expect(bounded(boxSegs(0, 0, 4, 3))[0].area).toBeCloseTo(12, 9);
  });

  it('an open chain encloses nothing', () => {
    expect(bounded([seg(0, 0, 4, 0), seg(4, 0, 4, 3)])).toEqual([]);
  });

  it('a wall across a box splits it into two faces', () => {
    const faces = bounded([...boxSegs(0, 0, 4, 3), seg(2, 0, 2, 3)]);
    expect(faces.length).toBe(2);
    expect(faces[0].area).toBeCloseTo(6, 9);
    expect(faces[1].area).toBeCloseTo(6, 9);
  });

  it('a T-junction closes a face even with no crossing anywhere', () => {
    // the divider ENDS against the top and bottom walls; nothing crosses
    const faces = bounded([...boxSegs(0, 0, 4, 3), seg(1, 0, 1, 3)]);
    expect(faces.length).toBe(2);
    expect(faces[0].area).toBeCloseTo(3, 9);
  });

  it('reports which faces the chain bounds, and which it does not', () => {
    const faces = bounded([...boxSegs(0, 0, 4, 3), seg(2, 0, 2, 3, true)]);
    expect(faces.length).toBe(2);
    expect(faces.every((f) => f.onChain)).toBe(true);

    const off = bounded([...boxSegs(0, 0, 4, 3), ...boxSegs(9, 0, 12, 3, true)]);
    expect(off.length).toBe(2);
    expect(off.filter((f) => f.onChain).length).toBe(1);
  });

  it('drops the pass-through vertices a split wall leaves behind', () => {
    // the right wall arrives as two collinear halves; the face is still a quad
    const faces = bounded([
      seg(0, 0, 4, 0),
      seg(4, 0, 4, 1.5),
      seg(4, 1.5, 4, 3),
      seg(4, 3, 0, 3),
      seg(0, 3, 0, 0),
    ]);
    expect(faces.length).toBe(1);
    expect(faces[0].ring.length).toBe(4);
  });

  it('every bounded face is wound the interior way', () => {
    for (const f of bounded([...boxSegs(0, 0, 4, 3), seg(2, 0, 2, 3)])) {
      expect(signedArea(f.ring)).toBeGreaterThan(0);
    }
  });

  it('two boxes sharing an edge are two faces, not one merged blob', () => {
    const faces = bounded([...boxSegs(0, 0, 4, 3), ...boxSegs(4, 0, 7, 3)]);
    expect(faces.length).toBe(2);
    expect(faces[0].area).toBeCloseTo(9, 9);
    expect(faces[1].area).toBeCloseTo(12, 9);
  });

  it('a degenerate input yields no bounded face rather than throwing', () => {
    expect(() => planarFaces([])).not.toThrow();
    expect(planarFaces([])).toEqual([]);
    expect(bounded([seg(1, 1, 1, 1)])).toEqual([]);
  });
});
