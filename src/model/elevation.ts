import { clamp, projectOnWall } from './geometry';
import { openingsOfWall, roomById, wallByIdIn } from './rooms';
import { rotationFromInward } from './snapping';
import type { Design } from './types';

/**
 * Front ("elevation") view of a single wall: the wall seen straight-on from
 * inside the room, with only the furniture that actually backs onto it.
 *
 * All geometry is pure — no store, no three.js — so it is unit-testable and
 * can later feed a manufacturing/wall-layout export. Along-wall distances run
 * left→right from the wall start corner; heights run up from the floor.
 */

export interface WallElevationItem {
  id: string;
  defId: string;
  /** along-wall centre distance from the wall start corner (m) */
  center: number;
  /** half of the item width measured along the wall (m) */
  halfW: number;
  /** bottom height above the floor (m) */
  z0: number;
  /** top height above the floor (m) */
  z1: number;
  color: string;
  /** perpendicular distance of the item centre from the wall centreline —
   *  used to draw items nearer the viewer on top */
  depth: number;
}

export interface WallElevationOpening {
  id: string;
  type: 'door' | 'window';
  /** along-wall centre distance from the wall start corner (m) */
  center: number;
  width: number;
  /** sill height (m) */
  z0: number;
  /** head height (m) */
  z1: number;
}

export interface WallElevation {
  wallId: string;
  /** the room this elevation is seen FROM (a partition has one per side) */
  roomId: string;
  roomName: string;
  /** interior length of the wall (m) */
  len: number;
  /** ceiling height (m) */
  height: number;
  thickness: number;
  /** back-to-front (against-wall first) */
  items: WallElevationItem[];
  openings: WallElevationOpening[];
}

/** how far (m) an item's back may sit off the wall face and still count as attached */
const BACK_GAP = 0.15;
/** how far (rad) an item may face off the wall's inward normal and still count */
const FACE_TOL = 0.3;

/** smallest absolute angular difference, folded into [0, π] */
function angleClose(a: number, b: number, tol: number): boolean {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d < tol;
}

/**
 * An item belongs to a wall's elevation when its back sits against that wall
 * (within a thickness of the face) AND it faces into the room off that wall.
 * Free-standing items (tables, chairs, island, ceiling lights) fail one or
 * both tests by their geometry, so they never appear.
 */
export function wallElevation(design: Design, wallId: string): WallElevation | null {
  const g = wallByIdIn(design.rooms, wallId);
  if (!g) return null;
  const room = roomById(design.rooms, g.roomId);
  const wantRot = rotationFromInward(g.inward);

  const items: WallElevationItem[] = [];
  const memberIds = new Set<string>();
  for (const it of design.items) {
    if (it.attach) continue; // mounted appliances follow their host below
    const pr = projectOnWall(g, { x: it.x, y: it.y });
    if (pr.t < -0.3 || pr.t > g.len + 0.3) continue; // beyond the wall span
    if (pr.side <= 0) continue; // outside the room (behind the wall)
    // distance from the interior wall face to the item's back plane
    const backGap = pr.side - it.d / 2 - g.faceOffset;
    if (backGap < -0.05 || backGap > BACK_GAP) continue; // not hugging this wall
    if (!angleClose(it.rotation, wantRot, FACE_TOL)) continue; // faces elsewhere
    memberIds.add(it.id);
    items.push({
      id: it.id,
      defId: it.defId,
      center: clamp(pr.t, 0, g.len),
      halfW: it.w / 2,
      z0: it.elevation,
      z1: it.elevation + it.h,
      color: it.color,
      depth: pr.side,
    });
  }
  // mounted appliances belong to whichever wall their HOST belongs to —
  // their own back sits nowhere near it (a sink is centred on the cabinet)
  for (const it of design.items) {
    if (!it.attach || !memberIds.has(it.attach.hostId)) continue;
    const pr = projectOnWall(g, { x: it.x, y: it.y });
    items.push({
      id: it.id,
      defId: it.defId,
      center: clamp(pr.t, 0, g.len),
      halfW: it.w / 2,
      z0: it.elevation,
      z1: it.elevation + it.h,
      color: it.color,
      depth: pr.side,
    });
  }

  // against-wall (small side) first so nearer items paint over them
  items.sort((a, b) => a.depth - b.depth);

  // a partition's openings are stored on the owning side; openingsOfWall
  // mirrors them so the door shows up in BOTH rooms' elevations
  const openings: WallElevationOpening[] = openingsOfWall(design, g).map((o) => ({
    id: o.id,
    type: o.type,
    center: o.offset,
    width: o.width,
    z0: o.sill,
    z1: o.sill + o.height,
  }));

  return {
    wallId,
    roomId: g.roomId,
    roomName: room?.name ?? '',
    len: g.len,
    height: room?.style.wallHeight ?? design.rooms[0].style.wallHeight,
    thickness: g.thickness,
    items,
    openings,
  };
}
