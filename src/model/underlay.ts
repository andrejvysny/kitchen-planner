/**
 * Everything the floor-plan tracing underlay needs that is pure maths: its
 * defaults, the sanitize gate, the calibration formula and the hit test.
 *
 * The transform maps IMAGE PIXELS to world meters: a pixel (px, py) lands at
 * `origin + rot(px * scale, py * scale, rotation)`, with the origin at the
 * image's top-left. Scaling therefore pins the top-left, which is what lets
 * calibration change `scale` alone without the picture sliding away.
 */

import { clamp } from './geometry';
import type { Point, Underlay } from './types';

/** Strong enough to read a scanned plan; the slider dials it back to trace. */
export const UNDERLAY_OPACITY = 0.85;
/** How wide a freshly imported photo is laid out (m) — a typical flat. */
export const UNDERLAY_START_WIDTH = 8;
/** Long edge of the stored image (px); bigger buys no accuracy, only quota. */
export const UNDERLAY_MAX_PX = 1600;
/** JPEG quality of the stored data URL. */
export const UNDERLAY_JPEG_Q = 0.8;

/**
 * Validate a persisted transform. A non-finite or non-positive x/y/scale/
 * rotation has no sane fallback for a tracing reference — the whole field is
 * dropped rather than guessed at. Opacity is merely clamped into 0..1 (a
 * fixable slider value), and the two flags only accept literal booleans.
 */
export function sanitizeUnderlay(raw: unknown): Underlay | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const nums = [r.x, r.y, r.scale, r.rotation];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  if ((r.scale as number) <= 0) return undefined;
  const op = r.opacity;
  return {
    x: r.x as number,
    y: r.y as number,
    scale: r.scale as number,
    rotation: r.rotation as number,
    opacity: typeof op === 'number' && Number.isFinite(op) ? clamp(op, 0, 1) : UNDERLAY_OPACITY,
    visible: r.visible !== false,
    locked: r.locked === true,
  };
}

/** Where a freshly imported `imgW × imgH` photo lands: centred on `center`. */
export function initialUnderlay(imgW: number, imgH: number, center: Point): Underlay {
  const scale = UNDERLAY_START_WIDTH / Math.max(1, imgW);
  return {
    x: center.x - (imgW * scale) / 2,
    y: center.y - (imgH * scale) / 2,
    scale,
    rotation: 0,
    opacity: UNDERLAY_OPACITY,
    visible: true,
    locked: false,
  };
}

/**
 * New meters-per-pixel from a calibration click pair. The two clicks are
 * `dWorld` metres apart at the CURRENT scale, so they sit `dWorld / oldScale`
 * image pixels apart — a rotation-independent quantity. Telling the app those
 * pixels really span `realMeters` gives
 *   newScale = realMeters / (dWorld / oldScale) = realMeters * oldScale / dWorld.
 * A degenerate input leaves the scale alone.
 */
export function underlayScaleFrom(dWorld: number, oldScale: number, realMeters: number): number {
  if (![dWorld, oldScale, realMeters].every((n) => Number.isFinite(n))) return oldScale;
  if (dWorld <= 0 || oldScale <= 0 || realMeters <= 0) return oldScale;
  return (realMeters * oldScale) / dWorld;
}

/** World point → image pixel coordinates (the inverse of the draw transform). */
export function underlayPixel(u: Underlay, p: Point): Point {
  const dx = p.x - u.x;
  const dy = p.y - u.y;
  const c = Math.cos(-u.rotation);
  const s = Math.sin(-u.rotation);
  return { x: (dx * c - dy * s) / u.scale, y: (dx * s + dy * c) / u.scale };
}

/**
 * The image's four corners in WORLD space, `[topLeft, topRight, bottomRight,
 * bottomLeft]` — the inverse of `underlayPixel`, and what `Plan2D.zoomFit`
 * needs to frame a reference that has no room around it yet.
 */
export function underlayCorners(u: Underlay, imgW: number, imgH: number): Point[] {
  const c = Math.cos(u.rotation);
  const s = Math.sin(u.rotation);
  const at = (px: number, py: number): Point => ({
    x: u.x + (px * c - py * s) * u.scale,
    y: u.y + (px * s + py * c) * u.scale,
  });
  return [at(0, 0), at(imgW, 0), at(imgW, imgH), at(0, imgH)];
}

/** Is the world point over the `imgW × imgH` image? Used to claim a drag. */
export function underlayHits(u: Underlay, imgW: number, imgH: number, p: Point): boolean {
  const q = underlayPixel(u, p);
  return q.x >= 0 && q.y >= 0 && q.x <= imgW && q.y <= imgH;
}
