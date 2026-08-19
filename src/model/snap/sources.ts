/**
 * Candidate generators: everything that turns the design and the chain in
 * flight into `SnapPoint`s and `SnapLine`s.
 *
 * Two rules hold this file together.
 *
 * 1. **Cull before you allocate.** These run on every pointermove. A generator
 *    filters by a cheap scalar test (one coordinate delta, one perpendicular
 *    distance) and only then builds an object. A plan with forty walls must not
 *    mint a hundred candidate objects per mouse move.
 * 2. **Score is `weight − distance / reach`.** The ratio is what makes the
 *    ranking zoom-independent: `reach` is itself derived from the zoom, so the
 *    two cancel and a candidate at the very edge of its reach always loses
 *    exactly one point. That keeps `TYPE_WEIGHT`'s gaps readable — a 10-point
 *    gap means "wins unless it is ten reaches further away", i.e. always.
 */

import { closestOnSegment, dist, lineIntersection } from '../geometry';
import type { Point } from '../types';
import {
  TYPE_WEIGHT,
  type SnapContext,
  type SnapKind,
  type SnapLine,
  type SnapPoint,
  type SnapRef,
  type SnapSegment,
} from './types';

/** How many near lines get paired for `intersection`. Caps an O(n²). */
const MAX_PAIR_LINES = 8;

/** How many walls near the anchor contribute a ⊥ / ∥ direction. */
const MAX_ORTHO_REFS = 4;

/** Length below which a segment is degenerate and carries no direction. */
const MIN_LEN = 1e-9;

/**
 * Most an alignment can lose for being drawn from a far-away reference, and the
 * distance (m) at which it has lost half of that. Deliberately smaller than the
 * gap down to `onSegment` (10 points), so a decayed alignment still outranks
 * lying on a wall — it re-orders alignments against each other, it does not
 * demote the whole kind.
 */
const ALIGN_FAR_PENALTY = 6;
const ALIGN_FALLOFF = 2;

const unit = (a: Point, b: Point): Point | null => {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < MIN_LEN) return null;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
};

/** Perpendicular distance from `p` to the infinite line through `o` along unit `d`. */
const lineDist = (p: Point, o: Point, d: Point): number =>
  Math.abs((p.x - o.x) * d.y - (p.y - o.y) * d.x);

const score = (kind: SnapKind, worldDist: number, reach: number): number =>
  TYPE_WEIGHT[kind] - worldDist / reach;

/* ---------------- design → reusable context material ---------------- */

/**
 * The design-derived half of a `SnapContext`: every centreline as a segment,
 * plus its two ends and its midpoint as reference points.
 *
 * Built ONCE per gesture by the caller. `segments` arrive already in the space
 * the caller wants to snap in — the wall tool passes
 * `wallCentrelines(rooms, freeWalls).segments`, the measure tool passes raw
 * walls — so this stays ignorant of the centreline/face distinction the rest of
 * rooms.ts has to care about.
 */
export function contextMaterial(segments: SnapSegment[]): {
  segments: SnapSegment[];
  points: SnapRef[];
} {
  const points: SnapRef[] = [];
  for (const s of segments) {
    points.push({ p: s.a, kind: 'endpoint' });
    points.push({ p: s.b, kind: 'endpoint' });
    if (dist(s.a, s.b) > MIN_LEN) {
      points.push({ p: { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, kind: 'midpoint' });
    }
  }
  return { segments, points };
}

/* ---------------- point candidates ---------------- */

/**
 * Endpoints and midpoints within reach, plus every vertex of the chain in
 * flight — which is what lifts the old two-vertex limit, where `drawPts[0]` and
 * the anchor were the entire reference set.
 *
 * The ANCHOR is excluded as a TARGET: landing the pending vertex on the vertex
 * it starts from is a zero-length wall, never what the user meant. It stays an
 * alignment reference, just not somewhere you can land.
 */
export function pointCandidates(cursor: Point, ctx: SnapContext, reach: number): SnapPoint[] {
  const out: SnapPoint[] = [];
  const push = (p: Point, kind: SnapKind, r = reach): void => {
    const d = dist(cursor, p);
    if (d > r) return;
    out.push({ p: { x: p.x, y: p.y }, kind, score: score(kind, d, r), ref: p });
  };
  for (const r of ctx.points) push(r.p, r.kind);
  for (const j of ctx.junctions ?? []) push(j, 'junction');
  for (let i = 0; i < ctx.chain.length; i++) {
    const v = ctx.chain[i];
    if (ctx.anchor && v === ctx.anchor) continue;
    // the first vertex of a ring long enough to close is the CLOSE target: its
    // own kind, and a wider reach, because everything about finishing a room
    // depends on being able to land on it
    if (i === 0 && ctx.chain.length >= 3) push(v, 'close', reach * CLOSE_REACH_SCALE);
    else push(v, 'endpoint');
  }
  return out;
}

/** How much further than a normal point snap the close target reaches. */
export const CLOSE_REACH_SCALE = 1.4;

/**
 * Crossings of the constraint LINES the near segments carry — extensions
 * included, which is the point: two walls that stop short of each other still
 * define the corner they would make, and that corner is usually exactly where
 * the next wall goes.
 *
 * Only segments whose line passes within reach of the cursor are paired, and
 * that list is capped, so the O(n²) is over a handful.
 */
export function intersectionCandidates(
  cursor: Point,
  ctx: SnapContext,
  reach: number
): SnapPoint[] {
  const near: { o: Point; d: Point; seg: SnapSegment }[] = [];
  for (const s of ctx.segments) {
    const d = unit(s.a, s.b);
    if (!d) continue;
    if (lineDist(cursor, s.a, d) > reach) continue;
    near.push({ o: s.a, d, seg: s });
    if (near.length >= MAX_PAIR_LINES) break;
  }
  const out: SnapPoint[] = [];
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const p = lineIntersection(near[i].o, near[i].d, near[j].o, near[j].d);
      if (!p) continue;
      const dd = dist(cursor, p);
      if (dd > reach) continue;
      out.push({
        p,
        kind: 'intersection',
        score: score('intersection', dd, reach),
        ref: near[i].seg.a,
        ref2: near[j].seg.a,
      });
    }
  }
  return out;
}

/* ---------------- line candidates ---------------- */

/**
 * Horizontal / vertical through any reference point in the band — the
 * inference every sketcher has, and the one this tool was missing beyond its
 * own previous vertex.
 *
 * The cull is the whole trick: a reference is only interesting if ONE of its
 * coordinates is within reach of the cursor's, which is a single subtraction
 * per point and allocates nothing for the overwhelming majority that miss.
 */
export function alignCandidates(cursor: Point, ctx: SnapContext, reach: number): SnapLine[] {
  const out: SnapLine[] = [];
  const consider = (p: Point): void => {
    const dx = Math.abs(p.x - cursor.x);
    const dy = Math.abs(p.y - cursor.y);
    // Rank a NEAR reference above a far one. Perpendicular distance alone
    // cannot: a corner 6 m up the plan sits exactly as close to a horizontal
    // line as one 10 cm away, so without this the winner among equals is
    // whichever the segment list happened to yield first — and an inference
    // drawn from somewhere the user is not even looking reads as the tool
    // moving on its own. The penalty saturates rather than cutting off, so a
    // distant reference still works when it is the only one.
    const decay = (along: number): number => ALIGN_FAR_PENALTY * (along / (along + ALIGN_FALLOFF));
    if (dx <= reach) {
      out.push({
        origin: p,
        dir: { x: 0, y: 1 },
        kind: 'align',
        score: score('align', dx, reach) - decay(dy),
        ref: p,
      });
    }
    if (dy <= reach) {
      out.push({
        origin: p,
        dir: { x: 1, y: 0 },
        kind: 'align',
        score: score('align', dy, reach) - decay(dx),
        ref: p,
      });
    }
  };
  for (const r of ctx.points) consider(r.p);
  for (const v of ctx.chain) consider(v);
  if (ctx.anchor) consider(ctx.anchor);
  return out;
}

/**
 * A segment's own line: `onSegment` where the perpendicular foot falls inside
 * it, `extension` where it falls beyond an end. One generator for both because
 * they are the same constraint — only which half of it the user is on differs —
 * and they are worth telling apart because lying on a wall is a fact while its
 * extension is an inference.
 */
export function segmentLineCandidates(cursor: Point, ctx: SnapContext, reach: number): SnapLine[] {
  const out: SnapLine[] = [];
  for (const s of ctx.segments) {
    const d = unit(s.a, s.b);
    if (!d) continue;
    const perp = lineDist(cursor, s.a, d);
    if (perp > reach) continue;
    const foot = closestOnSegment(cursor, s.a, s.b);
    // clamping moved the foot away from the true perpendicular one ⇒ past an end
    const kind: SnapKind = dist(cursor, foot) <= perp + 1e-9 ? 'onSegment' : 'extension';
    out.push({ origin: s.a, dir: d, kind, score: score(kind, perp, reach), ref: foot });
  }
  return out;
}

/**
 * Square and parallel to a nearby wall, anchored at the vertex the pending
 * segment starts from.
 *
 * This is the inference a rotated or non-orthogonal plan lives on: the world
 * angle lock can express "square to the world" but never "square to THAT wall".
 * The previous chain segment is always offered — a square corner is the single
 * most common thing anyone draws — then the walls nearest the anchor, kept to
 * `MAX_ORTHO_REFS` by a bounded insert rather than a sort, so this allocates
 * nothing per segment.
 */
export function orthoCandidates(cursor: Point, ctx: SnapContext, reach: number): SnapLine[] {
  const anchor = ctx.anchor;
  if (!anchor) return [];

  const dirs: Point[] = [];
  const n = ctx.chain.length;
  if (n >= 2) {
    const prev = unit(ctx.chain[n - 2], ctx.chain[n - 1]);
    if (prev) dirs.push(prev);
  }

  // bounded insertion: the MAX_ORTHO_REFS segments nearest the anchor
  const best: { d: number; seg: SnapSegment }[] = [];
  for (const s of ctx.segments) {
    const d = dist(anchor, closestOnSegment(anchor, s.a, s.b));
    if (best.length === MAX_ORTHO_REFS && d >= best[best.length - 1].d) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].d > d) i--;
    best.splice(i, 0, { d, seg: s });
    if (best.length > MAX_ORTHO_REFS) best.pop();
  }
  for (const { seg } of best) {
    const d = unit(seg.a, seg.b);
    if (d) dirs.push(d);
  }

  const out: SnapLine[] = [];
  for (const d of dirs) {
    for (const [kind, dd] of [
      ['parallel', d],
      ['perpendicular', { x: -d.y, y: d.x }],
    ] as const) {
      const perp = lineDist(cursor, anchor, dd);
      if (perp > reach) continue;
      out.push({ origin: anchor, dir: dd, kind, score: score(kind, perp, reach), ref: anchor });
    }
  }
  return out;
}

/**
 * The angle lock, as a line through the anchor. ABSOLUTE world angles — a floor
 * plan is overwhelmingly axis-aligned, and the relative case is covered better,
 * and more explicitly, by `orthoCandidates` above.
 *
 * Unlike every other generator this one is NOT reach-gated, because the lock is
 * a MODE rather than a proximity snap: with it on, the pending segment is meant
 * to lie on a quantised ray wherever the cursor is. Gating it would silently
 * switch it off as soon as the cursor drifted a few centimetres off the ray —
 * at half a step (7.5°) a 3 m wall is already ~0.39 m away, so it would
 * essentially never fire.
 *
 * Its penalty is CLAMPED to one point instead of scaling with distance. That
 * leaves it just under `TYPE_WEIGHT.angle`, so any real candidate in reach
 * (weight ≥ 50) still outranks it — preserving the old rule that landing on a
 * neighbour beats the lock — while it still wins whenever nothing else fired.
 */
export function angleCandidates(
  cursor: Point,
  ctx: SnapContext,
  step: number,
  reach: number
): SnapLine[] {
  const anchor = ctx.anchor;
  if (!anchor || step <= 0) return [];
  const raw = Math.atan2(cursor.y - anchor.y, cursor.x - anchor.x);
  const a = Math.round(raw / step) * step;
  const d = { x: Math.cos(a), y: Math.sin(a) };
  const perp = Math.min(lineDist(cursor, anchor, d), reach);
  return [
    { origin: anchor, dir: d, kind: 'angle', score: score('angle', perp, reach), ref: anchor },
  ];
}
