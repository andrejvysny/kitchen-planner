/**
 * Planar face extraction over wall centrelines — the general answer to "what
 * did that chain just enclose?".
 *
 * The wall tool used to answer it by walking ONE room's corner ring backwards
 * from the chain's end to its start. That works for a chain drawn off a single
 * room and for nothing else: land the two ends on two DIFFERENT rooms, or on a
 * free-standing chain, and there is no single ring to walk, so a perfectly
 * closed region committed as free-standing walls instead of a room. A plan is
 * drawn room-beside-room, so that case is the normal one after the second room.
 *
 * The standard construction is used instead. Every centreline — existing walls
 * and the chain alike — is cut at every crossing into a planar subdivision, and
 * its faces are traced by the "next edge clockwise from the reversed incoming
 * edge" rule. The face bounded partly by the chain IS the new room, whatever
 * the surrounding topology happens to be.
 *
 * Pure, DOM-free and framework-free, like everything else in src/model.
 * Coordinates are metres.
 */

import { dist, segmentIntersection, signedArea } from './geometry';
import type { Point } from './types';

/** Two points closer than this are the same node (1 mm — SHARE_EPS's twin). */
const NODE_EPS = 1e-3;
/** Cross-product floor below which three points count as collinear. */
const COLLINEAR_EPS = 1e-9;

export interface FaceSegment {
  a: Point;
  b: Point;
  /** true for the chain being drawn, false for geometry that already exists */
  chain?: boolean;
}

/**
 * Vertices merged within `NODE_EPS`.
 *
 * A plain quantised hash is not enough on its own: two points 0.6 mm apart can
 * still land in different buckets, and a subdivision that disagrees with itself
 * about whether two walls meet produces faces that do not close. So the bucket
 * is only a candidate filter and the 3×3 neighbourhood is re-checked exactly.
 */
class Nodes {
  readonly pts: Point[] = [];
  private readonly buckets = new Map<string, number[]>();

  id(p: Point): number {
    const bx = Math.round(p.x / NODE_EPS);
    const by = Math.round(p.y / NODE_EPS);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (dist(this.pts[i], p) <= NODE_EPS) return i;
        }
      }
    }
    const id = this.pts.length;
    this.pts.push({ x: p.x, y: p.y });
    const key = `${bx},${by}`;
    const list = this.buckets.get(key);
    if (list) list.push(id);
    else this.buckets.set(key, [id]);
    return id;
  }
}

/** Parameter of `p` along `a→b`, or null when it does not lie on the segment. */
function paramOn(p: Point, a: Point, b: Point): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  const cl = Math.min(1, Math.max(0, t));
  const q = { x: a.x + dx * cl, y: a.y + dy * cl };
  return dist(p, q) <= NODE_EPS ? cl : null;
}

interface Edge {
  from: number;
  to: number;
  chain: boolean;
}

/**
 * Cut every segment at every point another segment touches or crosses it, so
 * that afterwards two edges meet only at shared endpoints.
 *
 * Both kinds of contact matter and they are found separately: a proper
 * CROSSING comes from `segmentIntersection`, while a T-junction — one wall
 * ending against the middle of another, which is most of a floor plan — has no
 * crossing at all and is found by testing endpoints against segments.
 */
function planarize(segs: FaceSegment[], nodes: Nodes): Edge[] {
  const cuts: { t: number; id: number }[][] = segs.map(() => []);
  const cut = (i: number, p: Point): void => {
    const t = paramOn(p, segs[i].a, segs[i].b);
    if (t !== null) cuts[i].push({ t, id: nodes.id(p) });
  };
  for (let i = 0; i < segs.length; i++) {
    cut(i, segs[i].a);
    cut(i, segs[i].b);
  }
  // AABBs first: the pass below is O(n²) and a floor plan is mostly walls that
  // cannot possibly touch, so rejecting on a box costs four comparisons and
  // skips five geometric tests
  const box = segs.map((s) => ({
    x0: Math.min(s.a.x, s.b.x) - NODE_EPS,
    y0: Math.min(s.a.y, s.b.y) - NODE_EPS,
    x1: Math.max(s.a.x, s.b.x) + NODE_EPS,
    y1: Math.max(s.a.y, s.b.y) + NODE_EPS,
  }));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = box[i];
      const q = box[j];
      if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
      const x = segmentIntersection(segs[i].a, segs[i].b, segs[j].a, segs[j].b);
      if (x) {
        cut(i, x.p);
        cut(j, x.p);
      }
      cut(i, segs[j].a);
      cut(i, segs[j].b);
      cut(j, segs[i].a);
      cut(j, segs[i].b);
    }
  }

  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (let i = 0; i < segs.length; i++) {
    const list = cuts[i].sort((p, q) => p.t - q.t);
    for (let k = 0; k + 1 < list.length; k++) {
      const a = list[k].id;
      const b = list[k + 1].id;
      if (a === b) continue;
      // the same stretch can be produced by two overlapping input segments
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) {
        if (segs[i].chain) {
          const hit = edges.find(
            (e) => (e.from === a && e.to === b) || (e.from === b && e.to === a)
          );
          if (hit) hit.chain = true;
        }
        continue;
      }
      seen.add(key);
      edges.push({ from: a, to: b, chain: !!segs[i].chain });
    }
  }
  return edges;
}

export interface Face {
  ring: Point[];
  /** the face is bounded partly by the chain */
  onChain: boolean;
  /** positive is the interior orientation; the outer face comes out negative */
  area: number;
}

/**
 * Every face of the subdivision, the unbounded one included (it is the only
 * face whose signed area comes out negative, which is how callers drop it).
 *
 * The traversal is the textbook one: from a directed edge u→v, the next edge is
 * the outgoing edge at `v` sitting immediately clockwise of the direction back
 * to `u`. Every directed edge belongs to exactly one face, so walking each
 * unvisited one yields every face exactly once.
 */
export function planarFaces(segs: FaceSegment[]): Face[] {
  const nodes = new Nodes();
  const edges = planarize(segs, nodes);
  if (!edges.length) return [];

  // half-edge 2k is edges[k] forward, 2k+1 is its twin; twin = h ^ 1
  const from: number[] = [];
  const to: number[] = [];
  const chain: boolean[] = [];
  for (const e of edges) {
    from.push(e.from, e.to);
    to.push(e.to, e.from);
    chain.push(e.chain, e.chain);
  }
  const angle = (h: number): number => {
    const a = nodes.pts[from[h]];
    const b = nodes.pts[to[h]];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };

  const outgoing = new Map<number, number[]>();
  for (let h = 0; h < from.length; h++) {
    const list = outgoing.get(from[h]);
    if (list) list.push(h);
    else outgoing.set(from[h], [h]);
  }
  const rank = new Map<number, number>();
  for (const [, list] of outgoing) {
    list.sort((p, q) => angle(p) - angle(q));
    list.forEach((h, i) => rank.set(h, i));
  }

  const next = (h: number): number => {
    const twin = h ^ 1;
    const list = outgoing.get(from[twin])!;
    const i = rank.get(twin)!;
    // immediately clockwise of the way back = the previous entry, cyclically
    return list[(i - 1 + list.length) % list.length];
  };

  const faces: Face[] = [];
  const seen = new Uint8Array(from.length);
  for (let h0 = 0; h0 < from.length; h0++) {
    if (seen[h0]) continue;
    const ring: Point[] = [];
    let onChain = false;
    let h = h0;
    for (let guard = 0; guard <= from.length; guard++) {
      if (seen[h]) break;
      seen[h] = 1;
      onChain ||= chain[h];
      ring.push(nodes.pts[from[h]]);
      h = next(h);
      if (h === h0) break;
    }
    const clean = dropCollinear(ring);
    if (clean.length < 3) continue;
    faces.push({ ring: clean, onChain, area: signedArea(clean) });
  }
  return faces;
}

/**
 * Drop vertices that only continue a straight run. A face walk stops at every
 * node, so a wall split by a neighbour's tee comes back as two collinear edges;
 * a room does not want the extra corner, and `edgeCentrelineHits` reports every
 * collinear wall under the merged edge anyway.
 */
function dropCollinear(ring: Point[]): Point[] {
  const n = ring.length;
  if (n < 3) return ring;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const scale = Math.max(dist(a, b) * dist(b, c), 1e-9);
    if (Math.abs(cross) / scale > COLLINEAR_EPS) out.push(b);
  }
  return out.length >= 3 ? out : ring;
}
