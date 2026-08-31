import { clamp, fmtCm } from '../../model/geometry';
import { MAX_INTERIOR_ELEMENTS, resolveInterior } from '../../model/interior';
import type { Cavity } from '../../model/panels';
import type { InteriorElement } from '../../model/types';

/** Studio canvas palette — one definition, shared by every editor canvas. */
export const INK = '#3a3934';
export const ACCENT = '#2f6f5e';
export const SOFT = '#6f6d67';

/**
 * Centered footer caption, ellipsized to fit `maxWidth` instead of running
 * off the canvas at narrow Workshop-pane widths. Canvas text has no DOM
 * node to hang a `title` on, so a shortened caption keeps the full string
 * as `canvas.title` — a hover fallback for whatever got cut.
 */
export function fillFooterCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number
): void {
  const canvas = ctx.canvas;
  let fitted = text;
  if (ctx.measureText(text).width > maxWidth) {
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const candidate = `${text.slice(0, mid).trimEnd()}…`;
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    fitted = `${text.slice(0, lo).trimEnd()}…`;
    canvas.title = text;
  } else if (canvas.title) {
    canvas.title = '';
  }
  ctx.fillText(fitted, cx, y);
}

/** The explicit ({mode:'custom'}) interior container, structurally. */
export interface CustomElements {
  elements: InteriorElement[];
}

/**
 * Everything the drill-in editor is allowed to know about WHAT it is editing.
 *
 * Every method resolves the drilled-in target afresh — by path, by index,
 * however the host names it — because the studio applies each change through
 * `store.updateCustomPart`, whose `sanitizePart` REBUILDS the objects it
 * writes (WS-SPEC WP 3.1). A host that captured a leaf would be editing an
 * orphan from its second click on, which is why nothing here hands the editor
 * an object to hold.
 */
export interface InteriorHost {
  /** The edited cavity in its own local frame. Null = the target vanished. */
  cavity(): Cavity | null;
  /** RESOLVED elements: a custom interior verbatim, an auto one laid out. */
  elements(): InteriorElement[];
  /** First edit: convert a parametric interior into explicit elements. */
  ensureCustom(): CustomElements;
  /** The custom container WITHOUT converting — null while still parametric. */
  customInterior(): CustomElements | null;
  /** Back to even auto-spacing. Absent = the button is greyed out. */
  resetToEven?: (shelves: number, innerDrawers: number) => void;
  /** Footer caption for the edited target ("2 drawers", "open · custom", …). */
  caption(): string;
  /** Colour the elements are drawn in. */
  accentColor(): string;
  /** A settled edit (undo step) or, with `transient`, a mid-gesture tick. */
  changed(transient?: boolean): void;
  /** Nothing was written — only the selection moved: re-render and redraw. */
  refresh(): void;
  /** Leave the drill-in: the host clears its path, re-renders and redraws. */
  done(): void;
}

/** The host's toolbar button factory — it owns the DOM, the editor the rules. */
export type BtnFactory = (
  label: string,
  title: string,
  fn: () => void,
  disabled?: boolean,
  active?: boolean
) => HTMLButtonElement;

/**
 * One pointer event, in canvas terms. The editor owns no DOM, so cursor
 * feedback and pointer-capture release come back through the host.
 */
export interface PointerCtx {
  /** pointer position in canvas CSS px, from the canvas' top-left */
  x: number;
  y: number;
  /** canvas CSS size */
  cw: number;
  ch: number;
  setCursor(cursor: string): void;
  releaseCapture(): void;
}

interface InteriorView {
  scale: number;
  ox: number;
  oy: number;
  cav: Cavity;
}

/**
 * The interior drill-in: shelves, internal drawer boxes and hanging rails
 * inside ONE cavity, edited in cm on the host's canvas.
 *
 * Host-agnostic by construction — the cabinet zone canvas is one host, a
 * wardrobe section will be another — so all of it (toolbar rules, hit test,
 * add/delete/drag with cm snapping, canonicalization, drawing) lives here
 * exactly once.
 */
export class InteriorEditor {
  private host: InteriorHost;
  /** index of the selected element, or null */
  selected: number | null = null;
  private drag: number | null = null;

  constructor(host: InteriorHost) {
    this.host = host;
  }

  /* ---------------- edits ---------------- */

  /** Sort + clamp elements back into canonical form after a gesture. */
  private canonicalize(): void {
    const cav = this.host.cavity();
    const custom = this.host.customInterior();
    if (!cav || !custom) return;
    const selected = this.selected !== null ? custom.elements[this.selected] : null;
    custom.elements = resolveInterior({ mode: 'custom', elements: custom.elements }, cav.h);
    this.selected = selected ? custom.elements.indexOf(selected) : null;
    if (this.selected === -1) this.selected = null;
  }

  private addElement(kind: InteriorElement['kind']): void {
    const cav = this.host.cavity();
    if (!cav) return;
    const custom = this.host.ensureCustom();
    if (custom.elements.length >= MAX_INTERIOR_ELEMENTS) return;
    // drop the new element into the largest free vertical gap
    const tops = custom.elements
      .map((e) => (e.kind === 'drawerBox' ? e.y + e.h : e.y))
      .sort((a, b) => a - b);
    let gapStart = 0;
    let best = { start: 0, size: 0 };
    for (const t of [...tops, cav.h]) {
      if (t - gapStart > best.size) best = { start: gapStart, size: t - gapStart };
      gapStart = t;
    }
    const y = best.start + best.size / 2;
    // the index the pushed element takes in the PRE-canonical list — the
    // canonical one may be shorter (an overlapping addition is dropped), and
    // an index past its end reads back as "nothing selected"
    const at = custom.elements.length;
    custom.elements.push(
      kind === 'drawerBox'
        ? { kind: 'drawerBox', y: Math.max(0.01, y - 0.075), h: 0.15 }
        : kind === 'rail'
          ? { kind: 'rail', y }
          : { kind: 'shelf', y }
    );
    this.canonicalize();
    this.selected = at;
    this.host.changed();
  }

  private deleteElement(): void {
    if (!this.host.cavity() || this.selected === null) return;
    const custom = this.host.ensureCustom();
    custom.elements.splice(this.selected, 1);
    this.selected = null;
    this.host.changed();
  }

  private resetToEven(): void {
    const els = this.host.elements();
    const shelves = els.filter((e) => e.kind === 'shelf').length;
    const innerDrawers = els.filter((e) => e.kind === 'drawerBox').length;
    if (!this.host.resetToEven) return;
    this.host.resetToEven(shelves, innerDrawers);
    this.selected = null;
    this.host.changed();
  }

  /* ---------------- keys ---------------- */

  handleDelete(): boolean {
    if (this.selected === null) return false;
    this.deleteElement();
    return true;
  }

  /**
   * Escape LEAVES the drill-in, selected element or not: one Escape is one
   * level out, and the element selection is not a level — nothing in here
   * hides behind it, so deselecting first would only cost a keystroke.
   */
  handleEscape(): boolean {
    this.host.done();
    return true;
  }

  /* ---------------- toolbar ---------------- */

  renderToolbar(tb: HTMLElement, btn: BtnFactory): void {
    const cav = this.host.cavity();
    if (!cav) {
      this.host.done();
      return;
    }
    btn('← Done', 'Back to the zone layout (Esc)', () => this.host.done());
    const sep = document.createElement('span');
    sep.className = 'zone-toolbar-sep';
    tb.appendChild(sep);
    const els = this.host.elements();
    const full = els.length >= MAX_INTERIOR_ELEMENTS;
    btn('＋ Shelf', 'Add a shelf in the largest free gap', () => this.addElement('shelf'), full);
    btn('＋ Drawer', 'Add an internal drawer box', () => this.addElement('drawerBox'), full);
    btn('＋ Rail', 'Add a wardrobe hanging rail', () => this.addElement('rail'), full);
    btn(
      'Delete',
      'Remove the selected element (Delete)',
      () => this.deleteElement(),
      this.selected === null
    );
    // auto spacing only knows shelves and drawers — resetting would drop rails
    const hasRail = els.some((e) => e.kind === 'rail');
    btn(
      'Reset to even',
      hasRail
        ? 'Auto spacing has no rails — delete the hanging rail first'
        : 'Back to even auto-spacing with the same counts',
      () => this.resetToEven(),
      hasRail || !this.host.resetToEven
    );

    const sel = this.selected !== null ? els[this.selected] : null;
    if (sel) {
      // edits go through ensureCustom so an auto interior converts first;
      // indices survive because conversion preserves the resolved order
      const cmInput = (
        label: string,
        value: number,
        apply: (el: InteriorElement, m: number) => void
      ) => {
        const holder = document.createElement('span');
        holder.className = 'zone-stepper';
        holder.innerHTML = `<label>${label}</label><input type="number" step="1" style="width:56px">`;
        const input = holder.querySelector('input') as HTMLInputElement;
        input.value = String(Math.round(value * 100));
        input.addEventListener('change', () => {
          const custom = this.host.ensureCustom();
          const el = this.selected !== null ? custom.elements[this.selected] : null;
          if (!el) return;
          apply(el, clamp(Number(input.value) / 100, 0, cav.h));
          this.canonicalize();
          this.host.changed();
        });
        tb.appendChild(holder);
      };
      cmInput('Y', sel.y, (el, v) => (el.y = v));
      if (sel.kind === 'drawerBox') {
        cmInput('H', sel.h, (el, v) => {
          if (el.kind === 'drawerBox') el.h = clamp(v, 0.06, 0.4);
        });
      }
    } else {
      const hint = document.createElement('span');
      hint.className = 'studio-caption';
      hint.textContent = this.host.customInterior()
        ? 'custom · drag shelves and drawers'
        : 'auto · drag an element to customize';
      tb.appendChild(hint);
    }
  }

  /* ---------------- geometry ---------------- */

  /** The cavity fills the canvas. */
  private view(cw: number, ch: number): InteriorView | null {
    const cav = this.host.cavity();
    if (!cav) return null;
    const scale = Math.min((cw * 0.7) / cav.w, (ch * 0.7) / cav.h);
    return { scale, ox: (cw - cav.w * scale) / 2, oy: (ch + cav.h * scale) / 2, cav };
  }

  /** canvas px → cavity-local coords (x right from its left, y up from its bottom) */
  private toCavity(v: InteriorView, p: { x: number; y: number }): { x: number; y: number } {
    return { x: (p.x - v.ox) / v.scale, y: (v.oy - p.y) / v.scale };
  }

  /** index of the interior element under the pointer, topmost first */
  private hitElement(p: { x: number; y: number }, tol: number): number | null {
    const els = this.host.elements();
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      // shelves and rails are lines; only a drawer box has a body to hit
      const within =
        e.kind === 'drawerBox'
          ? p.y > e.y - tol && p.y < e.y + e.h + tol
          : Math.abs(p.y - e.y) < tol;
      if (within) return i;
    }
    return null;
  }

  /* ---------------- pointers ---------------- */

  /** The drill-in owns the canvas while it is live: every press is consumed. */
  onDown(ctx: PointerCtx): boolean {
    const v = this.view(ctx.cw, ctx.ch);
    if (!v) return true;
    const p = this.toCavity(v, ctx);
    this.selected = this.hitElement(p, 8 / v.scale);
    this.drag = this.selected;
    // selection only — a press must not take an undo step
    this.host.refresh();
    return true;
  }

  onMove(ctx: PointerCtx): boolean {
    const v = this.view(ctx.cw, ctx.ch);
    if (this.drag !== null) {
      if (!v) return true;
      const p = this.toCavity(v, ctx);
      const custom = this.host.ensureCustom();
      const el = custom.elements[this.drag];
      if (!el) return true;
      const snapped = Math.round(p.y * 100) / 100; // 1 cm snap
      // drawer boxes drag by their centre (they have height); every other
      // element is a line at y — branch on the box, never on the lines
      if (el.kind === 'drawerBox') el.y = clamp(snapped - el.h / 2, 0, v.cav.h - el.h);
      else el.y = clamp(snapped, 0, v.cav.h);
      // mid-drag: notify so the 3D preview tracks it, but take no undo step —
      // onUp's changed() is the one that commits (WS-SPEC WP 3.1)
      this.host.changed(true);
      return true;
    }
    const over = v ? this.hitElement(this.toCavity(v, ctx), 8 / v.scale) : null;
    ctx.setCursor(over !== null ? 'ns-resize' : 'default');
    return true;
  }

  onUp(ctx: PointerCtx): boolean {
    if (this.drag === null) return false;
    ctx.releaseCapture();
    this.drag = null;
    this.canonicalize();
    this.host.changed();
    return true;
  }

  /* ---------------- drawing ---------------- */

  draw(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const v = this.view(cw, ch);
    if (!v) return;
    const { cav, scale, ox, oy } = v;
    const sx = (x: number) => ox + x * scale;
    const sy = (y: number) => oy - y * scale;

    ctx.font = '11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // cavity outline (the space between carcass boards)
    ctx.fillStyle = '#faf9f6';
    ctx.fillRect(sx(0), sy(cav.h), cav.w * scale, cav.h * scale);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    ctx.strokeRect(sx(0), sy(cav.h), cav.w * scale, cav.h * scale);

    const accent = this.host.accentColor();
    const els = this.host.elements();
    els.forEach((e, i) => {
      const active = i === this.selected;
      ctx.strokeStyle = active ? ACCENT : SOFT;
      ctx.fillStyle = active ? '#dcebe6' : accent;
      if (e.kind === 'rail') {
        // a thin bar across the cavity with its end holders
        const y = sy(e.y);
        ctx.lineWidth = active ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(sx(0.01), y);
        ctx.lineTo(sx(cav.w - 0.01), y);
        ctx.stroke();
        ctx.fillStyle = active ? ACCENT : SOFT;
        for (const ex of [0.01, cav.w - 0.01]) {
          ctx.beginPath();
          ctx.arc(sx(ex), y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillText(`rail · ${Math.round(e.y * 100)} cm`, sx(cav.w / 2), y - 10);
      } else if (e.kind === 'shelf') {
        const t = Math.max(2, 0.018 * scale);
        ctx.globalAlpha = 0.9;
        ctx.fillRect(sx(0.01), sy(e.y) - t / 2, (cav.w - 0.02) * scale, t);
        ctx.globalAlpha = 1;
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeRect(sx(0.01), sy(e.y) - t / 2, (cav.w - 0.02) * scale, t);
        ctx.fillStyle = active ? ACCENT : SOFT;
        ctx.fillText(`shelf · ${Math.round(e.y * 100)} cm`, sx(cav.w / 2), sy(e.y) - 10);
      } else {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(sx(0.02), sy(e.y + e.h), (cav.w - 0.04) * scale, e.h * scale);
        ctx.globalAlpha = 1;
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeRect(sx(0.02), sy(e.y + e.h), (cav.w - 0.04) * scale, e.h * scale);
        ctx.fillStyle = active ? ACCENT : INK;
        ctx.fillText(
          `drawer · ${Math.round(e.h * 100)} cm @ ${Math.round(e.y * 100)} cm`,
          sx(cav.w / 2),
          sy(e.y + e.h / 2)
        );
      }
    });

    // cavity dimensions + hint
    ctx.fillStyle = SOFT;
    ctx.fillText(fmtCm(cav.w), sx(cav.w / 2), sy(0) + 14);
    ctx.save();
    ctx.translate(sx(0) - 12, sy(cav.h / 2));
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(fmtCm(cav.h), 0, 0);
    ctx.restore();
    fillFooterCaption(
      ctx,
      `${this.host.caption()} — interior · drag to move, Esc when done`,
      cw / 2,
      ch - 12,
      cw - 24
    );
  }
}
