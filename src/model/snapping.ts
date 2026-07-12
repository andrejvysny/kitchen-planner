import { snapsToWall, type CatalogDef } from './catalog';
import { clamp, projectOnWall, wallPoint, type WallGeom } from './geometry';
import type { Store } from './store';
import type { Item, Point } from './types';

export interface Guide {
  a: Point;
  b: Point;
  label?: string;
}

export interface SnapResult {
  x: number;
  y: number;
  rotation: number;
  wallId: string | null;
  guides: Guide[];
}

const WALL_SNAP_DIST = 0.22;
const EDGE_SNAP_DIST = 0.09;
const ALIGN_SNAP_DIST = 0.06;

/** rotation that makes an item's back face a wall whose inward normal is n */
export function rotationFromInward(n: Point): number {
  return Math.atan2(-n.x, n.y);
}

function angleClose(a: number, b: number, tol = 0.06): boolean {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d < tol;
}

export function nearestWall(
  store: Store,
  p: Point,
  maxPerp = 0.5
): { wall: WallGeom; t: number; perp: number } | null {
  let best: { wall: WallGeom; t: number; perp: number } | null = null;
  for (const wall of store.walls()) {
    const pr = projectOnWall(wall, p);
    if (pr.t < -0.1 || pr.t > wall.len + 0.1) continue;
    const perp = Math.abs(pr.side);
    if (perp > maxPerp) continue;
    if (!best || perp < best.perp) best = { wall, t: clamp(pr.t, 0, wall.len), perp };
  }
  return best;
}

/**
 * Compute the snapped pose for an item being placed or dragged to (x, y).
 * Snaps: back-to-wall (with auto-rotation), edge-to-edge against neighbours
 * on the same run, center alignment for free-standing items, fine grid.
 */
export function snapItem(
  store: Store,
  def: CatalogDef,
  itemId: string | null,
  x: number,
  y: number,
  rotation: number
): SnapResult {
  const guides: Guide[] = [];
  const t = store.design.room.wallThickness;
  const item = itemId ? store.itemById(itemId) : null;
  const w = item?.w ?? def.w;
  const d = item?.d ?? def.d;

  let wallId: string | null = null;

  // ---- wall snap ----
  if (snapsToWall(def)) {
    const targetSide = t / 2 + d / 2;
    let best: { wall: WallGeom; t: number; err: number } | null = null;
    for (const wall of store.walls()) {
      const pr = projectOnWall(wall, { x, y });
      if (pr.t < -0.05 || pr.t > wall.len + 0.05) continue;
      const err = Math.abs(pr.side - targetSide);
      if (err > WALL_SNAP_DIST) continue;
      if (!best || err < best.err) best = { wall, t: pr.t, err };
    }
    if (best) {
      const g = best.wall;
      const halfSpan = Math.min(w / 2, g.len / 2);
      const tt = clamp(best.t, halfSpan, g.len - halfSpan);
      const foot = wallPoint(g, tt);
      x = foot.x + g.inward.x * (t / 2 + d / 2);
      y = foot.y + g.inward.y * (t / 2 + d / 2);
      rotation = rotationFromInward(g.inward);
      wallId = g.id;

      // clearance guides from the item's side edges to the wall's corners
      const edgeL = tt - w / 2;
      const edgeR = g.len - (tt + w / 2);
      const off = t / 2 + d / 2;
      const gp = (tp: number): Point => ({
        x: g.a.x + g.dir.x * tp + g.inward.x * off,
        y: g.a.y + g.dir.y * tp + g.inward.y * off,
      });
      if (edgeL > 0.015) guides.push({ a: gp(0), b: gp(tt - w / 2), label: `${Math.round(edgeL * 100)}` });
      if (edgeR > 0.015) guides.push({ a: gp(tt + w / 2), b: gp(g.len), label: `${Math.round(edgeR * 100)}` });
    }
  }

  // ---- edge-to-edge snap against neighbours with the same orientation ----
  const ux = Math.cos(rotation);
  const uy = Math.sin(rotation);
  let s = x * ux + y * uy; // my position along the width axis
  const depthAxis = { x: -uy, y: ux };
  const myDepthPos = x * depthAxis.x + y * depthAxis.y;

  let edgeSnapped = false;
  for (const o of store.design.items) {
    if (o.id === itemId) continue;
    if (!angleClose(o.rotation, rotation)) continue;
    const oDepth = o.x * depthAxis.x + o.y * depthAxis.y;
    if (Math.abs(oDepth - myDepthPos) > (d + o.d) / 2 + 0.4) continue; // different run
    const os = o.x * ux + o.y * uy;
    // my left edge to their right edge
    if (Math.abs(os + o.w / 2 + w / 2 - s) < EDGE_SNAP_DIST) {
      s = os + o.w / 2 + w / 2;
      edgeSnapped = true;
      break;
    }
    // my right edge to their left edge
    if (Math.abs(os - o.w / 2 - w / 2 - s) < EDGE_SNAP_DIST) {
      s = os - o.w / 2 - w / 2;
      edgeSnapped = true;
      break;
    }
    // exact center-over-center (stacking wall units above base units)
    if (Math.abs(os - s) < ALIGN_SNAP_DIST) {
      s = os;
      edgeSnapped = true;
      break;
    }
  }
  if (edgeSnapped) {
    const delta = s - (x * ux + y * uy);
    x += ux * delta;
    y += uy * delta;
  }

  // ---- center alignment for free-standing items ----
  if (!wallId) {
    for (const o of store.design.items) {
      if (o.id === itemId) continue;
      if (Math.abs(o.x - x) < ALIGN_SNAP_DIST) {
        x = o.x;
        guides.push({ a: { x: o.x, y: Math.min(o.y, y) }, b: { x: o.x, y: Math.max(o.y, y) } });
        break;
      }
    }
    for (const o of store.design.items) {
      if (o.id === itemId) continue;
      if (Math.abs(o.y - y) < ALIGN_SNAP_DIST) {
        y = o.y;
        guides.push({ a: { x: Math.min(o.x, x), y: o.y }, b: { x: Math.max(o.x, x), y: o.y } });
        break;
      }
    }
    // fine grid keeps free placement tidy
    x = Math.round(x * 100) / 100;
    y = Math.round(y * 100) / 100;
  }

  return { x, y, rotation, wallId, guides };
}
