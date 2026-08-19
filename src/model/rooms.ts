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
  insetPolygon,
  pointInPolygon,
  polygonIsSimple,
  segmentIntersection,
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
  type FreeWall,
  type Point,
  type Room,
  type RoomStyle,
} from './types';

/**
 * Default wall width (m). 115 mm is a real single-leaf partition — a 100 mm
 * round number is not a wall anybody builds, and every room drawn at it comes
 * out 15 mm per wall wrong against the plan it was traced from.
 */
export const DEFAULT_WALL_W = 0.115;

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
  /** owning room, or `NO_ROOM` for a free-standing chain's segment */
  roomId: string;
  /** set instead of `roomId` when this segment belongs to a `FreeWall` chain */
  freeWallId?: string;
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
        // the per-wall override is resolved HERE and nowhere else, so every
        // consumer (slabs, joints, 3D, openings, the plan) reads one number
        thickness: room.wallWidths?.[c[i].id] ?? room.style.wallThickness,
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
    // A partition is ONE physical wall, so the two twins cannot disagree about
    // how thick it is: the owner's width wins and is written onto both. Only
    // the owner draws the slab, but the follower's faceOffset (and everything
    // derived from it — openings, the 3D slab, the band centre) must describe
    // that same wall from the other side.
    const t = owner ? w.thickness : twin.thickness;
    w.thickness = t;
    twin.thickness = t;
    w.faceOffset = t / 2;
    twin.faceOffset = t / 2;
  }
}

/**
 * The sentinel `roomId` of a wall belonging to no room. Not null, so every
 * consumer that groups or compares by `roomId` keeps working unchanged; it is
 * simply an id no room can ever have.
 */
export const NO_ROOM = '';

/**
 * The free-standing chains as walls, in the SAME `RoomWall` shape the room
 * rings produce — which is the whole point: `slabQuad`, `wallJoints`,
 * `bandCenter`, opening lookup and every renderer already speak that shape, so
 * a divider needs no second code path anywhere downstream.
 *
 * A chain is OPEN, so it yields `corners.length - 1` walls rather than one per
 * corner. `faceOffset` is thickness/2 like a partition's: a free wall has no
 * interior side, so its slab straddles the polyline it was drawn on — the same
 * centreline the wall tool drew.
 */
export function freeWallGeoms(walls: FreeWall[] | undefined): RoomWall[] {
  const out: RoomWall[] = [];
  for (const chain of walls ?? []) {
    const c = chain.corners;
    for (let i = 0; i + 1 < c.length; i++) {
      // test the RAW distance: wallGeom floors its len at 1e-6, so a guard on
      // `g.len` can never fire and a duplicated point would emit a wall with a
      // direction made up out of the floor
      if (dist(c[i], c[i + 1]) < SHARE_EPS) continue;
      const g = wallGeom({ id: c[i].id, a: c[i], b: c[i + 1] });
      const t = chain.wallWidths?.[c[i].id] ?? chain.thickness;
      out.push({
        ...g,
        roomId: NO_ROOM,
        freeWallId: chain.id,
        index: i,
        thickness: t,
        faceOffset: t / 2,
        shared: null,
      });
    }
  }
  return out;
}

/** Every wall in the design: room rings first, then the free-standing chains. */
export function designWalls(rooms: Room[], walls?: FreeWall[]): RoomWall[] {
  return [...allWalls(rooms), ...freeWallGeoms(walls)];
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

/**
 * Where a wall slab's CENTRELINE sits relative to its polygon edge, measured
 * along the edge's inward normal. Room corners are the room-side wall face, so
 * an exterior wall lies wholly outside (−t/2) and a partition straddles (0).
 *
 * This is the single sanctioned bridge between the model's face-polygon
 * invariant and the centreline space the wall tool draws in — the same role
 * `faceOffset` plays for the slab itself. Never hardcode ±thickness / 2.
 */
export const bandCenter = (g: RoomWall): number => g.faceOffset - g.thickness / 2;

/** One wall's centreline, mitred into its neighbours at both ends. */
export interface Centreline {
  wallId: string;
  roomId: string;
  a: Point;
  b: Point;
}

/** A room's mitred centreline junctions, in corner order. */
export interface CentrelineRing {
  roomId: string;
  /** one point per corner: where the two incident centrelines meet */
  points: { cornerId: string; x: number; y: number }[];
}

/**
 * Every room's walls as CENTRELINE segments, plus the MITRED junction ring.
 * The two are deliberately different and are used for different jobs:
 *
 * - `segments` are each wall's own extent shifted perpendicular by
 *   `bandCenter`, so a segment ends exactly where its wall does. This is what
 *   the wall tool SNAPS to, because it is also what
 *   `Store.alignWallToCentreline` produces when it promotes that wall — snap
 *   and promotion have to agree to the millimetre or the two rings never
 *   coincide and no partition forms.
 * - `rings` are the corner ring offset per edge by `bandCenter` and
 *   re-intersected, i.e. where two centrelines actually MEET. This is where
 *   the plan draws its corner handles. A mitre runs past the wall's end (by
 *   half a thickness at a right angle), which is exactly why it must not be a
 *   snap target. A ring that degenerates under the offset — a concave corner
 *   tighter than the offset it carries — falls back to the raw corners, so a
 *   room always yields a ring rather than dropping out.
 *
 * `freeWalls`, when passed, contribute segments only — an open chain has no
 * ring to mitre. Their `bandCenter` is 0 (a free wall's slab straddles its own
 * polyline), so a free segment is exactly the chain's own corners: the wall
 * tool needs to land a NEW chain on an EXISTING one's endpoint the same way it
 * lands on a room corner.
 */
export function wallCentrelines(
  rooms: Room[],
  freeWalls?: FreeWall[]
): {
  segments: Centreline[];
  rings: CentrelineRing[];
} {
  const walls = allWalls(rooms);
  const byRoom = new Map<string, RoomWall[]>();
  for (const w of walls) {
    const list = byRoom.get(w.roomId);
    if (list) list.push(w);
    else byRoom.set(w.roomId, [w]);
  }

  const segments: Centreline[] = [];
  const rings: CentrelineRing[] = [];
  for (const room of rooms) {
    const mine = byRoom.get(room.id);
    if (!mine || mine.length < 3) continue;
    // allWalls emits in corner order per room, but sort by index rather than
    // trust that: the ring must line up index-for-index with room.corners
    const ordered = [...mine].sort((p, q) => p.index - q.index);
    const moved = insetPolygon(room.corners, ordered.map(bandCenter));
    const pts = moved ?? room.corners;
    rings.push({
      roomId: room.id,
      points: pts.map((p, i) => ({ cornerId: room.corners[i].id, x: p.x, y: p.y })),
    });
    for (const w of ordered) {
      const o = bandCenter(w);
      segments.push({
        wallId: w.id,
        roomId: room.id,
        a: { x: w.a.x + w.inward.x * o, y: w.a.y + w.inward.y * o },
        b: { x: w.b.x + w.inward.x * o, y: w.b.y + w.inward.y * o },
      });
    }
  }
  for (const w of freeWallGeoms(freeWalls)) {
    segments.push({ wallId: w.id, roomId: NO_ROOM, a: w.a, b: w.b });
  }
  return { segments, rings };
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
    wallThickness: DEFAULT_WALL_W,
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
  if (room.wallWidths) {
    const remapped: Record<string, number> = {};
    for (const [id, m] of Object.entries(room.wallWidths)) {
      remapped[map.get(id) ?? id] = m;
    }
    room.wallWidths = remapped;
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

/**
 * `snapPointToRooms`' twin for the wall tool: pull a free point onto another
 * room's wall CENTRELINE — a mitred junction within ROOM_CORNER_SNAP wins
 * outright, otherwise the closest spot on a centreline segment within
 * ROOM_EDGE_SNAP.
 *
 * Snapping the face ring (what `snapPointToRooms` does) is what left a drawn
 * corner half a wall thickness off its neighbour, so the weld had to cut the
 * mismatch into stub segments. Landing on the centreline instead means the
 * drawn room's own face ring — the centreline ring inset by its half width —
 * comes out flush with the neighbour's, which is the precondition `weld` needs
 * to make one clean partition.
 *
 * `freeWalls` (design.walls) join the same pass, so a chain being drawn also
 * snaps onto an existing open chain's corner or centreline — the wall tool's
 * OTHER kind of neighbour, with no room ring behind it at all.
 */
export function snapPointToCentrelines(
  rooms: Room[],
  p: Point,
  skipId?: string,
  freeWalls?: FreeWall[]
): PointSnap {
  const { segments } = wallCentrelines(rooms, freeWalls);
  let best: Point | null = null;
  let bestD = ROOM_CORNER_SNAP;
  // segment ENDPOINTS, not the mitred junctions: a mitre overshoots the wall's
  // real end, and a drawn edge has to match that end exactly to share it
  for (const s of segments) {
    if (s.roomId === skipId) continue;
    for (const e of [s.a, s.b]) {
      const d = dist(p, e);
      if (d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
  }
  if (best) return { p: best, hit: true };
  bestD = ROOM_EDGE_SNAP;
  for (const s of segments) {
    if (s.roomId === skipId) continue;
    const q = closestOnSegment(p, s.a, s.b);
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best ? { p: best, hit: true } : { p, hit: false };
}

/**
 * Axis-aligned CENTRELINE lines of every room but `skipId` — `snapRoomRect`'s
 * input set, moved off the face ring for the same reason
 * `snapPointToCentrelines` exists. A rectangle side landing on one of these
 * puts the new room's centreline on the neighbour's, so the two face rings end
 * up flush once the tool insets by the half width.
 *
 * `freeWalls` joins the same pass as it does in `snapPointToCentrelines`: a
 * drag-rectangle side has to be able to land on an existing open chain, which
 * has no room ring behind it at all. Without it the two gestures of the ONE
 * wall tool disagree about what counts as a neighbour.
 */
export function centrelineAxisLines(
  rooms: Room[],
  skipId?: string,
  freeWalls?: FreeWall[]
): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of wallCentrelines(rooms, freeWalls).segments) {
    if (s.roomId === skipId) continue;
    if (Math.abs(s.a.x - s.b.x) < SHARE_EPS) xs.push(s.a.x);
    if (Math.abs(s.a.y - s.b.y) < SHARE_EPS) ys.push(s.a.y);
  }
  return { xs, ys };
}

/** Everything committing a drawn ring needs, decided in ONE pass. */
export interface FaceRingPlan {
  /** per-edge inset turning the centreline ring into the stored face ring */
  offsets: number[];
  /** existing exterior walls to promote onto their centreline first, by wall id */
  promote: string[];
}

/**
 * How far each edge of a drawn CENTRELINE ring must move inward to become the
 * room-side face ring a `Room` stores — the conversion the wall tool commits
 * through, and the reason `insetPolygon` takes a per-edge offset — plus the
 * existing walls that have to move out to meet it.
 *
 * The offset is NOT uniform, because `Room.corners` means two different things
 * depending on the wall: for an EXTERIOR wall the ring is the room-side face
 * (`faceOffset` 0, the slab lies wholly outside), but for a PARTITION the ring
 * is the wall's centreline and the slab straddles it (`faceOffset` t/2). So an
 * edge that will be exterior moves in by `half`, and an edge that lands on an
 * existing wall's centreline must STAY on it — that coincidence is the whole
 * of what `allWalls` looks for when it detects a shared edge, and moving it
 * would leave the two rooms a wall's thickness apart with a weld unable to
 * close the gap (the stub segments and notched junctions this replaces).
 *
 * An edge counts as landing on a neighbour when its midpoint sits on that
 * neighbour's centreline segment and the two run parallel. A PARTIAL overlap
 * (a tee) is treated as shared for the whole edge: the weld then splits it,
 * and the remainder becomes exterior on its own.
 *
 * Both halves are computed against the SAME snapshot of the rooms, which is the
 * whole point of returning them together. Promoting a wall moves its ring edge
 * onto its centreline, and (until something actually shares it) that moves the
 * centreline too, so an offsets pass run afterwards would no longer recognise
 * the edge it just prepared. Callers promote from `promote`, then inset with
 * `offsets`; never re-derive between the two.
 */
export function faceRingPlan(rooms: Room[], ring: Point[], half: number): FaceRingPlan {
  const offsets: number[] = [];
  const promote: string[] = [];
  for (let i = 0; i < ring.length; i++) {
    const hit = centrelineEdgeHit(rooms, ring, i);
    offsets.push(hit ? 0 : half);
    if (hit && !promote.includes(hit.wallId)) promote.push(hit.wallId);
  }
  return { offsets, promote };
}

/**
 * The existing wall a drawn ring's edge `i` lands on the centreline of, or
 * null. Companion to `faceRingPlan`: the offsets say WHERE the edge goes,
 * this says WHICH wall has to be promoted to meet it there
 * (`Store.alignWallToCentreline`).
 */
export function centrelineEdgeHit(rooms: Room[], ring: Point[], i: number): Centreline | null {
  const a = ring[i];
  const b = ring[(i + 1) % ring.length];
  const len = dist(a, b);
  if (len < 1e-9) return null;
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  for (const s of wallCentrelines(rooms).segments) {
    const sl = dist(s.a, s.b);
    if (sl < 1e-9) continue;
    const sd = { x: (s.b.x - s.a.x) / sl, y: (s.b.y - s.a.y) / sl };
    // parallel either way round — a partition is traversed in reverse
    if (Math.abs(dir.x * sd.y - dir.y * sd.x) > PARALLEL_EPS) continue;
    if (dist(mid, closestOnSegment(mid, s.a, s.b)) > SHARE_EPS) continue;
    return s;
  }
  return null;
}

/** sin of the largest angle two edges may differ by and still count parallel (~0.06°). */
const PARALLEL_EPS = 1e-3;

/** An axis-aligned rectangle by its four sides, each flagged as snapped or not. */
export interface RectSides {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  snapped: { x0: boolean; y0: boolean; x1: boolean; y1: boolean };
}

/**
 * Snap each SIDE of an axis-aligned rectangle to the nearest wall centreline
 * independently — unlike `snapRoomRect`, which slides the whole rectangle and
 * so can only ever land one side of each axis.
 *
 * Independence is what a drag-rectangle needs: a new room laid alongside an
 * existing one wants its shared side ON that wall's centreline AND its two
 * flanking sides on the neighbour's, so that after the face inset all three
 * edges line up and the contact is one clean partition. Translating the
 * rectangle can satisfy the first and then miss the others by whatever the
 * caller's grid rounds to, which leaves a few-centimetre stub the weld refuses
 * to cut (its MIN_SEAM floor) and the rooms never share at all.
 *
 * A side with nothing in reach is left untouched, flagged false, for the
 * caller to grid-round.
 */
export function snapRectSides(
  rooms: Room[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  skipId?: string,
  freeWalls?: FreeWall[],
  /**
   * Reach in METRES. Defaults to the historic fixed `ROOM_SNAP_REACH`; the plan
   * passes a screen-px-derived value so a rectangle side snaps from the same
   * apparent distance at every zoom, matching the click gesture next door.
   */
  reach: number = ROOM_SNAP_REACH
): RectSides {
  const { xs, ys } = centrelineAxisLines(rooms, skipId, freeWalls);
  const near = (lines: number[], v: number): number | null => {
    let best: number | null = null;
    let bestD = reach;
    for (const l of lines) {
      const d = Math.abs(l - v);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  };
  const sx0 = near(xs, x0);
  const sx1 = near(xs, x1);
  const sy0 = near(ys, y0);
  const sy1 = near(ys, y1);
  return {
    x0: sx0 ?? x0,
    y0: sy0 ?? y0,
    x1: sx1 ?? x1,
    y1: sy1 ?? y1,
    snapped: { x0: sx0 !== null, y0: sy0 !== null, x1: sx1 !== null, y1: sy1 !== null },
  };
}

/* ---------------- splitting a room with a drawn chain ---------------- */

/** The two rings a chain cuts one room's ring into. */
export interface RoomSplit {
  /** the room that was cut */
  roomId: string;
  /** two closed rings, each already a simple polygon */
  rings: Point[][];
}

/**
 * Cut `room` in two along a drawn wall chain.
 *
 * The chain is drawn in CENTRELINE space and snaps to wall centrelines, which
 * for an exterior wall lie OUTSIDE the ring — so a chain across a room starts
 * and ends beyond the boundary and crosses it twice. Those two crossings are
 * what this finds; the chain is clipped to the part between them and used as
 * the shared edge of both halves.
 *
 * That shared edge is the chain's own centreline, which is exactly right: once
 * the two halves both hold it, `allWalls` links them and `faceOffset` t/2 makes
 * the slab straddle it. The outer arcs stay on the original ring, still the
 * room-side face of their (still exterior) walls. Both meanings of `corners`
 * hold simultaneously, which is what makes the result a legal design.
 *
 * Returns null when the chain does not cleanly cross the ring twice, or when
 * either half would be degenerate — the caller then treats the chain as a
 * free-standing wall instead of guessing.
 */
export function splitRoomByChain(room: Room, chain: Point[]): RoomSplit | null {
  if (chain.length < 2 || room.corners.length < 3) return null;
  const ring = room.corners;

  /** Chain crossings of the ring, in chain order, each with its ring position. */
  const hits: { p: Point; chainIdx: number; ringIdx: number; ringU: number }[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const found: typeof hits = [];
    for (let j = 0; j < ring.length; j++) {
      const x = segmentIntersection(chain[i], chain[i + 1], ring[j], ring[(j + 1) % ring.length]);
      if (x) found.push({ p: x.p, chainIdx: i, ringIdx: j, ringU: x.u });
    }
    // several crossings on ONE chain segment must keep their order along it
    found.sort((m, n) => dist(chain[i], m.p) - dist(chain[i], n.p));
    for (const f of found) {
      const prev = hits[hits.length - 1];
      if (prev && dist(prev.p, f.p) < SHARE_EPS) continue;
      hits.push(f);
    }
  }
  if (hits.length < 2) return null;

  // the FIRST and LAST crossings bound the part of the chain that is inside;
  // a chain that wanders out and back is not a split anybody drew on purpose
  const entry = hits[0];
  const exit = hits[hits.length - 1];
  if (entry.ringIdx === exit.ringIdx && Math.abs(entry.ringU - exit.ringU) < 1e-9) return null;

  // clipped chain: entry, every chain vertex strictly between the two
  // crossings, then exit
  const inner: Point[] = [entry.p];
  for (let i = entry.chainIdx + 1; i <= exit.chainIdx; i++) {
    const v = chain[i];
    if (dist(v, inner[inner.length - 1]) > SHARE_EPS) inner.push(v);
  }
  if (dist(exit.p, inner[inner.length - 1]) > SHARE_EPS) inner.push(exit.p);
  else inner[inner.length - 1] = exit.p;
  if (inner.length < 2) return null;

  /** Ring vertices strictly after position (idx,u), walking forward to (idx2,u2). */
  const arc = (from: typeof entry, to: typeof exit): Point[] => {
    const out: Point[] = [];
    let j = from.ringIdx;
    // start at the vertex ENDING the edge the entry sits on
    for (let step = 0; step <= ring.length; step++) {
      j = (j + 1) % ring.length;
      if (from.ringIdx === to.ringIdx && step === 0 && to.ringU > from.ringU) break;
      const atEnd = (j + ring.length - 1) % ring.length === to.ringIdx;
      if (atEnd) break;
      out.push({ x: ring[j].x, y: ring[j].y });
    }
    return out;
  };

  const ringA = [entry.p, ...arc(entry, exit), exit.p, ...[...inner].reverse().slice(1, -1)];
  const ringB = [exit.p, ...arc(exit, entry), entry.p, ...inner.slice(1, -1)];

  for (const r of [ringA, ringB]) {
    if (r.length < 3 || Math.abs(signedArea(r)) < 1e-4 || !polygonIsSimple(r)) return null;
  }
  return { roomId: room.id, rings: [ringA, ringB] };
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
