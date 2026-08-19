import { describe, expect, it } from 'vitest';
import { insetPolygon, signedArea } from '../../src/model/geometry';
import {
  allWalls,
  bandCenter,
  defaultRoomStyle,
  snapPointToCentrelines,
  faceRingPlan,
  snapRectSides,
  wallCentrelines,
} from '../../src/model/rooms';
import { Store } from '../../src/model/store';
import type { Design, FreeWall, Point, Room } from '../../src/model/types';

/**
 * The centreline layer the unified wall tool draws in, and the per-wall width
 * override it seeds. Both are pure model code — the tool itself only calls
 * these and `addRoom`, so pinning them here is what keeps the drag and the
 * click gesture producing the same walls.
 */

function room(id: string, pts: [number, number][], thickness = 0.1): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => ({ id: `${id}c${i}`, x, y })),
    style: { ...defaultRoomStyle(), wallThickness: thickness },
  };
}

const rect = (id: string, x: number, y: number, w: number, d: number, t = 0.1): Room =>
  room(
    id,
    [
      [x, y],
      [x + w, y],
      [x + w, y + d],
      [x, y + d],
    ],
    t
  );

const near = (a: Point, b: Point, eps = 1e-9): void => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  void eps;
};

describe('insetPolygon — per-edge offsets', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];
  // the ring above is CW in the y-down/signedArea sense used everywhere here
  const ccw = signedArea(square) > 0 ? square : [...square].reverse();

  it('an array of equal offsets matches the scalar form exactly', () => {
    const a = insetPolygon(ccw, 0.05)!;
    const b = insetPolygon(
      ccw,
      ccw.map(() => 0.05)
    )!;
    expect(b).toHaveLength(a.length);
    a.forEach((p, i) => near(b[i], p));
  });

  it('a wrong-length array is refused rather than read partially', () => {
    expect(insetPolygon(ccw, [0.05, 0.05])).toBeNull();
  });

  it('a negative offset grows the ring — how an exterior centreline is reached', () => {
    const out = insetPolygon(
      ccw,
      ccw.map(() => -0.05)
    )!;
    expect(Math.abs(signedArea(out))).toBeGreaterThan(Math.abs(signedArea(ccw)));
  });

  it('mixed offsets move only the edges they name', () => {
    // one thick wall on the first edge, hairlines elsewhere
    const out = insetPolygon(ccw, [0.5, 0, 0, 0])!;
    // three corners keep two of their coordinates; the thick edge moved inward
    const moved = out.filter((p, i) => Math.hypot(p.x - ccw[i].x, p.y - ccw[i].y) > 1e-9);
    expect(moved).toHaveLength(2); // the thick edge's two endpoints
  });
});

describe('wallCentrelines', () => {
  const rooms = [rect('A', 0, 0, 4, 3, 0.2)];

  it("a segment spans its wall EXACTLY — the mitre is the ring's job, not its", () => {
    const { segments, rings } = wallCentrelines(rooms);
    const walls = allWalls(rooms);
    for (const s of segments) {
      const w = walls.find((q) => q.id === s.wallId)!;
      // same length as the wall: promotion moves a wall's own endpoints, so a
      // snap target that overshot them could never produce a shared edge
      expect(Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)).toBeCloseTo(w.len, 9);
    }
    // the mitred ring, by contrast, runs past the wall end by half a thickness
    const ring = rings[0].points;
    const s0 = segments.find((q) => q.wallId === rooms[0].corners[0].id)!;
    const j = ring.find((q) => q.cornerId === rooms[0].corners[0].id)!;
    expect(Math.hypot(j.x - s0.a.x, j.y - s0.a.y)).toBeCloseTo(0.1, 9);
  });

  it('an exterior wall centreline sits half a thickness OUTSIDE the face ring', () => {
    const { rings } = wallCentrelines(rooms);
    const p = new Map(rings[0].points.map((q) => [q.cornerId, q]));
    // the ring is normalized CCW by the store, but this fixture is raw: check
    // against bandCenter rather than assuming a sign
    const walls = allWalls(rooms);
    for (const w of walls) expect(bandCenter(w)).toBeCloseTo(-0.1, 12);
    // every junction moved off its corner by the mitre of two 0.1 offsets
    for (const c of rooms[0].corners) {
      const j = p.get(c.id)!;
      expect(Math.hypot(j.x - c.x, j.y - c.y)).toBeCloseTo(Math.SQRT2 * 0.1, 9);
    }
  });

  it('a partition centreline lands ON the shared edge (faceOffset = t/2)', () => {
    const two = [rect('A', 0, 0, 4, 3), rect('B', 4, 0, 3, 3)];
    const store = new Store(design(two));
    store.weldRoom('A');
    const shared = store.allWalls().filter((w) => w.shared);
    expect(shared.length).toBeGreaterThan(0);
    for (const w of shared) expect(bandCenter(w)).toBeCloseTo(0, 12);
  });

  it('every wall gets exactly one segment, keyed by its own wall id', () => {
    const { segments } = wallCentrelines(rooms);
    expect(segments.map((s) => s.wallId).sort()).toEqual(
      allWalls(rooms)
        .map((w) => w.id)
        .sort()
    );
  });
});

describe('snapPointToCentrelines', () => {
  const rooms = [rect('A', 0, 0, 4, 3, 0.2)];
  const junctions = wallCentrelines(rooms).rings[0].points;

  it('a segment ENDPOINT within reach wins outright — never the mitred junction', () => {
    const seg = wallCentrelines(rooms).segments[0];
    const hit = snapPointToCentrelines(rooms, { x: seg.a.x + 0.04, y: seg.a.y - 0.03 });
    expect(hit.hit).toBe(true);
    near(hit.p, seg.a);
    // the mitre apex for that corner sits elsewhere and is NOT what we got
    expect(hit.p).not.toEqual({ x: junctions[0].x, y: junctions[0].y });
  });

  it('otherwise the closest point ON a centreline, not on the face ring', () => {
    const seg = wallCentrelines(rooms).segments[0];
    const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
    const hit = snapPointToCentrelines(rooms, { x: mid.x + 0.02, y: mid.y + 0.02 });
    expect(hit.hit).toBe(true);
    // it landed on the centreline, which is NOT the polygon edge
    expect(Math.hypot(hit.p.x - mid.x, hit.p.y - mid.y)).toBeLessThan(0.05);
  });

  it('nothing in reach is reported as a miss, with the point untouched', () => {
    const p = { x: 40, y: 40 };
    const miss = snapPointToCentrelines(rooms, p);
    expect(miss.hit).toBe(false);
    near(miss.p, p);
  });

  it('skipId leaves the room being edited out', () => {
    const seg = wallCentrelines(rooms).segments[0];
    expect(snapPointToCentrelines(rooms, seg.a, 'A').hit).toBe(false);
  });

  // a free-standing chain has no room ring behind it, so it only reaches the
  // snap pass if the caller ALSO hands over `design.walls` — this is the wall
  // tool's other kind of neighbour, and what starting a new wall on an
  // existing chain's endpoint depends on
  const chain: FreeWall = {
    id: 'fw1',
    corners: [
      { id: 'fa', x: 10, y: 10 },
      { id: 'fb', x: 12, y: 10 },
    ],
    thickness: 0.1,
  };

  it('a free wall endpoint is invisible without passing freeWalls', () => {
    const hit = snapPointToCentrelines(rooms, { x: 10.03, y: 10.02 });
    expect(hit.hit).toBe(false);
  });

  it('a free wall endpoint wins outright once freeWalls is passed', () => {
    const hit = snapPointToCentrelines(rooms, { x: 10.03, y: 10.02 }, undefined, [chain]);
    expect(hit.hit).toBe(true);
    near(hit.p, chain.corners[0]);
  });

  it('otherwise the closest point on the free wall centreline', () => {
    const hit = snapPointToCentrelines(rooms, { x: 11, y: 10.02 }, undefined, [chain]);
    expect(hit.hit).toBe(true);
    near(hit.p, { x: 11, y: 10 });
  });
});

describe('snapRectSides', () => {
  const rooms = [rect('A', 0, 0, 4, 3, 0.2)];
  const line = Math.max(...wallCentrelines(rooms).segments.map((s) => s.a.x));

  it('a side within reach lands exactly on a neighbour centreline', () => {
    const snap = snapRectSides(rooms, line + 0.06, 0, line + 3, 3);
    expect(snap.snapped.x0).toBe(true);
    expect(snap.x0).toBeCloseTo(line, 9);
  });

  it('each side snaps INDEPENDENTLY — a slide could only ever land one', () => {
    const ys = wallCentrelines(rooms).segments.map((s) => s.a.y);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    // all three sides that touch room A are within reach, at different offsets
    const snap = snapRectSides(rooms, line + 0.06, top + 0.07, line + 3, bottom - 0.08);
    expect(snap.snapped).toEqual({ x0: true, y0: true, x1: false, y1: true });
    expect(snap.x0).toBeCloseTo(line, 9);
    expect(snap.y0).toBeCloseTo(top, 9);
    expect(snap.y1).toBeCloseTo(bottom, 9);
  });

  it('a side with nothing in reach is left alone for the caller to grid', () => {
    const snap = snapRectSides(rooms, 40, 40, 43, 43);
    expect(snap.snapped).toEqual({ x0: false, y0: false, x1: false, y1: false });
    expect(snap.x0).toBe(40);
  });

  // the drag gesture and the click gesture are ONE tool, so they have to agree
  // about what a neighbour is: an open chain is one for the click path
  // (snapPointToCentrelines above) and must be one here too
  const chain: FreeWall = {
    id: 'fw1',
    corners: [
      { id: 'fa', x: 20, y: 10 },
      { id: 'fb', x: 20, y: 14 },
    ],
    thickness: 0.1,
  };

  it('a free chain is invisible to a rectangle side without passing freeWalls', () => {
    const snap = snapRectSides(rooms, 20.06, 10, 23, 13);
    expect(snap.snapped.x0).toBe(false);
    expect(snap.x0).toBe(20.06);
  });

  it('a rectangle side lands on a free chain centreline once freeWalls is passed', () => {
    const snap = snapRectSides(rooms, 20.06, 10, 23, 13, undefined, [chain]);
    expect(snap.snapped.x0).toBe(true);
    expect(snap.x0).toBeCloseTo(20, 9);
  });
});

describe('per-wall widths', () => {
  it('allWalls resolves the override, falling back to the room style', () => {
    const r = rect('A', 0, 0, 4, 3, 0.1);
    r.wallWidths = { Ac0: 0.3 };
    const walls = allWalls([r]);
    expect(walls.find((w) => w.id === 'Ac0')!.thickness).toBeCloseTo(0.3, 12);
    for (const w of walls) if (w.id !== 'Ac0') expect(w.thickness).toBeCloseTo(0.1, 12);
  });

  it("a partition takes the OWNER's width on both sides", () => {
    const a = rect('A', 0, 0, 4, 3);
    const b = rect('B', 4, 0, 3, 3);
    const store = new Store(design([a, b]));
    store.weldRoom('A');
    const shared = store.allWalls().filter((w) => w.shared);
    const ownerWall = shared.find((w) => w.shared!.owner)!;
    store.setWallWidth(ownerWall.id, 0.3);

    const after = store.allWalls().filter((w) => w.shared);
    for (const w of after) {
      expect(w.thickness).toBeCloseTo(0.3, 12);
      expect(w.faceOffset).toBeCloseTo(0.15, 12);
    }
  });

  it('setting a partition from the NON-owner side still edits the owner', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3), rect('B', 4, 0, 3, 3)]));
    store.weldRoom('A');
    const follower = store.allWalls().find((w) => w.shared && !w.shared.owner)!;
    store.setWallWidth(follower.id, 0.25);
    expect(store.wallWidth(follower.id)).toBeCloseTo(0.25, 12);
    expect(store.hasWallWidthOverride(follower.id)).toBe(true);
  });

  it('null clears the override back to the room default', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3, 0.12)]));
    const id = store.allWalls()[0].id;
    store.setWallWidth(id, 0.3);
    expect(store.wallWidth(id)).toBeCloseTo(0.3, 12);
    store.setWallWidth(id, null);
    expect(store.hasWallWidthOverride(id)).toBe(false);
    expect(store.wallWidth(id)).toBeCloseTo(0.12, 12);
  });

  it('splitting a wall carries the override onto BOTH halves', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3)]));
    const id = store.allWalls()[0].id;
    const len = store.wallById(id)!.len;
    store.setWallWidth(id, 0.28);
    const nc = store.splitWall(id, len / 2)!;
    expect(store.wallWidth(id)).toBeCloseTo(0.28, 12);
    expect(store.wallWidth(nc.id)).toBeCloseTo(0.28, 12);
  });

  it('a value out of range is clamped, never stored raw', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3)]));
    const id = store.allWalls()[0].id;
    store.setWallWidth(id, 9);
    expect(store.wallWidth(id)).toBeCloseTo(0.4, 12);
    store.setWallWidth(id, 0.001);
    expect(store.wallWidth(id)).toBeCloseTo(0.05, 12);
  });
});

describe('centreline ring → face polygon (what the tool commits)', () => {
  it('two rooms drawn on a shared centreline weld into ONE partition', () => {
    const store = new Store(design([]));
    const width = 0.1;
    // exactly what Plan2D.commitRing does: inset the centreline ring by w/2
    const draw = (x: number, y: number, w: number, d: number): void => {
      const ring: Point[] = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + d },
        { x, y: y + d },
      ];
      const ccw = signedArea(ring) > 0 ? ring : [...ring].reverse();
      const plan = faceRingPlan(store.design.rooms, ccw, width / 2);
      for (const id of plan.promote) store.alignWallToCentreline(id);
      const face = insetPolygon(ccw, plan.offsets)!;
      expect(store.addRoom({ polygon: face, style: { wallThickness: width } })).toBeTruthy();
    };

    draw(0, 0, 4, 3);
    // the second room's LEFT centreline is the first room's RIGHT centreline
    draw(4, 0, 3, 3);

    const shared = store.allWalls().filter((w) => w.shared);
    expect(shared.length).toBe(2); // one partition, seen from both rooms
    // and no stub: every wall is a real span, not a weld crumb
    for (const w of store.allWalls()) expect(w.len).toBeGreaterThan(0.5);

    // the partition straddles its ring edge, so BOTH interiors keep their
    // faces where they were drawn — nobody silently lost half a thickness
    for (const w of shared) expect(w.faceOffset).toBeCloseTo(width / 2, 12);
    const a = store.design.rooms[0];
    // A's ring edge moved out to the centreline…
    expect(Math.max(...a.corners.map((c) => c.x))).toBeCloseTo(4, 9);
    // …and faceOffset puts its interior face back exactly where it was drawn
    for (const w of shared) {
      const face = w.a.x + w.inward.x * w.faceOffset;
      expect(Math.abs(face - (w.roomId === a.id ? 3.95 : 4.05))).toBeLessThan(1e-9);
    }
  });

  it('a drawn edge NOT on a neighbour insets normally and stays exterior', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3)]));
    const ring: Point[] = [
      { x: 10, y: 0 },
      { x: 13, y: 0 },
      { x: 13, y: 3 },
      { x: 10, y: 3 },
    ];
    const ccw = signedArea(ring) > 0 ? ring : [...ring].reverse();
    const plan = faceRingPlan(store.design.rooms, ccw, 0.05);
    expect(plan.promote).toEqual([]);
    expect(plan.offsets).toEqual([0.05, 0.05, 0.05, 0.05]);
  });
});

describe('alignWallToCentreline', () => {
  it('moves the ring edge out by t/2 and leaves the interior alone', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3, 0.2)]));
    const before = store.floorArea('A');
    const wall = store.allWalls().find((w) => w.len > 3.5)!;
    const inward = { ...wall.inward };
    const a0 = { ...wall.a };

    expect(store.alignWallToCentreline(wall.id)).toBe(true);
    const moved = store.cornerById(wall.a.id)!;
    expect(moved.x).toBeCloseTo(a0.x - inward.x * 0.1, 9);
    expect(moved.y).toBeCloseTo(a0.y - inward.y * 0.1, 9);
    // the room grew by exactly the slab it will give back as faceOffset
    expect(store.floorArea('A')).toBeGreaterThan(before);
  });

  it('refuses a wall that is already a partition', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3), rect('B', 4, 0, 3, 3)]));
    store.weldRoom('A');
    const shared = store.allWalls().find((w) => w.shared)!;
    expect(store.alignWallToCentreline(shared.id)).toBe(false);
  });

  it('refuses a wall whose end anchors another partition', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3), rect('B', 4, 0, 3, 3)]));
    store.weldRoom('A');
    const shared = store.allWalls().find((w) => w.shared && w.roomId === 'A')!;
    // a wall of A meeting that partition at a corner must not be dragged away
    const neighbour = store
      .allWalls()
      .find(
        (w) => w.roomId === 'A' && !w.shared && (w.a.id === shared.b.id || w.b.id === shared.a.id)
      )!;
    expect(store.alignWallToCentreline(neighbour.id)).toBe(false);
  });

  it('an unknown wall id is a no-op returning false, never a throw', () => {
    const store = new Store(design([rect('A', 0, 0, 4, 3)]));
    expect(store.alignWallToCentreline('nope')).toBe(false);
  });
});

function design(rooms: Room[]): Design {
  return {
    version: 6,
    rooms,
    openings: [],
    items: [],
    customParts: [],
    variables: [],
    scene: { sunAzimuth: 135, sunElevation: 45, brightness: 1, night: false },
  } as unknown as Design;
}
