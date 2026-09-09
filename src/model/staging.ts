import { defOfDesign, partOfDesign } from './attach';
import { isDecor, type CatalogDef } from './catalog';
import { obbOverlap, pointInPolygon, polygonBounds, polygonCentroid, type Obb } from './geometry';
import { clearanceAbove, surfaceContains, surfacesOf, type Surface } from './surfaces';
import type { Design, Item, Point } from './types';

/**
 * Room staging — filling a finished room with the clutter that makes it read
 * as lived-in, in one go.
 *
 * Pure and DETERMINISTIC. `planStaging` returns POSES, never items: `uid()` is
 * random, so ids can never be reproducible and only the arrangement can be.
 * Everything else follows from wanting the same seed to give the same room:
 * a seeded PRNG rather than `Math.random`, iteration over arrays in index
 * order, and `surfacesOf`'s documented stable ordering underneath.
 *
 * The rules below are the interesting part, and they are all about the KITCHEN
 * being a working space rather than a display: nothing is staged within reach
 * of the hob (that is where pans go and where a plant would burn), the
 * washing-up things cluster at the sink, and the long clear stretch between
 * them becomes the prep zone. Everything else — shelves, floor, tables — is
 * simpler because it has no such constraint.
 */

export interface StageSpec {
  defId: string;
  x: number;
  y: number;
  rotation: number;
  elevation: number;
  params?: Record<string, number>;
}

/* ---------------- determinism ---------------- */

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and the same everywhere. Never `Math.random`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- geometry helpers ---------------- */

const CLEAR_MARGIN = 0.03;
/** hob exclusion: NKBA puts a 300 mm landing beside a cooktop; keep clear of it */
const HOT_REACH = 0.45;
/** how far from the sink counts as the washing-up end of the run */
const WET_REACH = 0.55;
/** a prep stretch shorter than this is not worth dressing. 0.4 m, not 0.6:
 *  a three-unit run with a sink in the middle has no 60 cm clear stretch at
 *  all, and staging nothing in a real kitchen is the wrong answer. */
const PREP_MIN = 0.4;
/** headroom a shelf needs before anything is put on it */
const SHELF_HEADROOM = 0.22;

const obbOf = (x: number, y: number, w: number, d: number, rot: number): Obb => ({
  cx: x,
  cy: y,
  w,
  d,
  rot,
});

function corners(o: Obb): Point[] {
  const c = Math.cos(o.rot);
  const s = Math.sin(o.rot);
  const hw = o.w / 2;
  const hd = o.d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => ({ x: o.cx + p.x * c - p.y * s, y: o.cy + p.x * s + p.y * c }));
}

/** Wholly on the surface, clear of its cutouts, with a margin all round. */
function fitsOn(s: Surface, o: Obb): boolean {
  const grown = obbOf(o.cx, o.cy, o.w + CLEAR_MARGIN * 2, o.d + CLEAR_MARGIN * 2, o.rot);
  for (const p of corners(grown)) {
    if (!pointInPolygon(p, s.outline)) return false;
    for (const h of s.holes) if (pointInPolygon(p, h)) return false;
  }
  return true;
}

/**
 * Is there `need` metres of clear air above `p`, starting at `from`?
 *
 * POINT-based, unlike `clearanceAbove`, and that difference is load-bearing:
 * a room floor's bounds overlap every worktop and shelf in the room, so the
 * bounds test would report a 4 x 3 m floor as having 50 cm of headroom and no
 * plant would ever be staged anywhere.
 */
function clearAt(surfaces: readonly Surface[], p: Point, from: number, need: number): boolean {
  for (const s of surfaces) {
    if (s.top <= from + 1e-6 || s.top >= from + need) continue;
    if (surfaceContains(s, p)) return false;
  }
  return true;
}

/* ---------------- the planner ---------------- */

interface Ctx {
  design: Design;
  roomId: string;
  rand: () => number;
  density: number;
  /** everything placed so far, for the no-overlap rule */
  taken: { obb: Obb; z0: number; z1: number }[];
  out: StageSpec[];
}

function defOf(design: Design, id: string): CatalogDef | null {
  return defOfDesign(design, id);
}

/**
 * Try to place `defId` centred on (x, y). Returns false — and stages nothing —
 * when it would hang off the surface, sit in a cutout, or collide with
 * something already there.
 */
function tryPlace(c: Ctx, s: Surface, defId: string, x: number, y: number, jitter = 0.21): boolean {
  const def = defOf(c.design, defId);
  if (!def) return false;
  const rot = s.rotation + (c.rand() - 0.5) * jitter;
  const obb = obbOf(x, y, def.w, def.d, rot);
  if (!fitsOn(s, obb)) return false;

  const z0 = s.top;
  const z1 = s.top + def.h;
  for (const t of c.taken) {
    if (Math.min(t.z1, z1) - Math.max(t.z0, z0) <= 0.001) continue;
    if (obbOverlap(t.obb, obb)) return false;
  }
  c.taken.push({ obb, z0, z1 });
  c.out.push({ defId, x, y, rotation: rot, elevation: s.top });
  return true;
}

/** Items of these kinds whose centre lies on the surface. */
function appliancesOn(design: Design, s: Surface, kinds: string[]): Item[] {
  return design.items.filter((it) => {
    const def = defOfDesign(design, it.defId);
    if (!def || !kinds.includes(def.kind)) return false;
    return pointInPolygon({ x: it.x, y: it.y }, s.outline);
  });
}

/** `n` scaled by density, at least 0. */
const count = (c: Ctx, base: number): number => Math.max(0, Math.round(base * c.density * 2));

/**
 * Worktop rule. The run is walked along its OWN axis, so a rotated kitchen
 * stages exactly like an axis-aligned one.
 */
function stageWorktop(c: Ctx, s: Surface): void {
  const b = polygonBounds(s.outline);
  const along = { x: Math.cos(s.rotation), y: Math.sin(s.rotation) };
  const into = { x: -Math.sin(s.rotation), y: Math.cos(s.rotation) };
  const mid = polygonCentroid(s.outline);
  const proj = (p: Point): number => (p.x - mid.x) * along.x + (p.y - mid.y) * along.y;
  const at = (t: number, v: number): Point => ({
    x: mid.x + along.x * t + into.x * v,
    y: mid.y + along.y * t + into.y * v,
  });

  const half = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
  // extent ACROSS the run, so the two depth bands below scale with the actual
  // worktop rather than to a hardcoded 600 mm
  const depth = Math.min(b.maxX - b.minX, b.maxY - b.minY);
  /** hard against the back wall: kettles, jars, the things pushed out of the way */
  const backV = -depth / 2 + 0.13;
  /** the front half, where you actually work */
  const frontV = depth / 2 - 0.16;
  const sinks = appliancesOn(c.design, s, ['sink']);
  const hobs = appliancesOn(c.design, s, ['hob']);
  const sinkT = sinks.length ? proj({ x: sinks[0].x, y: sinks[0].y }) : null;
  const hotT = hobs.length ? proj({ x: hobs[0].x, y: hobs[0].y }) : null;

  const hot = (t: number): boolean => hotT !== null && Math.abs(t - hotT) < HOT_REACH;

  // --- wet zone: washing-up lives beside the sink ---
  // `wetSide` is +1 or -1 along the run; the dry end is the other way, and the
  // kettle goes there. Sending both to the same end (which "the end furthest
  // from the sink" does when the sink is in the MIDDLE, where sinkT is 0) puts
  // the kettle inside the dish rack and the collision rule then drops it.
  let wetSide = 0;
  if (sinkT !== null) {
    wetSide = sinkT > 0 ? -1 : 1; // toward the longer stretch of run
    const wet = sinkT + wetSide * WET_REACH;
    if (!hot(wet)) {
      // mid-depth, not the back strip: a dish rack is nearly as deep as the
      // worktop, so pushing it back would hang it off the rear edge
      tryPlace(c, s, 'decor-dish-rack', at(wet, 0).x, at(wet, 0).y);
    }
    if (c.density > 0.35) {
      // the towel hangs on the OTHER side of the sink from the rack
      const t2 = sinkT - wetSide * 0.34;
      if (!hot(t2)) tryPlace(c, s, 'decor-tea-towel', at(t2, frontV).x, at(t2, frontV).y);
    }
  }

  // --- the back edge: kettle and jars, at the DRY end ---
  const dry = wetSide === 0 ? 1 : -wetSide;
  const backEnd = dry * (half - 0.22);
  if (!hot(backEnd)) {
    tryPlace(c, s, 'decor-kettle', at(backEnd, backV).x, at(backEnd, backV).y);
    for (let i = 0; i < count(c, 1); i++) {
      const t = backEnd - dry * (0.2 + i * 0.13);
      if (!hot(t)) tryPlace(c, s, 'decor-jars', at(t, backV).x, at(t, backV).y);
    }
  }

  // --- prep zone: the longest stretch with neither appliance in it ---
  const busy = [sinkT, hotT].filter((v): v is number => v !== null).sort((a, z) => a - z);
  const edges = [-half, ...busy, half];
  let best: { t: number; len: number } | null = null;
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i] + (i === 0 ? 0.1 : 0.35);
    const hi = edges[i + 1] - (i === edges.length - 2 ? 0.1 : 0.35);
    if (hi - lo < PREP_MIN) continue;
    if (!best || hi - lo > best.len) best = { t: (lo + hi) / 2, len: hi - lo };
  }
  if (best) {
    tryPlace(c, s, 'decor-board', at(best.t, frontV).x, at(best.t, frontV).y);
    if (c.density > 0.3) {
      const t = best.t + (best.len > 0.9 ? 0.34 : 0);
      tryPlace(c, s, 'decor-fruit-bowl', at(t, frontV * 0.4).x, at(t, frontV * 0.4).y);
    }
    if (c.density > 0.7) {
      tryPlace(c, s, 'decor-crock', at(best.t, backV).x, at(best.t, backV).y);
    }
  }
}

/** Shelf / open-niche rule. Only surfaces you can actually see into. */
function stageShelf(c: Ctx, s: Surface, surfaces: readonly Surface[]): void {
  if (!s.visible) return;
  const b = polygonBounds(s.outline);
  const w = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (w < 0.25) return;
  if (clearanceAbove(surfaces, s) < SHELF_HEADROOM) return;

  const along = { x: Math.cos(s.rotation), y: Math.sin(s.rotation) };
  const mid = polygonCentroid(s.outline);
  const at = (t: number): Point => ({ x: mid.x + along.x * t, y: mid.y + along.y * t });

  // alternate a book stack with something to look at — a shelf of books alone
  // reads as a library, a shelf of ornaments alone as a showroom
  const slots = Math.max(1, Math.min(3, Math.floor(w / 0.28)));
  const ornaments = ['decor-vase', 'decor-frame', 'decor-herbs'];
  for (let i = 0; i < slots; i++) {
    const t = (i - (slots - 1) / 2) * (w / Math.max(1, slots));
    const p = at(t);
    const pick = i % 2 === 0 ? 'decor-books' : ornaments[Math.floor(c.rand() * ornaments.length)];
    if (c.rand() > c.density) continue;
    tryPlace(c, s, pick, p.x, p.y, 0.3);
  }
}

/** Table rule: a centrepiece, and at higher density something beside it. */
function stageTable(c: Ctx, s: Surface, surfaces: readonly Surface[]): void {
  if (clearanceAbove(surfaces, s) < SHELF_HEADROOM) return;
  const b = polygonBounds(s.outline);
  const w = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  if (w < 0.3) return;
  const mid = polygonCentroid(s.outline);
  const along = { x: Math.cos(s.rotation), y: Math.sin(s.rotation) };

  // a low table gets magazines, a dining-height one a bowl
  tryPlace(c, s, s.top < 0.6 ? 'decor-magazines' : 'decor-fruit-bowl', mid.x, mid.y);
  if (c.density > 0.5) {
    const off = Math.min(0.3, w / 2 - 0.12);
    tryPlace(c, s, 'decor-candles', mid.x + along.x * off, mid.y + along.y * off);
  }
}

/**
 * Floor rule: one plant per room, in the emptiest corner.
 *
 * Corners in ring order, first clear one wins — not "the best" corner, because
 * scoring them would make the result move whenever anything else in the room
 * moved, and a plant that teleports on every edit is worse than a plant in the
 * second-best corner.
 */
function stageFloor(c: Ctx, s: Surface, surfaces: readonly Surface[]): void {
  const plant = defOf(c.design, 'decor-plant');
  if (!plant) return;
  const mid = polygonCentroid(s.outline);
  for (const corner of s.outline) {
    // step in from the corner by the plant's own radius plus a hand's width
    const inset = plant.w / 2 + 0.12;
    const dx = mid.x - corner.x;
    const dy = mid.y - corner.y;
    const len = Math.hypot(dx, dy) || 1;
    const p = { x: corner.x + (dx / len) * inset * 1.6, y: corner.y + (dy / len) * inset * 1.6 };

    // anything already standing here — a cabinet, a bed — rules the corner out
    const obb = obbOf(p.x, p.y, plant.w, plant.d, 0);
    const blocked = c.design.items.some((it) => {
      const def = defOfDesign(c.design, it.defId);
      if (!def || isDecor(def)) return false;
      if (it.elevation > 0.4) return false; // wall units do not block the floor
      return obbOverlap(obbOf(it.x, it.y, it.w + 0.2, it.d + 0.2, it.rotation), obb);
    });
    if (blocked) continue;
    // and nothing may hang low over that SPOT (a worktop three metres away is
    // not in the way — see clearAt)
    if (!clearAt(surfaces, p, 0, plant.h)) continue;
    if (tryPlace(c, s, 'decor-plant', p.x, p.y, 0.6)) return;
  }
}

/**
 * Plan a room's set dressing. Returns poses only — the caller mints the items,
 * so the same seed reproduces the same ARRANGEMENT, never the same ids.
 *
 * `density` 0 stages nothing; 1 stages a lot. The default seed is a hash of
 * the room id, so re-staging one room reproduces it and two rooms differ.
 */
export function planStaging(
  design: Design,
  roomId: string,
  density = 0.5,
  seed = hashString(roomId)
): StageSpec[] {
  if (density <= 0) return [];
  const c: Ctx = { design, roomId, rand: mulberry32(seed), density, taken: [], out: [] };

  // `hostContexts` is a Map, whose iteration order is insertion order — stable,
  // and `surfacesOf` is documented as order-stable for exactly this reason.
  // Do not "optimise" either into a Set.
  const all = surfacesOf(design);
  const mine = all.filter((s) => s.roomId === roomId);

  for (const s of mine) if (s.kind === 'worktop') stageWorktop(c, s);
  for (const s of mine) if (s.kind === 'shelf' || s.kind === 'niche') stageShelf(c, s, all);
  for (const s of mine) if (s.kind === 'table') stageTable(c, s, all);
  for (const s of mine) if (s.kind === 'floor') stageFloor(c, s, all);

  return c.out;
}

/** Is this item something `planStaging` put there? (What "Clear" removes.) */
export function isStagedItem(design: Design, it: Item): boolean {
  if (partOfDesign(design, it.defId)) return false;
  const def = defOfDesign(design, it.defId);
  return !!def && isDecor(def);
}
