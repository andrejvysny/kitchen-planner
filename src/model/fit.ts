import { defOfDesign } from './attach';
import { isDecorative } from './catalog';
import {
  angleClose,
  obbCorners,
  polygonBounds,
  projectOnWall,
  segmentIntersection,
  signedArea,
  wallPoint,
} from './geometry';
import {
  openingsOfWall,
  roomOfItem,
  slabQuad,
  styleOfItem,
  swingSector,
  wallsOf,
  type RoomWall,
} from './rooms';
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
/** how far into the room a run reaches when the caller names no item */
export const FREE_SEG_DEPTH = 0.6;

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

/* ---------------- free segments ---------------- */

/** A clear stretch of one wall, measured along it from the wall's start. */
export interface FreeSegment {
  t0: number;
  t1: number;
}

/**
 * What is being measured against the wall. Every field is optional, so a
 * caller holding nothing but a wall still gets a usable answer.
 */
export interface FreeSegmentOpts {
  /** item left out of the scan — the one being fitted, so it cannot cut itself */
  exceptId?: string;
  /** how far into the room the run reaches; only what stands in that band cuts */
  depth?: number;
  /** bottom of the run above the floor */
  elevation?: number;
  /** height of the run; the default lets anything standing on the wall cut it */
  height?: number;
}

/** A blocked stretch, in the same along-the-wall coordinate as `FreeSegment`. */
interface Cut {
  lo: number;
  hi: number;
}

/** Sutherland–Hodgman half-plane clip: the part of a convex ring where `keep` ≥ 0. */
function clipHalf(poly: Point[], keep: (p: Point) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = keep(a);
    const db = keep(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const f = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
  }
  return out;
}

/**
 * What a door's swing blocks on `wall`: the (convex) sector clipped to the
 * run's own depth band in that wall's frame, reported as the along-the-wall
 * extent of whatever survives. Null when the two never overlap, or overlap in
 * nothing but an edge — a sector lying flat on the face has no area and must
 * not report the whole width of the door it came from.
 */
function sectorCut(sector: Point[], wall: RoomWall, depth: number): Cut | null {
  const near = wall.faceOffset;
  const far = wall.faceOffset + depth;
  const band = clipHalf(
    clipHalf(sector, (p) => projectOnWall(wall, p).side - near),
    (p) => far - projectOnWall(wall, p).side
  );
  if (band.length < 3 || Math.abs(signedArea(band)) < EPS) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of band) {
    const { t } = projectOnWall(wall, p);
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  return hi - lo > EPS ? { lo, hi } : null;
}

/** The stretch an item blocks, or null when it does not stand in the run. */
function itemCut(
  design: Design,
  wall: RoomWall,
  o: Item,
  opts: Required<FreeSegmentOpts>
): Cut | null {
  // an attached item rides its host's footprint, so it can never bound
  // anything the host does not already bound — that covers both directions
  // of the host relationship
  if (o.id === opts.exceptId || o.attach) return null;
  const def = defOfDesign(design, o.defId);
  if (def && isDecorative(def)) return null;
  if (roomOfItem(design, o)?.id !== wall.roomId) return null;
  const overlap =
    Math.min(opts.elevation + opts.height, o.elevation + o.h) -
    Math.max(opts.elevation, o.elevation);
  if (overlap <= 0.005) return null;

  let depthLo = Infinity;
  let depthHi = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of obbCorners({ cx: o.x, cy: o.y, w: o.w, d: o.d, rot: o.rotation })) {
    const pr = projectOnWall(wall, c);
    const dv = pr.side - wall.faceOffset;
    depthLo = Math.min(depthLo, dv);
    depthHi = Math.max(depthHi, dv);
    lo = Math.min(lo, pr.t);
    hi = Math.max(hi, pr.t);
  }
  // it only bounds the run if it stands in the depth band the run occupies
  if (Math.min(depthHi, opts.depth) - Math.max(depthLo, 0) <= EPS) return null;
  return { lo, hi };
}

/**
 * Everything that blocks this wall, as stretches along it. Four families, all
 * reported in the wall's own t coordinate:
 *
 * (a) the room's OTHER walls, at their room-side FACE — never the corner ring,
 *     since a partition's ring edge is its centreline, half a thickness past
 *     its face. One probe line run just off this wall's face crosses each of
 *     them at most once, and each crossing is a zero-width cut. The two
 *     sentinels {−∞, 0} and {len, +∞} close the ends, which is what makes an
 *     unbounded side impossible rather than something callers must test for.
 * (b) every opening on this wall, doors AND windows, whatever the sill: a run
 *     may not cross either. `openingsOfWall` is the ONLY source — a partition
 *     is stored on one side only, and it mirrors the twin's openings into this
 *     side's frame for free.
 * (c) the swing of every in-swinging door of the ROOM, projected onto this
 *     wall. On the door's own wall that reproduces (b) and merges away; the
 *     case it exists for is a door near a corner sweeping across the wall it
 *     does NOT sit on. An out-swinging door blocks nothing on this side.
 * (d) the room's other items, by exactly `fitWidth`'s old rule — the ghost has
 *     to promise precisely what `syncFits` will settle on.
 */
function wallCuts(design: Design, wall: RoomWall, opts: Required<FreeSegmentOpts>): Cut[] {
  const cuts: Cut[] = [
    { lo: -Infinity, hi: 0 },
    { lo: wall.len, hi: Infinity },
  ];
  const room = design.rooms.find((r) => r.id === wall.roomId);
  const walls = room ? wallsOf(design.rooms, room.id) : [];

  if (room) {
    // the back line, then a hair into the room (see FIT_PROBE_EPS)
    const at = (t: number): Point =>
      along(wallPoint(wall, t), wall.inward, wall.faceOffset + FIT_PROBE_EPS);
    const b = polygonBounds(room.corners);
    const reach = 2 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    const a0 = at(-reach);
    const a1 = at(wall.len + reach);
    const span = wall.len + 2 * reach;
    for (const other of walls) {
      if (other.id === wall.id) continue;
      const q = slabQuad(other);
      const x = segmentIntersection(a0, a1, q[0], q[1]);
      if (!x) continue;
      const t = x.t * span - reach;
      cuts.push({ lo: t, hi: t });
    }
  }

  for (const o of openingsOfWall(design, wall)) {
    cuts.push({ lo: o.offset - o.width / 2, hi: o.offset + o.width / 2 });
  }

  for (const g of walls) {
    for (const o of openingsOfWall(design, g)) {
      if (o.type !== 'door' || (o.swing ?? 'in') === 'out') continue;
      const cut = sectorCut(swingSector(g, o), wall, opts.depth);
      if (cut) cuts.push(cut);
    }
  }

  for (const o of design.items) {
    const cut = itemCut(design, wall, o, opts);
    if (cut) cuts.push(cut);
  }
  return cuts;
}

/**
 * The clear stretches of one wall, left to right, for a run of the given depth
 * and vertical band. Openings, door swings and wall-standing items all cut it;
 * the sentinels in `wallCuts` guarantee every segment lies inside [0, len].
 */
export function wallFreeSegments(
  design: Design,
  wall: RoomWall,
  opts: FreeSegmentOpts = {}
): FreeSegment[] {
  const cuts = wallCuts(design, wall, {
    exceptId: opts.exceptId ?? '',
    depth: opts.depth ?? FREE_SEG_DEPTH,
    elevation: opts.elevation ?? 0,
    height: opts.height ?? Infinity,
  });
  cuts.sort((a, b) => a.lo - b.lo);
  // one sweep both merges (touching cuts leave no zero-width sliver behind)
  // and inverts; the {len, +∞} sentinel is what closes the last segment
  const segs: FreeSegment[] = [];
  let prev = 0;
  for (const cut of cuts) {
    if (cut.lo - prev > EPS) segs.push({ t0: prev, t1: cut.lo });
    prev = Math.max(prev, cut.hi);
  }
  return segs;
}

/**
 * The segment a point along the wall picks out. When t sits inside a cut — an
 * opening added UNDER a fitted item — the NEAREST segment answers instead, so
 * the item visibly slides aside rather than stranding across the doorway.
 * Ties go to the wider segment, then to the one nearer the wall start.
 */
function segmentAt(segs: FreeSegment[], t: number): FreeSegment | null {
  let best: FreeSegment | null = null;
  let bestD = Infinity;
  for (const s of segs) {
    const d = Math.max(s.t0 - t, t - s.t1, 0);
    if (d > bestD + EPS) continue;
    const wide = s.t1 - s.t0 - (best ? best.t1 - best.t0 : -Infinity);
    if (!best || d < bestD - EPS || wide > EPS || (Math.abs(wide) <= EPS && s.t0 < best.t0)) {
      best = s;
      bestD = Math.min(bestD, d);
    }
  }
  return best;
}

/**
 * The free stretch the item's own position picks out, and where filling it
 * puts the item. Null when nothing is left of the wall, or when the stretch is
 * too narrow to be a run.
 */
function fitWidth(
  design: Design,
  item: Item,
  hug: Hug
): { w: number; x: number; y: number } | null {
  const { wall, t } = hug;
  const segs = wallFreeSegments(design, wall, {
    exceptId: item.id,
    depth: item.d,
    elevation: item.elevation,
    height: item.h,
  });
  const seg = segmentAt(segs, t);
  if (!seg) return null;
  const w = seg.t1 - seg.t0;
  if (w < FIT_MIN_W) return null;
  const foot = wallPoint(wall, (seg.t0 + seg.t1) / 2);
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
