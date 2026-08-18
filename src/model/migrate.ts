/**
 * Versioned design migrations. Every step takes the raw parsed JSON of version
 * N and returns the raw JSON of version N+1 — no validation, no repair: that is
 * sanitizeDesign's job, and it always runs afterwards. Keeping the steps dumb
 * is what makes them cheap to keep forever.
 */

import { clamp, insetPolygon, projectOnWall, wallPoint } from './geometry';
import { defaultRoomStyle, ringWalls } from './rooms';
import { uid, type Corner, type Item, type Opening, type RoomStyle } from './types';

export const DESIGN_VERSION = 7;
/** Designs older than this predate the preset cut and cannot be migrated. */
export const MIN_MIGRATABLE_VERSION = 5;

type Raw = Record<string, unknown>;

const MIGRATIONS: Record<number, (d: Raw) => Raw> = { 5: migrate5to6, 6: migrate6to7 };

/**
 * v6 → v7: `walls` (free-standing wall chains) joins the design. Nothing to
 * convert — a v6 design simply had none — but the version gates it, so an
 * older build refuses the file outright instead of loading it and silently
 * dropping every divider on the next save.
 */
function migrate6to7(d: Raw): Raw {
  d.walls = [];
  d.version = 7;
  return d;
}

/**
 * Step a raw design up to DESIGN_VERSION, or null when there is no path.
 * Mutates (and returns) the object it is handed — callers pass a copy.
 */
export function migrateDesign(raw: Raw): Raw | null {
  let d = raw;
  // one iteration per version step; the bound also guards a cyclic MIGRATIONS map
  for (let guard = 0; guard <= Object.keys(MIGRATIONS).length; guard++) {
    const v = d.version;
    if (typeof v !== 'number' || !Number.isInteger(v)) return null;
    if (v === DESIGN_VERSION) return d;
    if (v < MIN_MIGRATABLE_VERSION) return null;
    const step = MIGRATIONS[v];
    if (!step) return null;
    d = step(d);
  }
  return null;
}

/**
 * v5 (single `corners` polygon + global `room` style) → v6 (`rooms: Room[]`).
 *
 * v5 corners were wall CENTRELINES; v6 corners are the room-side wall face, so
 * the polygon is inset by half the wall thickness. Corner ids survive the inset
 * (wall ids are start-corner ids), and every opening is re-projected from its
 * old wall onto the new one so it keeps its along-wall position.
 */
export function migrate5to6(d: Raw): Raw {
  const corners = (Array.isArray(d.corners) ? d.corners : []) as Corner[];
  const style: RoomStyle = {
    ...defaultRoomStyle(),
    ...(d.room && typeof d.room === 'object' ? (d.room as Partial<RoomStyle>) : {}),
  };

  if (corners.length >= 3) {
    const t =
      Number.isFinite(style.wallThickness) && style.wallThickness > 0
        ? style.wallThickness
        : defaultRoomStyle().wallThickness;
    // a null inset (self-intersecting, over-thick, or clockwise input) leaves
    // the polygon on the old centreline — off by t/2, but never destroyed
    const inner = insetPolygon(corners, t / 2);
    if (inner) {
      reprojectOpenings(corners, inner, Array.isArray(d.openings) ? (d.openings as Opening[]) : []);
      d.corners = inner;
    }
  }

  const room: Raw = {
    id: uid('room'),
    name: 'Room 1',
    corners: d.corners,
    style,
  };
  if (d.wallVisibility !== undefined) room.wallVisibility = d.wallVisibility;
  if (d.ceilingVisibility !== undefined) room.ceilingVisibility = d.ceilingVisibility;

  // < 3 corners is unusable; an empty rooms array makes sanitizeDesign bail
  const usable = corners.length >= 3;
  d.rooms = usable ? [room] : [];
  if (usable && Array.isArray(d.items)) {
    for (const it of d.items as Item[]) {
      if (it && typeof it === 'object') it.roomId = room.id as string;
    }
  }

  delete d.corners;
  delete d.room;
  delete d.wallVisibility;
  delete d.ceilingVisibility;
  d.version = 6;
  return d;
}

/** Move every opening onto the moved ring, keeping its world position. */
function reprojectOpenings(before: Corner[], after: Corner[], openings: Opening[]): void {
  const oldWalls = ringWalls(before);
  const newWalls = ringWalls(after);
  for (const o of openings) {
    if (!o || typeof o !== 'object') continue;
    const g0 = oldWalls.get(o.wallId);
    const g1 = newWalls.get(o.wallId);
    if (!g0 || !g1 || !Number.isFinite(o.offset)) continue;
    o.offset = clamp(projectOnWall(g1, wallPoint(g0, o.offset)).t, 0, g1.len);
  }
}
