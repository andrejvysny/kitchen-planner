import type { Corner, Point, WallRef } from './types';

export const TAU = Math.PI * 2;

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

export function polygonContains(pts: Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
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

/**
 * Corners of a rotated rectangle centered at (cx, cy).
 * Local +y is the item's facing (front) direction.
 */
export function rectCorners(
  cx: number,
  cy: number,
  w: number,
  d: number,
  rotation: number
): Point[] {
  const hw = w / 2;
  const hd = d / 2;
  const local: Point[] = [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
  return local.map((p) => {
    const r = rot(p, rotation);
    return { x: r.x + cx, y: r.y + cy };
  });
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

export function normalizeAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export function fmtLen(m: number): string {
  return `${m.toFixed(2)} m`;
}

export function fmtCm(m: number): string {
  return `${Math.round(m * 100)} cm`;
}
