import { fmtCm, pointInPolygon, polygonBounds, polygonIsSimple, signedArea } from '../../model/geometry';
import { MAX_OUTLINE_POINTS } from '../../model/parts';
import type { BoardPartDef, Point } from '../../model/types';

type PolySelection =
  | { kind: 'corner'; i: number }
  | { kind: 'hole'; i: number }
  | { kind: 'none' };

type PolyDrag =
  | { kind: 'corner'; i: number }
  | { kind: 'hole-move'; i: number; dx: number; dy: number }
  | { kind: 'hole-size'; i: number }
  | { kind: 'none' };

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const BAD = '#b3423a';

/**
 * 2D editor for a board part's outline + cutouts. Same interaction language
 * as the room editor: drag ■ corners (1 cm snap, axis-lock to neighbours),
 * drag ◆ edge midpoints to insert a corner, cm labels on every edge.
 */
export class PolygonCanvas {
  private part: BoardPartDef;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onChange: () => void;
  private drag: PolyDrag = { kind: 'none' };
  selection: PolySelection = { kind: 'none' };
  onSelect: (() => void) | null = null;

  constructor(container: HTMLElement, part: BoardPartDef, onChange: () => void) {
    this.part = part;
    this.onChange = onChange;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'poly-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));

    const ro = new ResizeObserver(() => this.draw());
    ro.observe(container);
    this.draw();
  }

  /** True when the current outline + holes are usable. */
  valid(): string | null {
    if (this.part.outline.length < 3) return 'The outline needs at least 3 corners.';
    if (!polygonIsSimple(this.part.outline)) return 'The outline crosses itself.';
    for (const h of this.part.holes) {
      const pts = this.holeCorners(h);
      if (!pts.every((p) => pointInPolygon(p, this.part.outline))) {
        return 'Cutouts must stay inside the top.';
      }
    }
    return null;
  }

  addHole(): void {
    this.part.holes.push({ x: 0, y: 0, w: 0.4, d: 0.35 });
    this.selection = { kind: 'hole', i: this.part.holes.length - 1 };
    this.changed();
  }

  deleteSelected(): boolean {
    if (this.selection.kind === 'corner' && this.part.outline.length > 3) {
      this.part.outline.splice(this.selection.i, 1);
      this.selection = { kind: 'none' };
      this.changed();
      return true;
    }
    if (this.selection.kind === 'hole') {
      this.part.holes.splice(this.selection.i, 1);
      this.selection = { kind: 'none' };
      this.changed();
      return true;
    }
    return false;
  }

  clearSelection(): boolean {
    if (this.selection.kind === 'none') return false;
    this.selection = { kind: 'none' };
    this.changed();
    return true;
  }

  private changed(): void {
    this.onSelect?.();
    this.onChange();
    this.draw();
  }

  private holeCorners(h: { x: number; y: number; w: number; d: number }): Point[] {
    return [
      { x: h.x - h.w / 2, y: h.y - h.d / 2 },
      { x: h.x + h.w / 2, y: h.y - h.d / 2 },
      { x: h.x + h.w / 2, y: h.y + h.d / 2 },
      { x: h.x - h.w / 2, y: h.y + h.d / 2 },
    ];
  }

  /* ---------------- view transform ---------------- */

  private view(): { scale: number; ox: number; oy: number } {
    const b = polygonBounds(this.part.outline);
    const w = Math.max(0.3, b.maxX - b.minX);
    const d = Math.max(0.3, b.maxY - b.minY);
    const cw = this.canvas.clientWidth || 400;
    const ch = this.canvas.clientHeight || 400;
    const scale = Math.min((cw * 0.78) / w, (ch * 0.78) / d);
    return {
      scale,
      ox: cw / 2 - ((b.minX + b.maxX) / 2) * scale,
      oy: ch / 2 - ((b.minY + b.maxY) / 2) * scale,
    };
  }

  private toScreen(p: Point): Point {
    const v = this.view();
    return { x: p.x * v.scale + v.ox, y: p.y * v.scale + v.oy };
  }

  private toWorld(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    const v = this.view();
    return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale };
  }

  private snap(v: number): number {
    return Math.round(v * 100) / 100;
  }

  /* ---------------- pointers ---------------- */

  private onDown(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
    }
    const w = this.toWorld(e);
    const v = this.view();
    const hit = 9 / v.scale;
    const o = this.part.outline;

    for (let i = 0; i < o.length; i++) {
      if (Math.hypot(o[i].x - w.x, o[i].y - w.y) < hit) {
        this.selection = { kind: 'corner', i };
        this.drag = { kind: 'corner', i };
        this.changed();
        return;
      }
    }
    for (let i = 0; i < this.part.holes.length; i++) {
      const h = this.part.holes[i];
      const corner = { x: h.x + h.w / 2, y: h.y + h.d / 2 };
      if (Math.hypot(corner.x - w.x, corner.y - w.y) < hit) {
        this.selection = { kind: 'hole', i };
        this.drag = { kind: 'hole-size', i };
        this.changed();
        return;
      }
      if (Math.abs(w.x - h.x) < h.w / 2 && Math.abs(w.y - h.y) < h.d / 2) {
        this.selection = { kind: 'hole', i };
        this.drag = { kind: 'hole-move', i, dx: w.x - h.x, dy: w.y - h.y };
        this.changed();
        return;
      }
    }
    if (o.length < MAX_OUTLINE_POINTS) {
      for (let i = 0; i < o.length; i++) {
        const b = o[(i + 1) % o.length];
        const mid = { x: (o[i].x + b.x) / 2, y: (o[i].y + b.y) / 2 };
        if (Math.hypot(mid.x - w.x, mid.y - w.y) < hit) {
          o.splice(i + 1, 0, { x: this.snap(mid.x), y: this.snap(mid.y) });
          this.selection = { kind: 'corner', i: i + 1 };
          this.drag = { kind: 'corner', i: i + 1 };
          this.changed();
          return;
        }
      }
    }
    if (this.selection.kind !== 'none') {
      this.selection = { kind: 'none' };
      this.changed();
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.drag.kind === 'none') return;
    const w = this.toWorld(e);
    if (this.drag.kind === 'corner') {
      const o = this.part.outline;
      const c = o[this.drag.i];
      let x = this.snap(w.x);
      let y = this.snap(w.y);
      // axis-lock: snap to a neighbour's x/y when close (orthogonal outlines stay orthogonal)
      const v = this.view();
      const lock = 7 / v.scale;
      for (const n of [o[(this.drag.i + o.length - 1) % o.length], o[(this.drag.i + 1) % o.length]]) {
        if (Math.abs(n.x - x) < lock) x = n.x;
        if (Math.abs(n.y - y) < lock) y = n.y;
      }
      c.x = x;
      c.y = y;
    } else if (this.drag.kind === 'hole-move') {
      const h = this.part.holes[this.drag.i];
      h.x = this.snap(w.x - this.drag.dx);
      h.y = this.snap(w.y - this.drag.dy);
    } else {
      const h = this.part.holes[this.drag.i];
      h.w = Math.max(0.05, this.snap((w.x - h.x) * 2));
      h.d = Math.max(0.05, this.snap((w.y - h.y) * 2));
    }
    this.onChange();
    this.draw();
  }

  private onUp(e: PointerEvent): void {
    if (this.drag.kind === 'none') return;
    this.canvas.releasePointerCapture(e.pointerId);
    this.drag = { kind: 'none' };
    if (signedArea(this.part.outline) < 0) this.part.outline.reverse();
    this.changed();
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

    const o = this.part.outline;
    if (o.length < 3) return;
    const bad = this.valid() !== null;
    const pts = o.map((p) => this.toScreen(p));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = this.part.color;
    ctx.globalAlpha = 0.45;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = bad ? BAD : INK;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // edge labels + ◆ midpoints
    ctx.font = '11px system-ui, sans-serif';
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const wa = o[i];
      const wb = o[(i + 1) % o.length];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      const text = fmtCm(Math.hypot(wb.x - wa.x, wb.y - wa.y));
      ctx.fillStyle = '#f4f3f0';
      const tw = ctx.measureText(text).width;
      ctx.fillRect(mx + nx * 16 - tw / 2 - 3, my + ny * 16 - 8, tw + 6, 15);
      ctx.fillStyle = '#6f6d67';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, mx + nx * 16, my + ny * 16);

      if (o.length < MAX_OUTLINE_POINTS) {
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1;
        ctx.fillRect(-4, -4, 8, 8);
        ctx.strokeRect(-4, -4, 8, 8);
        ctx.restore();
      }
    }

    // ■ corners
    for (let i = 0; i < pts.length; i++) {
      const selHit = this.selection.kind === 'corner' && this.selection.i === i;
      ctx.fillStyle = selHit ? ACCENT : '#fff';
      ctx.strokeStyle = selHit ? ACCENT : INK;
      ctx.lineWidth = 1.4;
      ctx.fillRect(pts[i].x - 5, pts[i].y - 5, 10, 10);
      ctx.strokeRect(pts[i].x - 5, pts[i].y - 5, 10, 10);
    }

    // holes
    for (let i = 0; i < this.part.holes.length; i++) {
      const h = this.part.holes[i];
      const selHit = this.selection.kind === 'hole' && this.selection.i === i;
      const a = this.toScreen({ x: h.x - h.w / 2, y: h.y - h.d / 2 });
      const b = this.toScreen({ x: h.x + h.w / 2, y: h.y + h.d / 2 });
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = selHit ? ACCENT : INK;
      ctx.lineWidth = selHit ? 1.8 : 1.2;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
      ctx.fillStyle = '#f4f3f0';
      ctx.globalAlpha = 0.8;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = selHit ? ACCENT : '#fff';
      ctx.strokeStyle = selHit ? ACCENT : INK;
      ctx.fillRect(b.x - 5, b.y - 5, 10, 10);
      ctx.strokeRect(b.x - 5, b.y - 5, 10, 10);
    }

    // front marker (bottom edge of the canvas = +y = front)
    ctx.fillStyle = '#a09d95';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('front edge ▾', cw / 2, ch - 10);
  }
}
