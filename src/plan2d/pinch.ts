import { clamp } from '../model/geometry';
import type { Point } from '../model/types';

/**
 * Touch-input parity helpers shared by plan2d (top view) and elevation (wall
 * view): the two-finger pinch-zoom/pan gesture, and coarse-pointer hit-radius
 * scaling. Both views map a coordinate to screen px as `coord * zoom + pan`
 * (elevation just flips the height axis), so the same screen-space anchor
 * algebra re-zooms/pans around the pinch midpoint without this module ever
 * needing a view's toWorld/toScreen conventions.
 */

/** A view's current zoom + pan (2D plan or wall elevation share this shape). */
export interface Viewport {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Whether the primary pointer is coarse (touch), per the CSS media feature.
 * Evaluated once at module load — the device class doesn't change mid-session,
 * so hit tests read a constant instead of re-querying on every call.
 */
export const coarsePointer =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** Scales a mouse-tuned hit radius (px) up for touch; `base` unchanged otherwise. */
export function hitRadius(base: number): number {
  return coarsePointer ? base * 1.6 : base;
}

/** Two-finger pinch-zoom + pan, tracked by pointer id. */
export class PinchGesture {
  private pointers = new Map<number, Point>();
  private lastDist = 0;
  private lastMid: Point = { x: 0, y: 0 };

  /** Track a touch pointer; true the instant the 2nd finger lands (start the pinch). */
  down(id: number, p: Point): boolean {
    this.pointers.set(id, p);
    if (this.pointers.size !== 2) return false;
    const [p1, p2] = [...this.pointers.values()];
    this.lastDist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    this.lastMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    return true;
  }

  /** A 3rd+ finger has landed — callers should ignore this pointerdown entirely. */
  get overflowing(): boolean {
    return this.pointers.size > 2;
  }

  has(id: number): boolean {
    return this.pointers.has(id);
  }

  /** Keep a tracked finger's position current, even before/without an active pinch. */
  track(id: number, p: Point): void {
    if (this.pointers.has(id)) this.pointers.set(id, p);
  }

  /** Re-zoom/pan from the tracked fingers' current positions; null until 2 are down. */
  step(v: Viewport, zoomMin: number, zoomMax: number): Viewport | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    const [p1, p2] = pts;
    const dist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const zoom = clamp(v.zoom * (dist / this.lastDist), zoomMin, zoomMax);
    const applied = zoom / v.zoom;
    // keep the world point under the previous midpoint anchored, then follow the midpoint
    const panX = mid.x - (this.lastMid.x - v.panX) * applied;
    const panY = mid.y - (this.lastMid.y - v.panY) * applied;
    this.lastDist = dist;
    this.lastMid = mid;
    return { zoom, panX, panY };
  }

  /** A finger lifted. */
  up(id: number): void {
    this.pointers.delete(id);
  }
}
