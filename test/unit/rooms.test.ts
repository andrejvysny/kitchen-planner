import { describe, expect, it } from 'vitest';
import { insetPolygon, projectOnWall, signedArea } from '../../src/model/geometry';
import {
  allWalls,
  defaultRoomStyle,
  makeRoom,
  mirrorOpening,
  nextWeldSeam,
  rectangleSizeOf,
  reidCorners,
  roomArea,
  roomById,
  roomContaining,
  roomOfCorner,
  roomOfWall,
  slabQuad,
  snapPointToRooms,
  snapRoomRect,
  wallByIdIn,
  wallIndex,
  wallJoints,
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
const rectA = (): Room =>
  room('A', [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]);
const rectB = (): Room =>
  room('B', [
    [4, 0],
    [8, 0],
    [8, 3],
    [4, 3],
  ]);

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
    const diag = room('C', [
      [4, 3],
      [8, 3],
      [8, 6],
      [4, 6],
    ]);
    expect(seam([rectA(), diag])).toHaveLength(0);
  });

  it('rejects coincident edges traversed in the SAME direction', () => {
    // hand-built: D walks the seam (4,0)→(4,3) just like A does
    const same = room('D', [
      [4, 0],
      [4, 3],
      [8, 3],
      [8, 0],
    ]);
    expect(seam([rectA(), same])).toHaveLength(0);
  });

  it('ignores a room abutting itself', () => {
    const rooms = [rectA()];
    expect(allWalls(rooms).every((w) => w.shared === null)).toBe(true);
  });
});

describe('slabQuad', () => {
  const T = defaultRoomStyle().wallThickness; // 0.1

  /** each quad corner's signed offset along the wall's inward normal */
  const sides = (w: ReturnType<typeof allWalls>[number]): number[] =>
    slabQuad(w).map((p) => projectOnWall(w, p).side);

  const near = (got: number[], want: number[]): void =>
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]));

  it('hangs an exterior slab wholly outside the room-side face', () => {
    const w = allWalls([rectA()])[0]; // (0,0) → (4,0), inward = (0,1)
    const q = slabQuad(w);
    near(
      q.flatMap((p) => [p.x, p.y]),
      [0, 0, 4, 0, 4, -T, 0, -T]
    );
    // the inner edge IS the polygon edge; nothing reaches into the room
    near(sides(w), [0, 0, -T, -T]);
  });

  it('straddles the seam on a partition', () => {
    const [wa] = seam([rectA(), rectB()]); // A's (4,0) → (4,3), inward = (-1,0)
    near(sides(wa), [T / 2, T / 2, -T / 2, -T / 2]);
    const q = slabQuad(wa);
    near([q[0].x, q[0].y], [4 - T / 2, 0]);
    near([q[2].x, q[2].y], [4 + T / 2, 3]);
  });

  it('stops exactly at both corners — no extension', () => {
    for (const w of allWalls([rectA(), rectB()])) {
      const along = slabQuad(w).map((p) => projectOnWall(w, p).t);
      expect(Math.min(...along)).toBeCloseTo(0);
      expect(Math.max(...along)).toBeCloseTo(w.len);
    }
  });
});

describe('wallJoints', () => {
  const T = defaultRoomStyle().wallThickness; // 0.1
  const area = (hull: { x: number; y: number }[]): number => Math.abs(signedArea(hull));
  const at = (js: ReturnType<typeof wallJoints>, x: number, y: number) =>
    js.find((j) => Math.abs(j.at.x - x) < 1e-6 && Math.abs(j.at.y - y) < 1e-6);

  it('closes each corner of a lone room with a t × t square', () => {
    const joints = wallJoints(allWalls([rectA()]));
    expect(joints).toHaveLength(4);
    for (const j of joints) {
      expect(j.walls).toHaveLength(2);
      expect(j.hull).toHaveLength(4);
      expect(area(j.hull)).toBeCloseTo(T * T); // a mitred 90° corner, not a chamfer
    }
    // the patch sits OUTSIDE the room, between the two slabs
    const outer = at(joints, 0, 0)!.hull.find((p) => p.x < 0 && p.y < 0)!;
    expect(outer.x).toBeCloseTo(-T);
    expect(outer.y).toBeCloseTo(-T);
  });

  it('a partition tee collects all three end edges', () => {
    const joints = wallJoints(allWalls([rectA(), rectB()]));
    expect(joints).toHaveLength(6); // 4 outer corners + 2 tees
    for (const [x, y] of [
      [4, 0],
      [4, 3],
    ] as const) {
      const tee = at(joints, x, y)!;
      expect(tee.walls).toHaveLength(3); // the partition counts once, not twice
      expect(tee.walls.filter((w) => w.shared)).toHaveLength(1);
      expect(tee.walls.every((w) => !w.shared || w.shared.owner)).toBe(true);
      expect(area(tee.hull)).toBeGreaterThan(0);
    }
    // the outer corners of the merged footprint stay square
    for (const [x, y] of [
      [0, 0],
      [0, 3],
      [8, 0],
      [8, 3],
    ] as const) {
      expect(area(at(joints, x, y)!.hull)).toBeCloseTo(T * T);
    }
  });

  it('emits nothing at a collinear weld-split corner', () => {
    // an extra corner mid-edge: the two slabs are already flush there
    const split = room('A', [
      [0, 0],
      [2, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    const joints = wallJoints(allWalls([split]));
    expect(joints).toHaveLength(4);
    expect(at(joints, 2, 0)).toBeUndefined();
  });

  it('bevels instead of spiking at a very acute corner', () => {
    // a 4°-ish wedge: a true miter would run metres out from the corner
    const spike = room('W', [
      [0, 0],
      [8, 0],
      [8, 0.3],
    ]);
    for (const j of wallJoints(allWalls([spike]))) {
      for (const p of j.hull) {
        expect(Math.hypot(p.x - j.at.x, p.y - j.at.y)).toBeLessThanOrEqual(4 * T + 1e-9);
      }
    }
  });

  it('skips a dead end and never sees the non-owner twin', () => {
    const walls = allWalls([rectA(), rectB()]);
    const joints = wallJoints(walls);
    expect(joints.flatMap((j) => j.walls).some((w) => w.shared && !w.shared.owner)).toBe(false);
    // one wall on its own has no junction to close
    expect(wallJoints([walls[0]])).toHaveLength(0);
  });
});

describe('snapRoomRect', () => {
  // A occupies x 0..4, y 0..3, so its wall lines are x=0, x=4, y=0, y=3
  it('pulls a side that is within reach exactly onto a wall line', () => {
    const s = snapRoomRect([rectA()], 4.07, 0.04, 4, 3);
    expect(s).toMatchObject({ x: 4, y: 0, snappedX: true, snappedY: true });
  });

  it('snaps the two axes independently', () => {
    const s = snapRoomRect([rectA()], 4.07, 9, 4, 3);
    expect(s.x).toBeCloseTo(4);
    expect(s.snappedX).toBe(true);
    expect(s.y).toBe(9);
    expect(s.snappedY).toBe(false);
  });

  it('reports a snap even when the rectangle is already flush', () => {
    // callers grid-round the un-snapped axes; saying "no snap" here would let
    // that rounding undo a placement that is already exact
    const s = snapRoomRect([rectA()], 4, 0, 4, 3);
    expect(s).toMatchObject({ x: 4, y: 0, snappedX: true, snappedY: true });
  });

  it('leaves a rectangle out of reach alone, and ignores skipId', () => {
    expect(snapRoomRect([rectA()], 4.3, 8, 4, 3)).toMatchObject({
      x: 4.3,
      snappedX: false,
      snappedY: false,
    });
    expect(snapRoomRect([rectA()], 4.07, 0.04, 4, 3, 'A')).toMatchObject({
      x: 4.07,
      snappedX: false,
    });
  });

  it('aligns the far side too, so a room can sit left of a neighbour', () => {
    const s = snapRoomRect([rectA()], -4.06, 0, 4, 3);
    expect(s.x).toBeCloseTo(-4); // its RIGHT side lands on x = 0
    expect(s.snappedX).toBe(true);
  });
});

describe('snapPointToRooms', () => {
  it('a corner wins over the wall it sits on', () => {
    const s = snapPointToRooms([rectA()], { x: 3.95, y: 0.05 });
    expect(s).toEqual({ p: { x: 4, y: 0 }, hit: true });
  });

  it('falls back to the closest point on a wall segment', () => {
    const s = snapPointToRooms([rectA()], { x: 4.05, y: 1.5 });
    expect(s.hit).toBe(true);
    expect(s.p.x).toBeCloseTo(4);
    expect(s.p.y).toBeCloseTo(1.5);
  });

  it('returns the point untouched when nothing is in reach', () => {
    const p = { x: 4.5, y: 1.5 };
    expect(snapPointToRooms([rectA()], p)).toEqual({ p, hit: false });
    expect(snapPointToRooms([rectA()], { x: 3.95, y: 0.05 }, 'A').hit).toBe(false);
  });
});

describe('nextWeldSeam', () => {
  it('nudges a hairline-offset seam onto the host, without splitting', () => {
    // B's left side sits 0.6 mm off x = 4: close enough to weld, far enough
    // that the endpoint hash buckets differ and sharing has NOT fired
    const b = room('B', [
      [4.0006, 0],
      [8, 0],
      [8, 3],
      [4.0006, 3],
    ]);
    const rooms = [rectA(), b];
    expect(seam(rooms)).toHaveLength(0);

    const w = nextWeldSeam(rooms, 'B')!;
    expect(w.splits).toHaveLength(0);
    expect(w.moves).toEqual([
      { cornerId: 'Bc3', x: 4, y: 3 },
      { cornerId: 'Bc0', x: 4, y: 0 },
    ]);
    expect(w.roomIds).toEqual(['B', 'A']);
  });

  it('cuts the host wall at both ends of a partial overlap', () => {
    // B covers only y 1..2 of A's 3 m right wall
    const b = room('B', [
      [4, 1],
      [6, 1],
      [6, 2],
      [4, 2],
    ]);
    const w = nextWeldSeam([rectA(), b], 'B')!;
    expect(w.moves).toHaveLength(0);
    // both cuts land on A's right wall (start corner Ac1), at the overlap ends
    expect(w.splits).toEqual([
      { roomId: 'A', wallId: 'Ac1', t: 1, at: { x: 4, y: 1 } },
      { roomId: 'A', wallId: 'Ac1', t: 2, at: { x: 4, y: 2 } },
    ]);
  });

  it('cuts BOTH rings when the overlap is staggered', () => {
    // B runs y 1..5: it overhangs A's wall, so each ring needs one cut
    const b = room('B', [
      [4, 1],
      [6, 1],
      [6, 5],
      [4, 5],
    ]);
    const w = nextWeldSeam([rectA(), b], 'B')!;
    expect(w.moves).toHaveLength(0);
    expect(w.splits).toHaveLength(2);
    expect(w.splits.find((s) => s.roomId === 'A')).toMatchObject({
      wallId: 'Ac1',
      t: 1,
      at: { x: 4, y: 1 },
    });
    // B's left wall runs (4,5) → (4,1); the cut is 2 m down it, at A's corner
    expect(w.splits.find((s) => s.roomId === 'B')).toMatchObject({
      wallId: 'Bc3',
      t: 2,
      at: { x: 4, y: 3 },
    });
  });

  it('returns null for a gap, a short overlap, and an already-shared seam', () => {
    const off = room('B', [
      [4.005, 0],
      [8, 0],
      [8, 3],
      [4.005, 3],
    ]); // 5 mm gap
    expect(nextWeldSeam([rectA(), off], 'B')).toBeNull();
    const nib = room('B', [
      [4, 1],
      [6, 1],
      [6, 1.05],
      [4, 1.05],
    ]); // 5 cm of contact
    expect(nextWeldSeam([rectA(), nib], 'B')).toBeNull();
    expect(nextWeldSeam([rectA(), rectB()], 'B')).toBeNull(); // already shared
    expect(nextWeldSeam([rectA()], 'A')).toBeNull();
  });

  it('refuses a cut that would leave a stub too short to be a wall', () => {
    // the overlap starts 5 cm below A's corner: splitting there is illegal, and
    // silently sliding the corner 5 cm would be worse than not welding
    const b = room('B', [
      [4, 0.05],
      [6, 0.05],
      [6, 2],
      [4, 2],
    ]);
    expect(nextWeldSeam([rectA(), b], 'B')).toBeNull();
  });

  it('never welds two edges traversed the same way (overlapping rooms)', () => {
    const same = room('D', [
      [4, 0],
      [4, 3],
      [8, 3],
      [8, 0],
    ]);
    expect(nextWeldSeam([rectA(), same], 'D')).toBeNull();
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
    const over = room('Z', [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
    expect(roomContaining([rectA(), over], { x: 2, y: 1 })!.id).toBe('Z');
    expect(roomContaining([over, rectA()], { x: 2, y: 1 })!.id).toBe('A');
  });

  it('roomArea and rectangleSizeOf', () => {
    expect(roomArea(rectA())).toBeCloseTo(12);
    expect(rectangleSizeOf(rectA())).toEqual({ w: 4, d: 3 });
    const l = room('L', [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 3],
      [0, 3],
    ]);
    expect(roomArea(l)).toBeCloseTo(10);
    expect(rectangleSizeOf(l)).toBeNull();
    const skew = room('S', [
      [0, 0],
      [4, 0.5],
      [4, 3],
      [0, 3],
    ]);
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
    expect(
      new Set(makeRoom({ name: 'x', x: 0, y: 0, w: 1, d: 1 }).corners.map((c) => c.id))
    ).not.toContain(r.corners[0].id);
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
