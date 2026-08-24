import { describe, expect, it } from 'vitest';
import { insetPolygon, pointInPolygon, signedArea } from '../../src/model/geometry';
import {
  allWalls,
  bandCenter,
  defaultRoomStyle,
  closeChainAgainstWalls,
  edgeCentrelineHits,
  regularizeDrawnRing,
  snapRingToNeighbours,
  snapPointToCentrelines,
  faceRingPlan,
  REGULARIZE_TOL,
  type Centreline,
  snapRectSides,
  wallCentrelines,
} from '../../src/model/rooms';
import { runChecks } from '../../src/model/checks';
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

/**
 * The three pure pieces the wall tool's commit path gained: an OVERLAP-based
 * shared-edge test, the regularize pass that heals a near-miss before the
 * 1 mm coincidence downstream has to see it, and closing a chain against the
 * walls it was drawn off. Every one of them exists because the old code failed
 * SILENTLY — a missed match commits as two parallel slabs with no warning.
 */
describe('edgeCentrelineHits — overlap, not midpoint', () => {
  const segs = (rooms: Room[], walls?: FreeWall[]): Centreline[] =>
    wallCentrelines(rooms, walls).segments;

  it('matches an edge far LONGER than the wall it runs along', () => {
    // A is 3 m tall; the drawn edge runs 9 m down the same line, so its
    // MIDPOINT falls well past A's bottom corner — the old test's blind spot
    const x = 4.05; // A's right wall centreline
    const hits = edgeCentrelineHits(segs([rect('A', 0, 0, 4, 3, 0.1)]), { x, y: 0 }, { x, y: 9 });
    expect(hits.length).toBe(1);
    expect(hits[0].overlap).toBeCloseTo(3, 6);
  });

  it('returns EVERY collinear wall an edge spans, not just the first', () => {
    // two rooms stacked; one edge drawn down both their right walls
    const rooms = [rect('A', 0, 0, 4, 3, 0.1), rect('B', 0, 3, 4, 3, 0.1)];
    const hits = edgeCentrelineHits(segs(rooms), { x: 4.05, y: 0 }, { x: 4.05, y: 6 });
    expect(hits.map((h) => h.wall.roomId).sort()).toEqual(['A', 'B']);
  });

  it('an overlap shorter than MIN_SEAM is not a shared edge', () => {
    const rooms = [rect('A', 0, 0, 4, 3, 0.1)];
    // only 5 cm of the drawn edge touches A's right wall
    const hits = edgeCentrelineHits(segs(rooms), { x: 4.05, y: 2.95 }, { x: 4.05, y: 5 });
    expect(hits).toEqual([]);
  });

  it('sees a free-standing chain, which the old midpoint test never did', () => {
    const chain: FreeWall = {
      id: 'f1',
      corners: [
        { id: 'f1a', x: 8, y: 0 },
        { id: 'f1b', x: 8, y: 4 },
      ],
      thickness: 0.1,
    };
    const hits = edgeCentrelineHits(segs([], [chain]), { x: 8, y: 0.5 }, { x: 8, y: 3.5 });
    expect(hits.length).toBe(1);
    expect(hits[0].wall.roomId).toBe('');
  });

  it('honours the tolerance: 15 mm off misses at SHARE_EPS, hits when widened', () => {
    const rooms = [rect('A', 0, 0, 4, 3, 0.1)];
    const a = { x: 4.065, y: 0.2 };
    const b = { x: 4.065, y: 2.8 };
    expect(edgeCentrelineHits(segs(rooms), a, b)).toEqual([]);
    expect(edgeCentrelineHits(segs(rooms), a, b, REGULARIZE_TOL).length).toBe(1);
  });
});

describe('regularizeDrawnRing', () => {
  it('collapses the stub a ring closed by Enter leaves behind', () => {
    // the last click landed 30 mm short of the first — the skewed-wall bug
    const ring: Point[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
      { x: 0, y: 2 },
      { x: 0.03, y: 0.01 },
    ];
    const out = regularizeDrawnRing([], undefined, ring);
    expect(out.length).toBe(4);
    near(out[0], { x: 0, y: 0 });
  });

  it('pulls a near-miss edge exactly onto the neighbour it was aimed at', () => {
    const rooms = [rect('A', 0, 0, 4, 3, 0.1)];
    // drawn 8 mm to the right of A's right-wall centreline (x = 4.05)
    const ring: Point[] = [
      { x: 4.058, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4.058, y: 3 },
    ];
    const ccwRing = signedArea(ring) > 0 ? ring : [...ring].reverse();
    const out = regularizeDrawnRing(rooms, undefined, ccwRing);
    for (const p of out) {
      if (p.x < 5) expect(p.x).toBeCloseTo(4.05, 9);
    }
  });

  it('leaves a deliberate cavity alone — 60 mm is not a near miss', () => {
    const rooms = [rect('A', 0, 0, 4, 3, 0.1)];
    const ring: Point[] = [
      { x: 4.11, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4.11, y: 3 },
    ];
    const ccwRing = signedArea(ring) > 0 ? ring : [...ring].reverse();
    const out = regularizeDrawnRing(rooms, undefined, ccwRing);
    for (const p of out) if (p.x < 5) expect(p.x).toBeCloseTo(4.11, 9);
  });
});

describe('closeChainAgainstWalls', () => {
  const A = (): Room[] => [rect('A', 0, 0, 4, 3, 0.1)];

  it('three sides drawn off a wall close into a neighbour reusing it', () => {
    // A's right-wall centreline is x = 4.05; draw out, across and back
    const chain: Point[] = [
      { x: 4.05, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4.05, y: 3 },
    ];
    const ring = closeChainAgainstWalls(A(), chain)!;
    expect(ring).toBeTruthy();
    // the closing arc is A's right wall, so the ring is exactly the rectangle
    expect(ring.length).toBe(4);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(2.95 * 3, 6);
  });

  it('rejects the arc that would swallow the host room', () => {
    const chain: Point[] = [
      { x: 4.05, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4.05, y: 3 },
    ];
    const ring = closeChainAgainstWalls(A(), chain)!;
    // A's centroid must stay OUTSIDE the room we just described
    expect(pointInPolygon({ x: 2, y: 1.5 }, ring)).toBe(false);
  });

  it('a chain across the interior is a SPLIT, and is refused here', () => {
    const chain: Point[] = [
      { x: 2, y: -0.05 },
      { x: 2, y: 3.05 },
    ];
    expect(closeChainAgainstWalls(A(), chain)).toBeNull();
  });

  it('a chain touching nothing returns null', () => {
    const chain: Point[] = [
      { x: 20, y: 0 },
      { x: 23, y: 0 },
      { x: 23, y: 3 },
    ];
    expect(closeChainAgainstWalls(A(), chain)).toBeNull();
  });
});

/**
 * The whole commit path, composed exactly as `Plan2D.commitRing` composes it:
 * regularize → faceRingPlan → promote (honouring the refusal) → inset →
 * addRoom. Plan2D itself needs a canvas, so this mirror is the closest a unit
 * test gets — and the composition is where the two reported failures lived,
 * not in any one piece.
 */
function commitRing(store: Store, centreline: Point[], width: number): boolean {
  const ring = regularizeDrawnRing(store.design.rooms, store.design.walls, [...centreline]);
  const ccwRing = signedArea(ring) > 0 ? ring : [...ring].reverse();
  const plan = faceRingPlan(store.design.rooms, ccwRing, width / 2, store.design.walls);
  const promoted = store.alignWallsToCentreline(plan.promote);
  for (let i = 0; i < plan.edgeWalls.length; i++) {
    const walls = plan.edgeWalls[i];
    if (!walls.length) continue;
    if (!walls.some((id) => promoted.has(id) || store.wallById(id)?.shared)) {
      plan.offsets[i] = width / 2;
    }
  }
  const inset = insetPolygon(ccwRing, plan.offsets);
  const face = inset && snapRingToNeighbours(store.design.rooms, inset, width / 2);
  return !!face && !!store.addRoom({ polygon: face, style: { wallThickness: width } });
}

describe('commitRing composition — the two reported failures', () => {
  it('a ring drawn 8 mm off the neighbour still welds into ONE partition', () => {
    const store = new Store(design([]));
    const w = 0.1;
    expect(
      commitRing(
        store,
        [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 3 },
          { x: 0, y: 3 },
        ],
        w
      )
    ).toBe(true);
    // the second ring's left edge misses the shared centreline by 8 mm —
    // far outside SHARE_EPS, so before regularize this committed as two
    // parallel slabs with no warning at all
    expect(
      commitRing(
        store,
        [
          { x: 4.008, y: 0 },
          { x: 7, y: 0 },
          { x: 7, y: 3 },
          { x: 4.008, y: 3 },
        ],
        w
      )
    ).toBe(true);

    const shared = store.allWalls().filter((x) => x.shared);
    expect(shared.length).toBe(2); // one partition, seen from both rooms
    for (const x of shared) expect(x.faceOffset).toBeCloseTo(w / 2, 12);
    expect(runChecks(store.design).some((c) => c.kind === 'parallelWalls')).toBe(false);
  });

  it('a ring closed 30 mm short commits square, with no skewed wall', () => {
    const store = new Store(design([]));
    // the last click landed near the first but not on it — the stub whose
    // mitre used to drag a whole wall off axis
    expect(
      commitRing(
        store,
        [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 3 },
          { x: 0, y: 3 },
          { x: 0.03, y: 0.01 },
        ],
        0.1
      )
    ).toBe(true);
    expect(store.design.rooms[0].corners.length).toBe(4);
    for (const g of store.allWalls()) {
      const axis = Math.min(Math.abs(g.dir.x), Math.abs(g.dir.y));
      expect(axis).toBeLessThan(1e-9); // every wall is exactly axis-aligned
    }
  });

  it('a REFUSED promotion downgrades to exterior, and the doubling is REPORTED', () => {
    // A and B already share a partition, so A's top wall — whose ends anchor
    // it — cannot be promoted: moving either corner would un-share the seam.
    // There is then no offset that makes the third room share it either, since
    // sharing needs the HOST's ring to move and the store forbids exactly
    // that. So the edge falls back to exterior and the two slabs land on top
    // of each other, which is the honest outcome — but it must not be a SILENT
    // one, and that is what the check is for.
    const store = new Store(design([]));
    const w = 0.1;
    commitRing(
      store,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
      w
    );
    commitRing(
      store,
      [
        { x: 4, y: 0 },
        { x: 7, y: 0 },
        { x: 7, y: 3 },
        { x: 4, y: 3 },
      ],
      w
    );
    const before = store.allWalls().length;
    expect(
      commitRing(
        store,
        [
          { x: 0, y: -3 },
          { x: 4, y: -3 },
          { x: 4, y: 0 },
          { x: 0, y: 0 },
        ],
        w
      )
    ).toBe(true);
    expect(store.allWalls().length).toBeGreaterThan(before);

    // the edge did NOT keep the 0 offset a successful promotion would have
    // earned — that is what used to push the new room's slab INTO its
    // neighbour's floor
    const c = store.design.rooms[2];
    expect(Math.max(...c.corners.map((p) => p.y))).toBeCloseTo(-0.05, 9);

    const warned = runChecks(store.design).filter((x) => x.kind === 'parallelWalls');
    expect(warned.length).toBe(1);
    expect(warned[0].severity).toBe('warn');
  });
});

describe('closeChainAgainstWalls — the end lands where the weld can use it', () => {
  const HOST = (): Room[] => [rect('A', 0, 0, 4, 3, 0.1)];

  /**
   * The chain is returned AS DRAWN — no end is moved. Nudging an end onto the
   * ring corner would shear the segment attached to it, which is the skewed
   * wall this whole change exists to stop. The end-of-edge mismatch is settled
   * later, on the face ring, by `snapRingToNeighbours`.
   */
  it('closes the chain without moving what the user drew', () => {
    const ring = closeChainAgainstWalls(HOST(), [
      { x: 4.05, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 3 },
      { x: 4.05, y: 3 },
    ])!;
    expect(ring).toBeTruthy();
    expect(ring.length).toBe(4);
    for (const p of ring) expect(Math.min(Math.abs(p.y), Math.abs(p.y - 3))).toBeCloseTo(0, 9);
  });

  it.each([
    ['mitred corners', 0, 3],
    ['wall segment ends', 0.05, 2.95],
    ['mid-wall, a partial overlap', 0.4, 2.4],
  ] as const)('commits ONE partition with the ends on the %s', (_name, y0, y1) => {
    const store = new Store(design([]));
    const w = 0.1;
    commitRing(
      store,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
      w
    );
    const ring = closeChainAgainstWalls(store.design.rooms, [
      { x: 4, y: y0 },
      { x: 7, y: y0 },
      { x: 7, y: y1 },
      { x: 4, y: y1 },
    ]);
    expect(ring).toBeTruthy();
    expect(commitRing(store, ring!, w)).toBe(true);
    expect(store.allWalls().filter((x) => x.shared).length).toBe(2);
    expect(runChecks(store.design).filter((x) => x.kind === 'parallelWalls')).toEqual([]);
  });

  it('ends too far off the wall are not a loop — the chain stays open', () => {
    // 40 mm is outside REGULARIZE_TOL: the tool must not invent a room from a
    // chain that merely passes near something
    expect(
      closeChainAgainstWalls(HOST(), [
        { x: 4.09, y: -0.05 },
        { x: 7, y: -0.05 },
        { x: 7, y: 3.05 },
        { x: 4.09, y: 3.05 },
      ])
    ).toBeNull();
  });
});

/**
 * What the ring walk could not do at all. Each of these committed as
 * free-standing walls before `closeChainAgainstWalls` moved onto the planar
 * subdivision, which is what made a plan stop growing after the second room.
 */
describe('closeChainAgainstWalls — topologies the ring walk could not reach', () => {
  const two = (): Store => {
    const store = new Store(design([]));
    commitRing(
      store,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
      0.1
    );
    commitRing(
      store,
      [
        { x: 4, y: 0 },
        { x: 7, y: 0 },
        { x: 7, y: 3 },
        { x: 4, y: 3 },
      ],
      0.1
    );
    return store;
  };

  it('a chain whose ends land on TWO DIFFERENT rooms still closes', () => {
    const store = two();
    expect(store.design.rooms.length).toBe(2);
    // across the top of both, from room A's top-left corner to room B's top-right
    const ring = closeChainAgainstWalls(
      store.design.rooms,
      [
        { x: 0, y: 0 },
        { x: 0, y: -2 },
        { x: 7, y: -2 },
        { x: 7, y: 0 },
      ],
      store.design.walls
    );
    expect(ring).toBeTruthy();
    expect(commitRing(store, ring!, 0.1)).toBe(true);
    expect(store.design.rooms.length).toBe(3);
    // it shares a wall with BOTH rooms below it
    const shared = store.allWalls().filter((w) => w.shared);
    expect(new Set(shared.map((w) => w.roomId)).size).toBe(3);
    expect(runChecks(store.design).filter((w) => w.kind === 'parallelWalls')).toEqual([]);
  });

  it('the enclosed face is taken, never the one wrapping the whole plan', () => {
    const store = two();
    const ring = closeChainAgainstWalls(
      store.design.rooms,
      [
        { x: 0, y: 0 },
        { x: 0, y: -2 },
        { x: 7, y: -2 },
        { x: 7, y: 0 },
      ],
      store.design.walls
    )!;
    // both existing rooms stay OUTSIDE what was just drawn
    for (const c of [
      { x: 2, y: 1.5 },
      { x: 5.5, y: 1.5 },
    ]) {
      expect(pointInPolygon(c, ring)).toBe(false);
    }
    expect(Math.abs(signedArea(ring))).toBeCloseTo(7 * 2, 6);
  });

  it('a chain closing against a FREE wall chain makes a room', () => {
    const store = new Store(design([]));
    commitRing(
      store,
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
      0.1
    );
    // a peninsula off the right wall, enclosing nothing on its own
    expect(
      store.addFreeWall(
        [
          { x: 4, y: 0 },
          { x: 6, y: 0 },
        ],
        0.1
      )
    ).toBeTruthy();
    store.commit();
    const ring = closeChainAgainstWalls(
      store.design.rooms,
      [
        { x: 6, y: 0 },
        { x: 6, y: 3 },
        { x: 4, y: 3 },
      ],
      store.design.walls
    );
    expect(ring).toBeTruthy();
    expect(Math.abs(signedArea(ring!))).toBeCloseTo(2 * 3, 6);
  });

  it('a chain across a room is still a SPLIT, not a face grab', () => {
    const store = two();
    expect(
      closeChainAgainstWalls(
        store.design.rooms,
        [
          { x: 2, y: -0.1 },
          { x: 2, y: 3.1 },
        ],
        store.design.walls
      )
    ).toBeNull();
  });
});
