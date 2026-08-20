import { clamp, fmtCm } from '../../model/geometry';
import {
  defaultInterior,
  MAX_AUTO_DRAWERS,
  MAX_AUTO_SHELVES,
  MAX_INTERIOR_ELEMENTS,
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

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const SOFT = '#6f6d67';

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
  private elemSel: number | null = null;
  private elemDrag: number | null = null;

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
    if (this.interiorPath) {
      this.exitInterior();
      return true;
    }
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
    this.elemSel = null;
    this.renderToolbar();
    this.draw();
  }

  private exitInterior(): void {
    this.interiorPath = null;
    this.elemSel = null;
    this.elemDrag = null;
    this.renderToolbar();
    this.draw();
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

  /** Sort + clamp elements back into canonical form after a gesture. */
  private canonicalizeInterior(): void {
    const leaf = this.interiorLeaf();
    const cav = this.interiorCavity();
    if (!leaf || !cav || leaf.interior?.mode !== 'custom') return;
    const selected = this.elemSel !== null ? leaf.interior.elements[this.elemSel] : null;
    leaf.interior = { mode: 'custom', elements: resolveInterior(leaf.interior, cav.h) };
    this.elemSel = selected ? leaf.interior.elements.indexOf(selected) : null;
    if (this.elemSel === -1) this.elemSel = null;
  }

  private addElement(kind: InteriorElement['kind']): void {
    const cav = this.interiorCavity();
    if (!cav) return;
    const custom = this.ensureCustom();
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
    custom.elements.push(
      kind === 'drawerBox'
        ? { kind: 'drawerBox', y: Math.max(0.01, y - 0.075), h: 0.15 }
        : kind === 'rail'
          ? { kind: 'rail', y }
          : { kind: 'shelf', y }
    );
    this.canonicalizeInterior();
    this.elemSel = custom.elements.length - 1;
    this.changed();
  }

  private deleteElement(): void {
    const leaf = this.interiorLeaf();
    if (!leaf || this.elemSel === null) return;
    const custom = this.ensureCustom();
    custom.elements.splice(this.elemSel, 1);
    this.elemSel = null;
    this.changed();
  }

  private resetToEven(): void {
    const leaf = this.interiorLeaf();
    if (!leaf) return;
    const els = this.interiorElements();
    leaf.interior = {
      mode: 'auto',
      shelves: els.filter((e) => e.kind === 'shelf').length,
      innerDrawers: els.filter((e) => e.kind === 'drawerBox').length,
    };
    this.elemSel = null;
    this.changed();
  }

  handleDelete(): boolean {
    if (this.interiorPath) {
      if (this.elemSel === null) return false;
      this.deleteElement();
      return true;
    }
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

  private changed(): void {
    this.renderToolbar();
    this.onChange();
    this.draw();
  }

  /* ---------------- toolbar ---------------- */

  private renderToolbar(): void {
    const tb = this.toolbar;
    tb.innerHTML = '';
    const leaf = this.selectedLeaf();
    const btn = (
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
    if (this.interiorPath) {
      this.renderInteriorToolbar(btn);
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

  private renderInteriorToolbar(
    btn: (
      label: string,
      title: string,
      fn: () => void,
      disabled?: boolean,
      active?: boolean
    ) => HTMLButtonElement
  ): void {
    const tb = this.toolbar;
    const leaf = this.interiorLeaf();
    const cav = this.interiorCavity();
    if (!leaf || !cav) {
      this.exitInterior();
      return;
    }
    btn('← Done', 'Back to the zone layout (Esc)', () => this.exitInterior());
    const sep = document.createElement('span');
    sep.className = 'zone-toolbar-sep';
    tb.appendChild(sep);
    const els = this.interiorElements();
    const full = els.length >= MAX_INTERIOR_ELEMENTS;
    btn('＋ Shelf', 'Add a shelf in the largest free gap', () => this.addElement('shelf'), full);
    btn('＋ Drawer', 'Add an internal drawer box', () => this.addElement('drawerBox'), full);
    btn('＋ Rail', 'Add a wardrobe hanging rail', () => this.addElement('rail'), full);
    btn(
      'Delete',
      'Remove the selected element (Delete)',
      () => this.deleteElement(),
      this.elemSel === null
    );
    // auto spacing only knows shelves and drawers — resetting would drop rails
    const hasRail = els.some((e) => e.kind === 'rail');
    btn(
      'Reset to even',
      hasRail
        ? 'Auto spacing has no rails — delete the hanging rail first'
        : 'Back to even auto-spacing with the same counts',
      () => this.resetToEven(),
      hasRail
    );

    const sel = this.elemSel !== null ? els[this.elemSel] : null;
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
          const custom = this.ensureCustom();
          const el = this.elemSel !== null ? custom.elements[this.elemSel] : null;
          if (!el) return;
          apply(el, clamp(Number(input.value) / 100, 0, cav.h));
          this.canonicalizeInterior();
          this.changed();
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
      const mode = (leaf.interior ?? defaultInterior(leaf.fill))?.mode ?? 'auto';
      hint.textContent =
        mode === 'custom'
          ? 'custom · drag shelves and drawers'
          : 'auto · drag an element to customize';
      tb.appendChild(hint);
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

  /** Interior-mode view: the cavity fills the canvas. */
  private interiorView(): { scale: number; ox: number; oy: number; cav: Cavity } | null {
    const cav = this.interiorCavity();
    if (!cav) return null;
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    const scale = Math.min((cw * 0.7) / cav.w, (ch * 0.7) / cav.h);
    return { scale, ox: (cw - cav.w * scale) / 2, oy: (ch + cav.h * scale) / 2, cav };
  }

  /** pointer → cavity-local coords (x right from cavity left, y up from its bottom) */
  private toCavity(e: MouseEvent): { x: number; y: number } | null {
    const v = this.interiorView();
    if (!v) return null;
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - v.ox) / v.scale, y: (v.oy - (e.clientY - r.top)) / v.scale };
  }

  /** index of the interior element under the pointer, topmost first */
  private hitElement(p: { x: number; y: number }, tol: number): number | null {
    const els = this.interiorElements();
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

  private onDown(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
    }
    if (this.interiorPath) {
      const p = this.toCavity(e);
      const v = this.interiorView();
      if (!p || !v) return;
      this.elemSel = this.hitElement(p, 8 / v.scale);
      this.elemDrag = this.elemSel;
      this.renderToolbar();
      this.draw();
      return;
    }
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
    if (this.interiorPath) {
      if (this.elemDrag !== null) {
        const p = this.toCavity(e);
        const cav = this.interiorCavity();
        if (!p || !cav) return;
        const custom = this.ensureCustom();
        const el = custom.elements[this.elemDrag];
        if (!el) return;
        const snapped = Math.round(p.y * 100) / 100; // 1 cm snap
        // drawer boxes drag by their centre (they have height); every other
        // element is a line at y — branch on the box, never on the lines
        if (el.kind === 'drawerBox') el.y = clamp(snapped - el.h / 2, 0, cav.h - el.h);
        else el.y = clamp(snapped, 0, cav.h);
        // mid-drag: notify so the 3D preview tracks it, but take no undo step —
        // onUp's changed() is the one that commits (WS-SPEC WP 3.1)
        this.onChange(true);
        this.draw();
        return;
      }
      const p = this.toCavity(e);
      const v = this.interiorView();
      const over = p && v ? this.hitElement(p, 8 / v.scale) : null;
      this.canvas.style.cursor = over !== null ? 'ns-resize' : 'default';
      return;
    }
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
    if (this.elemDrag !== null) {
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      this.elemDrag = null;
      this.canonicalizeInterior();
      this.changed();
      return;
    }
    if (!this.drag) return;
    this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.changed();
  }

  /** Double-click: drill into a leaf's interior. Never acts on a divider —
   * equalizing one is a toolbar action now (see `equalizeDivider`). */
  private onDblClick(e: MouseEvent): void {
    if (this.interiorPath) return;
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

  /**
   * Centered footer caption, ellipsized to fit `maxWidth` instead of running
   * off the canvas at narrow Workshop-pane widths. Canvas text has no DOM
   * node to hang a `title` on, so a shortened caption keeps the full string
   * as `canvas.title` — a hover fallback for whatever got cut.
   */
  private fillFooterCaption(text: string, cx: number, y: number, maxWidth: number): void {
    const ctx = this.ctx;
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
      this.canvas.title = text;
    } else if (this.canvas.title) {
      this.canvas.title = '';
    }
    ctx.fillText(fitted, cx, y);
  }

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

    if (this.interiorPath) {
      this.drawInterior(ctx, cw, ch);
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
    this.fillFooterCaption(
      'cabinet front — click a zone, click or drag a line between zones (Equalize on the toolbar), double-click a zone for its interior',
      cw / 2,
      ch - 12,
      cw - 24
    );
  }

  /** Interior drill-in: the cavity full-frame, elements draggable. */
  private drawInterior(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    const v = this.interiorView();
    const leaf = this.interiorLeaf();
    if (!v || !leaf) return;
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

    const els = this.interiorElements();
    els.forEach((e, i) => {
      const active = i === this.elemSel;
      ctx.strokeStyle = active ? ACCENT : SOFT;
      ctx.fillStyle = active ? '#dcebe6' : this.part.accentColor;
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
    this.fillFooterCaption(
      `${leafCaption(leaf)} — interior · drag to move, Esc when done`,
      cw / 2,
      ch - 12,
      cw - 24
    );
  }
}
