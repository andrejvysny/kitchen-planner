import { clamp, fmtCm } from '../model/geometry';
import {
  wallElevation,
  type ElevationFront,
  type WallElevation,
  type WallElevationItem,
} from '../model/elevation';
import type { RoomWall } from '../model/rooms';
import type { EditorState } from '../editor/editorState';
import type { Store } from '../model/store';
import type { Point } from '../model/types';
import { resolveColor } from '../model/variables';
import { drawHingeTick } from './hingeTick';
import { coarsePointer, hitRadius, PinchGesture } from './pinch';

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const WALL_FILL = '#eceae4';
const FLOOR = '#d8d5ce';
/** front-layout strokes sit UNDER the body outline in weight, not over it */
const FRONT_INK = 'rgba(58, 57, 52, 0.55)';
const NICHE_FILL = 'rgba(0, 0, 0, 0.06)';
/** below this many px a front rectangle is noise, not information */
const FRONT_MIN = 6;

/**
 * Straight-on front view of one wall. Renders only the furniture attached to
 * that wall (see model/elevation.ts) so the user can plan a wall's layout —
 * cabinet heights, worktop line, splashback — without the top-view clutter of
 * tables and chairs. Read + select only: clicking an item selects it so the
 * shared properties panel edits it.
 */
export class ElevationView {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private store: Store;
  private editor: EditorState;
  private onWallChange: () => void;

  private wallId: string | null = null;
  private active = false;

  private zoom = 120; // px per meter
  private panX = 0;
  private panY = 0;
  private cssW = 100;
  private cssH = 100;
  private raf = 0;
  private drag: { sx: number; sy: number; panX0: number; panY0: number; moved: boolean } | null =
    null;
  private pinch = new PinchGesture(); // two-finger pinch-zoom / pan (touch)
  private pinching = false; // separate from `drag` (which only ever holds a pan)

  /* ---------------- lifecycle ---------------- */

  /** Aborts every DOM listener registered by the CURRENT attach(); null while detached. */
  private ac: AbortController | null = null;
  private ro: ResizeObserver | null = null;
  /** store.on() disposers of the current attach(), run and cleared by detach(). */
  private subs: (() => void)[] = [];
  private attached = false;

  /**
   * Constructed DETACHED: the canvas arrives from `attach()`, which is what a
   * React ref effect calls once the element is in the document. Nothing here
   * touches the DOM, so the view can be built before the shell renders.
   */
  constructor(store: Store, editor: EditorState, onWallChange: () => void) {
    this.store = store;
    this.editor = editor;
    this.onWallChange = onWallChange;
  }

  /**
   * Bind to `canvas`: DOM listeners, its ResizeObserver and the store
   * subscriptions. Re-attaching the canvas already held is a no-op, so a
   * double-mount (React StrictMode) double-subscribes nothing.
   */
  attach(canvas: HTMLCanvasElement): void {
    if (this.attached && canvas === this.canvas) return;
    if (this.attached) this.detach();

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.attached = true;
    this.ac = new AbortController();
    const { signal } = this.ac;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement!);

    this.subs.push(
      this.store.on('change', () => this.requestDraw()),
      // the nav cycles the ACTIVE room's walls, so a room switch re-resolves it
      this.store.on('activeRoom', () => {
        this.ensureWall();
        this.onWallChange();
        if (this.active) {
          this.fit();
          this.requestDraw();
        }
      }),
      this.editor.subscribeSelection(() => {
        // follow a wall picked in the plan; otherwise just repaint the highlight
        const sel = this.editor.selection;
        if (sel.kind === 'wall' && sel.id !== this.wallId) this.setWall(sel.id);
        else this.requestDraw();
      })
    );

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal });
    canvas.addEventListener(
      'pointercancel',
      (e) => {
        this.pinch.up(e.pointerId);
        this.pinching = false;
        this.drag = null;
        this.canvas.style.cursor = 'default';
      },
      { signal }
    );
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal });
  }

  /**
   * Release everything attach() wired: listeners, observer, subscriptions and
   * any pending frame. Idempotent; the wall selection and viewport survive.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.ac?.abort();
    this.ac = null;
    this.ro?.disconnect();
    this.ro = null;
    for (const off of this.subs) off();
    this.subs = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Permanent teardown. Nothing here is GPU-backed, so it is exactly detach(). */
  dispose(): void {
    this.detach();
  }

  /* ---------------- wall selection ---------------- */

  /** The walls this view cycles: the active room's own ring, in corner order. */
  private walls(): RoomWall[] {
    return this.store.wallsOf(this.store.activeRoomId);
  }

  private ensureWall(): void {
    const walls = this.walls();
    if (!walls.length) {
      this.wallId = null;
      return;
    }
    const cur = this.wallId ? this.store.wallById(this.wallId) : undefined;
    if (cur) {
      if (cur.roomId === this.store.activeRoomId) return;
      // a partition picked from the far side: show this room's own half of it
      if (cur.shared?.roomId === this.store.activeRoomId) {
        this.wallId = cur.shared.wallId;
        return;
      }
    }
    this.wallId = walls[0].id;
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
    const walls = this.walls();
    if (!walls.length) return;
    this.ensureWall();
    const idx = walls.findIndex((w) => w.id === this.wallId);
    const next = walls[(idx + dir + walls.length) % walls.length];
    this.setWall(next.id);
  }

  /** "Wall 2 / 4 · 340 cm" for the pane nav label, room-qualified once there are several. */
  wallLabel(): string {
    const walls = this.walls();
    this.ensureWall();
    const idx = walls.findIndex((w) => w.id === this.wallId);
    if (idx < 0) return 'No wall';
    const activeName = this.store.activeRoom()?.name;
    const room = this.store.design.rooms.length > 1 && activeName ? `${activeName} · ` : '';
    return `${room}Wall ${idx + 1} / ${walls.length} · ${fmtCm(walls[idx].len)}`;
  }

  /** Raw elevation model for the current wall (used by tests). */
  data(): WallElevation | null {
    this.ensureWall();
    return this.wallId ? wallElevation(this.store.design, this.wallId) : null;
  }

  /**
   * Same, plus each custom part's projected front layout. Only `draw()` calls
   * it: fronts cost a `partPanels` run per cabinet, and `hitItem` re-reads the
   * elevation on every pointer move (see `WallElevationOpts`).
   */
  private drawData(): WallElevation | null {
    this.ensureWall();
    return this.wallId ? wallElevation(this.store.design, this.wallId, { fronts: true }) : null;
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
    // touch has no exact-pixel precision; a mouse click keeps the bare rect
    const pad = coarsePointer ? hitRadius(6) / this.zoom : 0;
    // nearest-to-viewer first (reverse of paint order)
    for (let i = data.items.length - 1; i >= 0; i--) {
      const it = data.items[i];
      if (
        t >= it.center - it.halfW - pad &&
        t <= it.center + it.halfW + pad &&
        z >= it.z0 - pad &&
        z <= it.z1 + pad
      ) {
        return it;
      }
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    const s = { x: e.offsetX, y: e.offsetY };
    if (e.pointerType === 'touch') {
      if (this.pinch.down(e.pointerId, s)) {
        // second finger: abandon any single-finger pan/select, start the pinch
        this.drag = null;
        this.pinching = true;
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.pinch.overflowing) return; // ignore extra fingers
    }
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const wpt = this.toWorld(e.offsetX, e.offsetY);
    const hit = this.hitItem(wpt.t, wpt.z);
    if (hit) {
      this.editor.select({ kind: 'item', id: hit.id });
      this.drag = null;
      return;
    }
    this.drag = { sx: e.offsetX, sy: e.offsetY, panX0: this.panX, panY0: this.panY, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const s = { x: e.offsetX, y: e.offsetY };
    if (this.pinch.has(e.pointerId)) this.pinch.track(e.pointerId, s);

    if (this.pinching) {
      const res = this.pinch.step({ zoom: this.zoom, panX: this.panX, panY: this.panY }, 20, 500);
      if (!res) return;
      this.zoom = res.zoom;
      this.panX = res.panX;
      this.panY = res.panY;
      this.requestDraw();
      return;
    }
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
    this.pinch.up(e.pointerId);
    if (this.pinching) {
      // pinch ends when either finger lifts; the remaining finger starts nothing new
      this.pinching = false;
      this.canvas.style.cursor = 'default';
      return;
    }
    if (this.drag && !this.drag.moved) this.editor.select({ kind: 'none' });
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
    if (this.raf || !this.active || !this.attached) return;
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

    const data = this.drawData();
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
    const sel = this.editor.selection;
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

      if (it.front?.length) this.drawFronts(it.front, a, w, h);

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

  /**
   * The part's own doors / drawer fronts / panes / niches inside its body
   * rectangle, projected from the panel IR (src/model/elevation.ts). Clipped to
   * the body, so a worktop overhang or a chamfer's wider shadow can never bleed
   * over a neighbour, and anything under FRONT_MIN px is dropped rather than
   * drawn as a smudge — a carcass side reads as a line at any useful zoom.
   */
  private drawFronts(fronts: ElevationFront[], a: Point, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(a.x, a.y, w, h);
    ctx.clip();
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = FRONT_INK;
    for (const f of fronts) {
      const p = this.toScreen(f.t0, f.z1);
      const fw = (f.t1 - f.t0) * this.zoom;
      const fh = (f.z1 - f.z0) * this.zoom;
      if (fw < FRONT_MIN || fh < FRONT_MIN) continue;
      if (f.kind === 'niche') {
        ctx.fillStyle = NICHE_FILL;
        ctx.fillRect(p.x, p.y, fw, fh);
      }
      // the inner sliding lane sits BEHIND the outer one — fade it back
      ctx.globalAlpha = f.slide === 0 ? 0.85 : 1;
      ctx.strokeRect(p.x, p.y, fw, fh);
      if (f.kind === 'glass') {
        ctx.beginPath();
        ctx.moveTo(p.x + 3, p.y + 3);
        ctx.lineTo(p.x + fw - 3, p.y + fh - 3);
        ctx.moveTo(p.x + fw - 3, p.y + 3);
        ctx.lineTo(p.x + 3, p.y + fh - 3);
        ctx.stroke();
      }
      if (f.hinge) drawHingeTick(ctx, p.x, p.y, fw, fh, f.hinge);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
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
    ctx.fillText(
      `${fmtCm(data.len)} · ceiling ${fmtCm(data.height)}`,
      p0.x + (data.len * this.zoom) / 2,
      p0.y + 0.14 * this.zoom
    );
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
