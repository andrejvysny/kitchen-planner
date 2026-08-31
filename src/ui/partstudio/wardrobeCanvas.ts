import { clamp, fmtCm } from '../../model/geometry';
import { resolveInterior } from '../../model/interior';
import type { Cavity, PartDims } from '../../model/panels';
import { unitPrefs } from '../../model/prefs';
import type {
  Interior,
  InteriorElement,
  WardrobeColumn,
  WardrobePartDef,
  WardrobeSection,
  WardrobeSectionKind,
} from '../../model/types';
import { uid } from '../../model/types';
import { formatLength, parseLength } from '../../model/units';
import {
  COL_MAX_W,
  COL_MIN_W,
  HOOK_RAIL_FLOOR_Y,
  MAX_COLUMNS,
  MAX_SECTIONS,
  SEAT_H,
  SEC_MAX_H,
  SEC_MIN_H,
  sanitizeWardrobeFields,
  sectionInterior,
  wardrobeLayout,
  wardrobeSectionCavity,
  type WardrobeLayout,
  type WardrobeLayoutColumn,
  type WardrobeLayoutSection,
} from '../../model/wardrobe';
import { drawHingeTick } from '../../plan2d/hingeTick';
import { promptValue } from '../dialogService';
import { numRow, stepperRow, toggleRow } from './controls';
import {
  ACCENT,
  fillFooterCaption,
  INK,
  InteriorEditor,
  SOFT,
  type BtnFactory,
  type CustomElements,
  type InteriorHost,
  type PointerCtx,
} from './interiorEditor';

/* ---------------- vocabulary ---------------- */

/** Canvas label + popover glyph for every section kind, in tile order. */
const KINDS: Record<WardrobeSectionKind, { glyph: string; label: string }> = {
  hanging: { glyph: '━', label: 'Hanging' },
  hangingDouble: { glyph: '═', label: 'Double hanging' },
  shelves: { glyph: '☰', label: 'Shelves' },
  drawers: { glyph: '▤', label: 'Drawers' },
  open: { glyph: '□', label: 'Open' },
  seat: { glyph: '▁', label: 'Seat' },
  shoes: { glyph: '◺', label: 'Shoes' },
  custom: { glyph: '✎', label: 'Custom' },
};

const KIND_ORDER: WardrobeSectionKind[] = [
  'hanging',
  'hangingDouble',
  'shelves',
  'drawers',
  'open',
  'seat',
  'shoes',
  'custom',
];

/** Kinds that may sit OUTSIDE the column door — mirrors wardrobe.ts EXPOSABLE. */
const EXPOSABLE: WardrobeSectionKind[] = ['drawers', 'open', 'seat', 'shelves'];

const DOOR_CYCLE: WardrobeColumn['door'][] = ['auto', 'none', 'left', 'right', 'pair'];
const DOOR_CHIP: Record<WardrobeColumn['door'], string> = {
  auto: 'auto',
  none: 'none',
  left: '◧',
  right: '◨',
  pair: '◫',
};

/**
 * The stepper's bounds for a counted kind. These MIRROR wardrobe.ts's private
 * `COUNTS` table (and its tighter cap on a drawer stack behind a door): the
 * sanitizer is the authority and clamps whatever arrives, so this only stops
 * the ＋ button offering a number that would visibly snap back.
 */
function countRange(sec: WardrobeSection): { lo: number; hi: number } | null {
  if (sec.kind === 'shelves') return { lo: 1, hi: 6 };
  if (sec.kind === 'shoes') return { lo: 1, hi: 8 };
  if (sec.kind === 'drawers') return { lo: 1, hi: sec.exposed ? 8 : 4 };
  return null;
}

/* ---------------- view + selection ---------------- */

/** Header band (column ⊕/✕ + width labels) and chip band (door chips), in px. */
const HEADER_H = 22;
const CHIP_H = 26;
const FOOTER_H = 24;
const DISC_R = 9;
/** divider grab tolerance, canvas px (the world tolerance is this / scale) */
const DIV_TOL = 6;

interface View {
  lay: WardrobeLayout;
  scale: number;
  /** screen x of the run's left edge, screen y of the floor line */
  ox: number;
  oy: number;
  cw: number;
  ch: number;
}

type Sel =
  | { kind: 'section'; c: number; s: number }
  | { kind: 'column'; c: number }
  | { kind: 'colDiv'; i: number }
  | { kind: 'secDiv'; c: number; s: number };

type Hit =
  | { t: 'colAdd'; at: number }
  | { t: 'colDel'; c: number }
  | { t: 'secAdd'; c: number; at: number }
  | { t: 'chip'; c: number }
  | { t: 'colDiv'; i: number }
  | { t: 'secDiv'; c: number; s: number }
  | { t: 'section'; c: number; s: number }
  | { t: 'colHead'; c: number };

interface Pt {
  x: number;
  y: number;
}

/**
 * Front-elevation editor for a fitted wardrobe: a run of columns, each a stack
 * of typed sections, edited by direct manipulation.
 *
 * Every rectangle it draws and hit-tests comes from `wardrobeLayout` — the same
 * single layout source the panel generator, the plan symbol and the elevation
 * drawing consume — so the canvas is what gets built, by construction. Nothing
 * here recomputes a width, a height or a door run.
 *
 * The state is INDICES ONLY (`Sel`, `drill`), never a column or a section
 * object: every write goes through `store.updateCustomPart`, whose
 * `sanitizePart` repairs the part in place and may replace what it holds, so a
 * handler that captured a section would be editing an orphan from its second
 * click on. `liveCol`/`liveSec` re-resolve on every call (the `live()` rule).
 */
export class WardrobeCanvas {
  private part: WardrobePartDef;
  private root: HTMLElement;
  private toolbar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private onChange: (transient?: boolean) => void;

  private sel: Sel | null = null;
  private hover: Pt | null = null;
  /** what the last redraw's hover offered — see `onMove` */
  private hoverSig = '';
  private drag: { kind: 'colDiv'; i: number } | { kind: 'secDiv'; c: number; s: number } | null =
    null;

  /** the open kind/size popover, and which section it edits */
  private pop: HTMLElement | null = null;
  private popSel: { c: number; s: number } | null = null;
  private readonly onDocDown: (e: PointerEvent) => void;

  /** section being edited in the shared interior drill-in (null = column view) */
  private drill: { c: number; s: number } | null = null;
  private interior: InteriorEditor | null = null;

  constructor(
    container: HTMLElement,
    part: WardrobePartDef,
    onChange: (transient?: boolean) => void
  ) {
    this.part = part;
    this.onChange = onChange;

    this.root = document.createElement('div');
    this.root.className = 'studio-wardrobe';
    container.appendChild(this.root);

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'zone-toolbar';
    this.root.appendChild(this.toolbar);

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'studio-wardrobe-canvas';
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.hoverSig = '';
      this.draw();
    });
    this.canvas.addEventListener('dblclick', (e) => void this.onDblClick(e));

    // The popover is the app's first floating layer, and it is NOT a dialog:
    // anything pressed outside it dismisses it. Capture phase, so the press
    // that dismisses still reaches whatever it landed on.
    this.onDocDown = (e: PointerEvent) => {
      if (!this.pop) return;
      if (e.target instanceof Node && this.pop.contains(e.target)) return;
      this.closePopover();
    };
    document.addEventListener('pointerdown', this.onDocDown, true);

    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.root);
    this.renderToolbar();
    this.draw();
  }

  dispose(): void {
    this.ro.disconnect();
    document.removeEventListener('pointerdown', this.onDocDown, true);
    this.closePopover();
    this.root.remove();
  }

  /* ---------------- live resolution ---------------- */

  private liveCol(c: number): WardrobeColumn | null {
    return this.part.columns[c] ?? null;
  }

  private liveSec(c: number, s: number): WardrobeSection | null {
    return this.liveCol(c)?.sections[s] ?? null;
  }

  private dims(): PartDims {
    const p = this.part;
    return { w: p.w, d: p.d, h: p.h, elevation: p.elevation };
  }

  /** Settled edit; `transient` is a mid-gesture tick that takes no undo step. */
  private changed(transient?: boolean): void {
    if (!transient) this.renderToolbar();
    this.onChange(transient);
    this.draw();
  }

  /* ---------------- structural edits ---------------- */

  private addColumn(at: number): void {
    const cols = this.part.columns;
    if (cols.length >= MAX_COLUMNS) return;
    cols.splice(at, 0, {
      id: uid('col'),
      w: 0.5,
      sections: [{ kind: 'shelves', h: 'fill', count: 3 }],
      door: 'auto',
    });
    this.sel = { kind: 'column', c: at };
    sanitizeWardrobeFields(this.part);
    this.changed();
  }

  private deleteColumn(c: number): boolean {
    if (this.part.columns.length <= 1 || !this.liveCol(c)) return false;
    this.part.columns.splice(c, 1);
    this.sel = null;
    this.closePopover();
    sanitizeWardrobeFields(this.part);
    this.changed();
    return true;
  }

  private addSection(c: number, at: number): void {
    const col = this.liveCol(c);
    if (!col || col.sections.length >= MAX_SECTIONS) return;
    col.sections.splice(at, 0, { kind: 'shelves', h: 0.4, count: 3 });
    this.sel = { kind: 'section', c, s: at };
    sanitizeWardrobeFields(this.part);
    this.changed();
  }

  private deleteSection(c: number, s: number): boolean {
    const col = this.liveCol(c);
    if (!col || col.sections.length <= 1 || !col.sections[s]) return false;
    col.sections.splice(s, 1);
    this.sel = null;
    this.closePopover();
    sanitizeWardrobeFields(this.part);
    this.changed();
    return true;
  }

  private cycleDoor(c: number, back: boolean): void {
    const col = this.liveCol(c);
    if (!col) return;
    const i = Math.max(0, DOOR_CYCLE.indexOf(col.door));
    const n = DOOR_CYCLE.length;
    col.door = DOOR_CYCLE[(i + (back ? n - 1 : 1)) % n];
    this.changed();
  }

  /* ---------------- keys ---------------- */

  handleEscape(): boolean {
    if (this.interior) return this.interior.handleEscape();
    if (this.pop) {
      this.closePopover();
      return true;
    }
    if (this.sel) {
      this.sel = null;
      this.renderToolbar();
      this.draw();
      return true;
    }
    return false;
  }

  handleDelete(): boolean {
    if (this.interior) return this.interior.handleDelete();
    const sel = this.sel;
    if (sel?.kind === 'section') return this.deleteSection(sel.c, sel.s);
    if (sel?.kind === 'column') return this.deleteColumn(sel.c);
    return false;
  }

  private canDelete(): boolean {
    const sel = this.sel;
    if (sel?.kind === 'section') return (this.liveCol(sel.c)?.sections.length ?? 0) > 1;
    if (sel?.kind === 'column') return this.part.columns.length > 1;
    return false;
  }

  /* ---------------- toolbar ---------------- */

  private renderToolbar(): void {
    const tb = this.toolbar;
    tb.innerHTML = '';
    const btn: BtnFactory = (label, title, fn, disabled = false, active = false) => {
      const b = document.createElement('button');
      b.className = `btn choice-btn${active ? ' active' : ''}`;
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      tb.appendChild(b);
      return b;
    };
    if (this.interior) {
      this.interior.renderToolbar(tb, btn);
      return;
    }
    // the ⊕/✕ discs are the direct route, but they only appear on hover —
    // these two make the same edits reachable without discovering them
    btn(
      '＋ Column',
      'Add a column at the end of the run',
      () => this.addColumn(this.part.columns.length),
      this.part.columns.length >= MAX_COLUMNS
    );
    btn(
      'Delete',
      'Remove the selected column or section (Delete)',
      () => {
        this.handleDelete();
      },
      !this.canDelete()
    );
    const hint = document.createElement('span');
    hint.className = 'studio-caption';
    hint.textContent = this.selectionCaption();
    tb.appendChild(hint);
  }

  private selectionCaption(): string {
    const sel = this.sel;
    if (!sel) return 'click a section to change what is in it';
    if (sel.kind === 'colDiv') return 'column edge — drag to resize, double-click to type a width';
    if (sel.kind === 'secDiv')
      return 'section edge — drag to resize, double-click to type a height';
    if (sel.kind === 'column') return `column ${sel.c + 1} of ${this.part.columns.length}`;
    const sec = this.liveSec(sel.c, sel.s);
    return sec ? `${KINDS[sec.kind].label.toLowerCase()} section` : '';
  }

  /* ---------------- geometry ---------------- */

  private view(): View {
    const lay = wardrobeLayout(this.part, this.dims());
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    const availH = Math.max(40, ch - HEADER_H - CHIP_H - FOOTER_H);
    const scale = Math.min(
      (cw * 0.78) / Math.max(lay.outer.w, 0.01),
      (availH * 0.94) / Math.max(lay.outer.h, 0.01)
    );
    return {
      lay,
      scale,
      ox: (cw - lay.outer.w * scale) / 2,
      oy: HEADER_H + (availH + lay.outer.h * scale) / 2,
      cw,
      ch,
    };
  }

  /** item-local x (metres, centred) → canvas px */
  private sx(v: View, x: number): number {
    return v.ox + (x + v.lay.outer.w / 2) * v.scale;
  }

  /** height above the floor (metres) → canvas px */
  private sy(v: View, y: number): number {
    return v.oy - y * v.scale;
  }

  private wx(v: View, px: number): number {
    return (px - v.ox) / v.scale - v.lay.outer.w / 2;
  }

  private wy(v: View, py: number): number {
    return (v.oy - py) / v.scale;
  }

  private at(e: { clientX: number; clientY: number }): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private secRect(
    v: View,
    col: WardrobeLayoutColumn,
    sec: WardrobeLayoutSection
  ): { x: number; y: number; w: number; h: number } {
    return {
      x: this.sx(v, col.x0),
      y: this.sy(v, sec.y1),
      w: (col.x1 - col.x0) * v.scale,
      h: (sec.y1 - sec.y0) * v.scale,
    };
  }

  /** The n+1 places a new column can be inserted, in canvas px. */
  private colAnchors(v: View): number[] {
    const cols = v.lay.columns;
    if (!cols.length) return [this.sx(v, 0)];
    const out = [this.sx(v, cols[0].x0)];
    for (let i = 0; i < cols.length - 1; i++) out.push(this.colDivX(v, i));
    out.push(this.sx(v, cols[cols.length - 1].x1));
    return out;
  }

  /** Centre of the divider board between columns i and i+1, in canvas px. */
  private colDivX(v: View, i: number): number {
    const cols = v.lay.columns;
    return (this.sx(v, cols[i].x1) + this.sx(v, cols[i + 1].x0)) / 2;
  }

  private secDivY(v: View, col: WardrobeLayoutColumn, s: number): number {
    return (this.sy(v, col.sections[s].y1) + this.sy(v, col.sections[s + 1].y0)) / 2;
  }

  /** Which column a canvas x falls in — the full width, boundaries split. */
  private columnAt(v: View, px: number): number | null {
    const cols = v.lay.columns;
    for (let i = 0; i < cols.length; i++) {
      const lo = i === 0 ? this.sx(v, cols[i].fx0) : this.colDivX(v, i - 1);
      const hi = i === cols.length - 1 ? this.sx(v, cols[i].fx1) : this.colDivX(v, i);
      if (px >= lo && px <= hi) return i;
    }
    return null;
  }

  private sectionAt(v: View, c: number, py: number): number | null {
    const secs = v.lay.columns[c]?.sections ?? [];
    for (let i = 0; i < secs.length; i++) {
      if (py <= this.sy(v, secs[i].y0) && py >= this.sy(v, secs[i].y1)) return i;
    }
    return null;
  }

  /**
   * What the header band offers under the pointer. Exactly ONE affordance at a
   * time: near a boundary it is the insert ⊕, otherwise the hovered column's
   * ✕ — two discs fighting over the same 12 px is how a click deletes the
   * column the user meant to split.
   */
  private headerHover(v: View, p: Pt): Hit | null {
    const top = this.sy(v, v.lay.outer.h);
    if (p.y < top - HEADER_H || p.y >= top) return null;
    if (v.lay.columns.length < MAX_COLUMNS) {
      const anchors = this.colAnchors(v);
      let best = -1;
      let bd = DISC_R + 3;
      anchors.forEach((x, i) => {
        const d = Math.abs(p.x - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) return { t: 'colAdd', at: best };
    }
    const c = this.columnAt(v, p.x);
    if (c === null) return null;
    if (this.part.columns.length > 1) {
      const cx = this.sx(v, v.lay.columns[c].x1) - DISC_R - 3;
      if (Math.abs(p.x - cx) <= DISC_R) return { t: 'colDel', c };
    }
    return { t: 'colHead', c };
  }

  /** The two section-insert discs of the hovered column, in canvas px. */
  private secAddDiscs(v: View, c: number): { at: number; x: number; y: number }[] {
    const col = v.lay.columns[c];
    if (!col || !col.sections.length || col.sections.length >= MAX_SECTIONS) return [];
    const cx = (this.sx(v, col.x0) + this.sx(v, col.x1)) / 2;
    const first = col.sections[0];
    const last = col.sections[col.sections.length - 1];
    return [
      { at: 0, x: cx, y: this.sy(v, first.y0) - DISC_R - 4 },
      { at: col.sections.length, x: cx, y: this.sy(v, last.y1) + DISC_R + 4 },
    ];
  }

  private chipRect(v: View, c: number): { x: number; y: number; w: number; h: number } | null {
    if (this.part.front.kind !== 'hinged') return null;
    const col = v.lay.columns[c];
    if (!col) return null;
    const w = Math.min(54, Math.max(24, (col.x1 - col.x0) * v.scale - 6));
    const cx = (this.sx(v, col.x0) + this.sx(v, col.x1)) / 2;
    return { x: cx - w / 2, y: v.oy + 4, w, h: CHIP_H - 8 };
  }

  private hitTest(v: View, p: Pt): Hit | null {
    const header = this.headerHover(v, p);
    if (header && header.t !== 'colHead') return header;

    const cols = v.lay.columns;
    const hoveredCol = this.columnAt(v, p.x);

    if (hoveredCol !== null) {
      for (const disc of this.secAddDiscs(v, hoveredCol)) {
        if (Math.hypot(p.x - disc.x, p.y - disc.y) <= DISC_R) {
          return { t: 'secAdd', c: hoveredCol, at: disc.at };
        }
      }
      const chip = this.chipRect(v, hoveredCol);
      if (
        chip &&
        p.x >= chip.x &&
        p.x <= chip.x + chip.w &&
        p.y >= chip.y &&
        p.y <= chip.y + chip.h
      )
        return { t: 'chip', c: hoveredCol };
    }

    const bodyTop = this.sy(v, v.lay.body.y1);
    const bodyBot = this.sy(v, v.lay.body.y0);
    if (p.y >= bodyTop - DIV_TOL && p.y <= bodyBot + DIV_TOL) {
      for (let i = 0; i < cols.length - 1; i++) {
        if (Math.abs(p.x - this.colDivX(v, i)) <= DIV_TOL) return { t: 'colDiv', i };
      }
    }
    if (hoveredCol !== null) {
      const col = cols[hoveredCol];
      for (let s = 0; s < col.sections.length - 1; s++) {
        if (Math.abs(p.y - this.secDivY(v, col, s)) <= DIV_TOL)
          return { t: 'secDiv', c: hoveredCol, s };
      }
      const s = this.sectionAt(v, hoveredCol, p.y);
      if (s !== null) return { t: 'section', c: hoveredCol, s };
    }
    return header;
  }

  /* ---------------- drag targets ---------------- */

  /**
   * Which column a divider drag actually resizes.
   *
   * The run has ONE fill column, and it absorbs whatever the fixed ones give
   * up — so resizing the neighbour on the fill's side would leave the divider
   * exactly where it was and the drag would do nothing visible. The neighbour
   * AWAY from the fill is the one whose edge the pointer is on.
   */
  private colDivTarget(i: number): { col: WardrobeColumn; anchor: 'left' | 'right' } | null {
    const cols = this.part.columns;
    if (!cols[i] || !cols[i + 1]) return null;
    const fillIdx = cols.findIndex((c) => c.w === 'fill');
    const useLeft = fillIdx < 0 || fillIdx > i;
    const col = useLeft ? cols[i] : cols[i + 1];
    return col.w === 'fill' ? null : { col, anchor: useLeft ? 'left' : 'right' };
  }

  private secDivTarget(
    c: number,
    s: number
  ): { sec: WardrobeSection; anchor: 'bottom' | 'top' } | null {
    const col = this.liveCol(c);
    if (!col?.sections[s] || !col.sections[s + 1]) return null;
    const fillIdx = col.sections.findIndex((x) => x.h === 'fill');
    const useLower = fillIdx < 0 || fillIdx > s;
    const sec = useLower ? col.sections[s] : col.sections[s + 1];
    return sec.h === 'fill' ? null : { sec, anchor: useLower ? 'bottom' : 'top' };
  }

  /* ---------------- pointers ---------------- */

  private pointerCtx(e: PointerEvent): PointerCtx {
    const p = this.at(e);
    return {
      x: p.x,
      y: p.y,
      cw: this.canvas.clientWidth || 400,
      ch: this.canvas.clientHeight || 400,
      setCursor: (cursor) => {
        this.canvas.style.cursor = cursor;
      },
      releaseCapture: () => {
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          /* synthetic events (tests) have no active pointer */
        }
      },
    };
  }

  private onDown(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
    }
    if (this.interior?.onDown(this.pointerCtx(e))) return;
    const v = this.view();
    const p = this.at(e);
    this.hover = p;
    const hit = this.hitTest(v, p);
    if (!hit) {
      this.sel = null;
      this.renderToolbar();
      this.draw();
      return;
    }
    switch (hit.t) {
      case 'colAdd':
        this.addColumn(hit.at);
        return;
      case 'colDel':
        this.deleteColumn(hit.c);
        return;
      case 'secAdd':
        this.addSection(hit.c, hit.at);
        return;
      case 'chip':
        this.cycleDoor(hit.c, e.shiftKey);
        return;
      case 'colDiv':
        this.sel = { kind: 'colDiv', i: hit.i };
        this.drag = { kind: 'colDiv', i: hit.i };
        break;
      case 'secDiv':
        this.sel = { kind: 'secDiv', c: hit.c, s: hit.s };
        this.drag = { kind: 'secDiv', c: hit.c, s: hit.s };
        break;
      case 'section':
        this.sel = { kind: 'section', c: hit.c, s: hit.s };
        this.openPopover(hit.c, hit.s);
        break;
      case 'colHead':
        this.sel = { kind: 'column', c: hit.c };
        break;
    }
    this.renderToolbar();
    this.draw();
  }

  private onMove(e: PointerEvent): void {
    if (this.interior?.onMove(this.pointerCtx(e))) return;
    const v = this.view();
    const p = this.at(e);
    this.hover = p;
    if (this.drag) {
      // 10 mm snapping, 1 mm with Shift — the two useful granularities for a
      // fitted run (a shelf pitch and a panel thickness)
      const step = e.shiftKey ? 0.001 : 0.01;
      const snap = (raw: number, lo: number, hi: number): number =>
        clamp(Number((Math.round(raw / step) * step).toFixed(4)), lo, hi);
      if (this.drag.kind === 'colDiv') {
        const t = this.colDivTarget(this.drag.i);
        const lc = v.lay.columns;
        if (!t) return;
        const raw =
          t.anchor === 'left'
            ? this.wx(v, p.x) - lc[this.drag.i].x0
            : lc[this.drag.i + 1].x1 - this.wx(v, p.x);
        t.col.w = snap(raw, COL_MIN_W, COL_MAX_W);
      } else {
        const { c, s } = this.drag;
        const t = this.secDivTarget(c, s);
        const secs = v.lay.columns[c]?.sections;
        if (!t || !secs) return;
        const raw =
          t.anchor === 'bottom' ? this.wy(v, p.y) - secs[s].y0 : secs[s + 1].y1 - this.wy(v, p.y);
        t.sec.h = snap(raw, SEC_MIN_H, SEC_MAX_H);
      }
      this.changed(true); // mid-drag tick; onUp commits
      return;
    }
    const hit = this.hitTest(v, p);
    this.canvas.style.cursor =
      hit?.t === 'colDiv'
        ? 'col-resize'
        : hit?.t === 'secDiv'
          ? 'row-resize'
          : hit
            ? 'pointer'
            : 'default';
    // hover only changes ⊕/✕ discs, so redraw when the OFFER changes, not on
    // every pointer move — the ⊕ of a column is the same ⊕ across its width
    const sig = `${this.columnAt(v, p.x)}|${JSON.stringify(this.headerHover(v, p))}|${JSON.stringify(hit)}`;
    if (sig !== this.hoverSig) {
      this.hoverSig = sig;
      this.draw();
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.interior?.onUp(this.pointerCtx(e))) return;
    if (!this.drag) return;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
    }
    this.drag = null;
    sanitizeWardrobeFields(this.part);
    this.changed();
  }

  private async onDblClick(e: MouseEvent): Promise<void> {
    if (this.interior) return;
    const v = this.view();
    const hit = this.hitTest(v, this.at(e));
    if (!hit) return;
    if (hit.t === 'colDiv' || hit.t === 'secDiv') {
      await this.promptDivider(hit);
      return;
    }
    if (hit.t === 'section' && this.liveSec(hit.c, hit.s)?.kind === 'custom') {
      this.enterInterior(hit.c, hit.s);
    }
  }

  /**
   * Type an exact width or height for the board under the cursor. It goes
   * through `parseLength`, so it takes the same expressions and the same unit
   * every inspector field does ('600', '0.6m', '900-18').
   */
  private async promptDivider(
    hit: { t: 'colDiv'; i: number } | { t: 'secDiv'; c: number; s: number }
  ): Promise<void> {
    const isCol = hit.t === 'colDiv';
    const target = isCol ? this.colDivTarget(hit.i) : this.secDivTarget(hit.c, hit.s);
    if (!target) return;
    const [lo, hi] = isCol ? [COL_MIN_W, COL_MAX_W] : [SEC_MIN_H, SEC_MAX_H];
    const prefs = unitPrefs();
    const answer = await promptValue({
      title: isCol ? 'Column width' : 'Section height',
      body: isCol
        ? 'The clear width of the column on this side of the board'
        : 'The clear height of the section on this side of the board',
      confirmLabel: 'Set',
      input: {
        placeholder: `e.g. 600 or 0.6m (${prefs.unit})`,
        parse: (raw) => {
          const value = parseLength(raw, prefs);
          if (value === null) return { ok: false, error: 'Not a length — try 600, 0.6m or 60cm' };
          if (value < lo || value > hi) {
            return {
              ok: false,
              error: `Between ${formatLength(lo, prefs)} and ${formatLength(hi, prefs)} ${prefs.unit}`,
            };
          }
          return { ok: true, value };
        },
      },
    });
    // the design can have been replaced while the dialog was up, and the studio
    // torn out of its host with it
    if (answer === null || !this.canvas.isConnected) return;
    const live = isCol ? this.colDivTarget(hit.i) : this.secDivTarget(hit.c, hit.s);
    if (!live) return;
    if ('col' in live) live.col.w = clamp(answer, lo, hi);
    else live.sec.h = clamp(answer, lo, hi);
    sanitizeWardrobeFields(this.part);
    this.changed();
  }

  /* ---------------- interior drill-in ---------------- */

  private drillCavity(): Cavity | null {
    if (!this.drill) return null;
    return wardrobeSectionCavity(this.part, this.dims(), this.drill.c, this.drill.s);
  }

  private drillElements(): InteriorElement[] {
    const sec = this.drill ? this.liveSec(this.drill.c, this.drill.s) : null;
    const cav = this.drillCavity();
    if (!sec || !cav) return [];
    return resolveInterior(sectionInterior(sec, cav.h), cav.h);
  }

  /**
   * A wardrobe section's interior is ALWAYS explicit: the drill-in is only
   * offered on kind 'custom', whose `interior` is stored verbatim. The seed
   * comes from `sectionInterior`, so converting a shelf stack keeps its
   * shelves rather than starting empty.
   */
  private drillEnsureCustom(): CustomElements {
    const sec = this.drill ? this.liveSec(this.drill.c, this.drill.s) : null;
    const cav = this.drillCavity();
    if (!sec || !cav) return { elements: [] };
    const cur = sec.interior;
    if (cur?.mode === 'custom') return cur;
    const custom: Extract<Interior, { mode: 'custom' }> = {
      mode: 'custom',
      elements: resolveInterior(sectionInterior(sec, cav.h), cav.h),
    };
    sec.interior = custom;
    return custom;
  }

  private interiorHost(): InteriorHost {
    return {
      cavity: () => this.drillCavity(),
      elements: () => this.drillElements(),
      ensureCustom: () => this.drillEnsureCustom(),
      customInterior: () => {
        const cur = this.drill ? this.liveSec(this.drill.c, this.drill.s)?.interior : null;
        return cur?.mode === 'custom' ? cur : null;
      },
      // no `resetToEven`: a wardrobe section reaches the drill-in only as kind
      // 'custom', which has no parametric form to reset to
      caption: () => {
        const sec = this.drill ? this.liveSec(this.drill.c, this.drill.s) : null;
        return sec ? `${KINDS[sec.kind].label.toLowerCase()} section` : '';
      },
      accentColor: () => this.part.accentColor,
      changed: (transient) => this.changed(transient),
      refresh: () => {
        this.renderToolbar();
        this.draw();
      },
      done: () => this.exitInterior(),
    };
  }

  private enterInterior(c: number, s: number): void {
    if (this.liveSec(c, s)?.kind !== 'custom') return;
    this.closePopover();
    this.drill = { c, s };
    this.interior = new InteriorEditor(this.interiorHost());
    this.renderToolbar();
    this.draw();
  }

  private exitInterior(): void {
    this.drill = null;
    this.interior = null;
    this.renderToolbar();
    this.draw();
  }

  /* ---------------- the section popover ---------------- */

  private closePopover(): void {
    this.pop?.remove();
    this.pop = null;
    this.popSel = null;
  }

  private openPopover(c: number, s: number): void {
    this.closePopover();
    if (!this.liveSec(c, s)) return;
    this.popSel = { c, s };
    const pop = document.createElement('div');
    pop.className = 'studio-wardrobe-pop';
    this.root.appendChild(pop);
    this.pop = pop;
    this.renderPopover();
    this.positionPopover();
  }

  private positionPopover(): void {
    const pop = this.pop;
    const sel = this.popSel;
    if (!pop || !sel) return;
    const v = this.view();
    const col = v.lay.columns[sel.c];
    const sec = col?.sections[sel.s];
    if (!col || !sec) return;
    const r = this.secRect(v, col, sec);
    const rootRect = this.root.getBoundingClientRect();
    const canRect = this.canvas.getBoundingClientRect();
    const dx = canRect.left - rootRect.left;
    const dy = canRect.top - rootRect.top;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const maxX = Math.max(6, this.root.clientWidth - pw - 6);
    const maxY = Math.max(6, this.root.clientHeight - ph - 6);
    let x = dx + r.x + r.w + 8;
    if (x > maxX) x = dx + r.x - pw - 8;
    pop.style.left = `${clamp(x, 6, maxX)}px`;
    pop.style.top = `${clamp(dy + r.y - 6, 6, maxY)}px`;
  }

  /** Rebuild the popover from the LIVE section — a kind change reshapes it. */
  private renderPopover(): void {
    const pop = this.pop;
    const sel = this.popSel;
    if (!pop || !sel) return;
    const sec = this.liveSec(sel.c, sel.s);
    const col = this.liveCol(sel.c);
    if (!sec || !col) {
      this.closePopover();
      return;
    }
    pop.innerHTML = '';

    const kinds = document.createElement('div');
    kinds.className = 'studio-wardrobe-kinds';
    for (const kind of KIND_ORDER) {
      const b = document.createElement('button');
      b.className = `btn choice-btn studio-wardrobe-kind${sec.kind === kind ? ' active' : ''}`;
      b.dataset.kind = kind;
      // the Custom tile leads somewhere (the drill-in), so it keeps its ellipsis
      b.textContent = `${KINDS[kind].glyph} ${KINDS[kind].label}${kind === 'custom' ? '…' : ''}`;
      b.addEventListener('click', () => this.setKind(sel.c, sel.s, kind));
      kinds.appendChild(b);
    }
    pop.appendChild(kinds);

    const range = countRange(sec);
    if (range) {
      stepperRow(
        pop,
        sec.kind === 'shelves' ? 'Shelves' : sec.kind === 'drawers' ? 'Drawers' : 'Pairs',
        () => this.liveSec(sel.c, sel.s)?.count ?? range.lo,
        (v) => {
          const live = this.liveSec(sel.c, sel.s);
          if (!live) return;
          live.count = v;
          this.changed();
        },
        range.lo,
        range.hi
      );
    }

    if (this.part.front.kind === 'hinged' && EXPOSABLE.includes(sec.kind)) {
      toggleRow(
        pop,
        'Outside the door',
        () => this.liveSec(sel.c, sel.s)?.exposed === true,
        (on) => {
          const live = this.liveSec(sel.c, sel.s);
          if (!live) return;
          if (on) live.exposed = true;
          else delete live.exposed;
          this.changed();
          this.renderPopover();
        }
      );
    }

    if (sec.kind === 'hanging' || sec.kind === 'hangingDouble') {
      toggleRow(
        pop,
        'Pull-down rail',
        () => this.liveSec(sel.c, sel.s)?.pullDown === true,
        (on) => {
          const live = this.liveSec(sel.c, sel.s);
          if (!live) return;
          if (on) live.pullDown = true;
          else delete live.pullDown;
          this.changed();
        }
      );
    }

    if (sec.h === 'fill') {
      const cap = document.createElement('div');
      cap.className = 'studio-caption';
      cap.textContent = 'Height: fills the column';
      pop.appendChild(cap);
    } else {
      numRow(
        pop,
        'Height',
        () => {
          const live = this.liveSec(sel.c, sel.s);
          return typeof live?.h === 'number' ? live.h : SEC_MIN_H;
        },
        (v) => {
          const live = this.liveSec(sel.c, sel.s);
          if (!live) return;
          live.h = clamp(v, SEC_MIN_H, SEC_MAX_H);
          this.changed();
        },
        { min: SEC_MIN_H, max: SEC_MAX_H }
      );
      const fill = document.createElement('button');
      fill.className = 'btn';
      fill.textContent = 'Fill the rest';
      fill.title = 'This section takes whatever height the fixed ones leave';
      fill.addEventListener('click', () => this.makeFill(sel.c, sel.s));
      pop.appendChild(fill);
    }

    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'Delete section';
    del.disabled = col.sections.length <= 1;
    del.addEventListener('click', () => this.deleteSection(sel.c, sel.s));
    pop.appendChild(del);
  }

  /**
   * Switch a section's kind. Picking Custom… ALSO enters the drill-in, in the
   * same click: "custom" is not a state anyone wants to sit in, it is a way of
   * saying "let me place the shelves myself".
   */
  private setKind(c: number, s: number, kind: WardrobeSectionKind): void {
    const sec = this.liveSec(c, s);
    if (!sec || sec.kind === kind) {
      if (kind === 'custom') this.enterInterior(c, s);
      return;
    }
    if (kind === 'custom') {
      const cav = wardrobeSectionCavity(this.part, this.dims(), c, s);
      const seed = cav ? resolveInterior(sectionInterior(sec, cav.h), cav.h) : [];
      sec.kind = 'custom';
      sec.interior = { mode: 'custom', elements: seed };
      this.changed();
      this.enterInterior(c, s);
      return;
    }
    sec.kind = kind;
    // the sanitizer drops what the new kind cannot carry (count, pullDown,
    // exposed, interior) and defaults what it needs
    this.changed();
    this.renderPopover();
    this.positionPopover();
  }

  /** Move the column's fill flag onto this section. */
  private makeFill(c: number, s: number): void {
    const col = this.liveCol(c);
    const sec = this.liveSec(c, s);
    if (!col || !sec || sec.h === 'fill') return;
    const v = this.view();
    for (let i = 0; i < col.sections.length; i++) {
      if (col.sections[i].h !== 'fill') continue;
      // the old fill keeps the height it currently has on screen
      const laid = v.lay.columns[c]?.sections[i];
      col.sections[i].h = clamp(laid ? laid.y1 - laid.y0 : SEC_MIN_H, SEC_MIN_H, SEC_MAX_H);
    }
    sec.h = 'fill';
    sanitizeWardrobeFields(this.part);
    this.changed();
    this.renderPopover();
    this.positionPopover();
  }

  /* ---------------- drawing ---------------- */

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    if (this.canvas.width !== Math.round(cw * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#f4f3f0';
    ctx.fillRect(0, 0, cw, ch);
    ctx.font = '11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (this.interior) {
      this.interior.draw(ctx, cw, ch);
      this.writeSeams(null);
      return;
    }

    const v = this.view();
    this.drawCarcass(ctx, v);
    this.drawSections(ctx, v, false);
    this.drawFronts(ctx, v);
    this.drawSections(ctx, v, true);
    this.drawHeaderAndDividers(ctx, v);
    this.drawChips(ctx, v);
    this.drawDiscs(ctx, v);

    ctx.fillStyle = SOFT;
    fillFooterCaption(
      ctx,
      'wardrobe front — click a section to change it, drag a board to resize, hover the header for ⊕ / ✕',
      cw / 2,
      ch - 12,
      cw - 24
    );
    this.writeSeams(v);
  }

  private drawCarcass(ctx: CanvasRenderingContext2D, v: View): void {
    const lay = v.lay;
    const left = this.sx(v, -lay.outer.w / 2);
    const wpx = lay.outer.w * v.scale;

    // the body slab IS the carcass: every board the layout leaves between two
    // cavities stays visible where a section rect is not painted over it
    const by = this.sy(v, lay.body.y1);
    ctx.fillStyle = '#ded9cf';
    ctx.fillRect(left, by, wpx, this.sy(v, lay.body.y0) - by);

    if (lay.plinth) {
      ctx.fillStyle = '#c9c3b8';
      const py = this.sy(v, lay.plinth.y1);
      ctx.fillRect(left + 6, py, wpx - 12, this.sy(v, lay.plinth.y0) - py);
    }
    if (lay.cornice) {
      ctx.fillStyle = '#ded9cf';
      const cy = this.sy(v, lay.cornice.y1);
      ctx.fillRect(left, cy, wpx, this.sy(v, lay.cornice.y0) - cy);
    }
    if (lay.topRow) {
      const ty = this.sy(v, lay.topRow.y1);
      const th = this.sy(v, lay.topRow.y0) - ty;
      ctx.fillStyle = '#faf9f6';
      ctx.fillRect(left + 4, ty + 2, wpx - 8, th - 4);
      ctx.strokeStyle = SOFT;
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 4, ty + 2, wpx - 8, th - 4);
      if (th > 18) {
        ctx.fillStyle = SOFT;
        ctx.fillText(
          lay.topRow.doors ? 'top boxes · doors' : 'top boxes',
          left + wpx / 2,
          ty + th / 2
        );
      }
    }

    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    const top = this.sy(v, lay.outer.h);
    ctx.strokeRect(left, top, wpx, this.sy(v, 0) - top);
  }

  private drawSections(ctx: CanvasRenderingContext2D, v: View, exposedOnly: boolean): void {
    for (const col of v.lay.columns) {
      for (const sec of col.sections) {
        if (exposedOnly && !sec.exposed) continue;
        this.drawSection(ctx, v, col, sec);
      }
    }
  }

  private drawSection(
    ctx: CanvasRenderingContext2D,
    v: View,
    col: WardrobeLayoutColumn,
    sec: WardrobeLayoutSection
  ): void {
    const r = this.secRect(v, col, sec);
    if (r.w <= 1 || r.h <= 1) return;
    const active =
      this.sel?.kind === 'section' && this.sel.c === col.index && this.sel.s === sec.index;
    ctx.fillStyle = active ? '#eef4f2' : '#faf9f6';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = active ? ACCENT : SOFT;
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    this.drawContent(ctx, col, sec, r);

    if (sec.fill && r.w > 34 && r.h > 22) this.drawPill(ctx, r.x + r.w - 6, r.y + 4, 'fill');

    if (r.w > 46 && r.h > 26) {
      const meta = KINDS[sec.kind];
      ctx.fillStyle = active ? ACCENT : INK;
      ctx.fillText(
        `${meta.glyph} ${meta.label}`,
        r.x + r.w / 2,
        r.y + r.h / 2 - (r.h > 44 ? 7 : 0)
      );
      if (r.h > 44) {
        ctx.fillStyle = SOFT;
        ctx.fillText(
          `${Math.round((col.x1 - col.x0) * 100)} × ${Math.round((sec.y1 - sec.y0) * 100)}`,
          r.x + r.w / 2,
          r.y + r.h / 2 + 8
        );
      }
    }
  }

  /**
   * The schematic inside one section. Everything positional comes from
   * `sectionInterior` + `resolveInterior` — the same bridge the panel
   * generator uses — so a shelf drawn here is a shelf that gets cut.
   */
  private drawContent(
    ctx: CanvasRenderingContext2D,
    col: WardrobeLayoutColumn,
    sec: WardrobeLayoutSection,
    r: { x: number; y: number; w: number; h: number }
  ): void {
    const cavH = sec.y1 - sec.y0;
    if (cavH <= 0 || r.h < 8) return;
    const py = (y: number): number => r.y + r.h - (y / cavH) * r.h;
    const x0 = r.x + 5;
    const x1 = r.x + r.w - 5;
    ctx.strokeStyle = SOFT;
    ctx.fillStyle = SOFT;
    ctx.lineWidth = 1;

    if (sec.kind === 'open') return;

    if (sec.kind === 'seat') {
      const bench = py(Math.min(SEAT_H, cavH * 0.6));
      ctx.fillRect(x0, bench - 2, x1 - x0, 3);
      // the coat-hook rail is measured from the FLOOR, so it only shows when
      // it falls inside this section
      const hookY = HOOK_RAIL_FLOOR_Y - sec.y0;
      if (hookY > 0 && hookY < cavH) {
        const hy = py(hookY);
        ctx.beginPath();
        ctx.moveTo(x0, hy);
        ctx.lineTo(x1, hy);
        ctx.stroke();
        for (let k = 1; k <= 3; k++) {
          const hx = x0 + ((x1 - x0) * k) / 4;
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx, hy + 5);
          ctx.stroke();
        }
      }
      return;
    }

    if (sec.kind === 'shoes') {
      const n = Math.max(1, sec.count ?? 4);
      for (let k = 0; k < n; k++) {
        const y = py((cavH * (k + 0.5)) / n);
        ctx.beginPath();
        ctx.moveTo(x0, y + Math.min(6, r.h / (n * 3)));
        ctx.lineTo(x1, y - Math.min(6, r.h / (n * 3)));
        ctx.stroke();
      }
      return;
    }

    if (sec.kind === 'drawers' && sec.exposed) {
      const n = Math.max(1, sec.count ?? 3);
      for (let k = 0; k < n; k++) {
        const yb = r.y + (r.h * k) / n;
        ctx.strokeRect(x0, yb + 2, x1 - x0, r.h / n - 4);
        if (r.h / n > 14) {
          ctx.beginPath();
          ctx.moveTo(r.x + r.w / 2 - 8, yb + r.h / n / 2);
          ctx.lineTo(r.x + r.w / 2 + 8, yb + r.h / n / 2);
          ctx.stroke();
        }
      }
      return;
    }

    const secDef = this.liveSec(col.index, sec.index);
    const elements = secDef ? resolveInterior(sectionInterior(secDef, cavH), cavH) : [];
    for (const el of elements) {
      if (el.kind === 'rail') {
        const y = py(el.y);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.lineWidth = 1;
        for (const ex of [x0, x1]) {
          ctx.beginPath();
          ctx.arc(ex, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (el.kind === 'shelf') {
        const y = py(el.y);
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeRect(x0, py(el.y + el.h), x1 - x0, (el.h / cavH) * r.h);
      }
    }
  }

  private drawFronts(ctx: CanvasRenderingContext2D, v: View): void {
    const front = v.lay.front;
    if (front.kind === 'none') return;
    ctx.save();
    if (front.kind === 'hinged') {
      ctx.strokeStyle = INK;
      ctx.fillStyle = this.part.color;
      for (const col of v.lay.columns) {
        for (const run of col.doors) {
          const x = this.sx(v, run.x0);
          const y = this.sy(v, run.y1);
          const w = (run.x1 - run.x0) * v.scale;
          const h = (run.y1 - run.y0) * v.scale;
          const leaves: { x: number; w: number; side: 'left' | 'right' }[] = run.pair
            ? [
                { x, w: w / 2, side: 'left' },
                { x: x + w / 2, w: w / 2, side: 'right' },
              ]
            : [{ x, w, side: run.side }];
          for (const leaf of leaves) {
            ctx.globalAlpha = 0.42;
            ctx.fillRect(leaf.x + 1, y + 1, leaf.w - 2, h - 2);
            ctx.globalAlpha = 1;
            ctx.lineWidth = 1.2;
            ctx.strokeRect(leaf.x + 1, y + 1, leaf.w - 2, h - 2);
            if (leaf.w > 16 && h > 16) {
              ctx.lineWidth = 1;
              drawHingeTick(ctx, leaf.x + 1, y + 1, leaf.w - 2, h - 2, leaf.side);
            }
          }
        }
      }
      ctx.restore();
      return;
    }

    // sliding: the two lanes overlap, so the inner one is drawn inset — the
    // drawing says "these pass each other", which is the only thing the
    // elevation can say about a slider
    for (const p of front.panels) {
      const x = this.sx(v, p.x0);
      const y = this.sy(v, p.y1);
      const w = (p.x1 - p.x0) * v.scale;
      const h = (p.y1 - p.y0) * v.scale;
      const inset = p.layer === 1 ? 4 : 1;
      ctx.globalAlpha = p.layer === 1 ? 0.5 : 0.34;
      ctx.fillStyle = this.part.color;
      ctx.fillRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      if (front.mirror && w > 20 && h > 20) {
        ctx.strokeStyle = SOFT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + inset + 4, y + h - inset - 4);
        ctx.lineTo(x + w - inset - 4, y + inset + 4);
        ctx.stroke();
      }
      if (w > 30) {
        ctx.fillStyle = INK;
        ctx.fillText('↔', x + w / 2, y + h / 2);
      }
    }
    ctx.restore();
  }

  /** The header band's width labels, plus the draggable board hairlines. */
  private drawHeaderAndDividers(ctx: CanvasRenderingContext2D, v: View): void {
    const top = this.sy(v, v.lay.outer.h);
    const cy = top - HEADER_H / 2;
    for (const col of v.lay.columns) {
      const cx = (this.sx(v, col.x0) + this.sx(v, col.x1)) / 2;
      const wpx = (col.x1 - col.x0) * v.scale;
      const active = this.sel?.kind === 'column' && this.sel.c === col.index;
      ctx.fillStyle = active ? ACCENT : SOFT;
      if (wpx > 34) {
        ctx.fillText(col.fill ? 'fill' : fmtCm(col.x1 - col.x0), cx, cy);
      }
    }
    // divider handles: a hairline down the boards the user can drag
    for (let i = 0; i < v.lay.columns.length - 1; i++) {
      const x = this.colDivX(v, i);
      const on = this.sel?.kind === 'colDiv' && this.sel.i === i;
      ctx.strokeStyle = on ? ACCENT : 'rgba(0,0,0,0.18)';
      ctx.lineWidth = on ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, this.sy(v, v.lay.body.y1));
      ctx.lineTo(x, this.sy(v, v.lay.body.y0));
      ctx.stroke();
    }
    if (this.sel?.kind === 'secDiv') {
      const col = v.lay.columns[this.sel.c];
      if (col && col.sections[this.sel.s + 1]) {
        const y = this.secDivY(v, col, this.sel.s);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.sx(v, col.x0), y);
        ctx.lineTo(this.sx(v, col.x1), y);
        ctx.stroke();
      }
    }
  }

  private drawChips(ctx: CanvasRenderingContext2D, v: View): void {
    if (this.part.front.kind !== 'hinged') return;
    for (const col of v.lay.columns) {
      const r = this.chipRect(v, col.index);
      const def = this.liveCol(col.index);
      if (!r || !def) continue;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = SOFT;
      ctx.lineWidth = 1;
      this.roundRect(ctx, r.x, r.y, r.w, r.h, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.fillText(DOOR_CHIP[def.door], r.x + r.w / 2, r.y + r.h / 2);
    }
  }

  private drawDiscs(ctx: CanvasRenderingContext2D, v: View): void {
    const p = this.hover;
    if (!p || this.drag) return;
    const header = this.headerHover(v, p);
    if (header?.t === 'colAdd') {
      this.drawDisc(
        ctx,
        this.colAnchors(v)[header.at],
        this.sy(v, v.lay.outer.h) - HEADER_H / 2,
        '＋'
      );
    } else if (header?.t === 'colDel') {
      const col = v.lay.columns[header.c];
      this.drawDisc(
        ctx,
        this.sx(v, col.x1) - DISC_R - 3,
        this.sy(v, v.lay.outer.h) - HEADER_H / 2,
        '✕'
      );
    }
    const c = this.columnAt(v, p.x);
    if (c === null || header) return;
    for (const disc of this.secAddDiscs(v, c)) this.drawDisc(ctx, disc.x, disc.y, '＋');
  }

  private drawDisc(ctx: CanvasRenderingContext2D, x: number, y: number, glyph: string): void {
    ctx.beginPath();
    ctx.arc(x, y, DISC_R, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    ctx.fillText(glyph, x, y + 0.5);
  }

  private drawPill(ctx: CanvasRenderingContext2D, right: number, top: number, text: string): void {
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = ACCENT;
    this.roundRect(ctx, right - w, top, w, 13, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, right - w / 2, top + 7);
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * The e2e seams: where the draggable boards, the section rects and the door
   * chips ended up, in CSS px. Written on every draw so a spec never has to
   * re-derive the view transform. Empty while the interior drill-in is up —
   * none of those things is on screen then.
   */
  private writeSeams(v: View | null): void {
    const ds = this.canvas.dataset;
    if (!v) {
      ds.dividers = '';
      ds.sections = '[]';
      ds.chips = '';
      return;
    }
    const divs: number[] = [];
    for (let i = 0; i < v.lay.columns.length - 1; i++) divs.push(Math.round(this.colDivX(v, i)));
    ds.dividers = divs.join(',');
    const rects: { c: number; s: number; x: number; y: number; w: number; h: number }[] = [];
    for (const col of v.lay.columns) {
      for (const sec of col.sections) {
        const r = this.secRect(v, col, sec);
        rects.push({
          c: col.index,
          s: sec.index,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.w),
          h: Math.round(r.h),
        });
      }
    }
    ds.sections = JSON.stringify(rects);
    if (this.part.front.kind !== 'hinged') {
      ds.chips = '';
      return;
    }
    const chips: number[] = [];
    for (const col of v.lay.columns) {
      const r = this.chipRect(v, col.index);
      if (r) chips.push(Math.round(r.x + r.w / 2));
    }
    ds.chips = chips.join(',');
  }
}
