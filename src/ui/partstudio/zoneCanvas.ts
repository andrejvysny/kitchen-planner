import { fmtCm } from '../../model/geometry';
import type { CabinetPartDef, LeafZone, Zone, ZoneFill } from '../../model/types';
import {
  countLeaves,
  MAX_DEPTH,
  MAX_LEAVES,
  mergeZone,
  normalizeZones,
  setDivider,
  splitZone,
  walkZones,
  zoneAtPath,
  zoneAtPoint,
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
};

function leafCaption(leaf: LeafZone): string {
  if (leaf.fill === 'drawers') return `${leaf.drawers ?? 1} drawer${(leaf.drawers ?? 1) > 1 ? 's' : ''}`;
  if (leaf.fill === 'open') return `open · ${leaf.shelves ?? 0} shelf${(leaf.shelves ?? 0) === 1 ? '' : 's'}`;
  return FILL_LABELS[leaf.fill].toLowerCase();
}

/** The front face the zones live on (matches the mesh builder's body math). */
export function faceSize(part: CabinetPartDef): { faceW: number; faceH: number } {
  const wallMounted = part.elevation > 0.3;
  const topT = part.worktop ? 0.035 : 0;
  const y0 = !wallMounted && part.plinth ? 0.1 : 0;
  const fp = part.footprint;
  let faceW = part.w;
  if (fp.kind === 'chamfer') faceW = fp.face === 'angled' ? Math.hypot(fp.cx, fp.cz) : part.w - fp.cx;
  else if (fp.kind === 'cornerL') faceW = part.w - fp.nw;
  return { faceW: Math.max(0.1, faceW), faceH: Math.max(0.1, part.h - y0 - topT) };
}

interface DividerLine {
  path: number[];
  index: number;
  dir: 'h' | 'v';
  /** face coords of the divider segment */
  x: number;
  y: number;
  len: number;
  /** rect of the owning split, for drag fractions */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

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
  private onChange: () => void;
  private drag: DividerLine | null = null;
  selection: number[] | null = null;

  constructor(container: HTMLElement, part: CabinetPartDef, onChange: () => void) {
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

    const ro = new ResizeObserver(() => this.draw());
    ro.observe(container);
    this.renderToolbar();
    this.draw();
  }

  /* ---------------- selection + edits ---------------- */

  private selectedLeaf(): LeafZone | null {
    if (!this.selection) return null;
    const z = zoneAtPath(this.part.face, this.selection);
    return z && z.kind === 'leaf' ? z : null;
  }

  handleEscape(): boolean {
    if (this.selection) {
      this.selection = null;
      this.renderToolbar();
      this.draw();
      return true;
    }
    return false;
  }

  handleDelete(): boolean {
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

  private setFill(fill: ZoneFill): void {
    const leaf = this.selectedLeaf();
    if (!leaf) return;
    leaf.fill = fill;
    if (fill === 'drawers' && !leaf.drawers) leaf.drawers = 2;
    if (fill === 'open' && leaf.shelves === undefined) leaf.shelves = 1;
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
    const btn = (label: string, title: string, fn: () => void, disabled = false, active = false) => {
      const b = document.createElement('button');
      b.className = `btn choice-btn${active ? ' active' : ''}`;
      b.textContent = label;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      tb.appendChild(b);
      return b;
    };
    const canSplit =
      !!leaf &&
      countLeaves(this.part.face) < MAX_LEAVES &&
      (this.selection?.length ?? 0) + 1 <= MAX_DEPTH;
    btn('⬍ Split', 'Split the zone into top + bottom', () => this.split('h'), !canSplit);
    btn('⬌ Split', 'Split the zone into left + right', () => this.split('v'), !canSplit);
    btn('Merge', 'Merge this zone back into its neighbours (Delete)', () => this.merge(), !leaf || !this.selection?.length);

    const sep = document.createElement('span');
    sep.className = 'zone-toolbar-sep';
    tb.appendChild(sep);

    if (!leaf) {
      const hint = document.createElement('span');
      hint.className = 'studio-caption';
      hint.textContent = 'Click a zone to edit it.';
      tb.appendChild(hint);
      return;
    }
    for (const fill of Object.keys(FILL_LABELS) as ZoneFill[]) {
      btn(FILL_LABELS[fill], `Fill this zone with: ${FILL_LABELS[fill].toLowerCase()}`, () => this.setFill(fill), false, leaf.fill === fill);
    }
    const stepper = (label: string, get: () => number, set: (v: number) => void, min: number, max: number) => {
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
    if (leaf.fill === 'drawers') {
      stepper('Drawers', () => leaf.drawers ?? 2, (v) => (leaf.drawers = v), 1, 5);
    }
    if (leaf.fill === 'open') {
      stepper('Shelves', () => leaf.shelves ?? 1, (v) => (leaf.shelves = v), 0, 4);
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
    const out: DividerLine[] = [];
    const visit = (z: Zone, x: number, y: number, w: number, h: number, path: number[]): void => {
      if (z.kind === 'leaf') return;
      const total = z.weights.reduce((s, v) => s + v, 0) || 1;
      let off = 0;
      for (let i = 0; i < z.children.length; i++) {
        const frac = (z.weights[i] ?? 0) / total;
        const cx = z.dir === 'v' ? x + off * w : x;
        const cy = z.dir === 'h' ? y + off * h : y;
        const cw = z.dir === 'v' ? frac * w : w;
        const chh = z.dir === 'h' ? frac * h : h;
        if (i > 0) {
          out.push(
            z.dir === 'v'
              ? { path, index: i - 1, dir: 'v', x: cx, y, len: h, rx: x, ry: y, rw: w, rh: h }
              : { path, index: i - 1, dir: 'h', x, y: cy, len: w, rx: x, ry: y, rw: w, rh: h }
          );
        }
        visit(z.children[i], cx, cy, cw, chh, [...path, i]);
        off += frac;
      }
    };
    visit(this.part.face, 0, 0, faceW, faceH, []);
    return out;
  }

  /* ---------------- pointers ---------------- */

  private onDown(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
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
        return;
      }
    }
    const z = zoneAtPoint(this.part.face, v.faceW, v.faceH, f.x, f.y);
    this.selection = z ? z.path : null;
    this.renderToolbar();
    this.draw();
  }

  private onMove(e: PointerEvent): void {
    if (this.drag) {
      const f = this.toFace(e);
      const d = this.drag;
      // 1 cm snapping on the cut position
      const pos = d.dir === 'v' ? f.x - d.rx : f.y - d.ry;
      const extent = d.dir === 'v' ? d.rw : d.rh;
      const frac = Math.round(pos * 100) / 100 / extent;
      setDivider(this.part.face, d.path, d.index, frac);
      this.onChange();
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
    if (!this.drag) return;
    this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
    this.changed();
  }

  /** Double-click a divider: equalize the whole split. */
  private onDblClick(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view();
    const f = { x: (e.clientX - r.left - v.ox) / v.scale, y: (v.oy - (e.clientY - r.top)) / v.scale };
    const hit = 6 / v.scale;
    for (const d of this.dividers()) {
      const near =
        d.dir === 'v'
          ? Math.abs(f.x - d.x) < hit
          : Math.abs(f.y - d.y) < hit;
      if (!near) continue;
      const split = zoneAtPath(this.part.face, d.path);
      if (split && split.kind === 'split') {
        split.weights = split.weights.map(() => 1 / split.weights.length);
        this.changed();
      }
      return;
    }
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
        const n = Math.max(1, r.leaf.shelves ?? 1);
        ctx.setLineDash([4, 3]);
        for (let i = 1; i <= n; i++) {
          const y = a.y + (hpx * i) / (n + 1);
          ctx.beginPath();
          ctx.moveTo(a.x + 8, y);
          ctx.lineTo(a.x + wpx - 8, y);
          ctx.stroke();
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
    ctx.fillText('cabinet front — click a zone, drag the lines between zones', cw / 2, ch - 12);
  }
}
