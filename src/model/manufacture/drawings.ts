import { catalogDef, hasCatalogDef } from '../catalog';
import { polygonBounds, polygonCentroid, rot } from '../geometry';
import { wallElevation } from '../elevation';
import { partPanels, type Panel, type PanelParams, type PartDims } from '../panels';
import { footprintPolygon } from '../parts';
import type { CabinetPartDef, CustomPartDef, Design, Point } from '../types';
import { collectDesign, type CollectedItem } from './collect';
import { doorHingeSides, itemDrilling, type PanelOps } from './drilling';
import { DEFAULT_MANUFACTURE, panelParamsFrom, type ManufactureSettings } from './settings';
import type { ApplianceEntry, CutPart, DrawingSheet, DrawPrim, HardwareItem, SheetTable } from './types';

/**
 * Sheet-IR builder for the manufacturing pack. Turns a design (+ its already
 * built cut list / hardware / appliance schedule) into a deterministic ordered
 * list of `DrawingSheet`s — a cover, a floor plan, one elevation per occupied
 * wall, one orthographic sheet per unique cabinet, and the cut-list / hardware /
 * appliance tables. Everything geometric is expressed in millimetres in each
 * sheet's own drawing frame (y up, the conventional drafting orientation); page
 * fitting, scaling and title blocks happen later in the PDF layer (pdfPack.ts).
 *
 * Pure model code — NO jsPDF, NO DOM, no Three.js, no Store. Deterministic: no
 * Date.now / Math.random anywhere, so two builds of the same design deep-equal.
 *
 * Prim layers: 'wall' | 'item' | 'dim' | 'label' | 'hidden' | 'drill' |
 * 'outline'. Dimension prims (`t:'dim'`) are their own implicit layer.
 */

const MM = 1000; // meters → millimetres
const mmRound = (v: number): number => Math.round(v);

/* ── prim constructors ─────────────────────────────────────────────────────── */

const poly = (pts: Point[], closed: boolean, layer: string): DrawPrim => ({ t: 'poly', pts, closed, layer });
const seg = (a: Point, b: Point, layer: string): DrawPrim => ({ t: 'poly', pts: [a, b], closed: false, layer });
const rect = (x0: number, y0: number, x1: number, y1: number, layer: string): DrawPrim =>
  poly([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], true, layer);
const circle = (c: Point, r: number, layer: string): DrawPrim => ({ t: 'circle', c, r, layer });
const label = (p: Point, s: string, size: number, layer = 'label', anchor: 'l' | 'c' | 'r' = 'c'): DrawPrim =>
  ({ t: 'text', p, s, size, layer, anchor });

/** Unit vector a→b, or (1,0) for a degenerate segment. */
function unit(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/**
 * One dimension prim between `a` and `b`, its line offset perpendicular by `off`
 * mm (positive = left of a→b in the sheet's y-up frame). `text` defaults to the
 * rounded a–b distance in mm. Returned as an array so callers can spread running
 * chains; exported for tests. Deterministic, no rounding drift beyond one mm.
 */
export function dimChainPrims(a: Point, b: Point, off: number, text?: string): DrawPrim[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return [{ t: 'dim', a, b, text: text ?? String(Math.max(1, mmRound(len))), off }];
}

/** Truncate a label to at most `maxChars`, appending an ellipsis when clipped. */
export function fitLabel(s: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (s.length <= maxChars) return s;
  if (maxChars === 1) return s.slice(0, 1);
  return s.slice(0, maxChars - 1) + '…';
}

/** A dimension pushed to the side of a→b that faces away from `centroid`. */
function outwardDim(a: Point, b: Point, centroid: Point, mag: number, text?: string): DrawPrim[] {
  const u = unit(a, b);
  const perp = { x: -u.y, y: u.x };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const away = perp.x * (mid.x - centroid.x) + perp.y * (mid.y - centroid.y);
  return dimChainPrims(a, b, away >= 0 ? mag : -mag, text);
}

/* ── bounds ────────────────────────────────────────────────────────────────── */

export interface SheetBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Tight-ish bounds of every prim on a sheet (drawing mm), used to set a sheet's
 * wMm/hMm and to fit the sheet onto a page in the PDF layer — both read the same
 * function so the extents always agree. Dimension lines account for their offset
 * so running chains outside the geometry are not clipped.
 */
export function sheetBounds(prims: DrawPrim[]): SheetBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ext = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const p of prims) {
    if (p.t === 'poly') {
      for (const q of p.pts) ext(q.x, q.y);
    } else if (p.t === 'circle') {
      ext(p.c.x - p.r, p.c.y - p.r);
      ext(p.c.x + p.r, p.c.y + p.r);
    } else if (p.t === 'text') {
      ext(p.p.x, p.p.y);
      ext(p.p.x + p.s.length * p.size * 0.6, p.p.y + p.size);
    } else {
      const u = unit(p.a, p.b);
      const perp = { x: -u.y * p.off, y: u.x * p.off };
      for (const base of [p.a, p.b]) {
        ext(base.x, base.y);
        ext(base.x + perp.x, base.y + perp.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** Shift every prim (and dim endpoints) by (dx, dy). */
function shift(prims: DrawPrim[], dx: number, dy: number): DrawPrim[] {
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  return prims.map((p): DrawPrim => {
    if (p.t === 'poly') return { ...p, pts: p.pts.map(mv) };
    if (p.t === 'circle') return { ...p, c: mv(p.c) };
    if (p.t === 'text') return { ...p, p: mv(p.p) };
    return { ...p, a: mv(p.a), b: mv(p.b) };
  });
}

/* ── shared helpers ────────────────────────────────────────────────────────── */

const isCabinet = (c: CollectedItem): c is CollectedItem & { part: CabinetPartDef } =>
  c.part != null && c.part.type === 'cabinet';

/** Geometry-affecting signature: part definition + instance dimensions (mm). */
function cabinetSignature(c: CollectedItem): string {
  const d = c.dims;
  const dk = [mmRound(d.w * MM), mmRound(d.d * MM), mmRound(d.h * MM), mmRound(d.elevation * MM)].join(',');
  return `${JSON.stringify(c.part)}|${dk}`;
}

interface UniqueCabinet {
  sig: string;
  index: number; // 1-based, matches the cabinet sheet number
  rep: CollectedItem;
}

/** Distinct cabinets in first-seen order, plus a per-item-id number map. */
export function uniqueCabinets(design: Design): { list: UniqueCabinet[]; numberOf: Map<string, number> } {
  const bySig = new Map<string, UniqueCabinet>();
  const numberOf = new Map<string, number>();
  for (const c of collectDesign(design).items) {
    if (!isCabinet(c)) continue;
    const sig = cabinetSignature(c);
    let u = bySig.get(sig);
    if (!u) {
      u = { sig, index: bySig.size + 1, rep: c };
      bySig.set(sig, u);
    }
    numberOf.set(c.item.id, u.index);
  }
  return { list: [...bySig.values()], numberOf };
}

/* ── cover ─────────────────────────────────────────────────────────────────── */

function coverSheet(design: Design, cabinets: number, items: number, appliances: number): DrawingSheet {
  const m = design.manufacture ?? DEFAULT_MANUFACTURE;
  const s32 = m.system32;
  const row = (k: string, v: string): string[] => [k, v];
  const table: SheetTable = {
    headers: ['Item', 'Value'],
    rows: [
      row('Cabinets (unique)', String(cabinets)),
      row('Manufacturable items', String(items)),
      row('Appliances', String(appliances)),
      row('Carcass board', `${mmRound(m.carcassT * MM)} mm PB`),
      row('Back', `${m.backMode} ${mmRound(m.backT * MM)} mm (groove ${mmRound(m.grooveDepth * MM)} mm)`),
      row('Joinery', m.joinery),
      row('Front reveal', `${mmRound(m.frontReveal * MM)} mm`),
      row('Edge banding', `front ${mmRound(m.edgeFrontT * MM)} mm / carcass ${(m.edgeCarcassT * MM).toFixed(1)} mm`),
      row('System 32', `pitch ${mmRound(s32.pitch * MM)} mm, cup Ø${mmRound(s32.hingeCupDia * MM)} mm, setback ${mmRound(s32.frontSetback * MM)} mm`),
    ],
  };
  const prims: DrawPrim[] = [label({ x: 0, y: 0 }, 'Kitchen manufacturing pack', 20, 'label', 'l')];
  return { id: 'cover', title: 'Kitchen manufacturing pack', kind: 'cover', wMm: 277, hMm: 190, prims, table };
}

/* ── floor plan ────────────────────────────────────────────────────────────── */

const OFF_WALL = 250; // dim offset off a wall face, drawing mm
const OFF_TOTAL = 550; // dim offset for the overall room totals

function defLabel(defId: string, customById?: Map<string, CustomPartDef>): string {
  const custom = customById?.get(defId);
  if (custom) return custom.name;
  return hasCatalogDef(defId) ? catalogDef(defId).label : 'part';
}

function floorplanSheet(
  design: Design,
  collected: ReturnType<typeof collectDesign>,
  appliances: ApplianceEntry[],
  numberOf: Map<string, number>
): DrawingSheet {
  const prims: DrawPrim[] = [];
  // Plan → drawing: plan is x right / y DOWN (meters); the drawing frame is y UP,
  // so we flip y (negate) as we scale to mm. Width/height of any shape are
  // unchanged by the flip, so room bounds still read as the true room dims.
  const toDraw = (p: Point): Point => ({ x: p.x * MM, y: -p.y * MM });

  const roomPts = design.corners.map(toDraw);
  prims.push(poly(roomPts, true, 'wall'));
  const centroid = polygonCentroid(roomPts);

  // openings as simple wall-gap marks (two ticks across the wall at the opening)
  for (const o of design.openings) {
    const idx = design.corners.findIndex((c) => c.id === o.wallId);
    if (idx < 0) continue;
    const a = design.corners[idx];
    const b = design.corners[(idx + 1) % design.corners.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy;
    const ny = ux;
    const t = design.room.wallThickness / 2 + 0.02;
    for (const s of [o.offset - o.width / 2, o.offset + o.width / 2]) {
      const px = a.x + ux * s;
      const py = a.y + uy * s;
      prims.push(seg(toDraw({ x: px - nx * t, y: py - ny * t }), toDraw({ x: px + nx * t, y: py + ny * t }), 'hidden'));
    }
  }

  // manufacturable + appliance item footprints
  const drawIds = new Set(collected.items.map((c) => c.item.id));
  const applIds = new Set(appliances.map((a) => a.itemId));
  const customById = new Map(design.customParts.map((p) => [p.id, p] as const));
  for (const it of design.items) {
    if (!drawIds.has(it.id) && !applIds.has(it.id)) continue;
    const part = customById.get(it.defId);
    const local = (part ? footprintPolygon(part, it.w, it.d) : null) ?? [
      { x: -it.w / 2, y: -it.d / 2 },
      { x: it.w / 2, y: -it.d / 2 },
      { x: it.w / 2, y: it.d / 2 },
      { x: -it.w / 2, y: it.d / 2 },
    ];
    const world = local.map((lp) => {
      const r = rot(lp, it.rotation);
      return toDraw({ x: r.x + it.x, y: r.y + it.y });
    });
    prims.push(poly(world, true, 'item'));
    const num = numberOf.get(it.id);
    prims.push(label(toDraw({ x: it.x, y: it.y }), num != null ? String(num) : fitLabel(defLabel(it.defId, customById), 10), num != null ? 110 : 70));
  }

  // per-wall outside dimension (wall length)
  for (let i = 0; i < design.corners.length; i++) {
    const a = design.corners[i];
    const b = design.corners[(i + 1) % design.corners.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-4) continue;
    prims.push(...outwardDim(toDraw(a), toDraw(b), centroid, OFF_WALL, String(mmRound(len * MM))));
  }

  // overall room width + depth totals from the plan bounds
  const rb = polygonBounds(design.corners);
  const bl = toDraw({ x: rb.minX, y: rb.maxY });
  const br = toDraw({ x: rb.maxX, y: rb.maxY });
  const tl = toDraw({ x: rb.minX, y: rb.minY });
  prims.push(...outwardDim(bl, br, centroid, OFF_TOTAL, String(mmRound((rb.maxX - rb.minX) * MM))));
  prims.push(...outwardDim(tl, bl, centroid, OFF_TOTAL, String(mmRound((rb.maxY - rb.minY) * MM))));

  const bnd = sheetBounds(prims);
  return {
    id: 'floorplan',
    title: 'Floor plan',
    kind: 'floorplan',
    wMm: bnd.maxX - bnd.minX,
    hMm: bnd.maxY - bnd.minY,
    prims,
  };
}

/* ── elevations ────────────────────────────────────────────────────────────── */

function elevationSheet(design: Design, wallId: string, index: number, numberOf: Map<string, number>): DrawingSheet | null {
  const elev = wallElevation(design, wallId);
  if (!elev || elev.items.length === 0) return null;
  const m = design.manufacture ?? DEFAULT_MANUFACTURE;
  const prims: DrawPrim[] = [];
  const Lmm = Math.max(1, mmRound(elev.len * MM));
  const Hmm = Math.max(1, mmRound(elev.height * MM));

  // wall outline
  prims.push(rect(0, 0, Lmm, Hmm, 'wall'));

  // openings (behind the run) on the hidden layer
  for (const o of elev.openings) {
    const x0 = mmRound((o.center - o.width / 2) * MM);
    const x1 = mmRound((o.center + o.width / 2) * MM);
    prims.push(rect(x0, mmRound(o.z0 * MM), x1, mmRound(o.z1 * MM), 'hidden'));
  }

  // items as front rects with labels
  for (const it of elev.items) {
    const x0 = mmRound((it.center - it.halfW) * MM);
    const x1 = mmRound((it.center + it.halfW) * MM);
    const y0 = mmRound(it.z0 * MM);
    const y1 = mmRound(it.z1 * MM);
    prims.push(rect(x0, y0, x1, y1, 'item'));
    const num = numberOf.get(it.id);
    prims.push(label({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, num != null ? String(num) : fitLabel(defLabel(it.defId), 10), 90));
  }

  // bottom running chain: integer boundaries so segment widths sum EXACTLY to Lmm
  const bset = new Set<number>([0, Lmm]);
  for (const it of elev.items) {
    bset.add(Math.max(0, Math.min(Lmm, mmRound((it.center - it.halfW) * MM))));
    bset.add(Math.max(0, Math.min(Lmm, mmRound((it.center + it.halfW) * MM))));
  }
  const bs = [...bset].sort((a, b) => a - b);
  for (let i = 0; i + 1 < bs.length; i++) {
    const w = bs[i + 1] - bs[i];
    if (w <= 0) continue;
    prims.push(...dimChainPrims({ x: bs[i], y: 0 }, { x: bs[i + 1], y: 0 }, -180, String(w)));
  }

  // height chain on the left: floor / plinth / worktop / wall-cabinet underside
  const hset = new Set<number>([0, Math.min(Hmm, mmRound(m.plinthH * MM))]);
  for (const it of elev.items) {
    hset.add(Math.max(0, Math.min(Hmm, mmRound(it.z0 * MM))));
    hset.add(Math.max(0, Math.min(Hmm, mmRound(it.z1 * MM))));
  }
  const hs = [...hset].sort((a, b) => a - b);
  for (let i = 0; i + 1 < hs.length; i++) {
    const h = hs[i + 1] - hs[i];
    if (h <= 0) continue;
    prims.push(...dimChainPrims({ x: 0, y: hs[i] }, { x: 0, y: hs[i + 1] }, 160, String(h)));
  }

  const bnd = sheetBounds(prims);
  return {
    id: `elev-${wallId}`,
    title: `Elevation — wall ${index}`,
    kind: 'elevation',
    wMm: bnd.maxX - bnd.minX,
    hMm: bnd.maxY - bnd.minY,
    prims,
  };
}

/* ── cabinet orthographic sheets ───────────────────────────────────────────── */

const VIEW_GAP = 220; // gap between the FRONT / SIDE / PLAN views, drawing mm

type Box = { kind: 'box'; w: number; h: number; d: number };
const asBox = (p: Panel): Box | null => (p.shape.kind === 'box' ? p.shape : null);

/** FRONT view: project panels onto x (width) / y (height). */
function frontView(panels: Panel[], drills: Map<string, PanelOps>, sides: Map<string, 'left' | 'right'>, dims: PartDims): DrawPrim[] {
  const out: DrawPrim[] = [];
  const w = dims.w * MM;
  const h = dims.h * MM;
  out.push(rect(-w / 2, 0, w / 2, h, 'outline'));

  for (const p of panels) {
    const s = asBox(p);
    if (!s) continue;
    const x0 = (p.x - s.w / 2) * MM;
    const x1 = (p.x + s.w / 2) * MM;
    const y0 = p.y * MM;
    const y1 = (p.y + s.h) * MM;
    if (p.role === 'front' || p.role === 'panel' || p.role === 'frame' || p.role === 'glass') {
      out.push(rect(x0, y0, x1, y1, p.role === 'glass' ? 'hidden' : 'item'));
    } else if (p.role === 'plinth') {
      out.push(rect(x0, y0, x1, y1, 'item'));
    } else if (p.role === 'worktop') {
      out.push(rect(x0, y0, x1, y1, 'item'));
    } else if (p.role === 'shelf') {
      // open-zone shelves as horizontal lines
      const y = (p.y + s.h / 2) * MM;
      out.push(seg({ x: x0, y }, { x: x1, y }, 'hidden'));
    }
    // hinge cups on door fronts (from the drilling map + the hinge-edge helper)
    if (p.role === 'front') {
      const ops = drills.get(p.id);
      if (ops) {
        const side = sides.get(p.id) ?? 'left';
        for (const d of ops.drills) {
          if (d.kind !== 'hingeCup') continue;
          const cx = side === 'left' ? (p.x - s.w / 2) * MM + d.v : (p.x + s.w / 2) * MM - d.v;
          const cy = p.y * MM + d.u;
          out.push(circle({ x: cx, y: cy }, d.dia / 2, 'drill'));
        }
      }
    }
  }

  // overall W (below) + H (left)
  out.push(...dimChainPrims({ x: -w / 2, y: 0 }, { x: w / 2, y: 0 }, -160, String(mmRound(w))));
  out.push(...dimChainPrims({ x: -w / 2, y: 0 }, { x: -w / 2, y: h }, 150, String(mmRound(h))));

  // per-front width chain (top) + height chain (right) from the front edges
  const fronts = panels.filter((p) => p.role === 'front' && asBox(p));
  const xEdges = new Set<number>();
  const yEdges = new Set<number>();
  for (const p of fronts) {
    const s = asBox(p)!;
    xEdges.add(mmRound((p.x - s.w / 2) * MM));
    xEdges.add(mmRound((p.x + s.w / 2) * MM));
    yEdges.add(mmRound(p.y * MM));
    yEdges.add(mmRound((p.y + s.h) * MM));
  }
  const xs = [...xEdges].sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i++) {
    const d = xs[i + 1] - xs[i];
    if (d > 0) out.push(...dimChainPrims({ x: xs[i], y: h }, { x: xs[i + 1], y: h }, 90, String(d)));
  }
  const ys = [...yEdges].sort((a, b) => a - b);
  for (let i = 0; i + 1 < ys.length; i++) {
    const d = ys[i + 1] - ys[i];
    if (d > 0) out.push(...dimChainPrims({ x: w / 2, y: ys[i] }, { x: w / 2, y: ys[i + 1] }, -90, String(d)));
  }

  if (dims.elevation > 0.3) {
    out.push(label({ x: 0, y: -120 }, `mounted at ${mmRound(dims.elevation * MM)} mm`, 80, 'label', 'c'));
  }
  return out;
}

/** SIDE view: section on z (depth, +z front → right) / y (height). */
function sideView(panels: Panel[], dims: PartDims): DrawPrim[] {
  const out: DrawPrim[] = [];
  const d = dims.d * MM;
  const h = dims.h * MM;
  out.push(rect(-d / 2, 0, d / 2, h, 'outline'));

  for (const p of panels) {
    const s = asBox(p);
    if (!s) continue;
    const z0 = (p.z - s.d / 2) * MM;
    const z1 = (p.z + s.d / 2) * MM;
    const y0 = p.y * MM;
    const y1 = (p.y + s.h) * MM;
    if (p.id === 'side-l') {
      out.push(rect(z0, y0, z1, y1, 'item'));
    } else if (p.role === 'back' && !p.id.endsWith('.liner')) {
      out.push(rect(z0, y0, z1, y1, 'hidden')); // grooved back position, dashed
    } else if (p.role === 'worktop') {
      out.push(rect(z0, y0, z1, y1, 'item')); // overhang visible front + back
    } else if (p.role === 'top' || p.role === 'bottom' || p.role === 'shelf') {
      const y = (p.y + s.h / 2) * MM;
      out.push(seg({ x: z0, y }, { x: z1, y }, 'item'));
    }
  }

  out.push(...dimChainPrims({ x: -d / 2, y: 0 }, { x: d / 2, y: 0 }, -160, String(mmRound(d))));
  return out;
}

/** PLAN view: project onto x (width) / z (depth, +z front → up). */
function planView(part: CabinetPartDef, panels: Panel[], dims: PartDims): DrawPrim[] {
  const out: DrawPrim[] = [];
  const w = dims.w * MM;
  const d = dims.d * MM;
  const fp = footprintPolygon(part, dims.w, dims.d);
  if (fp) out.push(poly(fp.map((q) => ({ x: q.x * MM, y: q.y * MM })), true, 'outline'));
  else out.push(rect(-w / 2, -d / 2, w / 2, d / 2, 'outline'));

  for (const p of panels) {
    const s = asBox(p);
    if (!s) continue;
    const x0 = (p.x - s.w / 2) * MM;
    const x1 = (p.x + s.w / 2) * MM;
    const zc = p.z * MM;
    const hd = (s.d / 2) * MM;
    if (p.role === 'back' && !p.id.endsWith('.liner')) {
      out.push(rect(x0, zc - hd, x1, zc + hd, 'hidden'));
    } else if (p.role === 'front' || p.role === 'panel' || p.role === 'frame') {
      out.push(rect(x0, zc - hd, x1, zc + hd, 'item'));
    }
  }

  out.push(...dimChainPrims({ x: -w / 2, y: -d / 2 }, { x: w / 2, y: -d / 2 }, -150, String(mmRound(w))));
  out.push(...dimChainPrims({ x: -w / 2, y: -d / 2 }, { x: -w / 2, y: d / 2 }, 150, String(mmRound(d))));
  return out;
}

/** Lay a list of self-contained views left→right, bottoms aligned, with gaps. */
function layoutViews(views: { title: string; prims: DrawPrim[] }[]): DrawPrim[] {
  const out: DrawPrim[] = [];
  let cursor = 0;
  for (const v of views) {
    const b = sheetBounds(v.prims);
    const dx = cursor - b.minX;
    const dy = -b.minY;
    out.push(...shift(v.prims, dx, dy));
    out.push(label({ x: cursor + (b.maxX - b.minX) / 2, y: -260 }, v.title, 110, 'label', 'c'));
    cursor += (b.maxX - b.minX) + VIEW_GAP;
  }
  return out;
}

function cabinetSheet(design: Design, u: UniqueCabinet, m: PanelParams, mfg: ManufactureSettings): DrawingSheet {
  const part = u.rep.part as CabinetPartDef;
  const dims = u.rep.dims;
  const panels = partPanels(part, dims, m);
  const drills = itemDrilling(part, dims, panels, mfg);
  const sides = doorHingeSides(part, dims, mfg);

  const prims = layoutViews([
    { title: 'FRONT', prims: frontView(panels, drills, sides, dims) },
    { title: 'SIDE', prims: sideView(panels, dims) },
    { title: 'PLAN', prims: planView(part, panels, dims) },
  ]);

  const title = `${u.index}. ${u.rep.label} ${mmRound(dims.w * MM)}×${mmRound(dims.d * MM)}×${mmRound(dims.h * MM)}`;
  const bnd = sheetBounds(prims);
  return {
    id: `cab-${u.index}`,
    title,
    kind: 'cabinet',
    wMm: bnd.maxX - bnd.minX,
    hMm: bnd.maxY - bnd.minY,
    prims,
  };
}

/* ── table sheets ──────────────────────────────────────────────────────────── */

const ROWS_PER_SHEET = 24;
const edgeStr = (e: CutPart['edge']): string => `${e.L1}/${e.L2}/${e.W1}/${e.W2}`;

function chunk<T>(rows: T[], size: number): T[][] {
  if (rows.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function tableSheets(id: string, title: string, headers: string[], rows: string[][]): DrawingSheet[] {
  const parts = chunk(rows, ROWS_PER_SHEET);
  return parts.map((r, i): DrawingSheet => ({
    id: parts.length > 1 ? `${id}-${i + 1}` : id,
    title: parts.length > 1 ? `${title} (${i + 1}/${parts.length})` : title,
    kind: 'table',
    wMm: 277,
    hMm: 190,
    prims: [],
    table: { headers, rows: r },
  }));
}

function cutlistSheets(parts: CutPart[]): DrawingSheet[] {
  const headers = ['id', 'cabinet', 'name', 'L×W×T', 'qty', 'material', 'grain', 'edging', 'notes'];
  const rows = parts.map((p): string[] => [
    p.refId,
    p.cabinet,
    p.name,
    `${p.lengthMm}×${p.widthMm}×${p.thicknessMm}`,
    String(p.qty),
    p.material,
    p.grain ? 'L' : '',
    edgeStr(p.edge),
    p.notes,
  ]);
  return tableSheets('tbl-cutlist', 'Cut list', headers, rows);
}

function hardwareSheets(hardware: HardwareItem[]): DrawingSheet[] {
  const headers = ['name', 'spec', 'qty', 'unit'];
  const rows = hardware.map((h): string[] => [h.name, h.spec, String(h.qty), h.unit]);
  return tableSheets('tbl-hardware', 'Hardware schedule', headers, rows);
}

function applianceSheets(appliances: ApplianceEntry[]): DrawingSheet[] {
  const headers = ['label', 'W×D×H', 'note'];
  const rows = appliances.map((a): string[] => [a.label, `${a.wMm}×${a.dMm}×${a.hMm}`, a.note]);
  return tableSheets('tbl-appliances', 'Appliance schedule', headers, rows);
}

/* ── entry point ───────────────────────────────────────────────────────────── */

export function buildSheets(
  design: Design,
  pack: { parts: CutPart[]; hardware: HardwareItem[]; appliances: ApplianceEntry[] }
): DrawingSheet[] {
  const mfg = design.manufacture ?? DEFAULT_MANUFACTURE;
  const m = panelParamsFrom(mfg);
  const collected = collectDesign(design);
  const { list: cabs, numberOf } = uniqueCabinets(design);

  const sheets: DrawingSheet[] = [];
  sheets.push(coverSheet(design, cabs.length, collected.items.length, pack.appliances.length));
  sheets.push(floorplanSheet(design, collected, pack.appliances, numberOf));

  design.corners.forEach((c, i) => {
    const s = elevationSheet(design, c.id, i + 1, numberOf);
    if (s) sheets.push(s);
  });

  for (const u of cabs) sheets.push(cabinetSheet(design, u, m, mfg));

  sheets.push(...cutlistSheets(pack.parts));
  sheets.push(...hardwareSheets(pack.hardware));
  sheets.push(...applianceSheets(pack.appliances));

  return sheets;
}
