import { fmtCm } from '../../model/geometry';
import {
  defaultInterior,
  MAX_AUTO_DRAWERS,
  MAX_AUTO_SHELVES,
  resolveInterior,
} from '../../model/interior';
import { cabinetFaceSize, interiorBox, type Cavity } from '../../model/panels';
import type {
  CabinetPartDef,
  Interior,
  InteriorElement,
  LeafZone,
  ZoneFill,
} from '../../model/types';
import {
  countLeaves,
  MAX_DEPTH,
  MAX_LEAVES,
  mergeZone,
  normalizeZones,
  setDivider,
  splitZone,
  walkSplits,
  walkZones,
  zoneAtPath,
  zoneAtPoint,
  type SplitBoundary,
} from '../../model/zones';
import {
  ACCENT,
  fillFooterCaption,
  INK,
  InteriorEditor,
  SOFT,
  type BtnFactory,
  type InteriorHost,
  type PointerCtx,
} from './interiorEditor';

const FILL_LABELS: Record<ZoneFill, string> = {
  door: 'Door',
  doorPair: 'Door pair',
  drawers: 'Drawers',
  open: 'Open',
  panel: 'Panel',
  glass: 'Glass',
  appliance: 'Appliance',
};

/** The leaf's interior with the per-fill default applied. */
function interiorOf(leaf: LeafZone): Interior | undefined {
  return leaf.interior ?? defaultInterior(leaf.fill);
}

function leafCaption(leaf: LeafZone): string {
  if (leaf.fill === 'drawers')
    return `${leaf.drawers ?? 1} drawer${(leaf.drawers ?? 1) > 1 ? 's' : ''}`;
  const interior = interiorOf(leaf);
  if (leaf.fill === 'open') {
    if (interior?.mode === 'custom') return 'open · custom';
    const n = interior?.mode === 'auto' ? interior.shelves : 0;
    return `open · ${n} shelf${n === 1 ? '' : 's'}`;
  }
  if (interior?.mode === 'custom') return `${FILL_LABELS[leaf.fill].toLowerCase()} · custom`;
  return FILL_LABELS[leaf.fill].toLowerCase();
}

/** The front face the zones live on — shared body math from the panel generator. */
export const faceSize = cabinetFaceSize;

type DividerLine = SplitBoundary;

/**
 * Front-elevation zone editor: click a zone, split/merge via the toolbar,
 * drag divider lines to resize, all in cm. Shares walkZones with the mesh
 * builder, so the canvas is exactly what gets built.
 */
export class ZoneCanvas {
  private part: CabinetPartDef;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private toolbar: HTMLElement;
  private ro: ResizeObserver;
  private onChange: (transient?: boolean) => void;
  private drag: DividerLine | null = null;
  selection: number[] | null = null;
  /** selected divider line (mutually exclusive with `selection`) — toolbar
   * shows Equalize for it; dblclick never acts on a divider any more. */
  private dividerSel: DividerLine | null = null;
  /** leaf being edited in interior drill-in mode (null = zone mode) */
  interiorPath: number[] | null = null;
  /** live while `interiorPath` is set — it owns the drill-in, this owns the path */
  private interior: InteriorEditor | null = null;

  constructor(
    container: HTMLElement,
    part: CabinetPartDef,
    onChange: (transient?: boolean) => void
  ) {
    this.part = part;
    this.onChange = onChange;
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'zone-toolbar';
    container.appendChild(this.toolbar);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'zone-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));

    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(container);
    this.renderToolbar();
    this.draw();
  }

  /** Stop observing — the studio replaces this editor on every rail re-render. */
  dispose(): void {
    this.ro.disconnect();
  }

  /* ---------------- selection + edits ---------------- */

  private selectedLeaf(): LeafZone | null {
    if (!this.selection) return null;
    const z = zoneAtPath(this.part.face, this.selection);
    return z && z.kind === 'leaf' ? z : null;
  }

  handleEscape(): boolean {
    if (this.interior) return this.interior.handleEscape();
    if (this.dividerSel) {
      this.dividerSel = null;
      this.renderToolbar();
      this.draw();
      return true;
    }
    if (this.selection) {
      this.selection = null;
      this.renderToolbar();
      this.draw();
      return true;
    }
    return false;
  }

  /* ---------------- interior drill-in mode ---------------- */

  private interiorLeaf(): LeafZone | null {
    if (!this.interiorPath) return null;
    const z = zoneAtPath(this.part.face, this.interiorPath);
    return z && z.kind === 'leaf' ? z : null;
  }

  /** The edited leaf's interior box (face-local) — same math as the panels. */
  private interiorCavity(): Cavity | null {
    const leaf = this.interiorLeaf();
    if (!leaf || !this.interiorPath) return null;
    const { faceW, faceH } = faceSize(this.part);
    const key = this.interiorPath.join(',');
    for (const r of walkZones(this.part.face, faceW, faceH)) {
      if (r.path.join(',') === key) {
        return interiorBox(r, faceW, faceH, leaf.fill, this.part.footprint.kind === 'rect');
      }
    }
    return null;
  }

  private enterInterior(path: number[]): void {
    const z = zoneAtPath(this.part.face, path);
    if (!z || z.kind !== 'leaf' || !['door', 'doorPair', 'glass', 'open'].includes(z.fill)) return;
    this.interiorPath = path;
    this.interior = new InteriorEditor(this.interiorHost());
    this.renderToolbar();
    this.draw();
  }

  private exitInterior(): void {
    this.interiorPath = null;
    this.interior = null;
    this.renderToolbar();
    this.draw();
  }

  /**
   * The adapter: everything the shared drill-in editor may know about this
   * leaf, resolved BY PATH on every call. Nothing hands it a leaf to hold —
   * `sanitizePart` rebuilds them on each write (see `live()` below).
   */
  private interiorHost(): InteriorHost {
    return {
      cavity: () => this.interiorCavity(),
      elements: () => this.interiorElements(),
      ensureCustom: () => this.ensureCustom(),
      customInterior: () => {
        const cur = this.interiorLeaf()?.interior;
        return cur?.mode === 'custom' ? cur : null;
      },
      resetToEven: (shelves, innerDrawers) => {
        const leaf = this.interiorLeaf();
        if (leaf) leaf.interior = { mode: 'auto', shelves, innerDrawers };
      },
      caption: () => {
        const leaf = this.interiorLeaf();
        return leaf ? leafCaption(leaf) : '';
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

  /** The currently-resolved elements of the drilled-in leaf. */
  private interiorElements(): InteriorElement[] {
    const leaf = this.interiorLeaf();
    const cav = this.interiorCavity();
    if (!leaf || !cav) return [];
    const interior = leaf.interior ?? defaultInterior(leaf.fill);
    if (interior?.mode === 'custom') return interior.elements;
    return resolveInterior(interior, cav.h);
  }

  /** First edit converts the parametric interior into explicit elements. */
  private ensureCustom(): Extract<Interior, { mode: 'custom' }> {
    const leaf = this.interiorLeaf()!;
    const cav = this.interiorCavity()!;
    const cur = leaf.interior ?? defaultInterior(leaf.fill);
    if (cur?.mode === 'custom') {
      leaf.interior = cur;
      return cur;
    }
    const custom: Extract<Interior, { mode: 'custom' }> = {
      mode: 'custom',
      elements: resolveInterior(cur, cav.h),
    };
    leaf.interior = custom;
    return custom;
  }

  handleDelete(): boolean {
    if (this.interior) return this.interior.handleDelete();
    if (!this.selection?.length) return false;
    this.merge();
    return true;
  }

  private split(dir: 'h' | 'v'): void {
    if (!this.selection) return;
    this.part.face = splitZone(this.part.face, this.selection, dir);
    // keep editing the first piece of the fresh split
    const z = zoneAtPath(this.part.face, this.selection);
    if (z && z.kind === 'split') this.selection = [...this.selection, 0];
    this.changed();
  }

  private merge(): void {
    if (!this.selection?.length) return;
    this.part.face = mergeZone(this.part.face, this.selection);
    this.selection = null;
    this.changed();
  }

  /** Reset the selected divider's owning split to equal weights. */
  private equalizeDivider(): void {
    if (!this.dividerSel) return;
    const split = zoneAtPath(this.part.face, this.dividerSel.path);
    if (!split || split.kind !== 'split') return;
    split.weights = split.weights.map(() => 1 / split.weights.length);
    this.changed();
  }

  private setFill(fill: ZoneFill): void {
    const leaf = this.selectedLeaf();
    if (!leaf) return;
    leaf.fill = fill;
    if (fill === 'drawers' && !leaf.drawers) leaf.drawers = 2;
    if (leaf.interior === undefined) leaf.interior = defaultInterior(fill);
    this.part.face = normalizeZones(this.part.face);
    this.changed();
  }

  /** Settled edit; `transient` is a mid-gesture tick that takes no undo step. */
  private changed(transient?: boolean): void {
    if (!transient) this.renderToolbar();
    this.onChange(transient);
    this.draw();
  }

  /* ---------------- toolbar ---------------- */

  private renderToolbar(): void {
    const tb = this.toolbar;
    tb.innerHTML = '';
    const leaf = this.selectedLeaf();
    const btn: BtnFactory = (
      label: string,
      title: string,
      fn: () => void,
      disabled = false,
      active = false
    ) => {
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
    if (this.dividerSel) {
      const axis = this.dividerSel.dir === 'v' ? 'columns' : 'rows';
      btn('≡ Equalize', `Even out these ${axis} to equal sizes`, () => this.equalizeDivider());
      const hint = document.createElement('span');
      hint.className = 'studio-caption';
      hint.textContent = 'divider selected — drag to resize';
      tb.appendChild(hint);
      return;
    }
    const canSplit =
      !!leaf &&
      countLeaves(this.part.face) < MAX_LEAVES &&
      (this.selection?.length ?? 0) + 1 <= MAX_DEPTH;
    btn('⬍ Split', 'Split the zone into top + bottom', () => this.split('h'), !canSplit);
    btn('⬌ Split', 'Split the zone into left + right', () => this.split('v'), !canSplit);
    btn(
      'Merge',
      'Merge this zone back into its neighbours (Delete)',
      () => this.merge(),
      !leaf || !this.selection?.length
    );

    const sep = document.createElement('span');
    sep.className = 'zone-toolbar-sep';
    tb.appendChild(sep);

    // no leaf selected: no fill buttons. The "click a zone" prompt is the
    // canvas' own footer caption (see draw()) — a second copy here rendered
    // one on top of the other.
    if (!leaf) return;
    for (const fill of Object.keys(FILL_LABELS) as ZoneFill[]) {
      btn(
        FILL_LABELS[fill],
        `Fill this zone with: ${FILL_LABELS[fill].toLowerCase()}`,
        () => this.setFill(fill),
        false,
        leaf.fill === fill
      );
    }
    const stepper = (
      label: string,
      get: () => number,
      set: (v: number) => void,
      min: number,
      max: number
    ) => {
      const holder = document.createElement('span');
      holder.className = 'zone-stepper stepper';
      holder.innerHTML = `<label>${label}</label><button>−</button><span>${get()}</span><button>+</button>`;
      const [minus, plus] = Array.from(holder.querySelectorAll('button'));
      const span = holder.querySelector('span') as HTMLElement;
      const apply = (v: number) => {
        set(Math.min(max, Math.max(min, v)));
        span.textContent = String(get());
        this.onChange();
        this.draw();
      };
      minus.addEventListener('click', () => apply(get() - 1));
      plus.addEventListener('click', () => apply(get() + 1));
      tb.appendChild(holder);
    };
    /**
     * The selected leaf, RE-RESOLVED by path.
     *
     * `leaf` above is only good until the next write: the studio applies every
     * change through `store.updateCustomPart`, whose `sanitizePart` runs
     * `sanitizeZone` and REBUILDS every leaf object (WS-SPEC WP 3.1). A handler
     * that captured one would be editing an orphan from its second click on.
     * Resolving by path costs a tree walk and cannot go stale.
     */
    const live = (): LeafZone | null => this.selectedLeaf();

    if (leaf.fill === 'door') {
      // hinge side = drilling datum; persisted on the leaf, drives the open preview
      const hinges: [NonNullable<LeafZone['hinge']>, string, string][] = [
        ['left', '◀', 'Hinge on the left edge'],
        ['right', '▶', 'Hinge on the right edge'],
        ['top', '▲', 'Top-hung flap'],
        ['bottom', '▼', 'Bottom-hung flap'],
      ];
      for (const [side, label, title] of hinges) {
        btn(
          label,
          title,
          () => {
            const l = live();
            if (!l) return;
            l.hinge = side;
            this.part.face = normalizeZones(this.part.face);
            this.changed();
          },
          false,
          (leaf.hinge ?? 'left') === side
        );
      }
    }
    if (leaf.fill === 'drawers') {
      stepper(
        'Drawers',
        () => live()?.drawers ?? 2,
        (v) => {
          const l = live();
          if (l) l.drawers = v;
        },
        1,
        5
      );
    }
    if (['door', 'doorPair', 'glass', 'open'].includes(leaf.fill)) {
      btn('Interior…', 'Edit shelves and internal drawers (double-click the zone)', () =>
        this.enterInterior(this.selection!)
      );
      const interior = interiorOf(leaf);
      if (interior?.mode === 'custom') {
        const chip = document.createElement('span');
        chip.className = 'studio-caption';
        chip.textContent = 'custom interior';
        tb.appendChild(chip);
      } else {
        // parametric counts write the auto interior; exact positions come later.
        // `live()` throughout, for the same reason the hinge buttons use it.
        const auto = (): Extract<Interior, { mode: 'auto' }> | null => {
          const l = live();
          if (!l) return null;
          const cur = interiorOf(l);
          if (cur?.mode === 'auto') {
            l.interior = cur;
            return cur;
          }
          const fresh: Interior = { mode: 'auto', shelves: 0, innerDrawers: 0 };
          l.interior = fresh;
          return fresh;
        };
        const autoCount = (key: 'shelves' | 'innerDrawers') => (): number => {
          const l = live();
          const cur = l && interiorOf(l);
          return cur?.mode === 'auto' ? cur[key] : 0;
        };
        stepper(
          'Shelves',
          autoCount('shelves'),
          (v) => {
            const a = auto();
            if (a) a.shelves = v;
          },
          0,
          MAX_AUTO_SHELVES
        );
        stepper(
          'Inner drawers',
          autoCount('innerDrawers'),
          (v) => {
            const a = auto();
            if (a) a.innerDrawers = v;
          },
          0,
          MAX_AUTO_DRAWERS
        );
      }
    }
  }

  /* ---------------- geometry ---------------- */

  private view(): { scale: number; ox: number; oy: number; faceW: number; faceH: number } {
    const { faceW, faceH } = faceSize(this.part);
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    const scale = Math.min((cw * 0.74) / faceW, (ch * 0.74) / faceH);
    return { scale, ox: (cw - faceW * scale) / 2, oy: (ch + faceH * scale) / 2, faceW, faceH };
  }

  /** face coords (x right, y up) → screen */
  private toScreen(x: number, y: number): { x: number; y: number } {
    const v = this.view();
    return { x: v.ox + x * v.scale, y: v.oy - y * v.scale };
  }

  private toFace(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view();
    return { x: (e.clientX - r.left - v.ox) / v.scale, y: (v.oy - (e.clientY - r.top)) / v.scale };
  }

  private dividers(): DividerLine[] {
    const { faceW, faceH } = this.view();
    // shared with the panel generator — the lines dragged here are exactly
    // the divider boards the carcass emits
    return walkSplits(this.part.face, faceW, faceH);
  }

  /* ---------------- pointers ---------------- */

  /** One pointer event in canvas terms — all the drill-in editor gets. */
  private pointerCtx(e: PointerEvent): PointerCtx {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
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
    const f = this.toFace(e);
    const v = this.view();
    const hit = 6 / v.scale;
    for (const d of this.dividers()) {
      const near =
        d.dir === 'v'
          ? Math.abs(f.x - d.x) < hit && f.y > d.y - hit && f.y < d.y + d.len + hit
          : Math.abs(f.y - d.y) < hit && f.x > d.x - hit && f.x < d.x + d.len + hit;
      if (near) {
        this.drag = d;
        this.dividerSel = d;
        this.selection = null;
        this.renderToolbar();
        this.draw();
        return;
      }
    }
    const z = zoneAtPoint(this.part.face, v.faceW, v.faceH, f.x, f.y);
    this.selection = z ? z.path : null;
    this.dividerSel = null;
    this.renderToolbar();
    this.draw();
  }

  private onMove(e: PointerEvent): void {
    if (this.interior?.onMove(this.pointerCtx(e))) return;
    if (this.drag) {
      const f = this.toFace(e);
      const d = this.drag;
      // 1 cm snapping on the cut position
      const pos = d.dir === 'v' ? f.x - d.rx : f.y - d.ry;
      const extent = d.dir === 'v' ? d.rw : d.rh;
      const frac = Math.round(pos * 100) / 100 / extent;
      setDivider(this.part.face, d.path, d.index, frac);
      this.onChange(true); // mid-drag tick; onUp's changed() commits
      this.draw();
      return;
    }
    const v = this.view();
    const f = this.toFace(e);
    const hit = 6 / v.scale;
    const over = this.dividers().find((d) =>
      d.dir === 'v'
        ? Math.abs(f.x - d.x) < hit && f.y > d.y && f.y < d.y + d.len
        : Math.abs(f.y - d.y) < hit && f.x > d.x && f.x < d.x + d.len
    );
    this.canvas.style.cursor = over ? (over.dir === 'v' ? 'col-resize' : 'row-resize') : 'pointer';
  }

  private onUp(e: PointerEvent): void {
    if (this.interior?.onUp(this.pointerCtx(e))) return;
    if (!this.drag) return;
    this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.changed();
  }

  /** Double-click: drill into a leaf's interior. Never acts on a divider —
   * equalizing one is a toolbar action now (see `equalizeDivider`). */
  private onDblClick(e: MouseEvent): void {
    if (this.interior) return;
    const r = this.canvas.getBoundingClientRect();
    const v = this.view();
    const f = {
      x: (e.clientX - r.left - v.ox) / v.scale,
      y: (v.oy - (e.clientY - r.top)) / v.scale,
    };
    const z = zoneAtPoint(this.part.face, v.faceW, v.faceH, f.x, f.y);
    if (z) this.enterInterior(z.path);
  }

  /* ---------------- drawing ---------------- */

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    if (this.canvas.width !== cw * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#f4f3f0';
    ctx.fillRect(0, 0, cw, ch);

    if (this.interior) {
      this.interior.draw(ctx, cw, ch);
      return;
    }

    const v = this.view();
    const rects = walkZones(this.part.face, v.faceW, v.faceH);

    // face outline
    const tl = this.toScreen(0, v.faceH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    ctx.strokeRect(tl.x, tl.y, v.faceW * v.scale, v.faceH * v.scale);

    ctx.font = '11.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const r of rects) {
      const selHit = this.selection && r.path.join(',') === this.selection.join(',');
      const a = this.toScreen(r.x, r.y + r.h);
      const wpx = r.w * v.scale;
      const hpx = r.h * v.scale;
      const inset = 3;
      ctx.fillStyle = selHit ? '#eef4f2' : this.part.color;
      ctx.globalAlpha = selHit ? 0.9 : 0.35;
      ctx.fillRect(a.x + inset, a.y + inset, wpx - inset * 2, hpx - inset * 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selHit ? ACCENT : SOFT;
      ctx.lineWidth = selHit ? 2 : 1;
      ctx.strokeRect(a.x + inset, a.y + inset, wpx - inset * 2, hpx - inset * 2);

      // drawers get stack lines, open zones get shelf lines
      ctx.strokeStyle = SOFT;
      ctx.lineWidth = 1;
      if (r.leaf.fill === 'drawers') {
        const n = r.leaf.drawers ?? 1;
        for (let i = 1; i < n; i++) {
          const y = a.y + (hpx * i) / n;
          ctx.beginPath();
          ctx.moveTo(a.x + 8, y);
          ctx.lineTo(a.x + wpx - 8, y);
          ctx.stroke();
        }
      } else if (r.leaf.fill === 'doorPair') {
        ctx.beginPath();
        ctx.moveTo(a.x + wpx / 2, a.y + 8);
        ctx.lineTo(a.x + wpx / 2, a.y + hpx - 8);
        ctx.stroke();
      } else if (r.leaf.fill === 'open') {
        // dashed lines at the RESOLVED element positions — same math as the panels
        const elements = resolveInterior(interiorOf(r.leaf), Math.max(0, r.h - 0.03));
        ctx.setLineDash([4, 3]);
        for (const el of elements) {
          const ey = 0.015 + el.y + (el.kind === 'drawerBox' ? el.h : 0);
          const y = a.y + hpx - (ey / r.h) * hpx;
          ctx.beginPath();
          ctx.moveTo(a.x + 8, y);
          ctx.lineTo(a.x + wpx - 8, y);
          ctx.stroke();
          if (el.kind === 'drawerBox') {
            const yb2 = a.y + hpx - ((0.015 + el.y) / r.h) * hpx;
            ctx.strokeRect(a.x + 8, y, wpx - 16, yb2 - y);
          }
        }
        ctx.setLineDash([]);
      }

      if (wpx > 46 && hpx > 26) {
        const caption = leafCaption(r.leaf);
        const size = `${Math.round(r.w * 100)} × ${Math.round(r.h * 100)}`;
        ctx.fillStyle = selHit ? ACCENT : INK;
        ctx.fillText(caption, a.x + wpx / 2, a.y + hpx / 2 - (hpx > 44 ? 7 : 0));
        if (hpx > 44) {
          ctx.fillStyle = SOFT;
          ctx.fillText(size, a.x + wpx / 2, a.y + hpx / 2 + 8);
        }
      }
    }

    // face dimensions
    ctx.fillStyle = SOFT;
    const bl = this.toScreen(0, 0);
    ctx.fillText(fmtCm(v.faceW), bl.x + (v.faceW * v.scale) / 2, bl.y + 14);
    ctx.save();
    ctx.translate(tl.x - 12, tl.y + (v.faceH * v.scale) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(fmtCm(v.faceH), 0, 0);
    ctx.restore();
    fillFooterCaption(
      ctx,
      'cabinet front — click a zone, click or drag a line between zones (Equalize on the toolbar), double-click a zone for its interior',
      cw / 2,
      ch - 12,
      cw - 24
    );
  }
}
