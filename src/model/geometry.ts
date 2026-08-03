import type { Corner, Point, WallRef } from './types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Signed area of a polygon (positive when counter-clockwise in a y-up plane). */
export function signedArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function polygonCentroid(pts: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

export interface WallGeom {
  id: string;
  a: Corner;
  b: Corner;
  len: number;
  /** unit direction a -> b */
  dir: Point;
  /** unit normal pointing into the room (assumes CCW corner order) */
  inward: Point;
  angle: number;
}

export function wallGeom(w: WallRef): WallGeom {
  const len = Math.max(1e-6, dist(w.a, w.b));
  const dir = { x: (w.b.x - w.a.x) / len, y: (w.b.y - w.a.y) / len };
  // For CCW polygons the interior lies to the left of each directed edge.
  const inward = { x: -dir.y, y: dir.x };
  return { id: w.id, a: w.a, b: w.b, len, dir, inward, angle: Math.atan2(dir.y, dir.x) };
}

/** Point at distance t (m) from wall start along the wall. */
export function wallPoint(g: WallGeom, t: number): Point {
  return { x: g.a.x + g.dir.x * t, y: g.a.y + g.dir.y * t };
}

/** Projection of p onto the wall line; returns distance along wall and perpendicular signed distance (positive = inside). */
export function projectOnWall(g: WallGeom, p: Point): { t: number; side: number } {
  const vx = p.x - g.a.x;
  const vy = p.y - g.a.y;
  return {
    t: vx * g.dir.x + vy * g.dir.y,
    side: vx * g.inward.x + vy * g.inward.y,
  };
}

export function distToSegment(p: Point, a: Point, b: Point): number {
  const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = clamp(t, 0, 1);
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

/** Rotate a point around the origin. */
export function rot(p: Point, angle: number): Point {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** Smallest absolute angular difference, folded into [0, π]. */
export function angleClose(a: number, b: number, tol = 0.06): boolean {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d < tol;
}

/**
 * An oriented rectangle in plan space: centre, extents along its OWN axes
 * (`w` along local +x, `d` along local +y) and the rotation of those axes.
 * Matches an Item's x/y/w/d/rotation exactly.
 */
export interface Obb {
  cx: number;
  cy: number;
  w: number;
  d: number;
  rot: number;
}

/** The four corners of an oriented rectangle, in the same order as a CCW outline. */
export function obbCorners(o: Obb): Point[] {
  const hw = o.w / 2;
  const hd = o.d / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => {
    const r = rot(p, o.rot);
    return { x: o.cx + r.x, y: o.cy + r.y };
  });
}

/** Half-extent of an oriented box projected on the unit axis `n`. */
function obbRadius(o: Obb, n: Point): number {
  const ax = rot({ x: 1, y: 0 }, o.rot);
  const ay = rot({ x: 0, y: 1 }, o.rot);
  return (
    Math.abs(ax.x * n.x + ax.y * n.y) * (o.w / 2) + Math.abs(ay.x * n.x + ay.y * n.y) * (o.d / 2)
  );
}

/**
 * Separating-axis test for two oriented rectangles: the four box axes are the
 * only candidates. Returns the minimum penetration depth (m) over those axes,
 * or null when they are disjoint — exact touching counts as DISJOINT, so
 * edge-to-edge snapped neighbours never register. Callers wanting a tolerance
 * on top of that shrink their boxes before calling (see checks.ts TOUCH_EPS).
 */
export function obbOverlap(a: Obb, b: Obb): { depth: number } | null {
  const axes = [
    rot({ x: 1, y: 0 }, a.rot),
    rot({ x: 0, y: 1 }, a.rot),
    rot({ x: 1, y: 0 }, b.rot),
    rot({ x: 0, y: 1 }, b.rot),
  ];
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  let depth = Infinity;
  for (const n of axes) {
    const sep = Math.abs(dx * n.x + dy * n.y);
    const o = obbRadius(a, n) + obbRadius(b, n) - sep;
    if (o <= 0) return null; // separating axis found
    if (o < depth) depth = o;
  }
  return { depth };
}

/**
 * Do two simple polygons share any area? Crossing edges settle the general
 * case; one vertex inside the other polygon catches full containment. Points
 * ON an edge count as inside (pointInPolygon), so polygons that merely touch
 * report true — shrink them first when flush neighbours must pass.
 */
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a0, a1, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/**
 * Circular sector as a polygon: the centre followed by `segs + 1` points along
 * the arc from a0 to a1 (radians, plan space; the sweep follows the sign of
 * a1 − a0). Door swings are the reason it exists.
 */
export function sectorPolygon(c: Point, r: number, a0: number, a1: number, segs = 8): Point[] {
  const n = Math.max(1, Math.round(segs));
  const pts: Point[] = [{ x: c.x, y: c.y }];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return pts;
}

export function pointInRect(
  p: Point,
  cx: number,
  cy: number,
  w: number,
  d: number,
  rotation: number
): boolean {
  const local = rot({ x: p.x - cx, y: p.y - cy }, -rotation);
  return Math.abs(local.x) <= w / 2 && Math.abs(local.y) <= d / 2;
}

/** Even-odd ray cast; points on an edge count as inside. */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (distToSegment(p, a, b) < 1e-9) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when no two non-adjacent edges cross (O(n²) — outlines stay small). */
export function polygonIsSimple(poly: Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Offset every edge of a simple CCW polygon inward by `d` and re-intersect the
 * offset edge lines (miter joins). Inputs are cloned rather than rebuilt, so
 * richer point types (a Corner and its id) survive the offset. Returns null
 * when the result stops being a simple CCW polygon — over-inset, self
 * intersection, or a CW input whose "inward" normals point outward instead.
 */
export function insetPolygon<T extends Point>(pts: T[], d: number): T[] | null {
  const n = pts.length;
  if (n < 3) return null;
  const lines: { p: Point; dir: Point }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = dist(a, b);
    if (len < 1e-9) return null;
    const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const inward = { x: -dir.y, y: dir.x }; // CCW: interior lies left of the edge
    lines.push({ p: { x: a.x + inward.x * d, y: a.y + inward.y * d }, dir });
  }
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n];
    const cur = lines[i];
    const det = prev.dir.x * cur.dir.y - prev.dir.y * cur.dir.x;
    let v = cur.p; // collinear neighbours: the offset endpoint IS the join
    if (Math.abs(det) >= 1e-9) {
      const ex = cur.p.x - prev.p.x;
      const ey = cur.p.y - prev.p.y;
      const s = (ex * cur.dir.y - ey * cur.dir.x) / det;
      v = { x: prev.p.x + prev.dir.x * s, y: prev.p.y + prev.dir.y * s };
    }
    out.push({ ...pts[i], x: v.x, y: v.y });
  }
  return signedArea(out) > 1e-9 && polygonIsSimple(out) ? out : null;
}

export function polygonBounds(poly: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export function fmtLen(m: number): string {
  return `${m.toFixed(2)} m`;
}

export function fmtCm(m: number): string {
  return `${Math.round(m * 100)} cm`;
}
