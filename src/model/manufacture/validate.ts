import { partPanels, type Panel, type PanelParams, type PartDims } from '../panels';
import type { CabinetPartDef, CustomPartDef, Design } from '../types';
import { walkSplits } from '../zones';
import { DEFAULT_MANUFACTURE, panelParamsFrom, type ManufactureSettings } from './settings';
import { collectDesign } from './collect';
import { enumerateJoints, itemDrilling } from './drilling';
import { panelCutDims } from './cutlist';

/**
 * Fit validator: proves a design's items actually assemble from their emitted
 * `Panel` list. Rect-footprint cabinets get the full battery (envelope fill,
 * pairwise non-overlap with the grooved-back capture exception, interior fit,
 * front-reveal tiling, structural counts, plausible thicknesses). Polygon
 * cabinets and board/freeform parts get the envelope + positivity checks.
 *
 * The Panel[]-level entry point `validateItemPanels` reconstructs everything
 * from the emitted panels alone (never by re-running the generator's own
 * arithmetic), so a hand-broken panel list is caught. Pure model code.
 */

export interface FitViolation {
  itemId: string;
  panelId?: string;
  rule: string;
  detail: string;
}

const TOL = 5e-4; // 0.5 mm envelope tolerance
const REVEAL_TOL = 1e-4; // 0.1 mm reveal tolerance
const EPS = 1e-6;
const EPS_VOL = 1e-9;

interface AABB {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** AABB of an axis-aligned (rotY 0) box panel, else null. */
function aabb(p: Panel): AABB | null {
  if (p.shape.kind !== 'box' || Math.abs(p.rotY) > 1e-9) return null;
  const { w, h, d } = p.shape;
  return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y, y1: p.y + h, z0: p.z - d / 2, z1: p.z + d / 2 };
}

const ov1 = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const overlapVol = (a: AABB, b: AABB): number =>
  ov1(a.x0, a.x1, b.x0, b.x1) * ov1(a.y0, a.y1, b.y0, b.y1) * ov1(a.z0, a.z1, b.z0, b.z1);

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Rotation/shape-aware outer bounds of a whole panel list. */
function bounds(panels: Panel[]): Bounds {
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of panels) {
    if (p.shape.kind === 'prism') {
      for (const q of p.shape.outline) {
        b.minX = Math.min(b.minX, q.x);
        b.maxX = Math.max(b.maxX, q.x);
        b.minZ = Math.min(b.minZ, q.y);
        b.maxZ = Math.max(b.maxZ, q.y);
      }
      b.minY = Math.min(b.minY, p.y);
      b.maxY = Math.max(b.maxY, p.y + p.shape.h);
    } else {
      const c = Math.abs(Math.cos(p.rotY));
      const s = Math.abs(Math.sin(p.rotY));
      const w = p.shape.kind === 'cyl' ? p.shape.dia : p.shape.w;
      const d = p.shape.kind === 'cyl' ? p.shape.dia : p.shape.d;
      const ex = (w * c + d * s) / 2;
      const ez = (w * s + d * c) / 2;
      b.minX = Math.min(b.minX, p.x - ex);
      b.maxX = Math.max(b.maxX, p.x + ex);
      b.minZ = Math.min(b.minZ, p.z - ez);
      b.maxZ = Math.max(b.maxZ, p.z + ez);
      b.minY = Math.min(b.minY, p.y);
      b.maxY = Math.max(b.maxY, p.y + p.shape.h);
    }
  }
  return b;
}

function positivity(itemId: string, panels: Panel[], out: FitViolation[]): void {
  for (const p of panels) {
    const bad = (d: string): void => void out.push({ itemId, panelId: p.id, rule: 'positivity', detail: d });
    if (p.shape.kind === 'box') {
      if (!(p.shape.w > 0 && p.shape.h > 0 && p.shape.d > 0)) bad(`box dims ${p.shape.w}×${p.shape.h}×${p.shape.d}`);
    } else if (p.shape.kind === 'cyl') {
      if (!(p.shape.dia > 0 && p.shape.h > 0)) bad(`cyl dims Ø${p.shape.dia}×${p.shape.h}`);
    } else {
      if (p.shape.outline.length < 3 || !(p.shape.h > 0)) bad('degenerate prism');
    }
  }
}

/** Envelope fill + containment against the nominal dims. */
function envelope(itemId: string, dims: PartDims, panels: Panel[], out: FitViolation[], strictFill: boolean): void {
  const b = bounds(panels);
  const { w, d, h } = dims;
  const overhang = panels.some((p) => p.role === 'worktop') ? 0.03 : TOL;
  const push = (rule: string, detail: string): void => void out.push({ itemId, rule, detail });
  // containment
  if (b.maxX > w / 2 + overhang) push('bbox', `+x ${b.maxX.toFixed(4)} exceeds ${(w / 2).toFixed(4)}`);
  if (-b.minX > w / 2 + overhang) push('bbox', `-x ${b.minX.toFixed(4)} exceeds ${(-w / 2).toFixed(4)}`);
  if (b.maxZ > d / 2 + overhang) push('bbox', `+z ${b.maxZ.toFixed(4)} exceeds ${(d / 2).toFixed(4)}`);
  if (-b.minZ > d / 2 + overhang) push('bbox', `-z ${b.minZ.toFixed(4)} exceeds ${(-d / 2).toFixed(4)}`);
  if (b.maxY > h + TOL) push('bbox', `+y ${b.maxY.toFixed(4)} exceeds ${h.toFixed(4)}`);
  if (b.minY < -TOL) push('bbox', `-y ${b.minY.toFixed(4)} below 0`);
  // fill: the envelope is actually reached
  if (b.maxY < h - TOL) push('bbox', `height only reaches ${b.maxY.toFixed(4)} of ${h.toFixed(4)}`);
  if (strictFill) {
    if (b.maxX < w / 2 - TOL || -b.minX < w / 2 - TOL) push('bbox', `width only spans ${(b.maxX - b.minX).toFixed(4)} of ${w.toFixed(4)}`);
    // the rear must reach the back plane; the front face may be an open niche, so
    // the deepest board there (the carcass side edge) is allowed a front short.
    if (-b.minZ < d / 2 - TOL) push('bbox', `rear only reaches ${b.minZ.toFixed(4)} of ${(-d / 2).toFixed(4)}`);
    if (b.maxZ < d / 2 - 0.02 - TOL) push('bbox', `front only reaches ${b.maxZ.toFixed(4)} of ${(d / 2).toFixed(4)}`);
  }
}

/** The min-dimension axis of a box panel — its thickness direction. */
function thinAxis(p: Panel): 'x' | 'y' | 'z' {
  if (p.shape.kind !== 'box') return 'z';
  const { w, h, d } = p.shape;
  const m = Math.min(w, h, d);
  return m === w ? 'x' : m === h ? 'y' : 'z';
}

function rectBattery(itemId: string, dims: PartDims, panels: Panel[], m: PanelParams, out: FitViolation[]): void {
  const boxes = panels.filter((p) => aabb(p));
  const byId = (id: string): Panel | undefined => panels.find((p) => p.id === id);
  const push = (rule: string, detail: string, panelId?: string): void => void out.push({ itemId, rule, detail, panelId });

  envelope(itemId, dims, panels, out, true);

  // ---- (e) structural counts ----
  const sides = boxes.filter((p) => p.role === 'side');
  const tops = boxes.filter((p) => p.role === 'top');
  const bottoms = boxes.filter((p) => p.role === 'bottom');
  const backs = boxes.filter((p) => p.role === 'back' && !p.id.endsWith('.liner'));
  if (sides.length !== 2) push('structure', `expected 2 sides, found ${sides.length}`);
  if (tops.length !== 1) push('structure', `expected 1 top, found ${tops.length}`);
  if (bottoms.length !== 1) push('structure', `expected 1 bottom, found ${bottoms.length}`);
  if (backs.length !== 1) push('structure', `expected 1 structural back, found ${backs.length}`);

  const back = backs[0];
  const frame = ['side-l', 'side-r', 'top', 'bottom'].map(byId).filter(Boolean) as Panel[];
  const grooved = !!back && frame.some((f) => {
    const a = aabb(back);
    const b = aabb(f);
    return a && b && overlapVol(a, b) > EPS_VOL;
  });

  // ---- (b) pairwise non-overlap across the whole interior battery ----
  // Every solid interior board — carcass frame, dividers, shelves, drawer
  // boxes, structural back AND niche liner — must be collision-free. The single
  // exception is the grooved structural back seating into the frame (it captures
  // grooveDepth into side/top/bottom and passes behind the dividers).
  const isStructBack = (p: Panel): boolean => p.role === 'back' && !p.id.endsWith('.liner');
  const isFrame = (p: Panel): boolean =>
    p.role === 'side' || p.role === 'top' || p.role === 'bottom' || p.role === 'divider';
  const battery = boxes.filter(
    (p) => isFrame(p) || p.role === 'shelf' || p.role === 'drawerBottom' || p.role === 'drawerBack' || p.role === 'back'
  );
  for (let i = 0; i < battery.length; i++) {
    for (let j = i + 1; j < battery.length; j++) {
      const a = battery[i];
      const b = battery[j];
      const captureExempt = grooved && ((isStructBack(a) && isFrame(b)) || (isStructBack(b) && isFrame(a)));
      if (captureExempt) continue;
      if (overlapVol(aabb(a)!, aabb(b)!) > EPS_VOL) push('overlap', `${a.id} ∩ ${b.id}`, a.id);
    }
  }

  // grooved back must capture side-l/side-r/top/bottom by exactly grooveDepth
  if (grooved && back) {
    const ba = aabb(back)!;
    for (const f of frame) {
      const fa = aabb(f)!;
      if (overlapVol(ba, fa) <= EPS_VOL) {
        push('back-capture', `back not seated into ${f.id}`, 'back');
        continue;
      }
      const axis = thinAxis(f);
      const pen = axis === 'x' ? ov1(ba.x0, ba.x1, fa.x0, fa.x1) : axis === 'y' ? ov1(ba.y0, ba.y1, fa.y0, fa.y1) : ov1(ba.z0, ba.z1, fa.z0, fa.z1);
      if (pen > m.grooveDepth + EPS || pen < m.grooveDepth - EPS) {
        push('back-capture', `back captures ${f.id} by ${(pen * 1000).toFixed(2)}mm, expected ${(m.grooveDepth * 1000).toFixed(2)}mm`, 'back');
      }
    }
  }

  const sl = byId('side-l');
  const sr = byId('side-r');
  const bot = byId('bottom');
  const topP = byId('top');
  if (sl && sr && bot && topP) {
    const la = aabb(sl)!;
    const ra = aabb(sr)!;
    const boa = aabb(bot)!;
    const toa = aabb(topP)!;
    const intX0 = la.x1;
    const intX1 = ra.x0;
    const intY0 = boa.y1;
    const intY1 = toa.y0;
    const frontZ = Math.max(la.z1, ra.z1);
    // interior rear in z: in front of the structural back (drawers/shelves must
    // not pierce it); fall back to the carcass rear when there is no back.
    const backFrontZ = back ? aabb(back)!.z1 : Math.min(la.z0, ra.z0);
    const verticals = boxes.filter((p) => p.role === 'side' || (p.role === 'divider' && p.id.startsWith('div-v')));

    // ---- (c) shelves / drawer boards inside the carcass interior (x, y) ----
    for (const p of boxes) {
      if (p.role !== 'shelf' && p.role !== 'drawerBottom' && p.role !== 'drawerBack') continue;
      const a = aabb(p)!;
      if (a.x0 < intX0 - TOL || a.x1 > intX1 + TOL) push('interior', `${p.id} escapes side walls`, p.id);
      if (a.y0 < intY0 - TOL || a.y1 > intY1 + TOL) push('interior', `${p.id} escapes top/bottom`, p.id);
      if (a.z1 > frontZ + TOL) push('interior', `${p.id} pierces the fronts`, p.id);
      if (p.role === 'drawerBottom' && p.shape.kind === 'box') {
        // leaf interior = gap between the vertical members bracketing the drawer centre
        let leftFace = -Infinity;
        let rightFace = Infinity;
        for (const v of verticals) {
          const va = aabb(v)!;
          if (va.x1 <= p.x + TOL) leftFace = Math.max(leftFace, va.x1);
          if (va.x0 >= p.x - TOL) rightFace = Math.min(rightFace, va.x0);
        }
        if (Number.isFinite(leftFace) && Number.isFinite(rightFace)) {
          const expected = rightFace - leftFace - m.drawer.widthDeduction;
          if (Math.abs(p.shape.w - expected) > TOL) {
            push('drawer-width', `${p.id} width ${(p.shape.w * 1000).toFixed(1)}mm, expected ${(expected * 1000).toFixed(1)}mm`, p.id);
          }
        }
      }
    }

    // ---- rule (a): each shelf's rear face clears its niche liner by ≥ 0.5mm ----
    for (const p of boxes) {
      if (p.role !== 'shelf') continue;
      const zid = p.id.replace(/\.shelf\d+$/, '');
      const liner = boxes.find((q) => q.id === `${zid}.liner`);
      if (!liner) continue;
      const a = aabb(p)!;
      const lz = aabb(liner)!;
      if (a.z0 < lz.z1 + 0.0005) push('shelf-liner', `${p.id} rear ${(a.z0 * 1000).toFixed(2)}mm does not clear liner front ${(lz.z1 * 1000).toFixed(2)}mm`, p.id);
    }

    // ---- rule (b): drawer boxes inside their leaf's y-band and in front of the back ----
    for (const p of boxes) {
      if (p.role !== 'drawerBottom' && p.role !== 'drawerBack') continue;
      const a = aabb(p)!;
      const g = p.id.match(/^(.*)\.drawer(\d+)\.(?:bottom|back)$/);
      const front = g ? boxes.find((q) => q.id === `${g[1]}.front${g[2]}`) : undefined;
      if (front) {
        const fa = aabb(front)!;
        if (a.y0 < fa.y0 - TOL || a.y1 > fa.y1 + TOL) push('drawer-band', `${p.id} escapes its drawer opening in y`, p.id);
      }
      if (a.z0 < backFrontZ - TOL) push('drawer-band', `${p.id} pierces the structural back (rear ${(a.z0 * 1000).toFixed(2)}mm behind back front ${(backFrontZ * 1000).toFixed(2)}mm)`, p.id);
    }
  }

  // ---- (d) front tiling: reveals reconstructed from panel positions ----
  frontTiling(itemId, dims, panels, m, out);

  // ---- (f) plausible thicknesses ----
  const plausible = new Set([
    Math.round(m.backT * 1000),
    Math.round(m.frontT * 1000),
    Math.round(m.carcassT * 1000),
    Math.round(m.drawer.bottomT * 1000),
    Math.round(m.drawer.backT * 1000),
    Math.round(m.worktopT * 1000),
    3,
    6,
  ]);
  for (const p of boxes) {
    const { w, h, d } = p.shape as { w: number; h: number; d: number };
    const t = Math.round(Math.min(w, h, d) * 1000);
    if (t < 1) push('thickness', `${p.id} thickness ${t}mm < 1mm`, p.id);
    else if (!plausible.has(t)) push('thickness', `${p.id} thickness ${t}mm not in plausible set`, p.id);
  }
}

function frontTiling(itemId: string, dims: PartDims, panels: Panel[], m: PanelParams, out: FitViolation[]): void {
  const fronts = panels.filter((p) => p.role === 'front' && p.shape.kind === 'box' && Math.abs(p.rotY) < 1e-9);
  if (!fronts.length) return;
  const push = (detail: string, panelId?: string): void => void out.push({ itemId, rule: 'reveal', detail, panelId });
  const g = m.reveal;

  // common front plane
  const planeZ = Math.max(...fronts.map((p) => p.z));
  for (const p of fronts) if (Math.abs(p.z - planeZ) > TOL) push(`${p.id} off the front plane`, p.id);

  // pairwise: fronts never overlap in the face plane
  for (let i = 0; i < fronts.length; i++) {
    for (let j = i + 1; j < fronts.length; j++) {
      const a = aabb(fronts[i])!;
      const b = aabb(fronts[j])!;
      if (ov1(a.x0, a.x1, b.x0, b.x1) > REVEAL_TOL && ov1(a.y0, a.y1, b.y0, b.y1) > REVEAL_TOL) {
        push(`fronts ${fronts[i].id} and ${fronts[j].id} overlap`, fronts[i].id);
      }
    }
  }

  // within-zone gaps == reveal (stacked drawer fronts, side-by-side door pairs)
  const groups = new Map<string, Panel[]>();
  for (const p of fronts) {
    const zone = p.id.replace(/\.front\d+$/, '');
    if (!groups.has(zone)) groups.set(zone, []);
    groups.get(zone)!.push(p);
  }
  for (const [zone, group] of groups) {
    if (group.length < 2) continue;
    const varyY = Math.max(...group.map((p) => p.y)) - Math.min(...group.map((p) => p.y)) > REVEAL_TOL;
    const sorted = [...group].sort((a, b) => (varyY ? a.y - b.y : a.x - b.x));
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = aabb(sorted[i])!;
      const b = aabb(sorted[i + 1])!;
      const gap = varyY ? b.y0 - a.y1 : b.x0 - a.x1;
      if (Math.abs(gap - g) > REVEAL_TOL) push(`${zone} reveal ${(gap * 1000).toFixed(2)}mm, expected ${(g * 1000).toFixed(2)}mm`);
    }
  }

  // outer reveals: every front stays within the reveal-inset envelope (catches
  // over-wide fronts); a front sitting against an edge must clear it by exactly
  // one reveal. Fronts far from an edge belong to an open/glass-flanked leaf, so
  // their outer reveal is not defined and is skipped.
  const lo = -dims.w / 2 + g;
  const hi = dims.w / 2 - g;
  for (const p of fronts) {
    const a = aabb(p)!;
    if (a.x0 < lo - REVEAL_TOL) push(`${p.id} left edge ${(a.x0 * 1000).toFixed(2)}mm past reveal`, p.id);
    if (a.x1 > hi + REVEAL_TOL) push(`${p.id} right edge ${(a.x1 * 1000).toFixed(2)}mm past reveal`, p.id);
    if (a.x0 < lo + 2 * g && Math.abs(a.x0 - lo) > REVEAL_TOL) push(`${p.id} left outer reveal ${((a.x0 + dims.w / 2) * 1000).toFixed(2)}mm`, p.id);
    if (a.x1 > hi - 2 * g && Math.abs(a.x1 - hi) > REVEAL_TOL) push(`${p.id} right outer reveal ${((dims.w / 2 - a.x1) * 1000).toFixed(2)}mm`, p.id);
  }
}

/**
 * Validate one item's panels. Auto-detects the construction from the panels:
 * a box `side-l` ⇒ rect cabinet (full battery); prism `top`/`bottom` ⇒ polygon
 * cabinet; anything else ⇒ board / freeform (envelope + positivity only).
 */
export function validateItemPanels(itemId: string, dims: PartDims, panels: Panel[], m: PanelParams): FitViolation[] {
  const out: FitViolation[] = [];
  if (!panels.length) return out;
  positivity(itemId, panels, out);

  const rect = panels.some((p) => p.id === 'side-l' && p.shape.kind === 'box');
  const polygon = !rect && panels.some((p) => (p.id === 'top' || p.id === 'bottom') && p.shape.kind === 'prism');

  if (rect) {
    rectBattery(itemId, dims, panels, m, out);
  } else if (polygon) {
    envelope(itemId, dims, panels, out, true);
  } else {
    envelope(itemId, dims, panels, out, false);
  }
  return out;
}

/** Push helper that lazily appends to a per-key number list. */
function bucketPush(map: Map<string, number[]>, key: string, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Validate a cabinet's machining ops: every op inside its panel's cut rectangle
 * with a ≥ 2 mm edge margin (hinge cups clear by their radius); System-32
 * shelf-pin columns and hinge-plate pairs on the 32 mm grid; back-groove bands
 * within the panel width; confirmat holes over a mating board's centerline
 * (re-derived from the structural joint enumeration). Reconstructs the cut
 * rectangle from `panelCutDims` — the same frame the generator targets.
 */
export function validateItemDrilling(
  itemId: string, part: CustomPartDef, dims: PartDims, panels: Panel[], m: ManufactureSettings
): FitViolation[] {
  const out: FitViolation[] = [];
  const opsMap = itemDrilling(part, dims, panels, m);
  if (!opsMap.size) return out;
  const dimById = new Map(panels.map((p) => [p.id, panelCutDims(p)] as const));
  const push = (rule: string, detail: string, panelId?: string): void => void out.push({ itemId, panelId, rule, detail });

  for (const [pid, ops] of opsMap) {
    const cd = dimById.get(pid);
    if (!cd) continue;
    const L = cd.lengthMm;
    const W = cd.widthMm;

    // ---- op bounds ----
    for (const op of ops.drills) {
      if (op.face === 'edge') {
        if (op.u < -0.6 || op.u > L + 0.6) push('drill-bounds', `${op.kind} u ${op.u} off edge [0,${L}]`, pid);
        if (op.v < 2 || op.v > W - 2) push('drill-bounds', `${op.kind} edge v ${op.v} outside [2,${W - 2}]`, pid);
        continue;
      }
      const margin = op.kind === 'hingeCup' ? op.dia / 2 : 2;
      if (op.u < margin - 1e-6 || op.u > L - margin + 1e-6) push('drill-bounds', `${op.kind} u ${op.u} outside [${margin},${L - margin}]`, pid);
      if (op.v < margin - 1e-6 || op.v > W - margin + 1e-6) push('drill-bounds', `${op.kind} v ${op.v} outside [${margin},${W - margin}]`, pid);
    }

    // ---- System-32 pitch: shelf-pin columns on a 32 grid ----
    const spCols = new Map<string, number[]>();
    for (const op of ops.drills) if (op.kind === 'shelfPin') bucketPush(spCols, `${op.face}:${Math.round(op.v)}`, op.u);
    for (const us of spCols.values()) {
      us.sort((a, b) => a - b);
      for (let i = 1; i < us.length; i++) {
        const gap = us[i] - us[i - 1];
        if (Math.abs(gap - Math.round(gap / 32) * 32) > 0.6) push('pitch', `shelf-pin gap ${gap.toFixed(1)}mm not a multiple of 32`, pid);
      }
    }
    // hinge mounting plates (5 mm) come in 32 mm vertical pairs
    const mpCols = new Map<string, number[]>();
    for (const op of ops.drills) if (op.kind === 'hingePlate' && op.dia === 5) bucketPush(mpCols, `${op.face}:${Math.round(op.v)}`, op.u);
    for (const us of mpCols.values()) {
      for (const u of us) {
        if (!us.some((o) => Math.abs(Math.abs(o - u) - 32) <= 0.6)) push('pitch', `hinge plate at u ${u} has no 32mm pair`, pid);
      }
    }

    // ---- groove band within the panel ----
    for (const gr of ops.grooves) {
      if (gr.at < -1e-6 || gr.at + gr.width > W + 1e-6) push('groove-band', `groove [${gr.at},${gr.at + gr.width}] exceeds width ${W}`, pid);
      if (gr.from < -1e-6 || gr.to > L + 1e-6) push('groove-band', `groove span [${gr.from},${gr.to}] exceeds length ${L}`, pid);
    }
  }

  // ---- confirmat holes over a mating board centerline (structural) ----
  if (m.joinery === 'confirmat' && part.type === 'cabinet') {
    const joints = enumerateJoints(part as CabinetPartDef, dims, panels, m);
    for (const [pid, ops] of opsMap) {
      for (const op of ops.drills) {
        if (op.kind !== 'confirmat') continue;
        if (!joints.some((j) => j.postId === pid && Math.abs(j.uCenterM * 1000 - op.u) <= 1)) {
          push('confirmat-centerline', `confirmat u ${op.u} on ${pid} over no mating centerline`, pid);
        }
      }
    }
  }
  return out;
}

export function validateDesignFit(design: Design): FitViolation[] {
  const mfg = design.manufacture ?? DEFAULT_MANUFACTURE;
  const m = panelParamsFrom(mfg);
  const out: FitViolation[] = [];
  for (const c of collectDesign(design).items) {
    const panels = c.panels ?? (c.part ? partPanels(c.part, c.dims, m) : []);
    out.push(...validateItemPanels(c.item.id, c.dims, panels, m));
    // design-level: divider count matches the zone tree's split boundaries
    if (c.part && c.part.type === 'cabinet' && c.part.footprint.kind === 'rect') {
      const expected = walkSplits(c.part.face, c.dims.w, c.dims.h).reduce((s, sp) => s + sp.boundaries.length, 0);
      const actual = panels.filter((p) => p.role === 'divider').length;
      if (expected !== actual) {
        out.push({ itemId: c.item.id, rule: 'structure', detail: `divider count ${actual} != ${expected} split boundaries` });
      }
    }
    // design-level: machining ops within bounds / on grid
    if (c.part) out.push(...validateItemDrilling(c.item.id, c.part, c.dims, panels, mfg));
  }
  return out;
}
