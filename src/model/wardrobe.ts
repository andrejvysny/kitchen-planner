/**
 * Built-in wardrobe: sanitizer + layout math (src/model/panels.ts consumes
 * `wardrobePanels`, which still throws — the panel table lands in a later step).
 *
 * Coordinate conventions, identical to every other part generator:
 * item-local metres, x centred on the part (−w/2 … +w/2), y measured up from
 * the floor with a panel's `y` at its BOTTOM, +z towards the front of the part.
 *
 * `wardrobeLayout` is the SINGLE layout source — the panel generator, the
 * Part Studio's wardrobe canvas, the plan symbol and the elevation drawing all
 * read it, exactly as `walkZones` serves the cabinet zone tree. Nothing
 * downstream may re-derive a column or section rectangle of its own.
 *
 * An `open` section emits NO niche lining (unlike `interiorBox`'s 15 mm inset
 * for an open cabinet zone): a wardrobe column already has real boards on all
 * four sides, so the cavity IS the opening.
 *
 * No panels.ts value is EVALUATED at module scope — panels.ts imports
 * `wardrobePanels` from here, so the two modules are a cycle and whichever one
 * the bundler enters second is still in its temporal dead zone. The helper
 * imports below are therefore read only from inside function bodies, and
 * FRONT_T/GAP stay re-declared rather than imported, because they ARE read at
 * module scope by the layout constants.
 */

import { FRONT_COLORS, OAK } from './catalog';
import { clamp } from './geometry';
import {
  BACK_T,
  CARCASS_T,
  MIN_ELEM_SPACE,
  RAIL_DIA,
  resolveInterior,
  sanitizeInterior,
} from './interior';
import { AT, boxPanel, cylPanel, drawerBoxPanels, splitFronts } from './panels';
import type { Cavity, HostContext, Panel, PanelRole, PartDims } from './panels';
import {
  uid,
  type Interior,
  type InteriorElement,
  type WardrobeColumn,
  type WardrobeFront,
  type WardrobePartDef,
  type WardrobeSection,
  type WardrobeSectionKind,
} from './types';

/* ---------------- constants ---------------- */

export const MAX_COLUMNS = 8;
export const MAX_SECTIONS = 6;
/** fixed column width bounds (m) */
export const COL_MIN_W = 0.2;
export const COL_MAX_W = 1.5;
/** fixed section height bounds (m) */
export const SEC_MIN_H = 0.1;
export const SEC_MAX_H = 2.0;
/** how far a sliding panel laps the one on the other track */
export const SLIDING_OVERLAP = 0.04;
/** depth the two sliding tracks take off the front of the carcass */
export const SLIDING_TRACK_D = 0.1;
/** top/bottom sliding track height */
export const TRACK_T = 0.03;
/** an 'auto' door wider than this becomes a pair */
export const AUTO_PAIR_W = 0.6;
/** hanging rail below the top of its cavity */
export const HANG_DROP = 0.1;
/** hat shelf above the hanging rail */
export const HAT_SHELF_UP = 0.08;
/** lower rail of a double-hang column, above the cavity bottom */
export const DOUBLE_LOW_Y = 0.95;
/** bench height of a seat section */
export const SEAT_H = 0.45;
export const CUSHION_T = 0.05;
/** coat-hook rail height above the FLOOR (not the cavity bottom) */
export const HOOK_RAIL_FLOOR_Y = 1.5;
/** shoe shelves run shallower than the cavity */
export const SHOE_DEPTH_F = 0.8;
/** LED strip cross-section */
export const LIGHT_H = 0.02;
export const LIGHT_D = 0.012;
export const DEFAULT_PLINTH_H = 0.1;

/** front slab thickness / inter-front gap — panels.ts FRONT_T and GAP,
 * re-declared to keep this module free of any runtime import of panels.ts
 * (see the header). */
const FRONT_T = 0.018;
const GAP = 0.004;

const SECTION_KINDS: WardrobeSectionKind[] = [
  'hanging',
  'hangingDouble',
  'shelves',
  'drawers',
  'open',
  'seat',
  'shoes',
  'custom',
];
const DOOR_MODES: WardrobeColumn['door'][] = ['auto', 'none', 'left', 'right', 'pair'];
/** kinds a section may be `exposed` on: reachable without opening the door */
const EXPOSABLE: WardrobeSectionKind[] = ['drawers', 'open', 'seat', 'shelves', 'shoes'];

/** kinds that carry a `count`, with their clamp range and default */
const COUNTS: Partial<Record<WardrobeSectionKind, { lo: number; hi: number; def: number }>> = {
  shelves: { lo: 1, hi: 6, def: 3 },
  drawers: { lo: 1, hi: 8, def: 3 },
  shoes: { lo: 1, hi: 8, def: 4 },
};
/** a drawer stack behind a door takes fewer, taller boxes */
const DRAWERS_BEHIND_DOOR_MAX = 4;

/** The default 2-column wardrobe a new "Built-in wardrobe" part starts as. */
export function newWardrobePart(): WardrobePartDef {
  return {
    id: uid('part'),
    name: 'My wardrobe',
    type: 'wardrobe',
    w: 2,
    d: 0.6,
    h: 2.4,
    elevation: 0,
    color: FRONT_COLORS[0],
    accentColor: OAK,
    columns: [
      {
        id: uid('col'),
        w: 'fill',
        sections: [{ kind: 'hanging', h: 'fill' }],
        door: 'auto',
      },
      {
        id: uid('col'),
        w: 0.8,
        sections: [
          { kind: 'drawers', h: 0.6, count: 3 },
          { kind: 'shelves', h: 'fill', count: 3 },
        ],
        door: 'auto',
      },
    ],
    front: { kind: 'hinged' },
    sides: { left: 'panel', right: 'panel' },
    filler: { left: 0, right: 0 },
    top: 'panel',
    back: true,
    plinthH: 0.1,
  };
}

/* ---------------- sanitizer ---------------- */

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Exactly one entry may be 'fill'. None → the LAST one becomes fill (the run
 * always ends against something); several → the FIRST survives and the rest
 * become fixed. Never reorders.
 */
function oneFill<T>(
  list: T[],
  isFill: (t: T) => boolean,
  makeFill: (t: T) => void,
  makeFixed: (t: T) => void
): void {
  if (list.length === 0) return;
  const fills = list.filter(isFill);
  if (fills.length === 0) makeFill(list[list.length - 1]);
  else for (let i = 1; i < fills.length; i++) makeFixed(fills[i]);
}

/**
 * Validate + repair a wardrobe's own fields, IN PLACE. Never reorders columns
 * or sections — the studio holds indices into both while a gesture is live.
 * Absent optional fields are DELETED rather than written as defaults: an undo
 * snapshot is a JSON round-trip, so a key that appears from nowhere is a
 * spurious diff.
 */
export function sanitizeWardrobeFields(part: WardrobePartDef): void {
  /* front first — `exposed` and `mirror` are gated on it */
  part.front = sanitizeFront(part.front);
  const hinged = part.front.kind === 'hinged';

  /* sides / fillers */
  const sides = (part.sides ?? {}) as Partial<WardrobePartDef['sides']>;
  part.sides = {
    left: sides.left === 'wall' ? 'wall' : 'panel',
    right: sides.right === 'wall' ? 'wall' : 'panel',
  };
  const fil = (part.filler ?? {}) as Partial<WardrobePartDef['filler']>;
  part.filler = {
    left: part.sides.left === 'wall' ? 0 : clamp(num(fil.left, 0), 0, 0.1),
    right: part.sides.right === 'wall' ? 0 : clamp(num(fil.right, 0), 0, 0.1),
  };

  /* carcass envelope */
  if (part.top !== 'ceiling') part.top = 'panel';
  if (typeof part.back !== 'boolean') part.back = true;
  part.plinthH = clamp(num(part.plinthH, DEFAULT_PLINTH_H), 0, 0.2);

  const cornice = num(part.cornice, 0);
  if (cornice > 0) part.cornice = clamp(cornice, 0, 0.3);
  else delete part.cornice;

  const top = part.topRow as Partial<{ h: number; doors: boolean }> | undefined;
  if (top && typeof top === 'object') {
    part.topRow = { h: clamp(num(top.h, 0.4), 0.25, 0.8), doors: top.doors === true };
  } else {
    delete part.topRow;
  }

  const light = part.light as Partial<{ cove: boolean; shelves: boolean }> | undefined;
  if (light && typeof light === 'object' && (light.cove === true || light.shelves === true)) {
    part.light = { cove: light.cove === true, shelves: light.shelves === true };
  } else {
    delete part.light;
  }

  if (part.mirror !== true || !hinged) delete part.mirror;

  /* columns */
  const raw = Array.isArray(part.columns) ? part.columns : [];
  let cols = raw.filter((c): c is WardrobeColumn => !!c && typeof c === 'object');
  if (cols.length === 0) {
    cols = [
      { id: uid('col'), w: 'fill', sections: [{ kind: 'hanging', h: 'fill' }], door: 'auto' },
    ];
  }
  part.columns = cols.slice(0, MAX_COLUMNS);

  const ids = new Set<string>();
  for (const col of part.columns) {
    if (typeof col.id !== 'string' || col.id === '' || ids.has(col.id)) col.id = uid('col');
    ids.add(col.id);
    if (!DOOR_MODES.includes(col.door)) col.door = 'auto';
    sanitizeSections(col, hinged);
  }

  oneFill(
    part.columns,
    (c) => c.w === 'fill',
    (c) => {
      c.w = 'fill';
    },
    (c) => {
      c.w = COL_MIN_W;
    }
  );
  for (const col of part.columns) {
    if (col.w !== 'fill') col.w = clamp(num(col.w, COL_MIN_W), COL_MIN_W, COL_MAX_W);
  }

  // the fill column must be left at least COL_MIN_W of the part's own width;
  // when the fixed ones ask for more they all scale down proportionally, so
  // the run keeps its shape rather than losing its last column
  const budget = Math.max(0.01, num(part.w, 2) - COL_MIN_W);
  const fixedSum = part.columns.reduce((s, c) => s + (c.w === 'fill' ? 0 : c.w), 0);
  if (fixedSum > budget) {
    const k = budget / fixedSum;
    for (const col of part.columns) if (col.w !== 'fill') col.w *= k;
  }
}

function sanitizeFront(raw: unknown): WardrobeFront {
  const f = raw as Partial<{ kind: string; panels: number; mirror: boolean }> | undefined;
  if (!f || typeof f !== 'object') return { kind: 'hinged' };
  if (f.kind === 'none') return { kind: 'none' };
  if (f.kind === 'sliding') {
    const panels = Math.round(num(f.panels, 2)) === 3 ? 3 : 2;
    const out: WardrobeFront = { kind: 'sliding', panels };
    if (f.mirror === true) out.mirror = true;
    return out;
  }
  return { kind: 'hinged' };
}

function sanitizeSections(col: WardrobeColumn, hinged: boolean): void {
  const raw = Array.isArray(col.sections) ? col.sections : [];
  let secs = raw.filter((s): s is WardrobeSection => !!s && typeof s === 'object');
  if (secs.length === 0) secs = [{ kind: 'shelves', h: 'fill', count: 3 }];
  col.sections = secs.slice(0, MAX_SECTIONS);

  for (const sec of col.sections) {
    if (!SECTION_KINDS.includes(sec.kind)) sec.kind = 'shelves';

    // `exposed` sits OUTSIDE the column door, so it only means anything on a
    // hinged front and only on a fill you can reach without opening one
    if (hinged && sec.exposed === true && EXPOSABLE.includes(sec.kind)) sec.exposed = true;
    else delete sec.exposed;

    if (sec.pullDown === true && (sec.kind === 'hanging' || sec.kind === 'hangingDouble')) {
      sec.pullDown = true;
    } else {
      delete sec.pullDown;
    }

    const c = COUNTS[sec.kind];
    if (c) {
      const hi = sec.kind === 'drawers' && !sec.exposed ? DRAWERS_BEHIND_DOOR_MAX : c.hi;
      const n = Math.round(num(sec.count, c.def));
      sec.count = clamp(n > 0 ? n : c.def, c.lo, hi);
    } else {
      delete sec.count;
    }

    if (sec.kind === 'custom') {
      const inter = sanitizeInterior(sec.interior);
      if (inter) sec.interior = inter;
      else delete sec.interior;
    } else {
      delete sec.interior;
    }
  }

  oneFill(
    col.sections,
    (s) => s.h === 'fill',
    (s) => {
      s.h = 'fill';
    },
    (s) => {
      s.h = SEC_MIN_H;
    }
  );
  for (const sec of col.sections) {
    if (sec.h !== 'fill') sec.h = clamp(num(sec.h, SEC_MIN_H), SEC_MIN_H, SEC_MAX_H);
  }
}

/* ---------------- layout ---------------- */

export interface WardrobeLayoutSection {
  index: number;
  kind: WardrobeSectionKind;
  /** cavity bottom / top, item-local metres from the floor */
  y0: number;
  y1: number;
  /** this section absorbs the column's slack */
  fill: boolean;
  /** sits outside the column door (hinged fronts only) */
  exposed: boolean;
  count?: number;
  pullDown?: boolean;
  /** the def's own interior — 'custom' sections only, unresolved */
  interior?: Interior;
  /** motion unit of the door run covering it (a pair's leaves add `.0`/`.1`);
   * null when exposed, doorless or behind a sliding front */
  doorUnit: string | null;
}

export interface WardrobeDoorRun {
  /** base motion unit; a pair's two leaves are `${unit}.0` / `${unit}.1` */
  unit: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** single leaf: the hinged edge. A pair opens from both, and carries the
   * outer edge here so the drawing has a stable convention. */
  side: 'left' | 'right';
  pair: boolean;
}

export interface WardrobeLayoutColumn {
  index: number;
  id: string;
  /** clear cavity between the bounding boards */
  x0: number;
  x1: number;
  /** front rect: the cavity plus the lap over its bounding boards */
  fx0: number;
  fx1: number;
  fill: boolean;
  /** resolved door mode ('auto' is decided here) */
  door: 'none' | 'left' | 'right' | 'pair';
  doors: WardrobeDoorRun[];
  sections: WardrobeLayoutSection[];
}

export interface WardrobeSlidingPanel {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** track lane: 0 = inner (centre z `zInner`), 1 = outer (`zOuter`) */
  layer: 0 | 1;
  /** how far it slides — always positive, the sign lives in `dir` because
   * export.ts's `motionUnits` takes `Math.max` on a travel */
  travel: number;
  dir: 1 | -1;
}

export type WardrobeLayoutFront =
  | { kind: 'none' }
  | { kind: 'hinged' }
  | {
      kind: 'sliding';
      mirror: boolean;
      panelW: number;
      overlap: number;
      y0: number;
      y1: number;
      /** panel-centre z of the two lanes */
      zOuter: number;
      zInner: number;
      panels: WardrobeSlidingPanel[];
    };

export interface WardrobeLayout {
  outer: { w: number; d: number; h: number };
  /** carcass body: y0 = plinth top, y1 = under the top board */
  body: { y0: number; y1: number; sideH: number; divH: number };
  /** between the end panels / fillers */
  inner: { x0: number; x1: number; w: number };
  columns: WardrobeLayoutColumn[];
  topRow: { y0: number; y1: number; doors: boolean } | null;
  front: WardrobeLayoutFront;
  plinth: { y0: number; y1: number } | null;
  cornice: { y0: number; y1: number } | null;
  depth: {
    /** depth the front system takes off the carcass */
    frontD: number;
    bodyD: number;
    /** body box centre / its front plane */
    zBody: number;
    zBodyFront: number;
    /** cavity in front of the back board */
    cavD: number;
    zCav: number;
    /** centre plane a front slab sits on (the outer sliding lane too) */
    zFrontFace: number;
  };
}

/**
 * Every rectangle of a wardrobe at one instance's dimensions. Pure, total and
 * finite for any input: a degenerate part (0.3 m wide, 8 columns) yields
 * overlapping rectangles rather than NaN, because the studio has to draw
 * whatever the user is half-way through building.
 */
export function wardrobeLayout(part: WardrobePartDef, dims: PartDims): WardrobeLayout {
  const w = num(dims.w, 1);
  const d = num(dims.d, 0.6);
  const h = num(dims.h, 2);

  /* vertical */
  const plinthH = clamp(num(part.plinthH, 0), 0, 0.2);
  const topT = part.top === 'panel' ? CARCASS_T : 0;
  const cornice = Math.max(0, num(part.cornice, 0));
  const y0 = plinthH;
  const y1 = h - cornice - topT;
  const sideH = y1 + topT - y0;
  const divH = y1 - y0 - CARCASS_T;
  const colBot = y0 + CARCASS_T;
  const trH = part.topRow ? clamp(num(part.topRow.h, 0.4), 0.25, 0.8) : 0;
  const colTop = y1 - (part.topRow ? trH + CARCASS_T : 0);
  const stackH = colTop - colBot;

  /* horizontal */
  const wallL = part.sides?.left === 'wall';
  const wallR = part.sides?.right === 'wall';
  const endL = wallL ? 0 : CARCASS_T;
  const endR = wallR ? 0 : CARCASS_T;
  const filL = wallL ? 0 : clamp(num(part.filler?.left, 0), 0, 0.1);
  const filR = wallR ? 0 : clamp(num(part.filler?.right, 0), 0, 0.1);
  const ix0 = -w / 2 + filL + endL;
  const ix1 = w / 2 - filR - endR;
  const innerW = ix1 - ix0;

  const cols = Array.isArray(part.columns) ? part.columns : [];
  const n = cols.length;
  // the FIRST 'fill' wins, matching the sanitizer's own repair; a second one
  // (only reachable on unsanitized input) counts as a minimum-width column
  const fillIdx = cols.findIndex((c) => c.w === 'fill');
  const widthOf = (c: WardrobeColumn): number =>
    c.w === 'fill' ? COL_MIN_W : Math.max(0, num(c.w, COL_MIN_W));
  let fixedSum = 0;
  for (let i = 0; i < n; i++) if (i !== fillIdx) fixedSum += widthOf(cols[i]);
  const avail = innerW - Math.max(0, n - 1) * CARCASS_T;
  const fillW = Math.max(COL_MIN_W, avail - fixedSum);

  const hinged = part.front?.kind === 'hinged';
  const columns: WardrobeLayoutColumn[] = [];
  let x = ix0;
  for (let i = 0; i < n; i++) {
    const col = cols[i];
    const isFill = i === fillIdx;
    const cw = isFill ? fillW : widthOf(col);
    const cx0 = x;
    const cx1 = x + cw;
    x = cx1 + CARCASS_T;
    // the front laps the FULL end panel and HALF an internal divider, so two
    // neighbouring doors split the divider and no board is covered twice
    const fx0 = cx0 - (i === 0 ? endL : CARCASS_T / 2);
    const fx1 = cx1 + (i === n - 1 ? endR : CARCASS_T / 2);
    // an 'auto' single hinges on the run's OUTER edge, so the two end columns
    // of a run open away from each other
    const outer: 'left' | 'right' = i === 0 ? 'left' : i === n - 1 ? 'right' : 'left';

    const sections = layoutSections(col, colBot, stackH, hinged);
    const door = hinged ? resolveDoor(col.door, fx1 - fx0, outer) : 'none';
    const doors = door === 'none' ? [] : doorRuns(colId(col, i), sections, fx0, fx1, door, outer);
    for (const run of doors) {
      for (const sec of sections) {
        if (!sec.exposed && sec.y0 >= run.y0 - 1e-9 && sec.y1 <= run.y1 + 1e-9) {
          sec.doorUnit = run.unit;
        }
      }
    }

    columns.push({
      index: i,
      id: colId(col, i),
      x0: cx0,
      x1: cx1,
      fx0,
      fx1,
      fill: isFill,
      door,
      doors,
      sections,
    });
  }

  /* depth */
  const frontD =
    part.front?.kind === 'sliding' ? SLIDING_TRACK_D : part.front?.kind === 'hinged' ? FRONT_T : 0;
  const bodyD = d - frontD;
  const zBody = -frontD / 2;
  const zBodyFront = zBody + bodyD / 2;
  const backT = part.back ? BACK_T : 0;
  const cavD = bodyD - backT;
  const zCav = zBody + backT / 2;
  const zFrontFace = d / 2 - FRONT_T / 2;

  return {
    outer: { w, d, h },
    body: { y0, y1, sideH, divH },
    inner: { x0: ix0, x1: ix1, w: innerW },
    columns,
    topRow: part.topRow ? { y0: colTop + CARCASS_T, y1, doors: part.topRow.doors === true } : null,
    front: layoutFront(part, w, colTop, y1 + topT, zFrontFace),
    plinth: plinthH > 0 ? { y0: 0, y1: plinthH } : null,
    cornice: cornice > 0 ? { y0: y1 + topT, y1: y1 + topT + cornice } : null,
    depth: { frontD, bodyD, zBody, zBodyFront, cavD, zCav, zFrontFace },
  };
}

const colId = (col: WardrobeColumn, i: number): string =>
  typeof col.id === 'string' && col.id !== '' ? col.id : `col${i}`;

/** Tile a column's sections bottom → top, one divider board between each pair. */
function layoutSections(
  col: WardrobeColumn,
  colBot: number,
  stackH: number,
  hinged: boolean
): WardrobeLayoutSection[] {
  const secs = Array.isArray(col.sections) ? col.sections : [];
  const m = secs.length;
  if (m === 0) return [];
  const fillIdx = secs.findIndex((s) => s.h === 'fill');
  const heightOf = (s: WardrobeSection): number =>
    s.h === 'fill' ? SEC_MIN_H : Math.max(0, num(s.h, SEC_MIN_H));
  let fixedSum = 0;
  for (let i = 0; i < m; i++) if (i !== fillIdx) fixedSum += heightOf(secs[i]);
  const fillH = Math.max(SEC_MIN_H, stackH - (m - 1) * CARCASS_T - fixedSum);

  const out: WardrobeLayoutSection[] = [];
  let y = colBot;
  for (let i = 0; i < m; i++) {
    const sec = secs[i];
    const sh = i === fillIdx ? fillH : heightOf(sec);
    const entry: WardrobeLayoutSection = {
      index: i,
      kind: SECTION_KINDS.includes(sec.kind) ? sec.kind : 'shelves',
      y0: y,
      y1: y + sh,
      fill: i === fillIdx,
      exposed: hinged && sec.exposed === true,
      doorUnit: null,
    };
    if (sec.count !== undefined) entry.count = sec.count;
    if (sec.pullDown === true) entry.pullDown = true;
    if (sec.kind === 'custom' && sec.interior) entry.interior = sec.interior;
    out.push(entry);
    y = entry.y1 + CARCASS_T;
  }
  return out;
}

function resolveDoor(
  mode: WardrobeColumn['door'],
  frontW: number,
  outer: 'left' | 'right'
): 'none' | 'left' | 'right' | 'pair' {
  if (mode === 'none') return 'none';
  if (mode === 'pair') return 'pair';
  if (mode === 'left' || mode === 'right') return mode;
  return frontW > AUTO_PAIR_W ? 'pair' : outer;
}

/**
 * One run per maximal contiguous stretch of NON-exposed sections: an exposed
 * drawer bank splits a column's door in two rather than hiding behind it.
 */
function doorRuns(
  id: string,
  sections: WardrobeLayoutSection[],
  fx0: number,
  fx1: number,
  door: 'left' | 'right' | 'pair',
  outer: 'left' | 'right'
): WardrobeDoorRun[] {
  const side: 'left' | 'right' = door === 'pair' ? outer : door;
  const runs: WardrobeDoorRun[] = [];
  let start = -1;
  const close = (end: number): void => {
    if (start < 0 || end < start) {
      start = -1;
      return;
    }
    runs.push({
      unit: `${id}.door${runs.length}`,
      x0: fx0,
      x1: fx1,
      y0: sections[start].y0,
      y1: sections[end].y1,
      side,
      pair: door === 'pair',
    });
    start = -1;
  };
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].exposed) close(i - 1);
    else if (start < 0) start = i;
  }
  close(sections.length - 1);
  return runs;
}

function layoutFront(
  part: WardrobePartDef,
  w: number,
  colTop: number,
  bodyTop: number,
  zFrontFace: number
): WardrobeLayoutFront {
  const f = part.front;
  if (!f || f.kind === 'none') return { kind: 'none' };
  if (f.kind !== 'sliding') return { kind: 'hinged' };
  const n = f.panels === 3 ? 3 : 2;
  const panelW = (w + (n - 1) * SLIDING_OVERLAP) / n;
  // a top-box row keeps its own doors, so the sliders stop under it
  const y0 = TRACK_T;
  const y1 = (part.topRow ? colTop : bodyTop) - TRACK_T;
  // two lanes inside the SLIDING_TRACK_D deep front zone: the outer one is the
  // ordinary front plane, the inner one a slab thickness plus a gap behind it
  const zOuter = zFrontFace;
  const zInner = zFrontFace - FRONT_T - GAP;
  const travel = Math.max(0, panelW - SLIDING_OVERLAP);
  const panels: WardrobeSlidingPanel[] = [];
  for (let k = 0; k < n; k++) {
    const x0 = -w / 2 + k * (panelW - SLIDING_OVERLAP);
    panels.push({
      x0,
      x1: x0 + panelW,
      y0,
      y1,
      layer: k % 2 === 0 ? 0 : 1,
      travel,
      // the last panel is the only one with nothing to its right to slide over
      dir: k === n - 1 ? -1 : 1,
    });
  }
  return {
    kind: 'sliding',
    mirror: f.mirror === true,
    panelW,
    overlap: SLIDING_OVERLAP,
    y0,
    y1,
    zOuter,
    zInner,
    panels,
  };
}

/**
 * The interior cavity of one section, in the frame `resolveInterior` and the
 * interior drill-in use: `x0`/`w` across the column cavity in item-local x,
 * `y0` 0 (an element's `y` is measured from the cavity bottom) and `h` the
 * section's own height. Depth is not part of `Cavity` — read it from
 * `wardrobeLayout(...).depth.cavD`. Null for an out-of-range index.
 */
export function wardrobeSectionCavity(
  part: WardrobePartDef,
  dims: PartDims,
  col: number,
  sec: number
): Cavity | null {
  const lay = wardrobeLayout(part, dims);
  const c = lay.columns[col];
  const s = c?.sections[sec];
  if (!c || !s) return null;
  return { x0: c.x0, w: c.x1 - c.x0, y0: 0, h: s.y1 - s.y0 };
}

/**
 * The interior a typed section implies, inside a cavity `cavityH` tall. Every
 * branch hands its result to `resolveInterior`, so the positional clamps stay
 * single-source; undefined means "the panel generator emits this fill itself"
 * (exposed drawers, open, seat, shoes).
 */
export function sectionInterior(sec: WardrobeSection, cavityH: number): Interior | undefined {
  const cavH = num(cavityH, 0);
  switch (sec.kind) {
    case 'hanging': {
      // The rail drops HANG_DROP + HAT_SHELF_UP below the section top so the
      // hat shelf (HAT_SHELF_UP above the rail) still clears the cavity top by
      // HANG_DROP — which is what lets it past resolveInterior's clear-air
      // rule. hangingDouble has no hat shelf, so its upper rail keeps the
      // plain HANG_DROP drop.
      const railY = clamp(cavH - HANG_DROP - HAT_SHELF_UP, MIN_ELEM_SPACE, cavH - MIN_ELEM_SPACE);
      const elements: InteriorElement[] = [{ kind: 'rail', y: railY }];
      // Only when it clears the cavity top — a very short section keeps just
      // the rail; the carcass top board stands in for the shelf.
      const shelfY = railY + HAT_SHELF_UP;
      if (shelfY < cavH - MIN_ELEM_SPACE / 2) elements.push({ kind: 'shelf', y: shelfY });
      return { mode: 'custom', elements };
    }
    case 'hangingDouble':
      // resolveInterior's overlap rule drops the upper rail in a short cavity
      return {
        mode: 'custom',
        elements: [
          { kind: 'rail', y: DOUBLE_LOW_Y },
          { kind: 'rail', y: cavH - HANG_DROP },
        ],
      };
    case 'shelves':
      return { mode: 'auto', shelves: sec.count ?? COUNTS.shelves!.def, innerDrawers: 0 };
    case 'drawers': {
      if (sec.exposed) return undefined; // real fronts, emitted by the generator
      const count = Math.max(1, Math.round(num(sec.count, COUNTS.drawers!.def)));
      // The stack tiles the cavity on a uniform pitch, and the box height
      // leaves resolveInterior's clear-air gap (MIN_ELEM_SPACE/2) between
      // consecutive boxes plus 1 mm of slack — the drop rule is a strict
      // `< MIN_ELEM_SPACE/2`, so an exact gap loses to float noise and a
      // tighter one would get every second box dropped.
      const pitch = (cavH - 0.02) / count;
      const boxH = Math.min(0.25, pitch - MIN_ELEM_SPACE / 2 - 0.001);
      if (boxH <= 0) return { mode: 'custom', elements: [] };
      const elements: InteriorElement[] = [];
      for (let k = 0; k < count; k++) {
        elements.push({ kind: 'drawerBox', y: 0.01 + k * pitch, h: boxH });
      }
      return { mode: 'custom', elements };
    }
    case 'custom':
      return sec.interior;
    default:
      return undefined; // open / seat / shoes: the generator builds them
  }
}

/* ---------------- panel generator ---------------- */

/** carcass and divider boards read a shade darker than the fronts — the exact
 * tint cabinetPanels gives its shell */
const SHELL: Partial<Panel> = { tint: 0.92 };
/** interior boards (shelves, drawer boxes, benches) follow the wood accent */
const ACCENT: Partial<Panel> = { slot: 'accent', finish: 'wood' };
/** a metal tube: accent colour, never wood-grained */
const ROD: Partial<Panel> = { slot: 'accent', finish: 'matte', tint: 0.8 };

/** below this a "board" is float residue, not a board: a zero filler read back
 * off the layout comes out as 1.6e-17 m wide, and a cut list must not carry it */
const MIN_BOARD = 1e-6;

interface Emit {
  out: Panel[];
  /**
   * A degenerate part (0.3 m wide packed with 8 columns) is a legal editor
   * state — the studio has to draw whatever the user is half-way through
   * building — so a board that came out with a non-positive dimension is
   * DROPPED rather than emitted inside-out.
   */
  box(
    id: string,
    role: PanelRole,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rest?: Partial<Panel>
  ): void;
  /** horizontal rod across the column (hanging rail, coat hooks); `y` is its
   * underside, the same bottom-invariant every panel keeps */
  rod(
    id: string,
    role: PanelRole,
    dia: number,
    len: number,
    x: number,
    y: number,
    z: number,
    rest?: Partial<Panel>
  ): void;
}

function emitter(): Emit {
  const out: Panel[] = [];
  return {
    out,
    box(id, role, w, h, d, x, y, z, rest = {}) {
      if (w > MIN_BOARD && h > MIN_BOARD && d > MIN_BOARD) {
        out.push(boxPanel(id, role, w, h, d, x, y, z, AT, 0, rest));
      }
    },
    rod(id, role, dia, len, x, y, z, rest = {}) {
      if (dia > MIN_BOARD && len > MIN_BOARD) {
        out.push(cylPanel(id, role, dia, len, 'x', x, y, z, AT, 0, rest));
      }
    },
  };
}

/**
 * Every physical board of a wardrobe, at one instance's dimensions. Reads the
 * geometry from `wardrobeLayout` ONLY — nothing here re-derives a column or a
 * section rectangle, so the studio canvas, the plan symbol and the 3D view
 * cannot drift from the cut list.
 */
export function wardrobePanels(
  part: WardrobePartDef,
  dims: PartDims,
  // `ctx` completes the partPanels signature. A wardrobe hosts no appliance and
  // joins no continuous worktop run, so there is nothing in a HostContext for
  // it to read — it is accepted and ignored on purpose.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx?: HostContext
): Panel[] {
  const lay = wardrobeLayout(part, dims);
  const e = emitter();
  shellPanels(e, part, lay);
  trimPanels(e, lay);
  const led = part.light?.shelves === true;
  for (const col of lay.columns) columnPanels(e, lay, col, led);
  frontPanels(e, part, lay);
  if (part.light?.cove) {
    // one strip tucked under the top board, just behind the front edge
    e.box(
      'light.cove',
      'light',
      lay.inner.w - 0.02,
      LIGHT_H,
      LIGHT_D,
      (lay.inner.x0 + lay.inner.x1) / 2,
      lay.body.y1 - LIGHT_H - 0.002,
      lay.depth.zBodyFront - LIGHT_D / 2 - 0.005,
      { bought: 'LED strip' }
    );
  }
  return e.out;
}

/** End panels, fillers, the bottom/top/back boards and the column dividers. */
function shellPanels(e: Emit, part: WardrobePartDef, lay: WardrobeLayout): void {
  const { body, inner, depth, outer } = lay;
  const cx = (inner.x0 + inner.x1) / 2;
  const endL = part.sides?.left === 'wall' ? 0 : CARCASS_T;
  const endR = part.sides?.right === 'wall' ? 0 : CARCASS_T;
  // read the fillers BACK off the layout instead of re-clamping them here:
  // inner.x0 = −w/2 + filler + end panel, so the two cannot disagree
  const filL = inner.x0 + outer.w / 2 - endL;
  const filR = outer.w / 2 - inner.x1 - endR;

  if (endL > 0) {
    const x = inner.x0 - CARCASS_T / 2;
    e.box(
      'end.left',
      'carcass',
      CARCASS_T,
      body.sideH,
      depth.bodyD,
      x,
      body.y0,
      depth.zBody,
      SHELL
    );
  }
  if (endR > 0) {
    const x = inner.x1 + CARCASS_T / 2;
    e.box(
      'end.right',
      'carcass',
      CARCASS_T,
      body.sideH,
      depth.bodyD,
      x,
      body.y0,
      depth.zBody,
      SHELL
    );
  }
  // a filler closes the gap to the wall AT THE FRONT plane, where it shows;
  // a zero-width one is dropped by the emitter's own guard
  const fy = body.y0;
  e.box(
    'filler.left',
    'panel',
    filL,
    body.sideH,
    FRONT_T,
    -outer.w / 2 + filL / 2,
    fy,
    depth.zFrontFace
  );
  e.box(
    'filler.right',
    'panel',
    filR,
    body.sideH,
    FRONT_T,
    outer.w / 2 - filR / 2,
    fy,
    depth.zFrontFace
  );

  const bd = depth.bodyD;
  e.box('carcass.bottom', 'carcass', inner.w, CARCASS_T, bd, cx, body.y0, depth.zBody, SHELL);
  if (part.top === 'panel') {
    e.box('carcass.top', 'carcass', inner.w, CARCASS_T, bd, cx, body.y1, depth.zBody, SHELL);
  }
  if (part.back) {
    const zb = depth.zBody - bd / 2 + BACK_T / 2;
    e.box(
      'carcass.back',
      'carcass',
      inner.w,
      body.divH,
      BACK_T,
      cx,
      body.y0 + CARCASS_T,
      zb,
      SHELL
    );
  }
  for (let i = 1; i < lay.columns.length; i++) {
    const x = lay.columns[i - 1].x1 + CARCASS_T / 2;
    e.box(
      `div.${i}`,
      'divider',
      CARCASS_T,
      body.divH,
      bd,
      x,
      body.y0 + CARCASS_T,
      depth.zBody,
      SHELL
    );
  }
}

/** Plinth, cornice and the shelf under a top-box row. */
function trimPanels(e: Emit, lay: WardrobeLayout): void {
  const { inner, depth, outer } = lay;
  const cx = (inner.x0 + inner.x1) / 2;
  if (lay.plinth) {
    // the same toe recess cabinetPanels gives its plinth
    const h = lay.plinth.y1 - lay.plinth.y0;
    e.box(
      'plinth',
      'plinth',
      outer.w - 0.06,
      h,
      depth.bodyD - 0.05,
      0,
      lay.plinth.y0,
      depth.zBody - 0.02,
      { slot: 'plinth' }
    );
  }
  if (lay.cornice) {
    // full depth: with `top: 'ceiling'` the cornice IS the infill to the slab
    const h = lay.cornice.y1 - lay.cornice.y0;
    e.box('cornice', 'panel', outer.w, h, outer.d, 0, lay.cornice.y0, 0);
  }
  if (lay.topRow) {
    // role 'divider', not 'shelf': it is a fixed carcass board, and the
    // shelf-light rule below counts INTERIOR shelves only
    const y = lay.topRow.y0 - CARCASS_T;
    e.box('toprow.shelf', 'divider', inner.w, CARCASS_T, depth.bodyD, cx, y, depth.zBody, SHELL);
  }
}

/** One column: its section separators, then each section's own fill. */
function columnPanels(e: Emit, lay: WardrobeLayout, col: WardrobeLayoutColumn, led: boolean): void {
  const cavW = col.x1 - col.x0;
  const cavX = (col.x0 + col.x1) / 2;
  for (let i = 1; i < col.sections.length; i++) {
    const y = col.sections[i - 1].y1;
    e.box(
      `${col.id}.div${i}`,
      'divider',
      cavW,
      CARCASS_T,
      lay.depth.bodyD,
      cavX,
      y,
      lay.depth.zBody,
      SHELL
    );
  }
  for (const sec of col.sections) sectionPanels(e, lay, col, sec, led);
}

function sectionPanels(
  e: Emit,
  lay: WardrobeLayout,
  col: WardrobeLayoutColumn,
  sec: WardrobeLayoutSection,
  led: boolean
): void {
  const sid = `${col.id}-${sec.index}`;
  const secH = sec.y1 - sec.y0;
  const cavW = col.x1 - col.x0;
  const cavX = (col.x0 + col.x1) / 2;
  // rebuild the def-shaped section from the LAYOUT entry: sectionInterior is
  // the single parametric bridge and must not be handed a second reading of
  // the part's own arrays
  const def: WardrobeSection = { kind: sec.kind, h: secH };
  if (sec.count !== undefined) def.count = sec.count;
  if (sec.exposed) def.exposed = true;
  if (sec.interior) def.interior = sec.interior;
  const els = resolveInterior(sectionInterior(def, secH), secH);
  interiorPanels(e, lay, sid, cavX, cavW, sec, els, led);
  // the fills sectionInterior deliberately leaves to the generator
  if (sec.kind === 'seat') seatPanels(e, lay, sid, cavX, cavW, sec);
  else if (sec.kind === 'shoes') shoePanels(e, lay, sid, cavX, cavW, sec);
  else if (sec.kind === 'drawers' && sec.exposed) exposedDrawers(e, lay, sid, col, sec);
}

/** Resolved interior elements, in the SECTION's frame (`e.y` is measured from
 * the cavity bottom, every panel from the floor). */
function interiorPanels(
  e: Emit,
  lay: WardrobeLayout,
  sid: string,
  cavX: number,
  cavW: number,
  sec: WardrobeLayoutSection,
  els: InteriorElement[],
  led: boolean
): void {
  const { depth } = lay;
  // a pull-down lift replaces the column's TOPMOST rail, not every one
  let lastRail = -1;
  for (let i = 0; i < els.length; i++) if (els[i].kind === 'rail') lastRail = i;
  let ri = 0;
  let si = 0;
  let bi = 0;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.kind === 'rail') {
      const pull = sec.pullDown === true && i === lastRail;
      const rest: Partial<Panel> = pull ? { ...ROD, bought: 'Pull-down rail' } : ROD;
      const id = pull ? `${sid}.pulldown` : `${sid}.rail${ri++}`;
      e.rod(id, 'rail', RAIL_DIA, cavW, cavX, sec.y0 + el.y - RAIL_DIA / 2, depth.zCav, rest);
    } else if (el.kind === 'shelf') {
      const id = `${sid}.shelf${si++}`;
      const sd = depth.cavD - 0.01;
      const sy = sec.y0 + el.y - CARCASS_T / 2;
      e.box(id, 'shelf', cavW, CARCASS_T, sd, cavX, sy, depth.zCav, ACCENT);
      if (led) {
        const z = depth.zCav + sd / 2 - LIGHT_D / 2 - 0.005;
        e.box(`${id}.led`, 'light', cavW - 0.02, LIGHT_H, LIGHT_D, cavX, sy - LIGHT_H - 0.002, z, {
          bought: 'LED strip',
        });
      }
    } else {
      const id = `${sid}.ib${bi++}`;
      const dims = drawerBoxPanels(
        e.out,
        id,
        id,
        cavX,
        cavW,
        sec.y0 + el.y,
        el.h,
        depth.cavD,
        depth.zBodyFront,
        AT,
        0
      );
      if (dims) {
        // an internal drawer carries its own small front board
        const z = depth.zBodyFront - GAP - FRONT_T / 2;
        e.box(
          `${id}.front`,
          'drawerBox',
          dims.boxW,
          el.h + 0.02,
          FRONT_T,
          cavX,
          sec.y0 + el.y - 0.01,
          z,
          { ...ACCENT, motion: { unit: id, kind: 'slide', travel: dims.travel } }
        );
      }
    }
  }
}

/** A drawer bank that sits OUTSIDE the column door: real fronts on the front
 * plane, each pulling a real box. */
function exposedDrawers(
  e: Emit,
  lay: WardrobeLayout,
  sid: string,
  col: WardrobeLayoutColumn,
  sec: WardrobeLayoutSection
): void {
  const { depth } = lay;
  const n = Math.max(1, sec.count ?? 1);
  const fh = (sec.y1 - sec.y0 - GAP * (n + 1)) / n;
  if (fh <= 0) return;
  const fw = col.fx1 - col.fx0 - GAP * 2;
  const fxc = (col.fx0 + col.fx1) / 2;
  const cavW = col.x1 - col.x0;
  const cavX = (col.x0 + col.x1) / 2;
  for (let k = 0; k < n; k++) {
    const fy = sec.y0 + GAP + k * (fh + GAP);
    const unit = `${sid}.front${k}`;
    const boxH = Math.max(0.05, fh - 0.03);
    const dims = drawerBoxPanels(
      e.out,
      `${sid}.dbox${k}`,
      unit,
      cavX,
      cavW,
      fy + 0.01,
      boxH,
      depth.cavD,
      depth.zBodyFront,
      AT,
      0
    );
    e.box(unit, 'front', fw, fh, FRONT_T, fxc, fy, depth.zFrontFace, {
      groove: 'top',
      motion: { unit, kind: 'slide', travel: dims?.travel ?? depth.cavD * 0.9 },
    });
  }
}

/** Bench, cushion and the coat-hook rail of a seat niche. */
function seatPanels(
  e: Emit,
  lay: WardrobeLayout,
  sid: string,
  cavX: number,
  cavW: number,
  sec: WardrobeLayoutSection
): void {
  const { depth } = lay;
  const benchY = sec.y0 + SEAT_H;
  e.box(
    `${sid}.bench`,
    'shelf',
    cavW,
    CARCASS_T,
    depth.cavD - 0.01,
    cavX,
    benchY,
    depth.zCav,
    ACCENT
  );
  e.box(
    `${sid}.cushion`,
    'board',
    cavW - 0.02,
    CUSHION_T,
    depth.cavD - 0.04,
    cavX,
    benchY + CARCASS_T,
    depth.zCav,
    { slot: 'accent', finish: 'matte', tint: 1.1 }
  );
  // hooks hang at a fixed height above the FLOOR, so a niche high up the run
  // (or a short one) has nowhere legal to put them and simply gets none
  const lo = SEAT_H + CARCASS_T + 0.3;
  const hi = sec.y1 - sec.y0 - 0.15;
  if (hi < lo) return;
  const hookY = clamp(HOOK_RAIL_FLOOR_Y - sec.y0, lo, hi);
  const z = depth.zCav - depth.cavD / 2 + 0.06;
  e.rod(`${sid}.hookrail`, 'rail', RAIL_DIA, cavW, cavX, sec.y0 + hookY - RAIL_DIA / 2, z, ROD);
}

/** Shoe shelves: level boards on an even pitch, shallower than the column and
 * pushed to the BACK (the slant of a real shoe rack is cosmetic — not modelled,
 * because a cut list would have to cut it). */
function shoePanels(
  e: Emit,
  lay: WardrobeLayout,
  sid: string,
  cavX: number,
  cavW: number,
  sec: WardrobeLayoutSection
): void {
  const { depth } = lay;
  const n = Math.max(1, sec.count ?? 1);
  const secH = sec.y1 - sec.y0;
  const sd = depth.cavD * SHOE_DEPTH_F;
  const z = depth.zCav - (depth.cavD - sd) / 2;
  for (let k = 0; k < n; k++) {
    const y = sec.y0 + ((k + 1) * secH) / (n + 1) - CARCASS_T / 2;
    e.box(`${sid}.shoe${k}`, 'shelf', cavW, CARCASS_T, sd, cavX, y, z, ACCENT);
  }
}

/** The whole front system: hinged leaves, top-box doors, sliding panels. */
function frontPanels(e: Emit, part: WardrobePartDef, lay: WardrobeLayout): void {
  const mirrored =
    (lay.front.kind === 'hinged' && part.mirror === true) ||
    (lay.front.kind === 'sliding' && lay.front.mirror);
  const slot: Panel['slot'] = mirrored ? 'mirror' : 'front';
  for (const col of lay.columns) hingedLeaves(e, lay, col, slot);
  topRowDoors(e, lay, slot);
  slidingPanels(e, lay, slot);
}

function hingedLeaves(
  e: Emit,
  lay: WardrobeLayout,
  col: WardrobeLayoutColumn,
  slot: Panel['slot']
): void {
  const z = lay.depth.zFrontFace;
  for (const run of col.doors) {
    const fw = run.x1 - run.x0;
    const fxc = (run.x0 + run.x1) / 2;
    const h = run.y1 - run.y0 - GAP;
    const y = run.y0 + GAP / 2;
    if (run.pair) {
      let i = 0;
      splitFronts(fw, 2, (dx, lw) => {
        // a pair hinges on its OUTER edges, exactly like a cabinet doorPair
        const unit = `${run.unit}.${i}`;
        const side: 'left' | 'right' = i === 0 ? 'left' : 'right';
        i++;
        e.box(unit, 'front', lw, h, FRONT_T, fxc + dx, y, z, {
          slot,
          groove: 'top',
          motion: { unit, kind: 'hinge', side },
        });
      });
    } else {
      e.box(run.unit, 'front', fw - GAP * 2, h, FRONT_T, fxc, y, z, {
        slot,
        groove: 'top',
        motion: { unit: run.unit, kind: 'hinge', side: run.side },
      });
    }
  }
}

/** One door per column over the top-box row — sliding panels stop under it, so
 * this is the only thing that ever closes those boxes. */
function topRowDoors(e: Emit, lay: WardrobeLayout, slot: Panel['slot']): void {
  const row = lay.topRow;
  if (!row?.doors) return;
  const last = lay.columns.length - 1;
  for (const col of lay.columns) {
    const unit = `toprow.${col.index}.door`;
    const side: 'left' | 'right' = col.index === last ? 'right' : 'left';
    // overhead: the finger groove goes underneath, cabinetPanels' wall-hung rule
    e.box(
      unit,
      'front',
      col.fx1 - col.fx0 - GAP * 2,
      row.y1 - row.y0 - GAP,
      FRONT_T,
      (col.fx0 + col.fx1) / 2,
      row.y0 + GAP / 2,
      lay.depth.zFrontFace,
      { slot, groove: 'bottom', motion: { unit, kind: 'hinge', side } }
    );
  }
}

function slidingPanels(e: Emit, lay: WardrobeLayout, slot: Panel['slot']): void {
  const f = lay.front;
  if (f.kind !== 'sliding') return;
  f.panels.forEach((p, k) => {
    const unit = `slide${k}`;
    // no groove: a sliding panel is grabbed by its edge, not a routed lip
    e.box(
      unit,
      'front',
      p.x1 - p.x0,
      p.y1 - p.y0 - GAP,
      FRONT_T,
      (p.x0 + p.x1) / 2,
      p.y0 + GAP / 2,
      p.layer === 0 ? f.zInner : f.zOuter,
      { slot, motion: { unit, kind: 'slide', axis: 'x', travel: p.travel, dir: p.dir } }
    );
  });
  const track: Partial<Panel> = { bought: 'Sliding door track set' };
  const z = lay.outer.d / 2 - SLIDING_TRACK_D / 2;
  e.box('track.bottom', 'frame', lay.outer.w, TRACK_T, SLIDING_TRACK_D, 0, 0, z, track);
  e.box('track.top', 'frame', lay.outer.w, TRACK_T, SLIDING_TRACK_D, 0, f.y1, z, track);
}

/* ---------------- plan symbol ---------------- */

export interface WardrobePlanSymbol {
  /** internal column boundaries, item-local metres across the given width */
  ticks: number[];
  /** one entry per hinged LEAF — a pair emits two, hinged on opposite edges */
  doors: { x0: number; x1: number; hinge: 'left' | 'right' }[];
  /** sliding panel spans, with the track lane they ride */
  slides: { x0: number; x1: number; layer: 0 | 1 }[];
  /** the run carries no front at all (walk-in shelving) */
  open: boolean;
}

/**
 * What the plan draws for a wardrobe, derived from `wardrobeLayout` at the
 * PLACED item's width and depth — never from the part's own w/d, which an
 * instance overrides.
 */
export function wardrobePlanSymbol(
  part: WardrobePartDef,
  w: number,
  d: number
): WardrobePlanSymbol {
  const lay = wardrobeLayout(part, { w, d, h: num(part.h, 2), elevation: num(part.elevation, 0) });
  const ticks: number[] = [];
  for (let i = 1; i < lay.columns.length; i++) {
    ticks.push(lay.columns[i - 1].x1 + CARCASS_T / 2);
  }
  // ONE entry per COLUMN, not per door run: two runs split by an exposed
  // drawer bank project onto exactly the same plan span, and a second arc
  // there would only double the ink
  const doors: WardrobePlanSymbol['doors'] = [];
  for (const col of lay.columns) {
    if (col.doors.length === 0) continue;
    if (col.door === 'pair') {
      const mid = (col.fx0 + col.fx1) / 2;
      doors.push({ x0: col.fx0, x1: mid, hinge: 'left' }, { x0: mid, x1: col.fx1, hinge: 'right' });
    } else {
      doors.push({ x0: col.fx0, x1: col.fx1, hinge: col.door === 'right' ? 'right' : 'left' });
    }
  }
  const slides =
    lay.front.kind === 'sliding'
      ? lay.front.panels.map((p) => ({ x0: p.x0, x1: p.x1, layer: p.layer }))
      : [];
  return { ticks, doors, slides, open: lay.front.kind === 'none' };
}
