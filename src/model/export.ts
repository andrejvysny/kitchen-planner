/**
 * Bill of materials — the manufacturing export. Pure model code (no three.js,
 * no DOM): it turns a Design into flat rows, and src/model/exportFormats.ts
 * turns those rows into CSV / a printable sheet.
 *
 * Two invariants hold this file together:
 *  (a) every cut row comes from `partPanels` (src/model/panels.ts), NEVER from
 *      meshes — the panel list is the geometric truth the renderer also uses;
 *  (b) colour slots resolve through src/model/variables.ts, mirroring
 *      partMeshes.ts `panelMaterial` exactly, so the sheet shows what the 3D
 *      view shows.
 *
 * Manufactured (custom part / preset) and bought (catalog) items are mutually
 * exclusive: `partOfDesign` resolving is what makes an item manufactured.
 */

import { defOfDesign, partOfDesign } from './attach';
import { catalogSection, PLINTH_COLOR } from './catalog';
import { polygonBounds, signedArea } from './geometry';
import { materialDef } from './materials';
import { partPanels, type Panel, type PanelRole } from './panels';
import { roomOfItem, roomOfWall, styleOfItem } from './rooms';
import type { CustomPartDef, Design, Item, Point, Room } from './types';
import { counterFin, resolveColor, resolveFinish } from './variables';
import { hostContexts } from './worktops';

/* ---------------- constants ---------------- */

/**
 * Hinges per leaf by hinged-edge length (m). Shop rule of thumb, not a
 * supplier spec: 2 up to 1 m, 3 up to 1.6 m, 4 beyond. Deliberately coarse —
 * a real order is placed against the chosen hinge system.
 */
const HINGE_STEPS: readonly (readonly [number, number])[] = [
  [1.0, 2],
  [1.6, 3],
];
const HINGE_MAX = 4;

/** Nominal drawer-slide lengths (mm) every supplier stocks. */
const SLIDE_LENGTHS: readonly number[] = [250, 300, 350, 400, 450, 500, 550];

/** panels.ts derives a drawer's travel from its cavity depth as depth × 0.9. */
const SLIDE_TRAVEL_RATIO = 0.9;

export const HARDWARE_CATEGORY = 'Hardware';
export const OPENINGS_CATEGORY = 'Openings';
/** catalog entries with no section (custom/forked defs) land here */
const OTHER_CATEGORY = 'Other';

/* ---------------- row shapes ---------------- */

export interface CutRow {
  /** dedup identity; see `cutRows` for what it is made of */
  key: string;
  roomId: string;
  room: string;
  /** part NAME, not defId — see the dedup note in `cutRows` */
  part: string;
  /** defId of the FIRST instance that produced this row (traceability only) */
  defId: string;
  panelId: string;
  role: PanelRole;
  qty: number;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  shape: 'box' | 'cyl' | 'prism';
  slot: Panel['slot'];
  finish: Panel['finish'];
  colorHex: string;
  materialLabel: string;
  /** true material area (prisms subtract their holes) — for sheet-yield math */
  areaM2: number;
  notes: string;
  /** prisms only, item-local METERS — CNC-ready, kept for a future DXF export */
  outline?: Point[];
  holes?: Point[][];
  itemIds: string[];
}

export interface BuyRow {
  key: string;
  roomId: string;
  room: string;
  category: string;
  label: string;
  defId: string;
  qty: number;
  wMm: number;
  dMm: number;
  hMm: number;
  options: string;
  colorHex: string;
  materialLabel: string;
  notes: string;
  /** item ids, or opening ids for the Openings category */
  itemIds: string[];
}

export interface BomRoom {
  id: string;
  name: string;
}

export interface Bom {
  /** ISO timestamp the sheet was generated at */
  generatedAt: string;
  rooms: BomRoom[];
  cut: CutRow[];
  /** shopping list AND hardware (category `Hardware`) — one purchasable list */
  buy: BuyRow[];
  totals: {
    /** total boards to cut (qty summed) */
    panels: number;
    /** total board area in m² (qty summed) */
    boardAreaM2: number;
    /** total purchased pieces (qty summed, hardware included) */
    products: number;
  };
}

/* ---------------- helpers ---------------- */

const mm = (m: number): number => Math.round(m * 1000);

/** Descending sort — L ≥ W ≥ T, so thickness is always the smallest dimension. */
function sorted3(a: number, b: number, c: number): [number, number, number] {
  const s = [a, b, c].sort((x, y) => y - x);
  return [s[0], s[1], s[2]];
}

const polyArea = (poly: Point[]): number => Math.abs(signedArea(poly));

interface Dims {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  areaM2: number;
  shape: 'box' | 'cyl' | 'prism';
}

/**
 * Cut dimensions for one panel. Grain direction is NOT modelled — the panel IR
 * carries no grain axis today, so L/W are a pure size sort (deferred; adding it
 * means a `grain` field on Panel first, not a guess here).
 */
function panelDims(p: Panel): Dims {
  if (p.shape.kind === 'prism') {
    const b = polygonBounds(p.shape.outline);
    const [l, w, t] = sorted3(b.maxX - b.minX, b.maxY - b.minY, p.shape.h);
    const area =
      polyArea(p.shape.outline) - (p.shape.holes ?? []).reduce((s, h) => s + polyArea(h), 0);
    return {
      lengthMm: mm(l),
      widthMm: mm(w),
      thicknessMm: mm(t),
      areaM2: Math.max(0, area),
      shape: 'prism',
    };
  }
  if (p.shape.kind === 'cyl') {
    // a rod, not sheet goods: sorted like everything else, Ø goes in the notes
    const [l, w, t] = sorted3(p.shape.h, p.shape.dia, p.shape.dia);
    return { lengthMm: mm(l), widthMm: mm(w), thicknessMm: mm(t), areaM2: l * w, shape: 'cyl' };
  }
  const [l, w, t] = sorted3(p.shape.w, p.shape.h, p.shape.d);
  return { lengthMm: mm(l), widthMm: mm(w), thicknessMm: mm(t), areaM2: l * w, shape: 'box' };
}

/** Everything a shop needs beyond the numbers: hardware datums and cutouts. */
function panelNotes(p: Panel): string {
  const bits: string[] = [];
  if (p.shape.kind === 'cyl') bits.push(`Ø${mm(p.shape.dia)} mm`);
  if (p.motion?.kind === 'hinge') bits.push(`Hinge ${p.motion.side ?? 'left'}`);
  if (p.motion?.kind === 'slide') bits.push(`Slide travel ${mm(p.motion.travel ?? 0)} mm`);
  if (p.shape.kind === 'prism') {
    for (const hole of p.shape.holes ?? []) {
      const b = polygonBounds(hole);
      bits.push(`Cutout ${mm(b.maxX - b.minX)}×${mm(b.maxY - b.minY)} mm`);
    }
  }
  return bits.join('; ');
}

interface Fin {
  colorHex: string;
  materialLabel: string;
}

const labelOf = (materialId: string | undefined): string =>
  (materialId ? materialDef(materialId)?.label : undefined) ?? '';

/**
 * The resolved finish of one panel slot. Mirrors partMeshes.ts `panelMaterial`
 * line for line — glass first, then counter/worktop, accent, plinth, front.
 * `Panel.tint` is deliberately ignored: it is renderer-only darkening of a
 * carcass board, not a different material to order.
 */
function panelFinish(design: Design, item: Item, part: CustomPartDef, p: Panel): Fin {
  if (p.slot === 'glass') {
    const glass = materialDef('glass');
    return { colorHex: glass?.color ?? '#bcd2d8', materialLabel: glass?.label ?? 'Glass' };
  }
  if (p.slot === 'counter' || p.role === 'worktop') {
    const fin = counterFin(design, styleOfItem(design, item), item);
    return { colorHex: fin.color, materialLabel: labelOf(fin.material) };
  }
  if (p.slot === 'accent') {
    return {
      colorHex: resolveColor(design, item.accentColor ?? part.accentColor),
      materialLabel: '',
    };
  }
  if (p.slot === 'plinth') {
    return { colorHex: PLINTH_COLOR, materialLabel: '' };
  }
  const fin = resolveFinish(design, item.color, item.material, item.materialRot);
  return { colorHex: fin.color, materialLabel: labelOf(fin.material) };
}

const itemDims = (it: Item): { w: number; d: number; h: number; elevation: number } => ({
  w: it.w,
  d: it.d,
  h: it.h,
  elevation: it.elevation,
});

/** Accumulate rows under their dedup key, bumping qty and traceability. */
function collect<T extends { key: string; qty: number; itemIds: string[] }>(
  out: T[],
  byKey: Map<string, T>,
  row: T,
  sourceId: string
): void {
  const hit = byKey.get(row.key);
  if (hit) {
    hit.qty += row.qty;
    if (!hit.itemIds.includes(sourceId)) hit.itemIds.push(sourceId);
    return;
  }
  byKey.set(row.key, row);
  out.push(row);
}

/* ---------------- cut list ---------------- */

/**
 * Every board to cut, deduplicated.
 *
 * The key is `roomId | part NAME | panelId | LxWxT | colour | material |
 * finish | notes`. It carries the part NAME rather than its defId on purpose:
 * `Store.forkPartForItem` ("Customize in Workshop…") mints a FRESH defId for a copy of
 * a preset, so keying on defId would split two physically identical cabinets
 * into two rows. Name-keying merges them; `itemIds` keeps the traceability, and
 * two genuinely different parts sharing a name still differ in panel ids or
 * dimensions in practice.
 */
export function cutRows(design: Design): CutRow[] {
  // ONE hosting pass per export: cutouts and merged worktop runs are
  // design-wide truth, not per item
  const hosting = hostContexts(design);
  const out: CutRow[] = [];
  const byKey = new Map<string, CutRow>();
  for (const item of design.items) {
    const part = partOfDesign(design, item.defId);
    if (!part) continue; // bought product — it belongs in the shopping list
    const room = roomOfItem(design, item);
    for (const p of partPanels(part, itemDims(item), hosting.get(item.id))) {
      collect(out, byKey, cutRow(design, item, part, room, p), item.id);
    }
  }
  return out;
}

function cutRow(
  design: Design,
  item: Item,
  part: CustomPartDef,
  room: Room | undefined,
  p: Panel
): CutRow {
  const fin = panelFinish(design, item, part, p);
  const d = panelDims(p);
  const notes = panelNotes(p);
  const roomId = room?.id ?? '';
  return {
    key: [
      roomId,
      part.name,
      p.id,
      `${d.lengthMm}x${d.widthMm}x${d.thicknessMm}`,
      fin.colorHex,
      fin.materialLabel,
      p.finish,
      notes,
    ].join('|'),
    roomId,
    room: room?.name ?? '',
    part: part.name,
    defId: item.defId,
    panelId: p.id,
    role: p.role,
    qty: 1,
    lengthMm: d.lengthMm,
    widthMm: d.widthMm,
    thicknessMm: d.thicknessMm,
    shape: d.shape,
    slot: p.slot,
    finish: p.finish,
    colorHex: fin.colorHex,
    materialLabel: fin.materialLabel,
    areaM2: d.areaM2,
    notes,
    ...(p.shape.kind === 'prism'
      ? { outline: p.shape.outline, holes: p.shape.holes?.length ? p.shape.holes : undefined }
      : {}),
    itemIds: [item.id],
  };
}

/* ---------------- shopping list ---------------- */

/** `Bowls: 2; Zones: 4` — every declared param at its effective value. */
function paramOptions(
  item: Item,
  params: { key: string; label: string; def: number }[] | undefined
): string {
  if (!params?.length) return '';
  return params.map((p) => `${p.label}: ${item.params?.[p.key] ?? p.def}`).join('; ');
}

/** Where an attached appliance sits, and what it takes out of its host. */
function attachNote(design: Design, item: Item): string {
  const a = item.attach;
  if (!a) return '';
  const host = design.items.find((i) => i.id === a.hostId);
  const hostLabel = host ? (defOfDesign(design, host.defId)?.label ?? host.defId) : 'unknown host';
  if (a.kind === 'zone') return `Built into ${hostLabel} niche`;
  const cut = defOfDesign(design, item.defId)?.appliance?.cutout;
  return cut
    ? `Mounted in ${hostLabel} · cutout ${mm(cut.w)}×${mm(cut.d)} mm`
    : `Mounted in ${hostLabel}`;
}

/** Bought products (appliances, furniture, lighting, markers) + wall openings. */
export function buyRows(design: Design): BuyRow[] {
  const out: BuyRow[] = [];
  const byKey = new Map<string, BuyRow>();
  for (const item of design.items) {
    if (partOfDesign(design, item.defId)) continue; // manufactured — cut list
    const def = defOfDesign(design, item.defId);
    if (!def) continue; // dangling defId; sanitizeDesign drops these on load
    const room = roomOfItem(design, item);
    const roomId = room?.id ?? '';
    const options = paramOptions(item, def.params);
    const notes = attachNote(design, item);
    const colorHex = resolveColor(design, item.color);
    const materialLabel = labelOf(item.material);
    const size = `${mm(item.w)}x${mm(item.d)}x${mm(item.h)}`;
    collect(
      out,
      byKey,
      {
        key: [roomId, item.defId, size, options, colorHex, materialLabel, notes].join('|'),
        roomId,
        room: room?.name ?? '',
        category: catalogSection(item.defId) ?? OTHER_CATEGORY,
        label: def.label,
        defId: item.defId,
        qty: 1,
        wMm: mm(item.w),
        dMm: mm(item.d),
        hMm: mm(item.h),
        options,
        colorHex,
        materialLabel,
        notes,
        itemIds: [item.id],
      },
      item.id
    );
  }
  out.push(...openingRows(design));
  return out;
}

/**
 * Doors and windows to buy. `design.openings` stores a shared-wall opening
 * exactly ONCE (sanitizeDesign homes it on the owner side and the twin view is
 * derived), so iterating the stored list can never double-count a partition
 * door. Depth = the host room's wall thickness: the frame has to span it.
 */
function openingRows(design: Design): BuyRow[] {
  const out: BuyRow[] = [];
  const byKey = new Map<string, BuyRow>();
  for (const o of design.openings) {
    const room = roomOfWall(design.rooms, o.wallId);
    const roomId = room?.id ?? '';
    const label = o.type === 'door' ? 'Door' : 'Window';
    const options =
      o.type === 'door'
        ? `Hinge: ${o.hinge ?? 'left'}; Swing: ${o.swing ?? 'in'}`
        : `Sill: ${mm(o.sill)} mm`;
    const dMm = mm(room?.style.wallThickness ?? 0);
    const size = `${mm(o.width)}x${dMm}x${mm(o.height)}`;
    collect(
      out,
      byKey,
      {
        key: [roomId, OPENINGS_CATEGORY, o.type, size, options].join('|'),
        roomId,
        room: room?.name ?? '',
        category: OPENINGS_CATEGORY,
        label,
        defId: o.type,
        qty: 1,
        wMm: mm(o.width),
        dMm,
        hMm: mm(o.height),
        options,
        colorHex: '',
        materialLabel: '',
        notes: '',
        itemIds: [o.id],
      },
      o.id
    );
  }
  return out;
}

/* ---------------- hardware ---------------- */

interface MotionUnit {
  kind: 'hinge' | 'slide';
  side?: 'left' | 'right' | 'top' | 'bottom';
  travel: number;
  /** hinged leaf: the length of the hinged EDGE (m) */
  leaf: number;
}

/** One entry per moving unit; box boards share their front's unit id. */
function motionUnits(panels: Panel[]): Map<string, MotionUnit> {
  const units = new Map<string, MotionUnit>();
  for (const p of panels) {
    const m = p.motion;
    if (!m) continue;
    let u = units.get(m.unit);
    if (!u) {
      u = { kind: m.kind, side: m.side, travel: m.travel ?? 0, leaf: 0 };
      units.set(m.unit, u);
    }
    if (m.travel !== undefined) u.travel = Math.max(u.travel, m.travel);
    // the front board defines the leaf; side/bottom boards of a drawer don't
    if (p.role === 'front' && p.shape.kind === 'box') {
      u.leaf = m.side === 'top' || m.side === 'bottom' ? p.shape.w : p.shape.h;
    }
  }
  return units;
}

function hingeCount(leaf: number): number {
  for (const [maxLen, n] of HINGE_STEPS) if (leaf <= maxLen) return n;
  return HINGE_MAX;
}

/** Nearest stocked slide length to the cavity depth the travel was derived from. */
function slideLength(travel: number): number {
  const target = (travel / SLIDE_TRAVEL_RATIO) * 1000;
  return SLIDE_LENGTHS.reduce((best, v) =>
    Math.abs(v - target) < Math.abs(best - target) ? v : best
  );
}

/**
 * Hinges and slide pairs implied by `Panel.motion`. The counts are heuristics
 * (see HINGE_STEPS / SLIDE_LENGTHS) — enough to price a job, not a substitute
 * for a supplier's fitting table.
 */
export function hardwareRows(design: Design): BuyRow[] {
  const out: BuyRow[] = [];
  const byKey = new Map<string, BuyRow>();
  const row = (
    item: Item,
    room: Room | undefined,
    label: string,
    qty: number,
    options: string,
    dMm: number
  ): void => {
    const roomId = room?.id ?? '';
    collect(
      out,
      byKey,
      {
        key: [roomId, HARDWARE_CATEGORY, label, options].join('|'),
        roomId,
        room: room?.name ?? '',
        category: HARDWARE_CATEGORY,
        label,
        defId: '',
        qty,
        wMm: 0,
        dMm,
        hMm: 0,
        options,
        colorHex: '',
        materialLabel: '',
        notes: '',
        itemIds: [item.id],
      },
      item.id
    );
  };
  for (const item of design.items) {
    const part = partOfDesign(design, item.defId);
    if (!part) continue;
    const room = roomOfItem(design, item);
    for (const u of motionUnits(partPanels(part, itemDims(item))).values()) {
      if (u.kind === 'hinge') row(item, room, 'Concealed hinge', hingeCount(u.leaf), '', 0);
      else {
        const len = slideLength(u.travel);
        row(item, room, 'Drawer slide pair', 1, `${len} mm`, len);
      }
    }
  }
  return out;
}

/* ---------------- assembly ---------------- */

export function buildBom(design: Design, now: Date = new Date()): Bom {
  const cut = cutRows(design);
  const buy = [...buyRows(design), ...hardwareRows(design)];
  return {
    generatedAt: now.toISOString(),
    rooms: design.rooms.map((r) => ({ id: r.id, name: r.name })),
    cut,
    buy,
    totals: {
      panels: cut.reduce((s, r) => s + r.qty, 0),
      boardAreaM2: cut.reduce((s, r) => s + r.areaM2 * r.qty, 0),
      products: buy.reduce((s, r) => s + r.qty, 0),
    },
  };
}
