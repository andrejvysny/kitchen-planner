/**
 * `resolveSnap` — the one place a plan gesture turns a raw cursor into a point.
 *
 * Three stages, in strict order:
 *
 *  1. POINT candidates (endpoint / midpoint / intersection). Each fully
 *     determines the answer, so the best one wins and nothing else is consulted.
 *  2. LINE candidates (align / extension / perpendicular / parallel /
 *     onSegment / angle). Each removes ONE degree of freedom, so the top two
 *     non-parallel ones are INTERSECTED. That is the stage the old ladder had
 *     no equivalent of, and it is what makes "lined up with that corner AND
 *     square to the wall I just drew" reachable — previously you could have
 *     either constraint but never both.
 *  3. GRID, then the bare cursor.
 *
 * Guides describe only what ACTUALLY applied. A guide for a constraint that
 * lost is a lie about where the point came from, so losing candidates are
 * dropped rather than drawn faintly.
 */

import { dist, lineIntersection } from '../geometry';
import type { Point } from '../types';
import {
  alignCandidates,
  angleCandidates,
  intersectionCandidates,
  orthoCandidates,
  pointCandidates,
  segmentLineCandidates,
} from './sources';
import type { SnapConfig, SnapContext, SnapGuide, SnapLine, SnapPoint, SnapResult } from './types';

/** sin of the angle below which two constraint lines are too parallel to intersect (~2.9°). */
const PARALLEL_EPS = 0.05;

const free = (p: Point): SnapResult => ({
  p: { x: p.x, y: p.y },
  kind: 'free',
  kinds: [],
  guides: [],
});

const allows = (cfg: SnapConfig, kind: SnapPoint['kind']): boolean =>
  !cfg.enabled || cfg.enabled.has(kind);

/** Foot of the perpendicular from `p` onto the infinite line through `o` along unit `d`. */
function projectOnLine(p: Point, o: Point, d: Point): Point {
  const t = (p.x - o.x) * d.x + (p.y - o.y) * d.y;
  return { x: o.x + d.x * t, y: o.y + d.y * t };
}

/**
 * A guide is worth drawing only when it connects the snapped point to something
 * ELSE the user can see. `angle`, `perpendicular` and `parallel` all radiate
 * from the anchor, so their "guide" is the pending segment itself — drawing it
 * just lays a second line over the rubber band. Those report through the cursor
 * glyph instead, and return null here.
 */
function guideForLine(line: SnapLine, at: Point, anchor: Point | null): SnapGuide | null {
  const from = line.ref ?? line.origin;
  if (anchor && dist(from, anchor) < 1e-9) return null;
  return { a: from, b: at, kind: line.kind };
}

export function resolveSnap(cursor: Point, ctx: SnapContext, cfg: SnapConfig): SnapResult {
  if (cfg.suppressed) return free(cursor);

  const reachP = Math.min(cfg.pointReachPx / cfg.zoom, cfg.maxWorldReach);
  const reachL = Math.min(cfg.lineReachPx / cfg.zoom, cfg.maxWorldReach);

  /* ---- stage 1: points ---- */
  const pts: SnapPoint[] = [];
  for (const c of pointCandidates(cursor, ctx, reachP)) if (allows(cfg, c.kind)) pts.push(c);
  if (allows(cfg, 'intersection')) {
    for (const c of intersectionCandidates(cursor, ctx, reachP)) pts.push(c);
  }
  if (pts.length) {
    let best = pts[0];
    for (const c of pts) if (c.score > best.score) best = c;
    // an intersection is the one point kind whose two sources are worth
    // drawing: the glyph says WHERE, the guides say which two walls made it
    const guides: SnapGuide[] =
      best.kind === 'intersection' && best.ref && best.ref2
        ? [
            { a: best.ref, b: best.p, kind: 'intersection' },
            { a: best.ref2, b: best.p, kind: 'intersection' },
          ]
        : [];
    return {
      p: best.p,
      kind: best.kind,
      kinds: [best.kind],
      guides: guides.slice(0, cfg.maxGuides),
    };
  }

  /* ---- stage 2: lines ---- */
  const lines: SnapLine[] = [];
  const take = (arr: SnapLine[]): void => {
    for (const l of arr) if (allows(cfg, l.kind)) lines.push(l);
  };
  take(alignCandidates(cursor, ctx, reachL));
  take(segmentLineCandidates(cursor, ctx, reachL));
  take(orthoCandidates(cursor, ctx, reachL));

  if (cfg.angleStep !== null) {
    // filter to what is ALLOWED first: a disabled angle line must not still
    // knock out its rivals on its way to not being used
    const angle = angleCandidates(cursor, ctx, cfg.angleStep, reachL).filter((l) =>
      allows(cfg, l.kind)
    );
    if (angle.length) {
      // The lock already fixes this degree of freedom, THROUGH THE USER'S OWN
      // ANCHOR. Another line parallel to it can therefore only ever fight it —
      // it constrains the same axis from somewhere else — and because a line
      // cannot be crossed with a parallel one, the two can never combine into a
      // better answer either. So the lock takes the axis and the rivals go.
      //
      // Without this an `align` through any reference whose y happened to be
      // within reach (a distant wall's midpoint, say) outranked the lock on
      // weight alone and quietly tilted a segment the user had explicitly asked
      // to be straight. Non-parallel lines are untouched, which is the whole
      // point: "vertically in line with that corner AND square to my last wall"
      // still intersects into one exact point.
      const ad = angle[0].dir;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cross = Math.abs(lines[i].dir.x * ad.y - lines[i].dir.y * ad.x);
        if (cross < PARALLEL_EPS) lines.splice(i, 1);
      }
      lines.push(...angle);
    }
  }

  if (lines.length) {
    lines.sort((a, b) => b.score - a.score);
    const first = lines[0];
    // the best line PLUS the best one it can actually be crossed with: a second
    // near-parallel constraint adds nothing and intersects at a wild distance
    for (let i = 1; i < lines.length; i++) {
      const other = lines[i];
      const cross = Math.abs(first.dir.x * other.dir.y - first.dir.y * other.dir.x);
      if (cross < PARALLEL_EPS) continue;
      // Two lines through the SAME origin meet at that origin and nowhere else,
      // so crossing them says nothing and lands the vertex exactly on the
      // anchor — a zero-length wall. `angle`, `perpendicular` and `parallel`
      // are all anchored there, so this pairing is common, not exotic.
      if (dist(first.origin, other.origin) < 1e-9) continue;
      const p = lineIntersection(first.origin, first.dir, other.origin, other.dir);
      if (!p || dist(cursor, p) > reachL) continue;
      return {
        p,
        kind: first.kind,
        kinds: [first.kind, other.kind],
        guides: [guideForLine(first, p, ctx.anchor), guideForLine(other, p, ctx.anchor)]
          .filter((g): g is SnapGuide => g !== null)
          .slice(0, cfg.maxGuides),
      };
    }
    const p = projectOnLine(cursor, first.origin, first.dir);
    const g = guideForLine(first, p, ctx.anchor);
    return {
      p,
      kind: first.kind,
      kinds: [first.kind],
      guides: g ? [g].slice(0, cfg.maxGuides) : [],
    };
  }

  /* ---- stage 3: grid, then nothing ---- */
  if (cfg.gridStep !== null && cfg.gridStep > 0 && allows(cfg, 'grid')) {
    const g = cfg.gridStep;
    return {
      p: { x: Math.round(cursor.x / g) * g, y: Math.round(cursor.y / g) * g },
      kind: 'grid',
      kinds: ['grid'],
      guides: [],
    };
  }
  return free(cursor);
}
