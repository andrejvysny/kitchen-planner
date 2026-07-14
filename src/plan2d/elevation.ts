import { clamp, fmtCm } from '../model/geometry';
import { wallElevation, type WallElevation, type WallElevationItem } from '../model/elevation';
import type { Store } from '../model/store';
import type { Point } from '../model/types';
import { resolveColor } from '../model/variables';

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const WALL_FILL = '#eceae4';
const FLOOR = '#d8d5ce';

/**
 * Straight-on front view of one wall. Renders only the furniture attached to
 * that wall (see model/elevation.ts) so the user can plan a wall's layout —
 * cabinet heights, worktop line, splashback — without the top-view clutter of
 * tables and chairs. Read + select only: clicking an item selects it so the
 * shared properties panel edits it.
 */
export class ElevationView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private store: Store;
  private onWallChange: () => void;

  private wallId: string | null = null;
  private active = false;

  private zoom = 120; // px per meter
  private panX = 0;
  private panY = 0;
  private cssW = 100;
  private cssH = 100;
  private raf = 0;
  private drag: { sx: number; sy: number; panX0: number; panY0: number; moved: boolean } | null = null;

  constructor(canvas: HTMLCanvasElement, store: Store, onWallChange: () => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.store = store;
    this.onWallChange = onWallChange;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);

    store.on('change', () => this.requestDraw());
    store.on('selection', () => {
      // follow a wall picked in the plan; otherwise just repaint the highlight
      const sel = this.store.selection;
      if (sel.kind === 'wall' && sel.id !== this.wallId) this.setWall(sel.id);
      else this.requestDraw();
    });

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  /* ---------------- wall selection ---------------- */

  private ensureWall(): void {
    const walls = this.store.walls();
    if (!walls.length) {
      this.wallId = null;
      return;
    }
    if (!this.wallId || !walls.some((w) => w.id === this.wallId)) this.wallId = walls[0].id;
  }

  setWall(id: string): void {
    this.wallId = id;
    this.onWallChange();
    if (this.active) {
      this.fit();
      this.requestDraw();
    }
  }

  stepWall(dir: 1 | -1): void {
    const walls = this.store.walls();
    if (!walls.length) return;
    this.ensureWall();
    const idx = walls.findIndex((w) => w.id === this.wallId);
    const next = walls[(idx + dir + walls.length) % walls.length];
    this.setWall(next.id);
  }

  /** "Wall 2 / 4 · 340 cm" for the pane nav label. */
  wallLabel(): string {
    const walls = this.store.walls();
    this.ensureWall();
    const idx = walls.findIndex((w) => w.id === this.wallId);
    if (idx < 0) return 'No wall';
    return `Wall ${idx + 1} / ${walls.length} · ${fmtCm(walls[idx].len)}`;
  }

  /** Raw elevation model for the current wall (used by tests). */
  data(): WallElevation | null {
    this.ensureWall();
    return this.wallId ? wallElevation(this.store.design, this.wallId) : null;
  }

  /* ---------------- activation ---------------- */

  setActive(on: boolean): void {
    this.active = on;
    if (on) {
      this.ensureWall();
      this.onWallChange();
      this.resize();
      this.fit();
      this.requestDraw();
    }
  }

  /* ---------------- viewport ---------------- */

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = parent.clientWidth || 100;
    this.cssH = parent.clientHeight || 100;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.requestDraw();
  }

  /** Fit the current wall (length × ceiling height) into the canvas. */
  private fit(): void {
    const data = this.data();
    if (!data || this.cssW < 20) return;
    const pad = 0.6;
    const w = data.len + pad * 2;
    const h = data.height + pad * 2;
    this.zoom = clamp(Math.min(this.cssW / w, this.cssH / h), 20, 400);
    this.panX = this.cssW / 2 - (data.len / 2) * this.zoom;
    // world height z runs up; screen y runs down, so the floor (z=0) sits low
    this.panY = this.cssH / 2 + (data.height / 2) * this.zoom;
  }

  /** world (along-wall t, height z) → screen px */
  private toScreen(t: number, z: number): Point {
    return { x: t * this.zoom + this.panX, y: this.panY - z * this.zoom };
  }

  private toWorld(sx: number, sy: number): { t: number; z: number } {
    return { t: (sx - this.panX) / this.zoom, z: (this.panY - sy) / this.zoom };
  }

  /* ---------------- interaction ---------------- */

  private hitItem(t: number, z: number): WallElevationItem | null {
    const data = this.data();
    if (!data) return null;
    // nearest-to-viewer first (reverse of paint order)
    for (let i = data.items.length - 1; i >= 0; i--) {
      const it = data.items[i];
      if (t >= it.center - it.halfW && t <= it.center + it.halfW && z >= it.z0 && z <= it.z1) {
        return it;
      }
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const wpt = this.toWorld(e.offsetX, e.offsetY);
    const hit = this.hitItem(wpt.t, wpt.z);
    if (hit) {
      this.store.select({ kind: 'item', id: hit.id });
      this.drag = null;
      return;
    }
    this.drag = { sx: e.offsetX, sy: e.offsetY, panX0: this.panX, panY0: this.panY, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.drag) {
      this.panX = this.drag.panX0 + (e.offsetX - this.drag.sx);
      this.panY = this.drag.panY0 + (e.offsetY - this.drag.sy);
      this.drag.moved = true;
      this.canvas.style.cursor = 'grabbing';
      this.requestDraw();
      return;
    }
    const wpt = this.toWorld(e.offsetX, e.offsetY);
    this.canvas.style.cursor = this.hitItem(wpt.t, wpt.z) ? 'pointer' : 'default';
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.drag && !this.drag.moved) this.store.select({ kind: 'none' });
    this.drag = null;
    this.canvas.style.cursor = 'default';
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const before = this.toWorld(e.offsetX, e.offsetY);
    this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0011), 20, 500);
    this.panX = e.offsetX - before.t * this.zoom;
    this.panY = e.offsetY + before.z * this.zoom;
    this.requestDraw();
  }

  /* ---------------- drawing ---------------- */

  requestDraw(): void {
    if (this.raf || !this.active) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#f4f3f0';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const data = this.data();
    if (!data) {
      this.drawEmpty('Add a wall to see its elevation');
      return;
    }

    const p0 = this.toScreen(0, 0);
    const wallW = data.len * this.zoom;
    const wallH = data.height * this.zoom;

    // ---- floor band below the wall ----
    ctx.fillStyle = FLOOR;
    ctx.fillRect(p0.x - 0.6 * this.zoom, p0.y, wallW + 1.2 * this.zoom, 0.6 * this.zoom);

    // ---- wall face ----
    ctx.fillStyle = WALL_FILL;
    ctx.fillRect(p0.x, p0.y - wallH, wallW, wallH);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p0.x, p0.y - wallH, wallW, wallH);

    // ---- openings (doors / windows cut into the wall) ----
    for (const o of data.openings) {
      const a = this.toScreen(o.center - o.width / 2, o.z1);
      const w = o.width * this.zoom;
      const h = (o.z1 - o.z0) * this.zoom;
      ctx.fillStyle = o.type === 'window' ? '#dbe7ef' : '#f4f3f0';
      ctx.fillRect(a.x, a.y, w, h);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(a.x, a.y, w, h);
      if (o.type === 'window') {
        ctx.beginPath();
        ctx.moveTo(a.x + w / 2, a.y);
        ctx.lineTo(a.x + w / 2, a.y + h);
        ctx.moveTo(a.x, a.y + h / 2);
        ctx.lineTo(a.x + w, a.y + h / 2);
        ctx.stroke();
      }
    }

    // ---- items (front rectangles) ----
    const sel = this.store.selection;
    for (const it of data.items) {
      const a = this.toScreen(it.center - it.halfW, it.z1);
      const w = it.halfW * 2 * this.zoom;
      const h = (it.z1 - it.z0) * this.zoom;
      const selected = sel.kind === 'item' && sel.id === it.id;
      ctx.fillStyle = resolveColor(this.store.design, it.color);
      ctx.globalAlpha = 0.92;
      ctx.fillRect(a.x, a.y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = selected ? ACCENT : INK;
      ctx.lineWidth = selected ? 2.4 : 1.1;
      ctx.strokeRect(a.x, a.y, w, h);

      const label = this.store.defOf(it.defId).label;
      if (w > 44) this.drawItemLabel(a.x + w / 2, a.y + h / 2, label, selected);
    }

    // ---- floor line + height ticks ----
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p0.x - 0.6 * this.zoom, p0.y);
    ctx.lineTo(p0.x + wallW + 0.6 * this.zoom, p0.y);
    ctx.stroke();

    this.drawDimension(p0, data);
  }

  private drawItemLabel(cx: number, cy: number, text: string, selected: boolean): void {
    const ctx = this.ctx;
    ctx.font = `${selected ? 600 : 500} 11px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(244, 243, 240, 0.85)';
    ctx.strokeText(text, cx, cy);
    ctx.fillStyle = selected ? ACCENT : INK;
    ctx.fillText(text, cx, cy);
  }

  /** wall length label centred below the floor line */
  private drawDimension(p0: Point, data: WallElevation): void {
    const ctx = this.ctx;
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#8a877f';
    ctx.fillText(`${fmtCm(data.len)} · ceiling ${fmtCm(data.height)}`, p0.x + (data.len * this.zoom) / 2, p0.y + 0.14 * this.zoom);
  }

  private drawEmpty(msg: string): void {
    const ctx = this.ctx;
    ctx.font = '500 13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#a09d95';
    ctx.fillText(msg, this.cssW / 2, this.cssH / 2);
  }
}
