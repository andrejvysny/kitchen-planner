import { catalogDef } from '../catalog';
import { partPanels, type Panel, type PanelParams, type PanelRole } from '../panels';
import type { Design, Point } from '../types';
import { resolveColor } from '../variables';
import { DEFAULT_MANUFACTURE, panelParamsFrom } from './settings';
import type { CutPart, EdgeBanding } from './types';
import { collectDesign, type CollectedItem } from './collect';

/**
 * Panels → cut list. Every physical board a design's items decompose into becomes
 * a `CutPart` row: real length/width/thickness (mm integers, grain along length),
 * a material string with the resolved slot colour, and edge-banding per role.
 * Counter kinds additionally emit a worktop row. Identical rows are deduplicated
 * with a running quantity and a per-cabinet breakdown.
 *
 * Pure model code — no Three.js, no Store. Drills/grooves stay empty (Phase 3).
 */

const mm = (v: number): number => Math.round(v * 1000);
const EMPTY_EDGE: EdgeBanding = { L1: 0, L2: 0, W1: 0, W2: 0 };

/** Roles whose grain runs up the panel (its box 'h' dimension). */
const VERTICAL = new Set<PanelRole>(['front', 'panel', 'side', 'divider', 'drawerBack']);

interface Hexes {
  front: string;
  accent: string;
}

interface EdgeThk {
  ct: number;
  ft: number;
}

interface BoxCut {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  grain: boolean;
}

/**
 * Resolve a box panel to length/width/thickness. Thickness is always the minimum
 * dimension; length is the grain axis (h for vertical roles, w for horizontal),
 * width the remaining face dimension. Grainless roles (structural back, niche
 * liner, glass) take length = larger face dim, width = smaller.
 */
function boxCut(shape: { w: number; h: number; d: number }, lengthAxis: 'h' | 'w' | 'max', grain: boolean): BoxCut {
  const axes: [('w' | 'h' | 'd'), number][] = [
    ['w', shape.w],
    ['h', shape.h],
    ['d', shape.d],
  ];
  let ti = 0;
  for (let i = 1; i < 3; i++) if (axes[i][1] < axes[ti][1]) ti = i;
  const thicknessMm = mm(axes[ti][1]);
  const face = axes.filter((_, i) => i !== ti);
  let lengthVal: number;
  let widthVal: number;
  const le = lengthAxis === 'max' ? undefined : face.find((e) => e[0] === lengthAxis);
  if (le) {
    lengthVal = le[1];
    widthVal = face.find((e) => e !== le)![1];
  } else {
    lengthVal = Math.max(face[0][1], face[1][1]);
    widthVal = Math.min(face[0][1], face[1][1]);
  }
  return { lengthMm: mm(lengthVal), widthMm: mm(widthVal), thicknessMm, grain };
}

/** Axis-aligned bbox of a polygon, in mm (length = larger side). */
function outlineBboxMm(outline: Point[]): { lengthMm: number; widthMm: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const a = mm(maxX - minX);
  const b = mm(maxY - minY);
  return { lengthMm: Math.max(a, b), widthMm: Math.min(a, b) };
}

const toMmPoly = (poly: Point[]): Point[] => poly.map((p) => ({ x: mm(p.x), y: mm(p.y) }));

function materialFor(panel: Panel, thicknessMm: number, m: PanelParams, hex: Hexes): string {
  const isLiner = panel.id.endsWith('.liner');
  switch (panel.role) {
    case 'front':
    case 'panel':
    case 'frame':
      return `Front ${mm(m.frontT)}mm ${hex.front}`;
    case 'side':
    case 'top':
    case 'bottom':
    case 'divider':
    case 'plinth':
      return `PB ${mm(m.carcassT)}mm carcass`;
    case 'back':
      return isLiner ? `PB ${thicknessMm}mm ${hex.accent}` : `HDF ${mm(m.backT)}mm`;
    case 'shelf':
      return `PB ${thicknessMm}mm ${hex.accent}`;
    case 'drawerBottom':
    case 'drawerBack':
      return `PB ${mm(m.drawer.bottomT)}mm drawer`;
    case 'worktop':
      return `Worktop ${mm(m.worktopT)}mm ${hex.accent}`;
    case 'glass':
      return 'Glass 6mm toughened';
    case 'board': {
      const c = panel.slot === 'accent' ? hex.accent : hex.front;
      return panel.finish === 'wood' ? `Solid wood ${thicknessMm}mm ${c}` : `Sheet ${thicknessMm}mm ${c}`;
    }
  }
}

function edgeFor(role: PanelRole, e: EdgeThk): EdgeBanding {
  switch (role) {
    case 'front':
    case 'panel':
      return { L1: e.ft, L2: e.ft, W1: e.ft, W2: e.ft };
    case 'side':
    case 'divider':
    case 'top':
    case 'bottom':
    case 'shelf':
    case 'plinth':
      return { L1: e.ct, L2: 0, W1: 0, W2: 0 };
    case 'worktop':
      return { L1: e.ft, L2: 0, W1: e.ft, W2: e.ft };
    default:
      // back, liner, drawerBottom, drawerBack, glass, frame, board
      return { ...EMPTY_EDGE };
  }
}

function humanize(id: string): string {
  if (id === 'side-l') return 'left side';
  if (id === 'side-r') return 'right side';
  if (['top', 'bottom', 'back', 'plinth', 'worktop'].includes(id)) return id;
  if (id === 'slab') return 'panel';
  let g: RegExpMatchArray | null;
  if ((g = id.match(/^div-[vh]\d+-(\d+)$/))) return `divider ${+g[1] + 1}`;
  if ((g = id.match(/^edge(\d+)$/))) return `side ${+g[1] + 1}`;
  if ((g = id.match(/^shelf(\d+)$/))) return `shelf ${+g[1] + 1}`;
  const dot = id.indexOf('.');
  const tail = dot >= 0 ? id.slice(dot + 1) : id;
  if ((g = tail.match(/^front(\d+)$/))) return `front ${+g[1] + 1}`;
  if ((g = tail.match(/^drawer(\d+)\.bottom$/))) return `drawer ${+g[1] + 1} bottom`;
  if ((g = tail.match(/^drawer(\d+)\.back$/))) return `drawer ${+g[1] + 1} back`;
  if ((g = tail.match(/^frame(\d+)$/))) return `frame ${+g[1] + 1}`;
  if (tail === 'glass') return 'glass';
  if (tail === 'liner') return 'niche liner';
  if (tail === 'panel') return 'panel';
  if (tail === 'front') return 'front';
  return tail || id;
}

function hexesFor(design: Design, c: CollectedItem): Hexes {
  return {
    front: resolveColor(design, c.item.color),
    accent: resolveColor(design, c.item.accentColor ?? c.part?.accentColor ?? c.item.color),
  };
}

function edgeThkFrom(design: Design): EdgeThk {
  const s = design.manufacture ?? DEFAULT_MANUFACTURE;
  return { ct: mm(s.edgeCarcassT), ft: mm(s.edgeFrontT) };
}

/**
 * Turn one panel into a single-quantity cut part. Exported for unit tests; the
 * `key` field is the dedup signature (excludes name/refId).
 */
export function panelToCutPart(design: Design, c: CollectedItem, panel: Panel, m: PanelParams): CutPart {
  return makePart(design, c, panel, m, hexesFor(design, c), edgeThkFrom(design));
}

function makePart(design: Design, c: CollectedItem, panel: Panel, m: PanelParams, hex: Hexes, e: EdgeThk): CutPart {
  const role = panel.role;
  const isLiner = panel.id.endsWith('.liner');
  const grainless = role === 'glass' || role === 'back' || isLiner;

  let lengthMm: number;
  let widthMm: number;
  let thicknessMm: number;
  let grain: boolean;
  let material: string;
  let notes = '';
  let outline: Point[] | undefined;
  let holes: Point[][] | undefined;

  if (panel.shape.kind === 'cyl') {
    const dia = mm(panel.shape.dia);
    lengthMm = mm(panel.shape.h);
    widthMm = dia;
    thicknessMm = dia;
    grain = true;
    material = 'solid wood';
    notes = `turned/cylindrical Ø${dia}mm`;
  } else if (panel.shape.kind === 'prism') {
    const bb = outlineBboxMm(panel.shape.outline);
    lengthMm = bb.lengthMm;
    widthMm = bb.widthMm;
    thicknessMm = mm(panel.shape.h);
    grain = true;
    material = materialFor(panel, thicknessMm, m, hex);
    notes = 'CNC outline';
    outline = toMmPoly(panel.shape.outline);
    if (panel.shape.holes?.length) holes = panel.shape.holes.map(toMmPoly);
  } else {
    const lengthAxis = grainless ? 'max' : VERTICAL.has(role) ? 'h' : 'w';
    const cut = boxCut(panel.shape, lengthAxis, !grainless);
    lengthMm = cut.lengthMm;
    widthMm = cut.widthMm;
    thicknessMm = cut.thicknessMm;
    grain = cut.grain;
    material = materialFor(panel, thicknessMm, m, hex);
  }

  const edge = panel.shape.kind === 'box' ? edgeFor(role, e) : { ...EMPTY_EDGE };
  const edgeSig = `${edge.L1},${edge.L2},${edge.W1},${edge.W2}`;
  const key = `${role}|${lengthMm}|${widthMm}|${thicknessMm}|${material}|${grain ? '1' : '0'}|${edgeSig}`;

  return {
    key,
    refId: panel.id,
    cabinet: c.label,
    name: `${c.label} — ${humanize(panel.id)}`,
    role,
    lengthMm,
    widthMm,
    thicknessMm,
    qty: 1,
    material,
    grain,
    edge,
    drills: [],
    grooves: [],
    outline,
    holes,
    notes,
  };
}

/** The separate worktop slab row a counter item needs (item.w × item.d+20mm). */
function worktopRow(design: Design, c: CollectedItem, m: PanelParams, e: EdgeThk): CutPart {
  const kind = catalogDef(c.item.defId).kind;
  const hex = resolveColor(design, design.room.counterColor);
  // NB: the cut worktop is m.worktopT (35 mm default); the 3-D counter slab is
  // COUNTER_T = 40 mm (src/view3d/meshKit.ts). The 5 mm mismatch is intentional —
  // the render slab is a visual approximation; the manufactured worktop follows
  // the settings-driven worktopT.
  const lengthMm = mm(c.item.w);
  const widthMm = mm(c.item.d + 0.02);
  const thicknessMm = mm(m.worktopT);
  const material = `Worktop ${thicknessMm}mm ${hex}`;
  const edge: EdgeBanding = { L1: e.ft, L2: 0, W1: e.ft, W2: e.ft };
  const notes = kind === 'sink' ? 'sink cutout in worktop' : kind === 'hob' ? 'hob cutout in worktop' : '';
  const edgeSig = `${edge.L1},${edge.L2},${edge.W1},${edge.W2}`;
  return {
    key: `worktop|${lengthMm}|${widthMm}|${thicknessMm}|${material}|1|${edgeSig}|${notes}`,
    refId: `${c.item.id}.worktop`,
    cabinet: c.label,
    name: `${c.label} — worktop`,
    role: 'worktop',
    lengthMm,
    widthMm,
    thicknessMm,
    qty: 1,
    material,
    grain: true,
    edge,
    drills: [],
    grooves: [],
    notes,
  };
}

interface Bucket {
  part: CutPart;
  labels: Map<string, number>;
  qty: number;
}

/** Merge identical rows (same key), accumulating qty and per-cabinet counts. */
function dedup(rows: CutPart[]): CutPart[] {
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    let b = buckets.get(row.key);
    if (!b) {
      b = { part: row, labels: new Map(), qty: 0 };
      buckets.set(row.key, b);
    }
    b.qty += row.qty;
    b.labels.set(row.cabinet, (b.labels.get(row.cabinet) ?? 0) + row.qty);
  }
  const out: CutPart[] = [];
  for (const b of buckets.values()) {
    const cabinet = [...b.labels].map(([l, n]) => `${l} ×${n}`).join(', ');
    out.push({ ...b.part, qty: b.qty, cabinet });
  }
  return out;
}

export function buildCutList(design: Design): { parts: CutPart[]; appliances: ReturnType<typeof collectDesign>['appliances']; skipped: string[] } {
  const m = panelParamsFrom(design.manufacture ?? DEFAULT_MANUFACTURE);
  const e = edgeThkFrom(design);
  const collected = collectDesign(design);
  const rows: CutPart[] = [];

  for (const c of collected.items) {
    const hex = hexesFor(design, c);
    const panels = c.panels ?? (c.part ? partPanels(c.part, c.dims, m) : []);
    for (const panel of panels) rows.push(makePart(design, c, panel, m, hex, e));
    if (c.worktop) rows.push(worktopRow(design, c, m, e));
  }

  return { parts: dedup(rows), appliances: collected.appliances, skipped: collected.skipped };
}
