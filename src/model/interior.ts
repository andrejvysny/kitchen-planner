import { clamp } from './geometry';
import type { Interior, InteriorElement, ZoneFill } from './types';

/**
 * Interior layout math: the single bridge from the parametric form
 * ({mode:'auto', counts}) to concrete, exactly-positioned elements. The panel
 * generator (facePanels) and the studio's interior editor both lay out via
 * resolveInterior, so what the editor shows is exactly what gets built — and
 * what a cut list exports.
 */

/** carcass board thickness (shell sides/top/bottom + dividers) */
export const CARCASS_T = 0.018;
/** carcass back board thickness */
export const BACK_T = 0.012;
export const DRAWER_SIDE_T = 0.015;
export const DRAWER_BOTTOM_T = 0.012;
/** per-side clearance for drawer slides */
export const SLIDE_CLEAR = 0.013;
/** minimum useful gap between/around interior elements */
export const MIN_ELEM_SPACE = 0.06;
export const MAX_INTERIOR_ELEMENTS = 8;
export const MAX_AUTO_SHELVES = 6;
export const MAX_AUTO_DRAWERS = 4;
/** default box height for auto inner drawers */
const AUTO_DRAWER_H = 0.18;

/** Per-fill default when a leaf carries no interior at all. */
export function defaultInterior(fill: ZoneFill): Interior | undefined {
  if (fill === 'open' || fill === 'door' || fill === 'doorPair' || fill === 'glass') {
    return { mode: 'auto', shelves: 1, innerDrawers: 0 };
  }
  return undefined; // drawers bring their own boxes; panel is a fixed filler
}

/**
 * Resolve an interior to concrete elements inside a cavity of height
 * `cavityH`. Deterministic: auto spaces evenly (drawers stacked from the
 * bottom, shelves in the remainder); custom clamps into the cavity, sorts by
 * y and drops overlaps keeping the lowest. Degenerate cavities yield [].
 */
export function resolveInterior(interior: Interior | undefined, cavityH: number): InteriorElement[] {
  if (!interior || cavityH < MIN_ELEM_SPACE * 2) return [];
  if (interior.mode === 'auto') {
    const out: InteriorElement[] = [];
    const nd = clamp(Math.round(interior.innerDrawers), 0, MAX_AUTO_DRAWERS);
    const ns = clamp(Math.round(interior.shelves), 0, MAX_AUTO_SHELVES);
    const boxH = Math.min(AUTO_DRAWER_H, (cavityH - MIN_ELEM_SPACE) / Math.max(1, nd));
    let y = 0.01;
    for (let i = 0; i < nd; i++) {
      if (y + boxH > cavityH - MIN_ELEM_SPACE / 2) break;
      out.push({ kind: 'drawerBox', y, h: boxH });
      y += boxH + 0.01;
    }
    const rest = cavityH - y;
    for (let i = 1; i <= ns; i++) {
      const sy = y + (rest * i) / (ns + 1);
      if (sy > MIN_ELEM_SPACE / 2 && sy < cavityH - MIN_ELEM_SPACE / 2) {
        out.push({ kind: 'shelf', y: sy });
      }
    }
    return out;
  }
  const lo = MIN_ELEM_SPACE;
  const hi = cavityH - MIN_ELEM_SPACE;
  if (hi < lo) return []; // cavity too small for any element
  const sorted = interior.elements
    .slice(0, MAX_INTERIOR_ELEMENTS)
    .map((e): InteriorElement =>
      e.kind === 'shelf'
        ? { kind: 'shelf', y: clamp(e.y, lo, hi) }
        : { kind: 'drawerBox', y: clamp(e.y, 0.005, hi), h: clamp(e.h, 0.06, 0.4) }
    )
    .sort((a, b) => a.y - b.y);
  const out: InteriorElement[] = [];
  let top = -Infinity; // top of the last kept element
  for (const e of sorted) {
    const bottom = e.y;
    const t = e.kind === 'drawerBox' ? e.y + e.h : e.y;
    if (bottom - top < MIN_ELEM_SPACE / 2) continue; // overlaps the previous — drop
    if (t > cavityH - 0.005) continue; // sticks out the top
    out.push(e);
    top = t;
  }
  return out;
}

export interface DrawerBoxDims {
  boxW: number;
  boxD: number;
  sideH: number;
  /** slide extension for the open-preview (and hardware pick) */
  travel: number;
}

/**
 * Physical drawer-box dimensions inside a CAVITY (not the front): the box is
 * narrower than the cavity by the slide clearance on each side. Null when the
 * cavity can't hold a functional box.
 */
export function drawerBoxDims(cavityW: number, boxH: number, cavityD: number): DrawerBoxDims | null {
  const boxW = cavityW - SLIDE_CLEAR * 2;
  const boxD = cavityD - 0.02;
  const sideH = boxH;
  if (boxW < 0.1 || boxD < 0.1 || sideH < 0.05) return null;
  return { boxW, boxD, sideH, travel: cavityD * 0.9 };
}

/** Repair an interior parsed from storage; undefined when unusable. */
export function sanitizeInterior(raw: unknown): Interior | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (o.mode === 'auto') {
    return {
      mode: 'auto',
      shelves: clamp(Math.round(Number(o.shelves) || 0), 0, MAX_AUTO_SHELVES),
      innerDrawers: clamp(Math.round(Number(o.innerDrawers) || 0), 0, MAX_AUTO_DRAWERS),
    };
  }
  if (o.mode === 'custom' && Array.isArray(o.elements)) {
    const elements: InteriorElement[] = [];
    for (const e of o.elements.slice(0, MAX_INTERIOR_ELEMENTS)) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const y = Number(r.y);
      if (!Number.isFinite(y)) continue;
      if (r.kind === 'shelf') elements.push({ kind: 'shelf', y });
      else if (r.kind === 'drawerBox') {
        const h = Number(r.h);
        if (Number.isFinite(h)) elements.push({ kind: 'drawerBox', y, h: clamp(h, 0.06, 0.4) });
      }
    }
    return { mode: 'custom', elements };
  }
  return undefined;
}
