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

import { dist, pointInPolygon, signedArea, wallGeom, type WallGeom } from './geometry';
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

/* ---------------- openings ---------------- */

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

/** Stored openings sitting on one room's own walls. */
export function openingsOfRoom(design: Design, roomId: string): Opening[] {
  const room = roomById(design.rooms, roomId);
  if (!room) return [];
  const ids = new Set(room.corners.map((c) => c.id));
  return design.openings.filter((o) => ids.has(o.wallId));
}
