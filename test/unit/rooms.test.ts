import { describe, expect, it } from 'vitest';
import { insetPolygon, signedArea } from '../../src/model/geometry';
import {
  allWalls,
  defaultRoomStyle,
  makeRoom,
  mirrorOpening,
  rectangleSizeOf,
  reidCorners,
  roomArea,
  roomById,
  roomContaining,
  roomOfCorner,
  roomOfWall,
  wallByIdIn,
  wallIndex,
  wallsOf,
} from '../../src/model/rooms';
import type { Corner, Opening, Room } from '../../src/model/types';

function room(id: string, pts: [number, number][]): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => ({ id: `${id}c${i}`, x, y })),
    style: defaultRoomStyle(),
  };
}

// A and B are 4×3 rectangles abutting on x = 4; the seam coords are written
// bit-identically, exactly as addRoom({against}) will emit them.
const rectA = (): Room => room('A', [[0, 0], [4, 0], [4, 3], [0, 3]]);
const rectB = (): Room => room('B', [[4, 0], [8, 0], [8, 3], [4, 3]]);

/** the pair of walls tagged shared, in [A-side, B-side] order */
function seam(rooms: Room[]): ReturnType<typeof allWalls> {
  return allWalls(rooms).filter((w) => w.shared);
}

describe('shared-edge detection', () => {
  it('tags exactly one owner on a coincident reversed edge', () => {
    const rooms = [rectA(), rectB()];
    const walls = allWalls(rooms);
    expect(walls).toHaveLength(8);

    const pair = walls.filter((w) => w.shared);
    expect(pair).toHaveLength(2);
    const [wa, wb] = pair;
    expect(wa.roomId).toBe('A');
    expect(wb.roomId).toBe('B');
    // A's edge (4,0)→(4,3) is index 1; B's edge (4,3)→(4,0) is index 3
    expect(wa.index).toBe(1);
    expect(wb.index).toBe(3);

    // cross-references point at each other
    expect(wa.shared!.wallId).toBe(wb.id);
    expect(wa.shared!.roomId).toBe('B');
    expect(wb.shared!.wallId).toBe(wa.id);
    expect(wb.shared!.roomId).toBe('A');

    // rooms[0] owns the partition — exactly one owner
    expect(wa.shared!.owner).toBe(true);
    expect(wb.shared!.owner).toBe(false);
    expect(pair.filter((w) => w.shared!.owner)).toHaveLength(1);
  });

  it('owner follows the rooms[] order', () => {
    const [wb, wa] = seam([rectB(), rectA()]);
    expect(wb.roomId).toBe('B');
    expect(wb.shared!.owner).toBe(true);
    expect(wa.shared!.owner).toBe(false);
  });

  it('faceOffset is thickness/2 on shared walls and 0 elsewhere', () => {
    const walls = allWalls([rectA(), rectB()]);
    for (const w of walls) {
      expect(w.thickness).toBeCloseTo(0.1);
      expect(w.faceOffset).toBeCloseTo(w.shared ? 0.05 : 0);
    }
    expect(walls.filter((w) => w.faceOffset > 0)).toHaveLength(2);
  });

  it('a 2 mm gap un-shares, a 0.4 mm one does not', () => {
    const nudged = (dx: number): Room => {
      const b = rectB();
      b.corners[3].x += dx; // the (4,3) end of the seam edge
      return b;
    };
    expect(seam([rectA(), nudged(0.002)])).toHaveLength(0);
    expect(seam([rectA(), nudged(0.0004)])).toHaveLength(2);
  });

  it('rooms touching at a single corner are not shared', () => {
    const diag = room('C', [[4, 3], [8, 3], [8, 6], [4, 6]]);
    expect(seam([rectA(), diag])).toHaveLength(0);
  });

  it('rejects coincident edges traversed in the SAME direction', () => {
    // hand-built: D walks the seam (4,0)→(4,3) just like A does
    const same = room('D', [[4, 0], [4, 3], [8, 3], [8, 0]]);
    expect(seam([rectA(), same])).toHaveLength(0);
  });

  it('ignores a room abutting itself', () => {
    const rooms = [rectA()];
    expect(allWalls(rooms).every((w) => w.shared === null)).toBe(true);
  });
});

describe('wall queries', () => {
  it('wallsOf keeps corner order and ids', () => {
    const a = rectA();
    const walls = wallsOf([a, rectB()], 'A');
    expect(walls).toHaveLength(4);
    walls.forEach((w, i) => {
      expect(w.id).toBe(a.corners[i].id);
      expect(w.index).toBe(i);
      expect(w.roomId).toBe('A');
    });
  });

  it('wallIndex and wallByIdIn resolve design-wide', () => {
    const rooms = [rectA(), rectB()];
    const idx = wallIndex(rooms);
    expect(idx.size).toBe(8);
    expect(idx.get('Bc2')!.roomId).toBe('B');
    expect(wallByIdIn(rooms, 'Ac0')!.len).toBeCloseTo(4);
    expect(wallByIdIn(rooms, 'nope')).toBeUndefined();
  });
});

describe('room lookups', () => {
  it('roomContaining, roomById, roomOfWall, roomOfCorner', () => {
    const rooms = [rectA(), rectB()];
    expect(roomContaining(rooms, { x: 1, y: 1 })!.id).toBe('A');
    expect(roomContaining(rooms, { x: 6, y: 2 })!.id).toBe('B');
    expect(roomContaining(rooms, { x: 20, y: 20 })).toBeUndefined();
    expect(roomById(rooms, 'B')!.name).toBe('B');
    expect(roomById(rooms, 'zz')).toBeUndefined();
    expect(roomOfWall(rooms, 'Bc3')!.id).toBe('B');
    expect(roomOfCorner(rooms, 'Ac2')!.id).toBe('A');
    expect(roomOfCorner(rooms, 'Ac9')).toBeUndefined();
  });

  it('overlapping rooms resolve to the last match', () => {
    const over = room('Z', [[0, 0], [4, 0], [4, 3], [0, 3]]);
    expect(roomContaining([rectA(), over], { x: 2, y: 1 })!.id).toBe('Z');
    expect(roomContaining([over, rectA()], { x: 2, y: 1 })!.id).toBe('A');
  });

  it('roomArea and rectangleSizeOf', () => {
    expect(roomArea(rectA())).toBeCloseTo(12);
    expect(rectangleSizeOf(rectA())).toEqual({ w: 4, d: 3 });
    const l = room('L', [[0, 0], [4, 0], [4, 2], [2, 2], [2, 3], [0, 3]]);
    expect(roomArea(l)).toBeCloseTo(10);
    expect(rectangleSizeOf(l)).toBeNull();
    const skew = room('S', [[0, 0], [4, 0.5], [4, 3], [0, 3]]);
    expect(rectangleSizeOf(skew)).toBeNull();
  });
});

describe('makeRoom / reidCorners', () => {
  it('makeRoom builds a CCW rect with fresh ids', () => {
    const r = makeRoom({ name: 'Bath', x: 2, y: -1, w: 3, d: 2.5 });
    expect(r.name).toBe('Bath');
    expect(signedArea(r.corners)).toBeGreaterThan(0);
    expect(rectangleSizeOf(r)!.w).toBeCloseTo(3);
    expect(rectangleSizeOf(r)!.d).toBeCloseTo(2.5);
    expect(r.corners[0]).toMatchObject({ x: 2, y: -1 });
    expect(new Set(r.corners.map((c) => c.id)).size).toBe(4);
    expect(new Set(makeRoom({ name: 'x', x: 0, y: 0, w: 1, d: 1 }).corners.map((c) => c.id)))
      .not.toContain(r.corners[0].id);
    expect(r.style).toEqual(defaultRoomStyle());
  });

  it('makeRoom merges a partial style over the defaults', () => {
    const r = makeRoom({ name: 'x', x: 0, y: 0, w: 1, d: 1, style: { wallHeight: 3.2 } });
    expect(r.style.wallHeight).toBe(3.2);
    expect(r.style.wallThickness).toBe(defaultRoomStyle().wallThickness);
  });

  it('reidCorners replaces every id and remaps wall visibility', () => {
    const r = rectA();
    r.wallVisibility = { Ac0: 'hide', Ac2: 'show' };
    const before = r.corners.map((c) => ({ x: c.x, y: c.y }));
    const old = r.corners.map((c) => c.id);

    const map = reidCorners(r);

    expect(map.size).toBe(4);
    old.forEach((id) => expect(map.has(id)).toBe(true));
    r.corners.forEach((c, i) => {
      expect(c.id).toBe(map.get(old[i]));
      expect(old).not.toContain(c.id);
      expect({ x: c.x, y: c.y }).toEqual(before[i]);
    });
    expect(new Set(r.corners.map((c) => c.id)).size).toBe(4);
    expect(r.wallVisibility).toEqual({
      [map.get('Ac0')!]: 'hide',
      [map.get('Ac2')!]: 'show',
    });
  });
});

describe('mirrorOpening', () => {
  const door = (): Opening => ({
    id: 'o1',
    wallId: 'wA',
    type: 'door',
    offset: 1.2,
    width: 0.9,
    height: 2,
    sill: 0,
    hinge: 'right',
    swing: 'out',
  });

  it('mirrors the centre offset and flips hinge/swing', () => {
    const m = mirrorOpening(door(), 'wB', 4);
    expect(m.id).toBe('o1');
    expect(m.wallId).toBe('wB');
    expect(m.offset).toBeCloseTo(2.8); // len - offset; offset is the CENTRE
    expect(m.hinge).toBe('left');
    expect(m.swing).toBe('in');
    expect(m.mirrored).toBe(true);
    expect(m.width).toBe(0.9);
    expect(m.height).toBe(2);
    expect(m.sill).toBe(0);
    expect(m.type).toBe('door');
  });

  it('round-trips through a second mirror', () => {
    const o = door();
    const back = mirrorOpening(mirrorOpening(o, 'wB', 4), 'wA', 4);
    expect(back.offset).toBeCloseTo(o.offset);
    expect(back.hinge).toBe(o.hinge);
    expect(back.swing).toBe(o.swing);
    expect(back.wallId).toBe(o.wallId);
  });

  it('resolves implicit defaults before flipping', () => {
    const bare: Opening = { ...door(), hinge: undefined, swing: undefined };
    const m = mirrorOpening(bare, 'wB', 4);
    expect(m.hinge).toBe('right'); // default 'left' flipped
    expect(m.swing).toBe('out'); // default 'in' flipped
  });

  it('never mutates its input', () => {
    const o = door();
    const snapshot = JSON.parse(JSON.stringify(o)) as Opening;
    mirrorOpening(o, 'wB', 4);
    expect(o).toEqual(snapshot);
  });
});

describe('insetPolygon', () => {
  const c = (id: string, x: number, y: number): Corner => ({ id, x, y });

  it('insets an axis-aligned rect and preserves ids', () => {
    const rect = [c('a', 0, 0), c('b', 4, 0), c('d', 4, 3), c('e', 0, 3)];
    const out = insetPolygon(rect, 0.05)!;
    expect(out).not.toBeNull();
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'd', 'e']);
    const xs = out.map((p) => p.x);
    const ys = out.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3.9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2.9);
    expect(out[0].x).toBeCloseTo(0.05);
    expect(out[0].y).toBeCloseTo(0.05);
    expect(out[2].x).toBeCloseTo(3.95);
    expect(out[2].y).toBeCloseTo(2.95);
    expect(rect[0]).toEqual({ id: 'a', x: 0, y: 0 }); // input untouched
  });

  it('miters an L-shape, pushing the reflex corner outward', () => {
    const l = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 }, // reflex
      { x: 2, y: 3 },
      { x: 0, y: 3 },
    ];
    const out = insetPolygon(l, 0.1)!;
    const want = [
      [0.1, 0.1],
      [3.9, 0.1],
      [3.9, 1.9],
      [1.9, 1.9],
      [1.9, 2.9],
      [0.1, 2.9],
    ];
    out.forEach((p, i) => {
      expect(p.x).toBeCloseTo(want[i][0], 9);
      expect(p.y).toBeCloseTo(want[i][1], 9);
    });
  });

  it('falls back to the offset endpoint at collinear joins', () => {
    const withMid = [
      { x: 0, y: 0 },
      { x: 2, y: 0 }, // redundant collinear vertex
      { x: 4, y: 0 },
      { x: 4, y: 3 },
      { x: 0, y: 3 },
    ];
    const out = insetPolygon(withMid, 0.1)!;
    expect(out).toHaveLength(5);
    expect(out[1].x).toBeCloseTo(2);
    expect(out[1].y).toBeCloseTo(0.1);
  });

  it('returns null when the inset collapses the polygon', () => {
    const rect = [c('a', 0, 0), c('b', 4, 0), c('d', 4, 3), c('e', 0, 3)];
    expect(insetPolygon(rect, 1.6)).toBeNull();
    expect(insetPolygon(rect, 1.5)).toBeNull(); // exactly degenerate
  });

  it('returns null for CW input and for degenerate rings', () => {
    const cw = [c('a', 0, 3), c('b', 4, 3), c('d', 4, 0), c('e', 0, 0)];
    expect(signedArea(cw)).toBeLessThan(0);
    expect(insetPolygon(cw, 0.05)).toBeNull();
    expect(insetPolygon([c('a', 0, 0), c('b', 1, 0)], 0.05)).toBeNull();
    expect(insetPolygon([c('a', 0, 0), c('b', 0, 0), c('d', 1, 0)], 0.05)).toBeNull();
  });
});
