import { defOfDesign } from './attach';
import { isDecorative } from './catalog';
import {
  angleClose,
  obbCorners,
  polygonBounds,
  projectOnWall,
  segmentIntersection,
  wallPoint,
} from './geometry';
import { roomOfItem, slabQuad, styleOfItem, wallsOf, type RoomWall } from './rooms';
import { rotationFromInward } from './snapping';
import type { Design, Item, Point, Room } from './types';

/**
 * Fit-to-room — pure geometry over a Design. No Store, no UI, no mutation
 * except the one pass that applies what it computed.
 *
 * `item.fit` is a PERSISTENT request, not a one-shot action: `width: 'walls'`
 * asks the item to span its wall between whatever bounds it on either side,
 * `height: 'ceiling'` asks it to reach the room's ceiling. Because the flags
 * live in the Design, the answer has to be recomputed whenever anything they
 * read could have moved — that is `syncFits`, shaped exactly like
 * `syncAttachments` (src/model/attach.ts).
 *
 * ORDER: `syncFits` runs BEFORE `syncAttachments`. Fitting moves a host's
 * CENTRE, and a counter/zone anchor is host-LOCAL, so resolving attachments
 * against a pre-fit centre puts every mounted appliance in the wrong place.
 */

/** how far an item's rotation may differ from the wall's own facing */
export const FIT_ROT_TOL = 0.06;
/** how far the item's back face may sit off the wall face and still hug it */
export const FIT_BACK_TOL = 0.05;
/**
 * How far off the back line the width probe starts. On the line itself the
 * host wall's face — and every collinear continuation of it — would be a
 * degenerate collinear case; a centimetre in, `segmentIntersection`'s parallel
 * test discards them cleanly and a neighbouring wall's face is hit well inside
 * its own extent rather than exactly at its endpoint.
 */
export const FIT_PROBE_EPS = 0.01;
/** a fitted run narrower than this is not a run; the width keys are dropped */
export const FIT_MIN_W = 0.3;
/** likewise for a fitted height (an item mounted at or above the ceiling) */
export const FIT_MIN_H = 0.1;
/** see `syncFits` — one ascending pass settles a wall, the rest close corners */
export const MAX_FIT_PASSES = 3;

/** Everything fitting can change about an item; absent = leave it alone. */
export interface FitPatch {
  w?: number;
  h?: number;
  x?: number;
  y?: number;
}

/** below this a "new" value is the value the item already has */
const EPS = 1e-6;

interface Hug {
  room: Room;
  wall: RoomWall;
  /** distance along the wall of the item's centre */
  t: number;
}

const dot = (p: Point, n: Point): number => p.x * n.x + p.y * n.y;
const rel = (p: Point, o: Point): Point => ({ x: p.x - o.x, y: p.y - o.y });
const along = (o: Point, n: Point, s: number): Point => ({ x: o.x + n.x * s, y: o.y + n.y * s });

/**
 * The wall this item stands back-against, or null. Deliberately NOT
 * `snapping.ts`'s `nearestWall`: that one takes a Store and answers "which
 * wall is closest", while fitting only cares whether the item is already
 * placed the way `snapItem` would have placed it — same facing, back on the
 * face, within the wall's own span.
 */
function hugWall(design: Design, item: Item): Hug | null {
  const room = roomOfItem(design, item);
  if (!room) return null;
  let best: { wall: RoomWall; t: number; err: number } | null = null;
  for (const wall of wallsOf(design.rooms, room.id)) {
    if (!angleClose(item.rotation, rotationFromInward(wall.inward), FIT_ROT_TOL)) continue;
    const pr = projectOnWall(wall, { x: item.x, y: item.y });
    if (pr.t < -0.05 || pr.t > wall.len + 0.05) continue;
    // pr.side measures the item's CENTRE off the ring edge; its back sits d/2
    // behind that, and the wall face this room sees is `faceOffset` in
    const err = Math.abs(pr.side - item.d / 2 - wall.faceOffset);
    if (err > FIT_BACK_TOL) continue;
    if (!best || err < best.err) best = { wall, t: pr.t, err };
  }
  return best ? { room, wall: best.wall, t: best.t } : null;
}

/**
 * How far the item can grow either way along its wall, and where that puts it.
 * Null when a side is unbounded (the probe escaped the room) or the alcove is
 * too narrow to be one.
 */
function fitWidth(
  design: Design,
  item: Item,
  hug: Hug
): { w: number; x: number; y: number } | null {
  const { room, wall, t } = hug;
  const axis = wall.dir;
  // the back line at t, then a hair into the room (see FIT_PROBE_EPS)
  const back = along(wallPoint(wall, t), wall.inward, wall.faceOffset);
  const probe = along(back, wall.inward, FIT_PROBE_EPS);
  const b = polygonBounds(room.corners);
  const reach = 2 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY);

  let minus = Infinity;
  let plus = Infinity;
  const hit = (s: number, sign: 1 | -1): void => {
    if (s <= 0) return;
    if (sign < 0) minus = Math.min(minus, s);
    else plus = Math.min(plus, s);
  };

  // (a) the room's other walls, at their ROOM-SIDE FACE. Never the corner ring:
  // a partition's ring edge is its centreline, half a thickness past its face.
  for (const other of wallsOf(design.rooms, room.id)) {
    if (other.id === wall.id) continue;
    const q = slabQuad(other);
    for (const sign of [-1, 1] as const) {
      const x = segmentIntersection(probe, along(probe, axis, reach * sign), q[0], q[1]);
      if (x) hit(x.t * reach, sign);
    }
  }

  // (b) the room's other items
  for (const o of design.items) {
    // an attached item rides its host's footprint, so it can never bound
    // anything the host does not already bound — that covers both directions
    // of the host relationship
    if (o.id === item.id || o.attach) continue;
    const def = defOfDesign(design, o.defId);
    if (def && isDecorative(def)) continue;
    if (roomOfItem(design, o)?.id !== room.id) continue;
    const overlap =
      Math.min(item.elevation + item.h, o.elevation + o.h) - Math.max(item.elevation, o.elevation);
    if (overlap <= 0.005) continue;
    let depthLo = Infinity;
    let depthHi = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of obbCorners({ cx: o.x, cy: o.y, w: o.w, d: o.d, rot: o.rotation })) {
      const dv = dot(rel(c, back), wall.inward);
      depthLo = Math.min(depthLo, dv);
      depthHi = Math.max(depthHi, dv);
      const av = dot(rel(c, probe), axis);
      lo = Math.min(lo, av);
      hi = Math.max(hi, av);
    }
    // it only bounds the run if it stands in the depth band the run occupies
    if (Math.min(depthHi, item.d) - Math.max(depthLo, 0) <= EPS) continue;
    if (hi <= 0) hit(-hi, -1);
    else if (lo >= 0) hit(lo, 1);
    // straddling the centre is an overlap, which is checks' business, not ours
  }

  if (!Number.isFinite(minus) || !Number.isFinite(plus)) return null;
  const w = minus + plus;
  if (w < FIT_MIN_W) return null;
  const foot = wallPoint(wall, t + (plus - minus) / 2);
  // snapItem's own back-to-wall placement, so a fitted item lands exactly
  // where dragging it against the same wall would have
  const centre = along(foot, wall.inward, wall.faceOffset + item.d / 2);
  return { w, x: centre.x, y: centre.y };
}

/**
 * What the room says this item's size and position should be, as a patch of
 * only the values that actually differ. Null when the item does not ask to be
 * fitted, is mounted on a host, belongs to no room, hugs no wall, or already
 * measures what it should.
 */
export function fitItem(design: Design, item: Item): FitPatch | null {
  if (!item.fit || item.attach) return null;
  const hug = hugWall(design, item);
  if (!hug) return null;

  const patch: FitPatch = {};
  if (item.fit.width === 'walls') {
    const box = fitWidth(design, item, hug);
    if (box) {
      if (Math.abs(box.w - item.w) > EPS) patch.w = box.w;
      if (Math.abs(box.x - item.x) > EPS) patch.x = box.x;
      if (Math.abs(box.y - item.y) > EPS) patch.y = box.y;
    }
  }
  if (item.fit.height === 'ceiling') {
    const h = styleOfItem(design, item).wallHeight - item.elevation;
    if (h >= FIT_MIN_H && Math.abs(h - item.h) > EPS) patch.h = h;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** sort key: which wall the item hugs, then how far along it stands */
interface HugKey {
  /** 0 = hugs a wall, 1 = hugs nothing and sorts last (it patches to null) */
  rank: 0 | 1;
  wallId: string;
  t: number;
}

const NO_HUG: HugKey = { rank: 1, wallId: '', t: 0 };

function hugKey(design: Design, item: Item): HugKey {
  const hug = hugWall(design, item);
  return hug ? { rank: 0, wallId: hug.wall.id, t: hug.t } : NO_HUG;
}

function compareHugs(a: HugKey, b: HugKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.wallId !== b.wallId) return a.wallId < b.wallId ? -1 : 1;
  return a.t - b.t;
}

/**
 * Recompute every flagged item's fitted size/position in place; true when
 * anything moved.
 *
 * Items are visited along each wall in ascending order, which makes ONE pass a
 * fixed point for that wall: an item's left bound is either the wall face or a
 * neighbour already at its final position, and its own right growth cannot
 * move anything to its left. The extra passes exist for the cross-axis case —
 * an item fitted along one wall grows into the corner and becomes the new
 * bound for an item fitted along the perpendicular wall, which the first pass
 * measured against the old footprint. Three is the cap; a pass that changes
 * nothing breaks out early, so the common case costs two.
 */
export function syncFits(design: Design): boolean {
  const flagged = design.items.filter((it) => it.fit && !it.attach);
  if (flagged.length === 0) return false;
  let changed = false;
  for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
    const keys = new Map(flagged.map((it) => [it.id, hugKey(design, it)]));
    const order = [...flagged].sort((a, b) =>
      compareHugs(keys.get(a.id) ?? NO_HUG, keys.get(b.id) ?? NO_HUG)
    );
    let touched = false;
    for (const it of order) {
      const patch = fitItem(design, it);
      if (!patch) continue;
      Object.assign(it, patch);
      touched = true;
    }
    if (!touched) break;
    changed = true;
  }
  return changed;
}
