/**
 * Multi-room derivation layer: pure functions over a `Room[]`.
 *
 * Rooms store nothing but their own CCW corner ring — every wall, and in
 * particular every SHARED wall (a partition between two rooms), is derived
 * here geometrically. Two rooms abut when one traverses an edge a→b and the
 * other traverses the very same edge b→a; the CCW invariant guarantees that
 * opposite traversal, so coincident-and-reversed is the whole test.
 *
 * No Store, no three.js, no mutation of the inputs (except where a function
 * says so). Everything is meters.
 */

import {
  clamp,
  closestOnSegment,
  convexHull,
  dist,
  distToSegment,
  pointInPolygon,
  projectOnWall,
  signedArea,
  wallGeom,
  wallPoint,
  type WallGeom,
} from './geometry';
import {
  uid,
  type Corner,
  type Design,
  type Item,
  type Opening,
  type Point,
  type Room,
  type RoomStyle,
} from './types';

/** Two edge endpoints closer than this (1 mm) count as the same point. */
export const SHARE_EPS = 1e-3;
/** Endpoint hash bucket size; the exact SHARE_EPS re-check is the authority. */
export const SHARE_QUANT = 1e-3;

export interface SharedEdge {
  roomId: string;
  wallId: string;
  /** the twin whose room comes first in rooms[] owns the partition */
  owner: boolean;
}

export interface RoomWall extends WallGeom {
  roomId: string;
  /** edge index in room.corners; the wall id is corners[index].id */
  index: number;
  thickness: number;
  /** edge → this room's wall face along `inward`: 0 exterior, thickness/2 shared */
  faceOffset: number;
  shared: SharedEdge | null;
}

/** An opening as seen from one room; `mirrored` = viewed from the twin side. */
export interface WallOpening extends Opening {
  mirrored: boolean;
}

/* ---------------- walls ---------------- */

const bucket = (v: number): number => Math.round(v / SHARE_QUANT);

const edgeKey = (a: Point, b: Point): string =>
  `${bucket(a.x)},${bucket(a.y)}|${bucket(b.x)},${bucket(b.y)}`;

/** Every room's walls, with shared partitions cross-linked. O(total walls). */
export function allWalls(rooms: Room[]): RoomWall[] {
  const walls: RoomWall[] = [];
  const order = new Map<string, number>();
  rooms.forEach((room, r) => {
    order.set(room.id, r);
    const c = room.corners;
    for (let i = 0; i < c.length; i++) {
      const g = wallGeom({ id: c[i].id, a: c[i], b: c[(i + 1) % c.length] });
      walls.push({
        ...g,
        roomId: room.id,
        index: i,
        thickness: room.style.wallThickness,
        faceOffset: 0,
        shared: null,
      });
    }
  });
  linkShared(walls, order);
  return walls;
}

function linkShared(walls: RoomWall[], order: Map<string, number>): void {
  const byKey = new Map<string, RoomWall>();
  for (const w of walls) byKey.set(edgeKey(w.a, w.b), w);
  for (const w of walls) {
    if (w.shared) continue;
    const twin = byKey.get(edgeKey(w.b, w.a));
    if (!twin || twin === w || twin.shared || twin.roomId === w.roomId) continue;
    if (dist(w.a, twin.b) > SHARE_EPS || dist(w.b, twin.a) > SHARE_EPS) continue;
    const owner = (order.get(w.roomId) ?? 0) < (order.get(twin.roomId) ?? 0);
    w.shared = { roomId: twin.roomId, wallId: twin.id, owner };
    twin.shared = { roomId: w.roomId, wallId: w.id, owner: !owner };
    w.faceOffset = w.thickness / 2;
    twin.faceOffset = twin.thickness / 2;
  }
}

/** One room's walls, in corner order. */
export function wallsOf(rooms: Room[], roomId: string): RoomWall[] {
  return allWalls(rooms).filter((w) => w.roomId === roomId);
}

/** Wall id (start corner id) → wall; ids are unique design-wide. */
export function wallIndex(rooms: Room[]): Map<string, RoomWall> {
  const m = new Map<string, RoomWall>();
  for (const w of allWalls(rooms)) m.set(w.id, w);
  return m;
}

export function wallByIdIn(rooms: Room[], wallId: string): RoomWall | undefined {
  return allWalls(rooms).find((w) => w.id === wallId);
}

/* ---------------- wall slabs + joints ---------------- */

/**
 * The wall slab as a BUTT-ENDED quad in world space, `[aIn, bIn, bOut, aOut]`:
 * the room-side face runs `faceOffset` along `inward` from the polygon edge,
 * the outer face a further `thickness` back. Nothing is extended past a corner
 * — every junction is closed by `wallJoints` instead, which is the only scheme
 * that also works for partition↔exterior tees and non-90° corners.
 */
export function slabQuad(g: RoomWall): [Point, Point, Point, Point] {
  const at = (p: Point, o: number): Point => ({
    x: p.x + g.inward.x * o,
    y: p.y + g.inward.y * o,
  });
  const outer = g.faceOffset - g.thickness;
  return [at(g.a, g.faceOffset), at(g.b, g.faceOffset), at(g.b, outer), at(g.a, outer)];
}

/** A welded junction and the convex patch that closes it. */
export interface Joint {
  /** the point every incident wall ends at */
  at: Point;
  /** convex polygon covering what the butt-ended slabs leave open */
  hull: Point[];
  /** the DRAWN walls meeting here — a partition counts once (its owner twin) */
  walls: RoomWall[];
}

/**
 * A miter apex farther than this multiple of the wall thickness is dropped, so
 * an acute corner gets a bevel instead of a spike (same idea as canvas'
 * lineJoin miterLimit). Rooms rarely turn tighter than ~30°, which is where
 * this cuts in.
 */
const MITER_LIMIT = 4;

/** One wall's cross-section where it lands on a junction. */
interface JointEnd {
  wall: RoomWall;
  /** the wall endpoint sitting on the junction */
  at: Point;
  /** unit direction leading AWAY from the junction along the wall */
  out: Point;
  /** the slab's two corners at this end: room-side face, then outer face */
  inn: Point;
  outer: Point;
}

/**
 * Every welded junction of `walls`, as a convex patch to fill.
 *
 * Endpoints are grouped by the same SHARE_QUANT bucket that detects shared
 * edges, so exactly the corners the model treats as welded produce a joint.
 * The patch is the convex hull of every incident slab's end cross-section plus
 * — between each angularly adjacent PAIR of walls — the point where their
 * facing slab edges meet, which is what makes a plain 90° corner come out
 * square rather than chamfered. Junctions where that hull is degenerate are
 * dropped: a lone dead-end, or the collinear pass-through corner a weld split
 * leaves behind, is already covered by the straight slabs.
 */
export function wallJoints(walls: RoomWall[]): Joint[] {
  const groups = new Map<string, JointEnd[]>();
  const add = (p: Point, end: JointEnd): void => {
    const key = `${bucket(p.x)},${bucket(p.y)}`;
    const list = groups.get(key);
    if (list) list.push(end);
    else groups.set(key, [end]);
  };
  for (const w of walls) {
    // both halves of a partition describe the same slab — only the owner draws
    if (w.shared && !w.shared.owner) continue;
    const [aIn, bIn, bOut, aOut] = slabQuad(w);
    add(w.a, { wall: w, at: w.a, out: w.dir, inn: aIn, outer: aOut });
    add(w.b, { wall: w, at: w.b, out: { x: -w.dir.x, y: -w.dir.y }, inn: bIn, outer: bOut });
  }

  const joints: Joint[] = [];
  for (const ends of groups.values()) {
    if (new Set(ends.map((e) => e.wall.id)).size < 2) continue;
    const at = jointCentre(ends);
    const pts = ends.flatMap((e) => [e.inn, e.outer]);
    const cap = MITER_LIMIT * Math.max(...ends.map((e) => e.wall.thickness));
    const ring = [...ends].sort(
      (a, b) => Math.atan2(a.out.y, a.out.x) - Math.atan2(b.out.y, b.out.x)
    );
    for (let i = 0; i < ring.length; i++) {
      const m = miterPoint(ring[i], ring[(i + 1) % ring.length]);
      if (m && dist(m, at) <= cap) pts.push(m);
    }
    const hull = convexHull(pts);
    if (Math.abs(signedArea(hull)) < 1e-6) continue;
    joints.push({ at, hull, walls: ends.map((e) => e.wall) });
  }
  return joints;
}

/** Bucketed endpoints agree only to a millimetre; average them so the patch is centred. */
function jointCentre(ends: JointEnd[]): Point {
  let x = 0;
  let y = 0;
  for (const e of ends) {
    x += e.at.x;
    y += e.at.y;
  }
  return { x: x / ends.length, y: y / ends.length };
}

/**
 * Where the slab edges bounding the sector CCW-between `e` and `f` meet. Each
 * wall contributes the edge on the side facing that sector: `e`'s left edge and
 * `f`'s right edge, "left" being the side the left normal of its outgoing
 * direction points to. Null when the two edges are parallel — the collinear
 * pass-through a weld split leaves, which needs no patch.
 */
function miterPoint(e: JointEnd, f: JointEnd): Point | null {
  const side = (end: JointEnd, want: 'left' | 'right'): Point => {
    const n = { x: -end.out.y, y: end.out.x };
    const innIsLeft = (end.inn.x - end.outer.x) * n.x + (end.inn.y - end.outer.y) * n.y >= 0;
    return innIsLeft === (want === 'left') ? end.inn : end.outer;
  };
  const pe = side(e, 'left');
  const pf = side(f, 'right');
  const cross = e.out.x * f.out.y - e.out.y * f.out.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = pf.x - pe.x;
  const dy = pf.y - pe.y;
  const s = (dx * f.out.y - dy * f.out.x) / cross;
  return { x: pe.x + e.out.x * s, y: pe.y + e.out.y * s };
}

/* ---------------- room lookups ---------------- */

export function roomById(rooms: Room[], id: string): Room | undefined {
  return rooms.find((r) => r.id === id);
}

export function roomOfCorner(rooms: Room[], cornerId: string): Room | undefined {
  return rooms.find((r) => r.corners.some((c) => c.id === cornerId));
}

/** A wall is keyed by its start corner, so it belongs to that corner's room. */
export function roomOfWall(rooms: Room[], wallId: string): Room | undefined {
  return roomOfCorner(rooms, wallId);
}

/** Room whose polygon contains p; the LAST match wins when rooms overlap. */
export function roomContaining(rooms: Room[], p: Point): Room | undefined {
  let hit: Room | undefined;
  for (const r of rooms) if (pointInPolygon(p, r.corners)) hit = r;
  return hit;
}

/**
 * The room an item belongs to: its cached `roomId` when it still resolves,
 * otherwise the room its centre falls in, otherwise the first room.
 */
export function roomOfItem(design: Design, item: Item): Room | undefined {
  const cached = item.roomId ? roomById(design.rooms, item.roomId) : undefined;
  if (cached) return cached;
  return roomContaining(design.rooms, { x: item.x, y: item.y }) ?? design.rooms[0];
}

/** Finishes an item renders against (worktop colour, ceiling height, …). */
export function styleOfItem(design: Design, item: Item): RoomStyle {
  return roomOfItem(design, item)?.style ?? design.rooms[0]?.style ?? defaultRoomStyle();
}

export function roomArea(room: Room): number {
  return Math.abs(signedArea(room.corners));
}

/** Width/depth when the room is an axis-aligned 4-corner rectangle. */
export function rectangleSizeOf(room: Room): { w: number; d: number } | null {
  const c = room.corners;
  if (c.length !== 4) return null;
  const eps = 1e-3;
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    if (Math.abs(a.x - b.x) > eps && Math.abs(a.y - b.y) > eps) return null;
  }
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
}

/* ---------------- construction ---------------- */

export function defaultRoomStyle(): RoomStyle {
  return {
    wallColor: '#f4f1ea',
    floorColor: '#cfccc6',
    counterColor: '#c9a87c',
    wallHeight: 2.6,
    wallThickness: 0.1,
  };
}

/** A CCW rectangular room with (x, y) as its top-left corner in plan space. */
export function makeRoom(o: {
  name: string;
  x: number;
  y: number;
  w: number;
  d: number;
  style?: Partial<RoomStyle>;
}): Room {
  const c = (x: number, y: number): Corner => ({ id: uid('c'), x, y });
  return {
    id: uid('room'),
    name: o.name,
    corners: [c(o.x, o.y), c(o.x + o.w, o.y), c(o.x + o.w, o.y + o.d), c(o.x, o.y + o.d)],
    style: { ...defaultRoomStyle(), ...o.style },
  };
}

/**
 * Re-id every corner in place (corner ids must stay unique design-wide, so a
 * duplicated room cannot keep them) and return old→new. The room's own
 * wallVisibility keys are wall ids, so they are remapped along with it;
 * openings live outside the room and are the caller's to remap.
 */
export function reidCorners(room: Room): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of room.corners) {
    const next = uid('c');
    map.set(c.id, next);
    c.id = next;
  }
  if (room.wallVisibility) {
    const remapped: Record<string, (typeof room.wallVisibility)[string]> = {};
    for (const [id, mode] of Object.entries(room.wallVisibility)) {
      remapped[map.get(id) ?? id] = mode;
    }
    room.wallVisibility = remapped;
  }
  return map;
}

/* ---------------- placement snapping ---------------- */

/**
 * Reach of the room-level snaps. They mirror the item-level ones in
 * snapping.ts (WALL_SNAP_DIST / EDGE_SNAP_DIST): a placed rectangle or a
 * dragged corner this close to another room lands EXACTLY on it, which is the
 * precondition the weld below needs to turn the contact into a partition.
 */
export const ROOM_SNAP_REACH = 0.25;
export const ROOM_CORNER_SNAP = 0.15;
export const ROOM_EDGE_SNAP = 0.09;
/** Shortest weldable seam — also the shortest stub splitWall will leave. */
export const MIN_SEAM = 0.1;

/** Axis-aligned wall lines of every room but `skipId`, split by orientation. */
function axisLines(rooms: Room[], skipId?: string): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rooms) {
    if (r.id === skipId) continue;
    const c = r.corners;
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      if (Math.abs(a.x - b.x) < SHARE_EPS) xs.push(a.x);
      if (Math.abs(a.y - b.y) < SHARE_EPS) ys.push(a.y);
    }
  }
  return { xs, ys };
}

/** Shift putting one of `edges` on the nearest line, or null when none is in reach. */
function flushDelta(lines: number[], edges: number[]): number | null {
  let best: number | null = null;
  let bestD = ROOM_SNAP_REACH;
  for (const line of lines) {
    for (const e of edges) {
      const d = Math.abs(line - e);
      if (d < bestD) {
        bestD = d;
        best = line - e;
      }
    }
  }
  return best;
}

export interface RectSnap extends Point {
  snappedX: boolean;
  snappedY: boolean;
}

/**
 * Slide an axis-aligned w×d rectangle (x/y is its min corner) so that a side
 * within reach of a parallel wall line of another room lands exactly on it.
 * The two axes snap independently, so a rectangle corner near an existing room
 * corner ends up coinciding with it. Callers keep their own grid rounding on
 * whichever axis did not snap.
 */
export function snapRoomRect(
  rooms: Room[],
  x: number,
  y: number,
  w: number,
  d: number,
  skipId?: string
): RectSnap {
  const { xs, ys } = axisLines(rooms, skipId);
  const dx = flushDelta(xs, [x, x + w]);
  const dy = flushDelta(ys, [y, y + d]);
  return { x: x + (dx ?? 0), y: y + (dy ?? 0), snappedX: dx !== null, snappedY: dy !== null };
}

export interface PointSnap {
  p: Point;
  /** whether a corner or wall of another room was in reach */
  hit: boolean;
}

/**
 * Pull a free point onto another room's geometry: a corner within
 * ROOM_CORNER_SNAP wins outright, otherwise the closest spot on a wall segment
 * within ROOM_EDGE_SNAP. `skipId` leaves the room being edited out.
 */
export function snapPointToRooms(rooms: Room[], p: Point, skipId?: string): PointSnap {
  let best: Point | null = null;
  let bestD = ROOM_CORNER_SNAP;
  for (const r of rooms) {
    if (r.id === skipId) continue;
    for (const c of r.corners) {
      const d = dist(p, c);
      if (d < bestD) {
        bestD = d;
        best = { x: c.x, y: c.y };
      }
    }
  }
  if (best) return { p: best, hit: true };
  bestD = ROOM_EDGE_SNAP;
  for (const r of rooms) {
    if (r.id === skipId) continue;
    const c = r.corners;
    for (let i = 0; i < c.length; i++) {
      const q = closestOnSegment(p, c[i], c[(i + 1) % c.length]);
      const d = dist(p, q);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
  }
  return best ? { p: best, hit: true } : { p, hit: false };
}

/* ---------------- welding adjacent rooms ---------------- */

export interface WeldSplit {
  roomId: string;
  /** wall to cut, by start-corner id */
  wallId: string;
  /** distance along that wall from its start */
  t: number;
  /** the seam point — both rings must land on it bit-identically */
  at: Point;
}

/** A hairline gap closed by pulling one corner onto the host's coordinates. */
export interface WeldMove {
  cornerId: string;
  x: number;
  y: number;
}

/** One contact stretch, as the ring surgery that turns it into a partition. */
export interface WeldSeam {
  /** rooms whose corner ring the surgery touches — renormalize each */
  roomIds: string[];
  splits: WeldSplit[];
  moves: WeldMove[];
}

/**
 * The next stretch where `roomId` lies flush against another room without the
 * two rings sharing an edge yet, expressed as the corner insertions (and
 * sub-millimetre nudges) that would make them. Pure: nothing here mutates.
 *
 * One seam per call — a split re-keys walls, so the caller applies this, then
 * asks again against the re-derived walls.
 */
export function nextWeldSeam(rooms: Room[], roomId: string): WeldSeam | null {
  const walls = allWalls(rooms);
  // corners anchoring an existing partition may not be nudged: moving one
  // silently un-shares the seam it already holds together
  const locked = new Set<string>();
  for (const w of walls) if (w.shared) locked.add(w.a.id).add(w.b.id);
  for (const e of walls) {
    if (e.roomId !== roomId || e.shared) continue;
    for (const f of walls) {
      if (f.roomId === roomId || f.shared) continue;
      const seam = seamOps(e, f, locked);
      if (seam) return seam;
    }
  }
  return null;
}

/**
 * Weld edge `e` (of the room being placed) onto the colinear host edge `f`.
 * `f`'s line is the authority: every seam point is derived from it, so both
 * rings end up with the same coordinates bit for bit — which is exactly what
 * `linkShared` above tests for.
 *
 * Partial overlaps are the interesting case: whichever ring lacks a corner at
 * an end of the overlap interval gets one cut in there, so a 1 m room welded
 * against the middle of a 4 m wall leaves the host with three walls and the
 * middle one shared.
 */
function seamOps(e: RoomWall, f: RoomWall, locked: Set<string>): WeldSeam | null {
  // two rooms flush along an edge always traverse it in opposite directions
  if (e.dir.x * f.dir.x + e.dir.y * f.dir.y > -0.9999) return null;
  const pa = projectOnWall(f, e.a);
  const pb = projectOnWall(f, e.b);
  if (Math.abs(pa.side) > SHARE_EPS || Math.abs(pb.side) > SHARE_EPS) return null;
  // `e` runs backwards along `f`, so e.a sits at the high end of the overlap
  const lo = Math.max(0, pb.t);
  const hi = Math.min(f.len, pa.t);
  if (hi - lo < MIN_SEAM) return null;
  // fold hairline stubs onto the host's own corners
  const tLo = lo <= SHARE_EPS ? 0 : lo;
  const tHi = hi >= f.len - SHARE_EPS ? f.len : hi;
  const pLo = tLo === 0 ? { x: f.a.x, y: f.a.y } : wallPoint(f, tLo);
  const pHi = tHi === f.len ? { x: f.b.x, y: f.b.y } : wallPoint(f, tHi);

  const seam: WeldSeam = { roomIds: [e.roomId, f.roomId], splits: [], moves: [] };
  const ok =
    cutOrNudge(seam, e, pa.t - tHi, pHi, locked) &&
    cutOrNudge(seam, e, pa.t - tLo, pLo, locked) &&
    cutOrNudge(seam, f, tLo, pLo, locked) &&
    cutOrNudge(seam, f, tHi, pHi, locked);
  if (!ok) return null;
  // nothing to do means the pair is already welded — say so, or the caller loops
  return seam.splits.length || seam.moves.length ? seam : null;
}

/**
 * Make `wall` hold a corner exactly at `at`, `t` along it: a sub-millimetre gap
 * is a nudge of the nearer end corner, anything longer is a real cut. False
 * when the cut would leave a stub too short to be a wall — the pair is then
 * left unwelded rather than have its geometry fudged.
 */
function cutOrNudge(
  seam: WeldSeam,
  wall: RoomWall,
  t: number,
  at: Point,
  locked: Set<string>
): boolean {
  const end = t <= SHARE_EPS ? wall.a : wall.len - t <= SHARE_EPS ? wall.b : null;
  if (end) {
    if (end.x === at.x && end.y === at.y) return true;
    if (locked.has(end.id)) return false;
    seam.moves.push({ cornerId: end.id, x: at.x, y: at.y });
    return true;
  }
  if (t < MIN_SEAM || wall.len - t < MIN_SEAM) return false;
  seam.splits.push({ roomId: wall.roomId, wallId: wall.id, t, at });
  return true;
}

/* ---------------- openings ---------------- */

/** Wall geometry by start-corner id for one ring. */
export function ringWalls(pts: Corner[]): Map<string, WallGeom> {
  const m = new Map<string, WallGeom>();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    m.set(a.id, wallGeom({ id: a.id, a, b: pts[(i + 1) % pts.length] }));
  }
  return m;
}

/**
 * Re-home openings from a replaced ring onto whichever NEW wall is nearest to
 * each opening's old world position. Unlike migrate's reprojectOpenings (which
 * relies on corner ids surviving), this one assumes every id changed — it is
 * for wholesale outline swaps like the shape presets. Mutates the openings.
 */
export function reprojectOpeningsNearest(
  before: Corner[],
  after: Corner[],
  openings: Opening[]
): void {
  const oldWalls = ringWalls(before);
  const newWalls = [...ringWalls(after).values()];
  if (!newWalls.length) return;
  for (const o of openings) {
    const g0 = oldWalls.get(o.wallId);
    if (!g0 || !Number.isFinite(o.offset)) continue;
    const p = wallPoint(g0, o.offset);
    let best = newWalls[0];
    let bestD = Infinity;
    for (const g of newWalls) {
      const d = distToSegment(p, g.a, g.b);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    o.wallId = best.id;
    o.offset = clamp(projectOnWall(best, p).t, o.width / 2, best.len - o.width / 2);
  }
}

/**
 * The same opening as seen from the other side of a shared wall. The twin edge
 * runs in the opposite direction, and `Opening.offset` is the opening CENTRE
 * from the wall start (types.ts; see normalizeDesign's CCW flip, which mirrors
 * the same way), so the mirrored centre is simply `twinLen - offset` — no
 * width term. Hinge/swing are resolved to their defaults before flipping so an
 * implicit 'left'/'in' cannot survive as an unflipped implicit default.
 */
export function mirrorOpening(o: Opening, twinWallId: string, twinLen: number): WallOpening {
  return {
    ...o,
    wallId: twinWallId,
    offset: twinLen - o.offset,
    hinge: (o.hinge ?? 'left') === 'left' ? 'right' : 'left',
    swing: (o.swing ?? 'in') === 'in' ? 'out' : 'in',
    mirrored: true,
  };
}

/**
 * Move a STORED opening onto the other side of a partition, in place — the
 * room that held it is going away, so the twin has to keep the door. Same flip
 * as `mirrorOpening` (the non-mutating view form); `mirrored` is a view flag
 * only and has no place in the stored shape.
 */
export function rehomeOpening(o: Opening, twinWallId: string, twinLen: number): void {
  const { mirrored: _viewFlag, ...stored } = mirrorOpening(o, twinWallId, twinLen);
  Object.assign(o, stored);
}

/**
 * Every opening visible on a wall: the ones stored against it, plus — when it
 * is a partition — the twin's, mirrored into this side's frame. Sanitize homes
 * shared-wall openings on the owner, so in practice only one side stores them;
 * this stays symmetric so either side can be asked.
 */
export function openingsOfWall(design: Design, wall: RoomWall): WallOpening[] {
  const twinId = wall.shared?.wallId;
  const out: WallOpening[] = [];
  for (const o of design.openings) {
    if (o.wallId === wall.id) out.push({ ...o, mirrored: false });
    else if (twinId && o.wallId === twinId) out.push(mirrorOpening(o, wall.id, wall.len));
  }
  return out;
}
