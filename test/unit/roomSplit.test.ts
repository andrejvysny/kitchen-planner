import { describe, expect, it } from 'vitest';
import { signedArea } from '../../src/model/geometry';
import { defaultRoomStyle, splitRoomByChain } from '../../src/model/rooms';
import type { Point, Room } from '../../src/model/types';

/**
 * `splitRoomByChain` — a wall chain drawn across a room cuts it in two.
 *
 * The chain arrives in CENTRELINE space and its ends sit OUTSIDE the ring (a
 * wall centreline lies half a thickness beyond the room-side face it was
 * snapped to), so every case here overshoots deliberately: clipping to the two
 * ring crossings is the behaviour, not an accident of the numbers.
 */

const room = (pts: [number, number][]): Room => ({
  id: 'A',
  name: 'A',
  corners: pts.map(([x, y], i) => ({ id: `c${i}`, x, y })),
  style: defaultRoomStyle(),
});

/** 4x3 at the origin, wound CCW in signedArea's sense. */
const rect = (): Room => {
  const r = room([
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]);
  if (signedArea(r.corners) < 0) r.corners.reverse();
  return r;
};

const area = (p: Point[]): number => Math.abs(signedArea(p));

describe('splitRoomByChain', () => {
  it('a straight chain across the middle makes two halves that sum to the whole', () => {
    const r = rect();
    // vertical cut at x = 2.5, overshooting both walls like a real snap does
    const split = splitRoomByChain(r, [
      { x: 2.5, y: -0.06 },
      { x: 2.5, y: 3.06 },
    ])!;
    expect(split).not.toBeNull();
    expect(split.roomId).toBe('A');
    expect(split.rings).toHaveLength(2);

    const [a, b] = split.rings;
    expect(area(a) + area(b)).toBeCloseTo(12, 6);
    // which ring comes out first is an implementation detail; the two AREAS
    // are the contract
    expect([area(a), area(b)].sort((m, n) => m - n)).toEqual([
      expect.closeTo(1.5 * 3, 6),
      expect.closeTo(2.5 * 3, 6),
    ]);
  });

  it('both halves hold the cut edge, so the two rooms will share it', () => {
    const r = rect();
    const [a, b] = splitRoomByChain(r, [
      { x: 2.5, y: -0.06 },
      { x: 2.5, y: 3.06 },
    ])!.rings;
    const onCut = (p: Point): boolean => Math.abs(p.x - 2.5) < 1e-9;
    expect(a.filter(onCut)).toHaveLength(2);
    expect(b.filter(onCut)).toHaveLength(2);
    // the same two points, to the millimetre the shared-edge test uses
    const ya = a.filter(onCut).map((p) => p.y).sort((m, n) => m - n);
    const yb = b.filter(onCut).map((p) => p.y).sort((m, n) => m - n);
    expect(ya[0]).toBeCloseTo(yb[0], 9);
    expect(ya[1]).toBeCloseTo(yb[1], 9);
  });

  it('an L-shaped chain keeps its interior bends', () => {
    const r = rect();
    const split = splitRoomByChain(r, [
      { x: -0.06, y: 1.5 },
      { x: 2, y: 1.5 },
      { x: 2, y: 3.06 },
    ])!;
    expect(split).not.toBeNull();
    const [a, b] = split.rings;
    expect(area(a) + area(b)).toBeCloseTo(12, 6);
    // the bend at (2, 1.5) survives in both rings
    const hasBend = (ring: Point[]): boolean =>
      ring.some((p) => Math.abs(p.x - 2) < 1e-9 && Math.abs(p.y - 1.5) < 1e-9);
    expect(hasBend(a)).toBe(true);
    expect(hasBend(b)).toBe(true);
  });

  it('a horizontal cut works the same as a vertical one', () => {
    const split = splitRoomByChain(rect(), [
      { x: -0.06, y: 1 },
      { x: 4.06, y: 1 },
    ])!;
    const [a, b] = split.rings;
    expect(area(a) + area(b)).toBeCloseTo(12, 6);
    expect(Math.min(area(a), area(b))).toBeCloseTo(4, 6);
  });

  it('a chain that never reaches the room is refused', () => {
    expect(
      splitRoomByChain(rect(), [
        { x: 10, y: 10 },
        { x: 12, y: 12 },
      ])
    ).toBeNull();
  });

  it('a chain that only touches one wall is refused — that is not a cut', () => {
    expect(
      splitRoomByChain(rect(), [
        { x: 2, y: -0.06 },
        { x: 2, y: 1.5 },
      ])
    ).toBeNull();
  });

  it('a degenerate chain is refused rather than repaired', () => {
    expect(splitRoomByChain(rect(), [{ x: 2, y: 2 }])).toBeNull();
    expect(
      splitRoomByChain(rect(), [
        { x: 2, y: 1 },
        { x: 2, y: 1 },
      ])
    ).toBeNull();
  });

  it('every produced ring is simple and has real area', () => {
    for (const chain of [
      [
        { x: 2.5, y: -0.06 },
        { x: 2.5, y: 3.06 },
      ],
      [
        { x: -0.06, y: 1.5 },
        { x: 2, y: 1.5 },
        { x: 2, y: 3.06 },
      ],
      [
        { x: -0.06, y: 2 },
        { x: 4.06, y: 0.5 },
      ],
    ]) {
      const split = splitRoomByChain(rect(), chain);
      expect(split, JSON.stringify(chain)).not.toBeNull();
      for (const ring of split!.rings) {
        expect(ring.length).toBeGreaterThanOrEqual(3);
        expect(area(ring)).toBeGreaterThan(1e-4);
      }
      expect(area(split!.rings[0]) + area(split!.rings[1])).toBeCloseTo(12, 6);
    }
  });
});
