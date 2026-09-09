/**
 * Spatial checks — pure, advisory, and deliberately NON-BLOCKING.
 *
 * `runChecks(design)` reads a design and returns `Warning`s; it changes
 * nothing and it is imported by NO mutator. The planner never refuses an edit:
 * a designer routinely parks a cabinet through a wall on the way to its final
 * spot, and a tool that fights that is worse than one that stays quiet. Every
 * finding is a hint the views may surface, ranked error → warn → info.
 *
 * Two rules make the results trustworthy enough to show live:
 *  - **2.5D**: two items clash only when their PLAN shapes overlap AND their
 *    vertical intervals do. Without the height test every wall cabinet over a
 *    base cabinet is a false positive and the whole feature gets ignored.
 *  - **TOUCH_EPS**: shapes shrink by 5 mm before testing, so the flush,
 *    edge-snapped neighbours the snapping code deliberately produces never
 *    register as collisions.
 *
 * Rect footprints go through SAT (`obbOverlap`, which also yields the
 * penetration depth for the message); chamfer / cornerL / board outlines go
 * through the true polygon (`footprintPolygon` + `polygonsOverlap`).
 *
 * Warning ids are stable and content-free — `kind:subjectIdsSorted` — so a
 * view can diff two runs, and recomputing after an unrelated edit keeps the
 * same id for the same problem.
 */

import { defOfDesign, partOfDesign } from './attach';
import {
  isDecorative,
  isWallMounted,
  snapsToWall,
  type CatalogDef,
  type ItemKind,
} from './catalog';
import {
  dist,
  fmtCm,
  insetPolygon,
  obbCorners,
  obbOverlap,
  polygonsOverlap,
  projectOnWall,
  rot,
  wallPoint,
  type Obb,
} from './geometry';
import { FRONT_T, partPanels, type Panel } from './panels';
import { footprintPolygon } from './parts';
import {
  allWalls,
  bandCenter,
  designWalls,
  MIN_SEAM,
  openingsOfWall,
  roomOfItem,
  swingSector,
  type RoomWall,
  type WallOpening,
} from './rooms';
import type { Design, Item, Point } from './types';

export type Severity = 'error' | 'warn' | 'info';

/**
 * Check families. The collision set is here; ergonomic clearances and the
 * work triangle extend this union (and nothing else — every consumer switches
 * on `severity`, not on `kind`).
 */
export type CheckKind =
  | 'overlap'
  | 'throughWall'
  | 'blocksDoor'
  | 'doorLanding'
  | 'frontClearance'
  | 'walkway'
  | 'workAisle'
  | 'bedAccess'
  | 'workTriangle'
  /** two physical wall slabs running along each other instead of being one */
  | 'parallelWalls';

/** Where to draw the highlight; a sector is just a polygon. */
export type WarningGeom =
  { kind: 'segment'; a: Point; b: Point } | { kind: 'polygon'; points: Point[] };

export interface Warning {
  /** `kind:subjectIdsSorted` — stable across recomputes and item order */
  id: string;
  kind: CheckKind;
  severity: Severity;
  /** items the warning is about; a view highlights exactly these */
  itemIds: string[];
  /** set when an opening is one of the subjects */
  openingId?: string;
  roomId: string;
  /** one short line for a list */
  title: string;
  /** the numbers, spelled out */
  detail: string;
  /** measured quantity (m) when there is one */
  value?: number;
  /** the limit `value` is judged against (m), when there is one */
  limit?: number;
  geom?: WarningGeom;
}

/** Shapes shrink by this (5 mm) before any test: flush neighbours must pass. */
export const TOUCH_EPS = 0.005;
/** Vertical intervals must share more than this to count as a clash. */
export const VERT_EPS = 0.005;
/**
 * How far past its room's boundary ring an item may poke before it counts as
 * going through the wall. The ring is the room's own territory — the wall FACE
 * on an exterior wall, the CENTRELINE on a shared partition (RoomWall
 * .faceOffset is the offset between them) — so crossing it always means
 * leaving the room, and a partition-flush item sits a safe faceOffset inside.
 */
const THROUGH_TOL = 0.02;
/** slack at the wall ends, so a corner item is judged by the wall it faces */
const ALONG_TOL = 0.05;
/** clear floor a door needs in front of it (m) — NKBA-ish minimum landing */
export const DOOR_LANDING = 0.9;

/**
 * Ergonomic minima (m).
 * sources: NKBA Kitchen Planning Guidelines (2022) G3/G4/G5; Neufert for bed access
 */
export const CLEARANCE = Object.freeze({
  /** G4 Walkway: clear floor of any passage that is not a work aisle */
  WALKWAY: 0.9,
  /** G5 Work Aisle: floor between two work surfaces, one cook */
  WORK_AISLE: 1.07,
  /** G3 Work Triangle: no leg shorter than this (4 ft) */
  TRIANGLE_LEG_MIN: 1.2,
  /** G3 Work Triangle: no leg longer than this (9 ft) */
  TRIANGLE_LEG_MAX: 2.7,
  /** G3 Work Triangle: the three legs together (26 ft) */
  TRIANGLE_SUM_MAX: 7.9,
  /** Neufert, Architects' Data: clear floor along the long side of a bed */
  BED_SIDE: 0.6,
});
/** G5 again: two cooks want this much aisle — quoted in the message, not enforced */
const WORK_AISLE_TWO_COOKS = 1.22;

/** faces count as facing each other below this normal dot (≈ ±26° of parallel) */
const FACING_DOT = -0.9;
/** a blocker only has to lean towards a face this much to stop it */
const BLOCKING_DOT = -0.5;
/** a passage shorter than this along its run is a nook, not a route (m) */
const MIN_PASSAGE_RUN = 0.6;
/** below this the two things are touching — that is the collision family's job */
const MIN_REAL_GAP = 0.15;
/** items standing on the floor obstruct a route; anything hung higher does not */
const STANDING_ELEV = 0.3;
/** knee-high and under is a threshold to step over, not an obstruction */
const BLOCK_HEIGHT = 0.5;
/** appliance kinds a cook works at (worktop-bearing parts count too) */
const WORK_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'sink',
  'hob',
  'oven',
  'dishwasher',
  'fridge',
]);
/** the three corners of the work triangle, in the order the message lists them */
const TRIANGLE_KINDS = ['sink', 'hob', 'fridge'] as const;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/* ---------------- item shapes ---------------- */

/**
 * One item reduced to what the checks need: its plan shape twice (raw for
 * measuring, shrunk for testing) and its vertical span.
 */
interface Shape {
  item: Item;
  def: CatalogDef;
  roomId: string;
  /** unshrunk oriented box — the penetration depth is measured on this */
  raw: Obb;
  /** unshrunk world outline (true footprint, else the box corners) */
  corners: Point[];
  /** shrunk oriented box */
  box: Obb;
  /** shrunk world outline */
  hit: Point[];
  /** true when the footprint is not a plain rectangle */
  poly: boolean;
  z0: number;
  z1: number;
}

function toWorld(local: Point[], it: Item): Point[] {
  return local.map((p) => {
    const r = rot(p, it.rotation);
    return { x: it.x + r.x, y: it.y + r.y };
  });
}

function shrinkBox(o: Obb, eps: number): Obb {
  return { ...o, w: Math.max(1e-4, o.w - eps * 2), d: Math.max(1e-4, o.d - eps * 2) };
}

/** null when the def no longer resolves — sanitizeDesign drops those anyway. */
function itemShape(design: Design, it: Item): Shape | null {
  const def = defOfDesign(design, it.defId);
  if (!def) return null;
  const part = partOfDesign(design, it.defId);
  const local = part ? footprintPolygon(part, it.w, it.d) : null;
  const raw: Obb = { cx: it.x, cy: it.y, w: it.w, d: it.d, rot: it.rotation };
  const box = shrinkBox(raw, TOUCH_EPS);
  const corners = local ? toWorld(local, it) : obbCorners(raw);
  // insetPolygon returns null when the shape is too small to shrink — an item
  // that thin is better tested at full size than not at all
  const hit = local ? toWorld(insetPolygon(local, TOUCH_EPS) ?? local, it) : obbCorners(box);
  return {
    item: it,
    def,
    roomId: roomOfItem(design, it)?.id ?? '',
    raw,
    corners,
    box,
    hit,
    poly: local !== null,
    z0: it.elevation,
    z1: it.elevation + it.h,
  };
}

/** Vertical overlap (m) of two spans; ≤ 0 means one is clear of the other. */
const spanOverlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(a1, b1) - Math.max(a0, b0);

/** Plan-shape intersection: SAT for two boxes, true outlines when either is one. */
function plansOverlap(a: Shape, b: Shape): boolean {
  if (a.poly || b.poly) return polygonsOverlap(a.hit, b.hit);
  return obbOverlap(a.box, b.box) !== null;
}

/** A region (door sector, landing rect) against an item's shrunk shape. */
const regionHits = (region: Point[], s: Shape): boolean => polygonsOverlap(region, s.hit);

/* ---------------- checks ---------------- */

function overlapChecks(shapes: Shape[], out: Warning[]): void {
  for (let i = 0; i < shapes.length; i++) {
    const a = shapes[i];
    if (isDecorative(a.def)) continue;
    for (let j = i + 1; j < shapes.length; j++) {
      const b = shapes[j];
      if (isDecorative(b.def)) continue;
      // an appliance is INSIDE its host by construction
      if (a.item.attach?.hostId === b.item.id || b.item.attach?.hostId === a.item.id) continue;
      if (spanOverlap(a.z0, a.z1, b.z0, b.z1) <= VERT_EPS) continue;
      if (!plansOverlap(a, b)) continue;
      // depth is measured on the RAW boxes: the shrink is a test tolerance,
      // not part of the number the user reads
      const depth = obbOverlap(a.raw, b.raw)?.depth;
      out.push({
        id: warningId('overlap', [a.item.id, b.item.id]),
        kind: 'overlap',
        severity: 'error',
        itemIds: [a.item.id, b.item.id],
        roomId: a.roomId,
        title: 'Items overlap',
        detail:
          depth === undefined
            ? `${a.def.label} overlaps ${b.def.label}`
            : `${a.def.label} overlaps ${b.def.label} by ${fmtCm(depth)}`,
        value: depth,
        geom: { kind: 'polygon', points: a.hit },
      });
    }
  }
}

function throughWallChecks(shapes: Shape[], byRoom: Map<string, RoomWall[]>, out: Warning[]): void {
  for (const s of shapes) {
    // attached appliances follow their host; wall-mounted things (markers,
    // backsplash, TV) are SUPPOSED to sit in the wall face; and a decorative
    // item is exempt from every OTHER check here, so exempting it from this
    // one too is what makes `noCollide` mean what its doc comment says
    if (s.item.attach || isWallMounted(s.def) || isDecorative(s.def)) continue;
    for (const g of byRoom.get(s.roomId) ?? []) {
      const outside = s.corners.some((p) => {
        const pr = projectOnWall(g, p);
        return pr.t > -ALONG_TOL && pr.t < g.len + ALONG_TOL && pr.side < -THROUGH_TOL;
      });
      if (!outside) continue;
      // free-placement items (islands, rugs, coffee tables) are put anywhere on
      // purpose, so poking out is a hint rather than a mistake
      const free = !snapsToWall(s.def);
      out.push({
        id: warningId('throughWall', [s.item.id]),
        kind: 'throughWall',
        severity: free ? 'warn' : 'error',
        itemIds: [s.item.id],
        roomId: s.roomId,
        title: 'Item crosses a wall',
        detail: `${s.def.label} reaches past the wall out of the room`,
        geom: { kind: 'segment', a: { x: g.a.x, y: g.a.y }, b: { x: g.b.x, y: g.b.y } },
      });
      break; // one warning per item; the geom names the wall it left through
    }
  }
}

/** The clear floor rectangle a door needs on this side of the wall. */
function landingRect(g: RoomWall, o: WallOpening): Obb {
  const p = wallPoint(g, o.offset);
  const off = g.faceOffset + DOOR_LANDING / 2;
  return {
    cx: p.x + g.inward.x * off,
    cy: p.y + g.inward.y * off,
    w: o.width,
    d: DOOR_LANDING,
    rot: g.angle,
  };
}

/**
 * Door swings and landings, walked per ROOM-SIDE of every wall. A partition is
 * visited from both rooms, and `openingsOfWall` mirrors the stored opening
 * into each side's frame, so an out-swinging door is checked against the room
 * it actually opens into without any special case. Exterior walls only have an
 * inside, which is exactly the side the model knows anything about.
 */
function doorChecks(design: Design, shapes: Shape[], walls: RoomWall[], out: Warning[]): void {
  for (const g of walls) {
    for (const o of openingsOfWall(design, g)) {
      if (o.type !== 'door') continue;
      const room = shapes.filter((s) => s.roomId === g.roomId);
      const sector = swingSector(g, o);
      const landing = obbCorners(landingRect(g, o));
      const zone = (s: Shape) => spanOverlap(s.z0, s.z1, o.sill, o.sill + o.height) > VERT_EPS;
      const blocked = new Set<string>();
      for (const s of room) {
        if (isDecorative(s.def) || s.item.attach || !zone(s)) continue;
        if (!regionHits(sector, s)) continue;
        blocked.add(s.item.id);
        out.push({
          id: warningId('blocksDoor', [o.id, s.item.id]),
          kind: 'blocksDoor',
          severity: 'warn',
          itemIds: [s.item.id],
          openingId: o.id,
          roomId: g.roomId,
          title: 'Door swing blocked',
          detail: `${s.def.label} stands in the swing of a ${fmtCm(o.width)} door`,
          geom: { kind: 'polygon', points: sector },
        });
      }
      for (const s of room) {
        // an item already flagged for the swing needs no second, weaker line
        if (isDecorative(s.def) || s.item.attach || blocked.has(s.item.id) || !zone(s)) continue;
        if (!regionHits(landing, s)) continue;
        out.push({
          id: warningId('doorLanding', [o.id, s.item.id]),
          kind: 'doorLanding',
          severity: 'info',
          itemIds: [s.item.id],
          openingId: o.id,
          roomId: g.roomId,
          title: 'Tight door landing',
          detail: `${s.def.label} sits in the ${fmtCm(DOOR_LANDING)} of clear floor a door wants`,
          limit: DOOR_LANDING,
          geom: { kind: 'polygon', points: landing },
        });
      }
    }
  }
}

/* ---------------- ergonomics: the face model ---------------- */

/**
 * One planar side of something, in plan — the strip a person stands on to use
 * it. An item contributes its FRONT only: every clearance rule here is about
 * the space somebody occupies while USING the thing, and nobody works at a
 * cabinet's back. Walls contribute their room-side face, so "cabinet run
 * across an empty room" and "cabinet run across the room from a wall" are the
 * same measurement. Bed sides are built on demand (`bedSideFaces`).
 *
 * Items with a polygon footprint are faced by their bounding box, the same
 * simplification snapping already makes.
 */
interface Face {
  /** item id, or wall id for a wall face — warning ids are built from these */
  subjectId: string;
  /** null for a wall: a wall is never a warning subject */
  itemId: string | null;
  roomId: string;
  label: string;
  /** face centre */
  c: Point;
  /** unit normal, pointing away from the thing (into the room) */
  n: Point;
  /** unit direction along the face */
  t: Point;
  len: number;
  z0: number;
  z1: number;
  /** a cook works here: worktop, work appliance, or the host of one */
  work: boolean;
}

/** The gap two facing faces leave, and how much of it is a usable passage. */
interface FaceGap {
  /** clear distance between the two faces (m) */
  gap: number;
  /** length the two faces share along the passage (m) */
  run: number;
  /** point on `a` at the middle of that shared run */
  mid: Point;
}

/**
 * Faces looking at each other, or null. `maxDot` decides how anti-parallel
 * they must be: near-exact for a passage (which has two sides), loose for
 * "does this wall stop me walking forward".
 */
function faceGap(a: Face, b: Face, maxDot: number): FaceGap | null {
  if (a.n.x * b.n.x + a.n.y * b.n.y > maxDot) return null;
  const dx = b.c.x - a.c.x;
  const dy = b.c.y - a.c.y;
  // measured from both sides; the smaller is the clear distance either way
  const gap = Math.min(dx * a.n.x + dy * a.n.y, -(dx * b.n.x + dy * b.n.y));
  if (gap <= 0) return null;
  // b's extent projected onto a's along-axis, clipped to a
  const off = dx * a.t.x + dy * a.t.y;
  const half = (Math.abs(b.t.x * a.t.x + b.t.y * a.t.y) * b.len) / 2;
  const lo = Math.max(-a.len / 2, off - half);
  const hi = Math.min(a.len / 2, off + half);
  if (hi <= lo) return null;
  const m = (lo + hi) / 2;
  return { gap, run: hi - lo, mid: { x: a.c.x + a.t.x * m, y: a.c.y + a.t.y * m } };
}

const faceAhead = (f: Face, d: number): Point => ({ x: f.c.x + f.n.x * d, y: f.c.y + f.n.y * d });

/** The front face of an item: local +y, centred on the front edge. */
function frontFace(s: Shape, work: boolean): Face {
  const it = s.item;
  const n = rot({ x: 0, y: 1 }, it.rotation);
  return {
    subjectId: it.id,
    itemId: it.id,
    roomId: s.roomId,
    label: s.def.label,
    c: { x: it.x + (n.x * it.d) / 2, y: it.y + (n.y * it.d) / 2 },
    n,
    t: rot({ x: 1, y: 0 }, it.rotation),
    len: it.w,
    z0: s.z0,
    z1: s.z1,
    work,
  };
}

/**
 * A bed's two LONG sides (local ±x): `w` is the mattress width and `d` the
 * sleeping length, so the ±x edges are the ones you get in and out over.
 */
function bedSideFaces(s: Shape): [Face, Face] {
  const it = s.item;
  const side = (sign: 1 | -1): Face => {
    const n = rot({ x: sign, y: 0 }, it.rotation);
    return {
      subjectId: it.id,
      itemId: it.id,
      roomId: s.roomId,
      label: s.def.label,
      c: { x: it.x + (n.x * it.w) / 2, y: it.y + (n.y * it.w) / 2 },
      n,
      t: rot({ x: 0, y: 1 }, it.rotation),
      len: it.d,
      z0: s.z0,
      z1: s.z1,
      work: false,
    };
  };
  return [side(-1), side(1)];
}

function wallFace(g: RoomWall, height: number): Face {
  const mid = wallPoint(g, g.len / 2);
  return {
    subjectId: g.id,
    itemId: null,
    roomId: g.roomId,
    label: 'the wall',
    c: { x: mid.x + g.inward.x * g.faceOffset, y: mid.y + g.inward.y * g.faceOffset },
    n: g.inward,
    t: g.dir,
    len: g.len,
    z0: 0,
    z1: height,
    work: false,
  };
}

/**
 * How far forward a face is clear before an item or a wall stops it. A blocker
 * has to share the face's vertical band (a base cabinet cannot block a wall
 * unit) and cover enough of it to matter — `MIN_PASSAGE_RUN`, or the whole
 * face when the face is narrower than that, so a 45 cm nightstand can still be
 * blocked while a nightstand beside a 2 m bed does not count as blocking it.
 * Infinity when nothing is in the way.
 */
function freeDepth(face: Face, self: Shape, shapes: Shape[], wallFaces: Face[]): number {
  const need = Math.min(MIN_PASSAGE_RUN, face.len) - TOUCH_EPS;
  let best = Infinity;
  for (const s of shapes) {
    if (s === self || s.roomId !== face.roomId || isDecorative(s.def)) continue;
    // an item and the appliances mounted in it are one body
    if (s.item.attach?.hostId === self.item.id || self.item.attach?.hostId === s.item.id) continue;
    if (spanOverlap(s.z0, s.z1, face.z0, face.z1) <= VERT_EPS) continue;
    // the two are already inside each other: the overlap check has said so, and
    // said it better — a clearance figure on top would be the same news twice
    if (spanOverlap(s.z0, s.z1, self.z0, self.z1) > VERT_EPS && plansOverlap(self, s)) continue;
    let aMin = Infinity;
    let aMax = -Infinity;
    let fMin = Infinity;
    let fMax = -Infinity;
    for (const p of s.corners) {
      const dx = p.x - face.c.x;
      const dy = p.y - face.c.y;
      const al = dx * face.t.x + dy * face.t.y;
      const fw = dx * face.n.x + dy * face.n.y;
      aMin = Math.min(aMin, al);
      aMax = Math.max(aMax, al);
      fMin = Math.min(fMin, fw);
      fMax = Math.max(fMax, fw);
    }
    if (fMax <= 0) continue; // wholly behind the face
    if (Math.min(aMax, face.len / 2) - Math.max(aMin, -face.len / 2) < need) continue;
    best = Math.min(best, Math.max(0, fMin));
  }
  for (const wf of wallFaces) {
    const g = faceGap(face, wf, BLOCKING_DOT);
    if (g && g.run >= need) best = Math.min(best, g.gap);
  }
  return best;
}

/**
 * Items a cook works at: anything with a worktop, the work appliances
 * themselves, and the cabinets they are mounted in (a sink is a hole in its
 * host's counter — the host is the work surface). Two of these facing each
 * other make a work aisle rather than a walkway, whatever the room is called.
 */
function workItems(design: Design, shapes: Shape[]): ReadonlySet<string> {
  const work = new Set<string>();
  for (const s of shapes) {
    const part = partOfDesign(design, s.item.defId);
    if ((part?.type === 'cabinet' && part.worktop) || WORK_KINDS.has(s.def.kind)) {
      work.add(s.item.id);
    }
    // a host inherits the job of what it carries
    if (s.item.attach && WORK_KINDS.has(s.def.kind)) work.add(s.item.attach.hostId);
  }
  return work;
}

/**
 * Every face a passage can run between: the fronts of things standing on the
 * floor, plus every room's walls. Sorted by subject id so the pair walk — and
 * so the geometry each warning carries — never depends on item order.
 */
function passageFaces(
  design: Design,
  shapes: Shape[],
  wallFaces: Map<string, Face[]>,
  work: ReadonlySet<string>
): Face[] {
  const faces: Face[] = [];
  for (const s of shapes) {
    const it = s.item;
    // mounted appliances sit inside their host and repeat its front
    if (it.attach || isDecorative(s.def)) continue;
    if (it.elevation >= STANDING_ELEV || it.h < BLOCK_HEIGHT) continue;
    faces.push(frontFace(s, work.has(it.id)));
  }
  for (const room of design.rooms) faces.push(...(wallFaces.get(room.id) ?? []));
  return faces.sort((a, b) => (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0));
}

/* ---------------- ergonomics: the checks ---------------- */

/**
 * Walkways and work aisles: every pair of faces that look at each other across
 * a usable passage. Wall-vs-wall pairs are skipped — a room is its own walls,
 * and its size is not a warning. Gaps under `MIN_REAL_GAP` belong to the
 * collision family, which has already reported them as what they are.
 */
function passageChecks(faces: Face[], out: Warning[]): void {
  for (let i = 0; i < faces.length; i++) {
    const a = faces[i];
    for (let j = i + 1; j < faces.length; j++) {
      const b = faces[j];
      if (a.roomId !== b.roomId || (!a.itemId && !b.itemId)) continue;
      if (spanOverlap(a.z0, a.z1, b.z0, b.z1) <= VERT_EPS) continue;
      const g = faceGap(a, b, FACING_DOT);
      if (!g || g.run < MIN_PASSAGE_RUN - TOUCH_EPS || g.gap < MIN_REAL_GAP) continue;
      const aisle = a.work && b.work;
      const limit = aisle ? CLEARANCE.WORK_AISLE : CLEARANCE.WALKWAY;
      if (g.gap >= limit - TOUCH_EPS) continue;
      const ids = [a.itemId, b.itemId].filter((id): id is string => id !== null).sort();
      out.push({
        id: warningId(aisle ? 'workAisle' : 'walkway', [a.subjectId, b.subjectId]),
        kind: aisle ? 'workAisle' : 'walkway',
        severity: 'warn',
        itemIds: ids,
        roomId: a.roomId,
        title: aisle ? 'Work aisle is tight' : 'Walkway is tight',
        detail: aisle
          ? `${fmtCm(g.gap)} of work aisle between ${a.label} and ${b.label} — one cook wants ${fmtCm(
              CLEARANCE.WORK_AISLE
            )}, two cooks ${fmtCm(WORK_AISLE_TWO_COOKS)}`
          : `${fmtCm(g.gap)} between ${a.label} and ${b.label} — a walkway wants ${fmtCm(
              CLEARANCE.WALKWAY
            )}`,
        value: g.gap,
        limit,
        geom: {
          kind: 'segment',
          a: g.mid,
          b: { x: g.mid.x + a.n.x * g.gap, y: g.mid.y + a.n.y * g.gap },
        },
      });
    }
  }
}

/**
 * The deepest any front travels when opened: hinge leaf width, slide travel
 * — except an axis-x slide (a sliding wardrobe door), which rides sideways
 * on a track and only needs to clear its own thickness.
 */
function openingDepth(panels: Panel[]): number {
  let need = 0;
  for (const p of panels) {
    if (!p.motion) continue;
    if (p.motion.kind === 'slide') {
      need = Math.max(need, p.motion.axis === 'x' ? FRONT_T : (p.motion.travel ?? 0));
    } else if (p.shape.kind === 'box') need = Math.max(need, p.shape.w);
  }
  return need;
}

/**
 * Room to open the doors and drawers a part actually has. The requirement is
 * read off the panel list — `Panel.motion` is the geometric truth the cut list
 * and the 3D preview already share — so this covers every cabinet, present and
 * future, without a single hard-coded kind.
 */
function frontChecks(
  design: Design,
  shapes: Shape[],
  wallFacesOf: (roomId: string) => Face[],
  work: ReadonlySet<string>,
  out: Warning[]
): void {
  // one panel list per part GEOMETRY: a wall of identical wardrobes is one build
  const memo = new Map<string, Panel[]>();
  for (const s of shapes) {
    const it = s.item;
    if (it.attach) continue; // an appliance in a niche has no fronts of its own
    const part = partOfDesign(design, it.defId);
    if (!part || (part.type !== 'cabinet' && part.type !== 'wardrobe')) continue;
    const key = `${it.defId}|${it.w}|${it.d}|${it.h}|${it.elevation}`;
    let panels = memo.get(key);
    if (!panels) {
      panels = partPanels(part, { w: it.w, d: it.d, h: it.h, elevation: it.elevation });
      memo.set(key, panels);
    }
    const need = openingDepth(panels);
    if (need <= 0) continue; // open shelving, panels only — nothing to swing
    const face = frontFace(s, work.has(it.id));
    const free = freeDepth(face, s, shapes, wallFacesOf(s.roomId));
    if (!Number.isFinite(free) || free >= need - TOUCH_EPS) continue;
    out.push({
      id: warningId('frontClearance', [it.id]),
      kind: 'frontClearance',
      severity: 'warn',
      itemIds: [it.id],
      roomId: s.roomId,
      title: 'Fronts cannot open',
      detail: `${s.def.label}: door/drawer needs ${fmtCm(need)} to open, has ${fmtCm(free)}`,
      value: free,
      limit: need,
      geom: { kind: 'segment', a: face.c, b: faceAhead(face, free) },
    });
  }
}

/**
 * Getting into bed. Both long sides are measured; one side against a wall or a
 * wardrobe is a normal single bed, so only a bed that is tight on BOTH sides
 * is worth a word.
 */
function bedChecks(shapes: Shape[], wallFacesOf: (roomId: string) => Face[], out: Warning[]): void {
  for (const s of shapes) {
    if (s.def.kind !== 'bed' || s.item.attach) continue;
    const sides = bedSideFaces(s);
    const free = sides.map((f) => freeDepth(f, s, shapes, wallFacesOf(s.roomId)));
    if (free.some((v) => v >= CLEARANCE.BED_SIDE - TOUCH_EPS)) continue;
    const wider = free[0] >= free[1] ? 0 : 1;
    out.push({
      id: warningId('bedAccess', [s.item.id]),
      kind: 'bedAccess',
      severity: 'warn',
      itemIds: [s.item.id],
      roomId: s.roomId,
      title: 'Bed is boxed in',
      detail: `${fmtCm(free[0])} and ${fmtCm(free[1])} beside ${s.def.label} — one long side wants ${fmtCm(
        CLEARANCE.BED_SIDE
      )} to get in`,
      value: free[wider],
      limit: CLEARANCE.BED_SIDE,
      geom: { kind: 'segment', a: sides[wider].c, b: faceAhead(sides[wider], free[wider]) },
    });
  }
}

/** Where a cook stands at an appliance — the point the triangle is measured between. */
function frontCenter(it: Item): Point {
  const r = rot({ x: 0, y: it.d / 2 }, it.rotation);
  return { x: it.x + r.x, y: it.y + r.y };
}

/**
 * The kitchen work triangle, per room. Rooms without all three of sink / hob /
 * fridge are silently not kitchens. With several candidates every combination
 * is measured and the tightest one judged — that is the triangle a cook
 * actually walks. A compliant triangle says nothing at all: silence is the
 * good news here, which is also why this is `info` and never louder.
 */
function triangleChecks(shapes: Shape[], out: Warning[]): void {
  const byRoom = new Map<string, Shape[]>();
  for (const s of shapes) {
    if (!TRIANGLE_KINDS.some((k) => k === s.def.kind)) continue;
    const list = byRoom.get(s.roomId);
    if (list) list.push(s);
    else byRoom.set(s.roomId, [s]);
  }
  for (const [roomId, anchors] of byRoom) {
    const groups = TRIANGLE_KINDS.map((k) => anchors.filter((s) => s.def.kind === k));
    if (groups.some((g) => g.length === 0)) continue;
    let best: { trio: Shape[]; pts: Point[]; legs: number[]; sum: number } | null = null;
    let combos = 0;
    for (const a of groups[0]) {
      for (const b of groups[1]) {
        for (const c of groups[2]) {
          combos++;
          const pts = [a, b, c].map((s) => frontCenter(s.item));
          const legs = [dist(pts[0], pts[1]), dist(pts[1], pts[2]), dist(pts[2], pts[0])];
          const sum = legs[0] + legs[1] + legs[2];
          if (!best || sum < best.sum) best = { trio: [a, b, c], pts, legs, sum };
        }
      }
    }
    if (!best) continue;
    const short = best.legs.some((l) => l < CLEARANCE.TRIANGLE_LEG_MIN - TOUCH_EPS);
    const long = best.legs.some((l) => l > CLEARANCE.TRIANGLE_LEG_MAX + TOUCH_EPS);
    if (!short && !long && best.sum <= CLEARANCE.TRIANGLE_SUM_MAX + TOUCH_EPS) continue;
    const name = (i: number): string =>
      TRIANGLE_KINDS[i][0].toUpperCase() + TRIANGLE_KINDS[i].slice(1);
    const legText = best.legs
      .map((l, i) => `${name(i)}→${TRIANGLE_KINDS[(i + 1) % 3]} ${fmtCm(l)}`)
      .join(', ');
    const closest = combos > 1 ? ` (closest of ${combos} combinations)` : '';
    out.push({
      id: warningId(
        'workTriangle',
        best.trio.map((s) => s.item.id)
      ),
      kind: 'workTriangle',
      severity: 'info',
      itemIds: best.trio.map((s) => s.item.id).sort(),
      roomId,
      title: 'Work triangle out of range',
      detail:
        `${legText} — total ${fmtCm(best.sum)}${closest}. Each leg wants ` +
        `${fmtCm(CLEARANCE.TRIANGLE_LEG_MIN)}–${fmtCm(CLEARANCE.TRIANGLE_LEG_MAX)}, ` +
        `the three together at most ${fmtCm(CLEARANCE.TRIANGLE_SUM_MAX)}`,
      geom: { kind: 'polygon', points: best.pts },
    });
  }
}

/* ---------------- entry point ---------------- */

function warningId(kind: CheckKind, subjectIds: string[]): string {
  return `${kind}:${[...subjectIds].sort().join('+')}`;
}

/**
 * Every spatial problem in a design, worst first. Pure: no store, no view, no
 * mutation of `design`. Duplicate ids collapse (a partition is walked from
 * both rooms and yields the same world geometry twice), and the sort makes the
 * output independent of item order.
 */
/**
 * Sin of the largest angle two wall slabs may differ by and still count as
 * running along each other (~2.9°). Looser than the model's own coincidence
 * test on purpose — a doubled wall drawn by hand is rarely exactly parallel,
 * and it is still a doubled wall.
 */
const WALL_PARALLEL_EPS = 0.05;

/**
 * Two wall slabs running along each other, close enough to be one wall, that
 * the model did NOT merge into a partition.
 *
 * This is the check that makes the tool's one silent failure visible. Sharing
 * is derived geometrically and demands 1 mm coincidence (`linkShared`); miss it
 * and the design keeps two exterior walls a few centimetres apart, which reads
 * as a single thick wall in the plan and only becomes obvious in 3D. The wall
 * tool now heals the near-miss at commit, so anything reaching here is either a
 * deliberate cavity or a case the healing could not take — both worth saying
 * out loud.
 *
 * Advisory like everything else in this file: it never blocks the edit, and a
 * double-leaf wall built on purpose is a legitimate reason to ignore it.
 */
function parallelWallChecks(walls: RoomWall[], out: Warning[]): void {
  // a partition is ONE wall seen twice; only the owner side is a real slab
  const drawn = walls.filter((w) => !w.shared || w.shared.owner);
  const centre = (w: RoomWall, p: Point): Point => ({
    x: p.x + w.inward.x * bandCenter(w),
    y: p.y + w.inward.y * bandCenter(w),
  });
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i];
      const b = drawn[j];
      if (a.shared?.wallId === b.id || b.shared?.wallId === a.id) continue;
      if (Math.abs(a.dir.x * b.dir.y - a.dir.y * b.dir.x) > WALL_PARALLEL_EPS) continue;

      const a0 = centre(a, a.a);
      const b0 = centre(b, b.a);
      const b1 = centre(b, b.b);
      const sideOf = (p: Point): number => a.dir.x * (p.y - a0.y) - a.dir.y * (p.x - a0.x);
      const alongOf = (p: Point): number => a.dir.x * (p.x - a0.x) + a.dir.y * (p.y - a0.y);
      const gap = (Math.abs(sideOf(b0)) + Math.abs(sideOf(b1))) / 2;
      const limit = Math.max(a.thickness, b.thickness);
      if (gap >= limit) continue;

      const t0 = Math.max(0, Math.min(alongOf(b0), alongOf(b1)));
      const t1 = Math.min(a.len, Math.max(alongOf(b0), alongOf(b1)));
      if (t1 - t0 < MIN_SEAM) continue;

      const at = (t: number): Point => ({ x: a0.x + a.dir.x * t, y: a0.y + a.dir.y * t });
      const ids = [a.id, b.id].sort();
      out.push({
        id: `parallelWalls:${ids.join(',')}`,
        kind: 'parallelWalls',
        severity: 'warn',
        itemIds: [],
        roomId: a.roomId || b.roomId,
        title: 'Two walls run along each other',
        detail: `Their centres are ${fmtCm(gap)} apart over ${fmtCm(t1 - t0)} — they were meant to be one wall, but the rooms do not share an edge.`,
        value: gap,
        limit,
        geom: { kind: 'segment', a: at(t0), b: at(t1) },
      });
    }
  }
}

export function runChecks(design: Design): Warning[] {
  const shapes: Shape[] = [];
  for (const it of design.items) {
    const s = itemShape(design, it);
    if (s) shapes.push(s);
  }
  const walls = allWalls(design.rooms);
  const byRoom = new Map<string, RoomWall[]>();
  for (const w of walls) {
    const list = byRoom.get(w.roomId);
    if (list) list.push(w);
    else byRoom.set(w.roomId, [w]);
  }
  const wallFaces = new Map<string, Face[]>();
  for (const room of design.rooms) {
    wallFaces.set(
      room.id,
      (byRoom.get(room.id) ?? []).map((g) => wallFace(g, room.style.wallHeight))
    );
  }
  const wallFacesOf = (roomId: string): Face[] => wallFaces.get(roomId) ?? [];
  const work = workItems(design, shapes);

  const found: Warning[] = [];
  overlapChecks(shapes, found);
  throughWallChecks(shapes, byRoom, found);
  doorChecks(design, shapes, walls, found);
  passageChecks(passageFaces(design, shapes, wallFaces, work), found);
  frontChecks(design, shapes, wallFacesOf, work, found);
  parallelWallChecks(designWalls(design.rooms, design.walls), found);
  bedChecks(shapes, wallFacesOf, found);
  triangleChecks(shapes, found);

  const unique = new Map<string, Warning>();
  for (const w of found) if (!unique.has(w.id)) unique.set(w.id, w);
  return [...unique.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
