import { isWallMounted, snapsToWall, type CatalogDef } from '../model/catalog';
import {
  clamp,
  distToSegment,
  fmtCm,
  pointInPolygon,
  pointInRect,
  polygonCentroid,
  projectOnWall,
  rot,
  wallPoint,
} from '../model/geometry';
import { footprintPolygon } from '../model/parts';
import { nearestWall, snapItem, type Guide } from '../model/snapping';
import type { Store } from '../model/store';
import type { CustomPartDef, Item, Opening, Point } from '../model/types';
import { drawPlanSymbol, isOverhead } from './symbols';

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const GUIDE = '#c26d3f';

interface Label {
  x: number;
  y: number;
  text: string;
  angle?: number;
  color?: string;
  size?: number;
  bold?: boolean;
}

type Drag =
  | { type: 'none' }
  | { type: 'maybe-pan'; sx: number; sy: number; panX0: number; panY0: number; moved: boolean }
  | { type: 'pan'; sx: number; sy: number; panX0: number; panY0: number }
  | { type: 'maybe-split'; wallId: string; sx: number; sy: number }
  | { type: 'pinch'; lastDist: number; lastMid: Point }
  | { type: 'item'; id: string; ox: number; oy: number; moved: boolean; cycleTo?: string | null }
  | { type: 'corner'; id: string }
  | { type: 'opening'; id: string }
  | { type: 'rotate'; id: string };

export class Plan2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private store: Store;
  private onHint: (hint: string) => void;

  private zoom = 90; // px per meter
  private panX = 60;
  private panY = 60;
  private cssW = 100;
  private cssH = 100;

  armedDef: CatalogDef | null = null;
  onArmedChange: (() => void) | null = null;

  private ghost: { x: number; y: number; rotation: number; valid: boolean } | null = null;
  private ghostOpening: { wallId: string; t: number; valid: boolean } | null = null;
  private drag: Drag = { type: 'none' };
  private pointers = new Map<number, Point>(); // active pointers, for touch pinch/pan
  private guides: Guide[] = [];
  private pointerWorld: Point = { x: 0, y: 0 };
  private raf = 0;
  private fitted = false;

  constructor(canvas: HTMLCanvasElement, store: Store, onHint: (hint: string) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.store = store;
    this.onHint = onHint;

    const parent = canvas.parentElement!;
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();

    store.on('change', () => this.requestDraw());
    store.on('selection', () => {
      this.updateHint();
      this.requestDraw();
    });

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      this.endGesture();
    });
    canvas.addEventListener('pointerleave', () => {
      if (this.drag.type === 'none') {
        this.ghost = null;
        this.ghostOpening = null;
        this.requestDraw();
      }
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.updateHint();
  }

  /* ---------------- viewport ---------------- */

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = parent.clientWidth || 100;
    this.cssH = parent.clientHeight || 100;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    if (!this.fitted && this.cssW > 150) {
      this.zoomFit();
      this.fitted = true;
    }
    this.requestDraw();
  }

  zoomFit(): void {
    const c = this.store.design.corners;
    if (!c.length) return;
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    const minX = Math.min(...xs) - 0.9;
    const maxX = Math.max(...xs) + 0.9;
    const minY = Math.min(...ys) - 0.9;
    const maxY = Math.max(...ys) + 0.9;
    this.zoom = clamp(Math.min(this.cssW / (maxX - minX), this.cssH / (maxY - minY)), 15, 300);
    this.panX = this.cssW / 2 - ((minX + maxX) / 2) * this.zoom;
    this.panY = this.cssH / 2 - ((minY + maxY) / 2) * this.zoom;
    this.requestDraw();
  }

  zoomBy(f: number): void {
    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const before = this.toWorld(cx, cy);
    this.zoom = clamp(this.zoom * f, 15, 400);
    this.panX = cx - before.x * this.zoom;
    this.panY = cy - before.y * this.zoom;
    this.requestDraw();
  }

  private toWorld(sx: number, sy: number): Point {
    return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom };
  }

  private toScreen(p: Point): Point {
    return { x: p.x * this.zoom + this.panX, y: p.y * this.zoom + this.panY };
  }

  /* ---------------- arming (placement from catalog) ---------------- */

  setArmed(def: CatalogDef | null): void {
    this.armedDef = def;
    this.ghost = null;
    this.ghostOpening = null;
    this.canvas.style.cursor = def ? 'crosshair' : 'default';
    this.updateHint();
    this.onArmedChange?.();
    this.requestDraw();
  }

  /* ---------------- hints ---------------- */

  private updateHint(): void {
    if (this.armedDef) {
      if (this.armedDef.opening) {
        this.onHint(`Click on a wall to place the ${this.armedDef.label.toLowerCase()} · Esc cancels`);
      } else if (this.armedDef.marker) {
        this.onHint(`Click near a wall to mark the ${this.armedDef.label.toLowerCase()} · Shift places several · Esc cancels`);
      } else {
        this.onHint('Click to place · items snap to walls and neighbours · Shift places several · Esc cancels');
      }
      return;
    }
    const sel = this.store.selection;
    switch (sel.kind) {
      case 'item':
        this.onHint('Drag to move · click again for the item underneath · R rotates · arrows nudge · Ctrl+D duplicates · Delete removes');
        break;
      case 'corner':
        this.onHint('Drag the corner to reshape the room · Delete removes it');
        break;
      case 'wall':
        this.onHint('Edit the wall length in the panel · drag ◆ on a wall to bend it · double-click adds a corner');
        break;
      case 'opening':
        this.onHint('Drag to slide along the wall · size it in the panel · Delete removes');
        break;
      default:
        this.onHint('Drag corners to reshape the room · pick items from the left · scroll zooms, drag empty space pans');
    }
  }

  /* ---------------- pointer handling ---------------- */

  private hitCorner(s: Point): string | null {
    for (const c of this.store.design.corners) {
      const cs = this.toScreen(c);
      if (Math.hypot(cs.x - s.x, cs.y - s.y) < 9) return c.id;
    }
    return null;
  }

  private hitMidpoint(s: Point): string | null {
    for (const w of this.store.walls()) {
      const m = this.toScreen(wallPoint(w, w.len / 2));
      if (Math.hypot(m.x - s.x, m.y - s.y) < 8) return w.id;
    }
    return null;
  }

  private hitRotateHandle(s: Point): string | null {
    const sel = this.store.selection;
    if (sel.kind !== 'item') return null;
    const it = this.store.itemById(sel.id);
    if (!it) return null;
    const h = this.rotateHandlePos(it);
    const hs = this.toScreen(h);
    if (Math.hypot(hs.x - s.x, hs.y - s.y) < 9) return it.id;
    return null;
  }

  private rotateHandlePos(it: Item): Point {
    const r = 0.22 + it.d / 2;
    return {
      x: it.x - Math.sin(it.rotation) * r,
      y: it.y + Math.cos(it.rotation) * r,
    };
  }

  private hitOpening(w: Point): Opening | null {
    const t = this.store.design.room.wallThickness;
    for (const o of this.store.design.openings) {
      const g = this.store.wallById(o.wallId);
      if (!g) continue;
      const pr = projectOnWall(g, w);
      if (Math.abs(pr.side) < t / 2 + 8 / this.zoom && Math.abs(pr.t - o.offset) < o.width / 2) {
        return o;
      }
    }
    return null;
  }

  /** The item's true plan outline (custom parts only), in item-local coords. */
  private footprintOf(it: Item): Point[] | null {
    const part = this.store.customPartById(it.defId);
    return part ? footprintPolygon(part, it.w, it.d) : null;
  }

  private partOf(it: Item): CustomPartDef | undefined {
    return this.store.customPartById(it.defId);
  }

  /** all items under the point, top-most first (reverse of draw order) */
  private hitItems(w: Point): Item[] {
    const out: Item[] = [];
    for (const it of [...this.sortedItems()].reverse()) {
      const fp = this.footprintOf(it);
      if (fp) {
        const local = rot({ x: w.x - it.x, y: w.y - it.y }, -it.rotation);
        if (pointInPolygon(local, fp)) out.push(it);
        continue;
      }
      const pad = ['water', 'outlet', 'spot', 'strip'].includes(this.store.defOf(it.defId).kind)
        ? 0.08
        : 0.01;
      if (pointInRect(w, it.x, it.y, it.w + pad * 2, it.d + pad * 2, it.rotation)) out.push(it);
    }
    return out;
  }

  private hitItem(w: Point): Item | null {
    return this.hitItems(w)[0] ?? null;
  }

  private hitWall(w: Point): string | null {
    const t = this.store.design.room.wallThickness;
    for (const g of this.store.walls()) {
      if (distToSegment(w, g.a, g.b) < t / 2 + 5 / this.zoom) return g.id;
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    const s = { x: e.offsetX, y: e.offsetY };
    if (e.pointerType === 'touch') {
      this.pointers.set(e.pointerId, s);
      if (this.pointers.size === 2) {
        // second finger: abandon the single-finger gesture, start pinch zoom/pan
        if (['corner', 'opening', 'item', 'rotate'].includes(this.drag.type)) this.store.commit();
        const [p1, p2] = [...this.pointers.values()];
        this.drag = {
          type: 'pinch',
          lastDist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
          lastMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        };
        this.guides = [];
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.pointers.size > 2) return; // ignore extra fingers
    }
    if (this.drag.type !== 'none') return; // one gesture at a time
    this.canvas.setPointerCapture(e.pointerId);
    const w = this.toWorld(s.x, s.y);

    if (e.button === 1 || e.button === 2) {
      this.drag = { type: 'pan', sx: s.x, sy: s.y, panX0: this.panX, panY0: this.panY };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    // placing from the catalog
    if (this.armedDef) {
      this.placeArmed(w, e.shiftKey);
      return;
    }

    const cornerId = this.hitCorner(s);
    if (cornerId) {
      this.store.select({ kind: 'corner', id: cornerId });
      this.drag = { type: 'corner', id: cornerId };
      return;
    }
    const rotId = this.hitRotateHandle(s);
    if (rotId) {
      this.drag = { type: 'rotate', id: rotId };
      return;
    }
    const midWallId = this.hitMidpoint(s);
    if (midWallId) {
      // only an actual drag bends the wall — a bare click selects it (see onPointerMove)
      this.drag = { type: 'maybe-split', wallId: midWallId, sx: s.x, sy: s.y };
      return;
    }
    const opening = this.hitOpening(w);
    if (opening) {
      this.store.select({ kind: 'opening', id: opening.id });
      this.drag = { type: 'opening', id: opening.id };
      return;
    }
    const stack = this.hitItems(w);
    if (stack.length) {
      // drag whatever is already selected in the stack; a plain click cycles to the item below
      const sel = this.store.selection;
      const selIdx = sel.kind === 'item' ? stack.findIndex((it) => it.id === sel.id) : -1;
      const item = selIdx >= 0 ? stack[selIdx] : stack[0];
      this.store.select({ kind: 'item', id: item.id });
      this.drag = {
        type: 'item',
        id: item.id,
        ox: w.x - item.x,
        oy: w.y - item.y,
        moved: false,
        cycleTo: selIdx >= 0 ? stack[(selIdx + 1) % stack.length].id : null,
      };
      return;
    }
    const wallId = this.hitWall(w);
    if (wallId) {
      this.store.select({ kind: 'wall', id: wallId });
      return;
    }
    // empty space: maybe-pan; deselect on plain click
    this.drag = { type: 'maybe-pan', sx: s.x, sy: s.y, panX0: this.panX, panY0: this.panY, moved: false };
  }

  private placeArmed(w: Point, keep: boolean): void {
    const def = this.armedDef!;
    if (def.opening) {
      const near = nearestWall(this.store, w, 0.6);
      if (!near) return;
      const o = this.store.addOpening(def, near.wall.id, near.t);
      this.store.select({ kind: 'opening', id: o.id });
      this.store.commit();
      if (!keep) this.setArmed(null);
      return;
    }
    const snapped = snapItem(this.store, def, null, w.x, w.y, 0);
    if ((def.marker || isWallMounted(def)) && !snapped.wallId) return; // markers need a wall
    const item = this.store.addItem(def, snapped.x, snapped.y, snapped.rotation);
    this.store.select({ kind: 'item', id: item.id });
    this.store.commit();
    if (!keep) this.setArmed(null);
    // continue dragging the fresh item for fine placement
    this.drag = { type: 'item', id: item.id, ox: 0, oy: 0, moved: false };
  }

  private onPointerMove(e: PointerEvent): void {
    const s = { x: e.offsetX, y: e.offsetY };
    const w = this.toWorld(s.x, s.y);
    this.pointerWorld = w;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, s);

    switch (this.drag.type) {
      case 'pinch': {
        const d = this.drag;
        const pts = [...this.pointers.values()];
        if (pts.length < 2) return;
        const [p1, p2] = pts;
        const distNow = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
        const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const newZoom = clamp(this.zoom * (distNow / d.lastDist), 15, 400);
        const applied = newZoom / this.zoom;
        // keep the world point under the previous midpoint anchored, then follow the midpoint
        this.panX = m.x - (d.lastMid.x - this.panX) * applied;
        this.panY = m.y - (d.lastMid.y - this.panY) * applied;
        this.zoom = newZoom;
        d.lastDist = distNow;
        d.lastMid = m;
        this.requestDraw();
        return;
      }
      case 'maybe-split': {
        const d = this.drag;
        if (Math.hypot(s.x - d.sx, s.y - d.sy) <= 4) return;
        const g = this.store.wallById(d.wallId);
        if (!g) return;
        const nc = this.store.splitWall(d.wallId, g.len / 2);
        if (nc) {
          this.store.select({ kind: 'corner', id: nc.id });
          this.drag = { type: 'corner', id: nc.id };
        } else {
          this.drag = { type: 'none' };
        }
        return;
      }
      case 'pan':
      case 'maybe-pan': {
        const d = this.drag;
        if (d.type === 'maybe-pan') {
          if (Math.hypot(s.x - d.sx, s.y - d.sy) > 4) {
            this.drag = { type: 'pan', sx: d.sx, sy: d.sy, panX0: d.panX0, panY0: d.panY0 };
            this.canvas.style.cursor = 'grabbing';
          } else return;
        }
        const p = this.drag as Extract<Drag, { type: 'pan' }>;
        this.panX = p.panX0 + (s.x - p.sx);
        this.panY = p.panY0 + (s.y - p.sy);
        this.requestDraw();
        return;
      }
      case 'corner': {
        let x = Math.round(w.x * 20) / 20; // 5 cm grid
        let y = Math.round(w.y * 20) / 20;
        // axis-lock to neighbouring corners for easy orthogonal rooms
        const c = this.store.design.corners;
        const idx = c.findIndex((k) => k.id === (this.drag as { id: string }).id);
        if (idx >= 0) {
          const prev = c[(idx - 1 + c.length) % c.length];
          const next = c[(idx + 1) % c.length];
          this.guides = [];
          for (const n of [prev, next]) {
            if (Math.abs(w.x - n.x) < 0.09) {
              x = n.x;
              this.guides.push({ a: { x, y: Math.min(y, n.y) }, b: { x, y: Math.max(y, n.y) } });
            }
            if (Math.abs(w.y - n.y) < 0.09) {
              y = n.y;
              this.guides.push({ a: { x: Math.min(x, n.x), y }, b: { x: Math.max(x, n.x), y } });
            }
          }
        }
        this.store.moveCorner((this.drag as { id: string }).id, x, y);
        return;
      }
      case 'opening': {
        const o = this.store.openingById((this.drag as { id: string }).id);
        if (!o) return;
        const near = nearestWall(this.store, w, 0.7);
        if (near) {
          this.store.updateOpening(
            o.id,
            { wallId: near.wall.id, offset: near.t },
            { structural: true, transient: true }
          );
        }
        return;
      }
      case 'item': {
        const d = this.drag as Extract<Drag, { type: 'item' }>;
        const it = this.store.itemById(d.id);
        if (!it) return;
        d.moved = true;
        const def = this.store.defOf(it.defId);
        const res = snapItem(this.store, def, it.id, w.x - d.ox, w.y - d.oy, it.rotation);
        this.guides = res.guides;
        this.store.updateItem(
          it.id,
          { x: res.x, y: res.y, rotation: res.rotation },
          { structural: false, transient: true }
        );
        return;
      }
      case 'rotate': {
        const it = this.store.itemById((this.drag as { id: string }).id);
        if (!it) return;
        let ang = Math.atan2(w.y - it.y, w.x - it.x) - Math.PI / 2;
        const step = e.altKey ? Math.PI / 180 : Math.PI / 12; // 15° default, 1° with Alt
        ang = Math.round(ang / step) * step;
        this.store.updateItem(it.id, { rotation: ang }, { structural: false, transient: true });
        return;
      }
      case 'none':
        break;
    }

    // not dragging: ghost preview / hover cursor
    if (this.armedDef) {
      if (this.armedDef.opening) {
        const near = nearestWall(this.store, w, 0.6);
        this.ghostOpening = near ? { wallId: near.wall.id, t: near.t, valid: true } : null;
        this.ghost = null;
      } else {
        const res = snapItem(this.store, this.armedDef, null, w.x, w.y, 0);
        const needWall = this.armedDef.marker || isWallMounted(this.armedDef);
        this.ghost = { x: res.x, y: res.y, rotation: res.rotation, valid: !needWall || !!res.wallId };
        this.ghostOpening = null;
        this.guides = res.guides;
      }
      this.requestDraw();
      return;
    }

    const s2 = { x: e.offsetX, y: e.offsetY };
    const hover =
      this.hitCorner(s2) || this.hitRotateHandle(s2) || this.hitMidpoint(s2)
        ? 'pointer'
        : this.hitOpening(w) || this.hitItem(w)
          ? 'move'
          : this.hitWall(w)
            ? 'pointer'
            : 'default';
    this.canvas.style.cursor = hover;
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    const wasDrag = this.drag;
    if (wasDrag.type === 'pinch') {
      // pinch ends when either finger lifts; the remaining finger starts nothing new
      this.drag = { type: 'none' };
      return;
    }
    if (wasDrag.type === 'maybe-pan' && !wasDrag.moved) {
      this.store.select({ kind: 'none' });
    }
    if (wasDrag.type === 'maybe-split') {
      this.store.select({ kind: 'wall', id: wasDrag.wallId });
    }
    if (wasDrag.type === 'item' && !wasDrag.moved && wasDrag.cycleTo && wasDrag.cycleTo !== wasDrag.id) {
      this.store.select({ kind: 'item', id: wasDrag.cycleTo });
    }
    this.endGesture();
  }

  /** Shared teardown for pointerup and pointercancel — commits any in-flight edit. */
  private endGesture(): void {
    const wasDrag = this.drag;
    this.drag = { type: 'none' };
    this.guides = [];
    this.canvas.style.cursor = this.armedDef ? 'crosshair' : 'default';
    if (['corner', 'opening', 'item', 'rotate'].includes(wasDrag.type)) {
      this.store.commit();
    }
    this.requestDraw();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const s = { x: e.offsetX, y: e.offsetY };
    const before = this.toWorld(s.x, s.y);
    this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0011), 15, 400);
    this.panX = s.x - before.x * this.zoom;
    this.panY = s.y - before.y * this.zoom;
    this.requestDraw();
  }

  private onDblClick(e: PointerEvent | MouseEvent): void {
    const w = this.toWorld(e.offsetX, e.offsetY);
    if (this.armedDef) return;
    if (this.hitItem(w) || this.hitOpening(w)) return;
    const wallId = this.hitWall(w);
    if (wallId) {
      const g = this.store.wallById(wallId)!;
      const pr = projectOnWall(g, w);
      const nc = this.store.splitWall(wallId, pr.t);
      if (nc) {
        this.store.select({ kind: 'corner', id: nc.id });
        this.store.commit();
      }
    }
  }

  /* ---------------- drawing ---------------- */

  requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private sortedItems(): Item[] {
    const layer = (it: Item): number => {
      const def = this.store.defOf(it.defId);
      if (def.kind === 'backsplash') return 0;
      if (def.marker) return 3;
      if (def.kind === 'custom') {
        // worktop boards sit above base units but below overhead items
        if (this.partOf(it)?.type === 'board') return 2;
        return it.elevation > 0.5 ? 4 : 1;
      }
      if (isOverhead(def.kind)) return def.light ? 5 : 4;
      return 1;
    };
    return [...this.store.design.items].sort((a, b) => layer(a) - layer(b));
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const labels: Label[] = [];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = '#f4f3f0';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    // ---- grid ----
    const w0 = this.toWorld(0, 0);
    const w1 = this.toWorld(this.cssW, this.cssH);
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);
    const hair = 1 / this.zoom;

    const gridStep = this.zoom > 55 ? 0.1 : 0.5;
    ctx.lineWidth = hair;
    for (let x = Math.floor(w0.x / gridStep) * gridStep; x < w1.x; x += gridStep) {
      const major = Math.abs(x - Math.round(x)) < 1e-6;
      ctx.strokeStyle = major ? '#dcdad3' : '#eae8e2';
      ctx.beginPath();
      ctx.moveTo(x, w0.y);
      ctx.lineTo(x, w1.y);
      ctx.stroke();
    }
    for (let y = Math.floor(w0.y / gridStep) * gridStep; y < w1.y; y += gridStep) {
      const major = Math.abs(y - Math.round(y)) < 1e-6;
      ctx.strokeStyle = major ? '#dcdad3' : '#eae8e2';
      ctx.beginPath();
      ctx.moveTo(w0.x, y);
      ctx.lineTo(w1.x, y);
      ctx.stroke();
    }

    const design = this.store.design;
    const corners = design.corners;
    const t = design.room.wallThickness;
    const sel = this.store.selection;

    // ---- floor ----
    if (corners.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = design.room.floorColor;
      ctx.globalAlpha = 0.42;
      ctx.fill();
      ctx.globalAlpha = 1;

      const c = polygonCentroid(corners);
      labels.push({
        x: c.x,
        y: c.y,
        text: `${this.store.floorArea().toFixed(1)} m²`,
        color: '#a09d95',
        size: 13,
      });
    }

    // ---- guides (behind items) ----
    for (const g of this.guides) {
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = hair;
      ctx.setLineDash([hair * 5, hair * 4]);
      ctx.beginPath();
      ctx.moveTo(g.a.x, g.a.y);
      ctx.lineTo(g.b.x, g.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (g.label) {
        labels.push({
          x: (g.a.x + g.b.x) / 2,
          y: (g.a.y + g.b.y) / 2,
          text: g.label,
          color: GUIDE,
          size: 11,
          bold: true,
        });
      }
    }

    // ---- items ----
    for (const it of this.sortedItems()) {
      const def = this.store.defOf(it.defId);
      const selected = sel.kind === 'item' && sel.id === it.id;
      ctx.save();
      ctx.translate(it.x, it.y);
      ctx.rotate(it.rotation);
      if (selected) {
        ctx.fillStyle = ACCENT;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(-it.w / 2 - 0.04, -it.d / 2 - 0.04, it.w + 0.08, it.d + 0.08);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = hair * 2;
        ctx.strokeRect(-it.w / 2 - 0.04, -it.d / 2 - 0.04, it.w + 0.08, it.d + 0.08);
      }
      const part = this.partOf(it);
      drawPlanSymbol(ctx, def.kind, it.w, it.d, {
        color: it.color,
        selected,
        pxPerM: this.zoom,
        overhead:
          def.kind === 'custom' ? (part?.type === 'board' ? false : it.elevation > 0.5) : undefined,
        bodyAlpha: part?.type === 'board' ? 0.5 : undefined,
        footprint: this.footprintOf(it) ?? undefined,
      });
      ctx.restore();

      if (selected) {
        // rotation handle
        const h = this.rotateHandlePos(it);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.moveTo(it.x, it.y);
        ctx.lineTo(h.x, h.y);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 6 / this.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = hair * 1.6;
        ctx.stroke();

        labels.push({
          x: it.x,
          y: it.y - it.d / 2 - 0.18,
          text: `${def.label} · ${Math.round(it.w * 100)}×${Math.round(it.d * 100)} cm`,
          color: ACCENT,
          size: 12,
          bold: true,
        });
      }
    }

    // ---- ghost preview ----
    if (this.ghost && this.armedDef) {
      ctx.save();
      ctx.globalAlpha = this.ghost.valid ? 0.55 : 0.3;
      ctx.translate(this.ghost.x, this.ghost.y);
      ctx.rotate(this.ghost.rotation);
      const armedPart = this.store.customPartById(this.armedDef.id);
      drawPlanSymbol(ctx, this.armedDef.kind, this.armedDef.w, this.armedDef.d, {
        color: this.ghost.valid ? this.armedDef.color : '#d66',
        selected: false,
        pxPerM: this.zoom,
        footprint: armedPart
          ? (footprintPolygon(armedPart, this.armedDef.w, this.armedDef.d) ?? undefined)
          : undefined,
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // ---- walls ----
    ctx.lineCap = 'butt';
    for (const g of this.store.walls()) {
      const selectedWall = sel.kind === 'wall' && sel.id === g.id;
      ctx.strokeStyle = selectedWall ? ACCENT : INK;
      ctx.lineWidth = t;
      // extend walls half a thickness so corners join cleanly
      const ext = t / 2;
      ctx.beginPath();
      ctx.moveTo(g.a.x - g.dir.x * ext, g.a.y - g.dir.y * ext);
      ctx.lineTo(g.b.x + g.dir.x * ext, g.b.y + g.dir.y * ext);
      ctx.stroke();

      // wall dimension label (outside)
      const mid = wallPoint(g, g.len / 2);
      const off = 0.32;
      let ang = g.angle;
      if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI; // keep text upright
      labels.push({
        x: mid.x - g.inward.x * off,
        y: mid.y - g.inward.y * off,
        text: fmtCm(g.len),
        angle: ang,
        color: selectedWall ? ACCENT : '#8a877f',
        size: 12,
        bold: selectedWall,
      });
    }

    // ---- openings ----
    for (const o of design.openings) {
      const g = this.store.wallById(o.wallId);
      if (!g) continue;
      const p = wallPoint(g, o.offset);
      const selectedO = sel.kind === 'opening' && sel.id === o.id;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(g.angle);
      // clear the wall
      ctx.fillStyle = '#f4f3f0';
      ctx.fillRect(-o.width / 2, -t / 2 - hair, o.width, t + hair * 2);
      drawPlanSymbol(ctx, o.type, o.width, t, {
        color: '#fff',
        selected: selectedO,
        pxPerM: this.zoom,
        doorHinge: o.hinge,
        doorSwing: o.swing,
      });
      ctx.restore();

      if (selectedO) {
        // distances to both wall ends
        const l = o.offset - o.width / 2;
        const r = g.len - o.offset - o.width / 2;
        const off = -0.32;
        const gp = (tp: number): Point => ({
          x: g.a.x + g.dir.x * tp + g.inward.x * off,
          y: g.a.y + g.dir.y * tp + g.inward.y * off,
        });
        for (const [from, to, val] of [
          [0, o.offset - o.width / 2, l],
          [o.offset + o.width / 2, g.len, r],
        ] as const) {
          if (val < 0.03) continue;
          const a = gp(from);
          const b = gp(to);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = hair;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          labels.push({
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            text: fmtCm(val),
            color: ACCENT,
            size: 11,
            bold: true,
          });
        }
      }
    }

    // ---- ghost opening ----
    if (this.ghostOpening && this.armedDef) {
      const g = this.store.wallById(this.ghostOpening.wallId);
      if (g) {
        const p = wallPoint(g, this.ghostOpening.t);
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.translate(p.x, p.y);
        ctx.rotate(g.angle);
        ctx.fillStyle = '#f4f3f0';
        ctx.fillRect(-this.armedDef.w / 2, -t / 2, this.armedDef.w, t);
        drawPlanSymbol(ctx, this.armedDef.kind, this.armedDef.w, t, {
          color: '#fff',
          selected: false,
          pxPerM: this.zoom,
        });
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // ---- corner + midpoint handles ----
    for (const g of this.store.walls()) {
      const m = wallPoint(g, g.len / 2);
      const r = 4.5 / this.zoom;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#a5a29a';
      ctx.lineWidth = hair;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
    for (const c of corners) {
      const selectedC = sel.kind === 'corner' && sel.id === c.id;
      const r = (selectedC ? 6.5 : 5) / this.zoom;
      ctx.fillStyle = selectedC ? ACCENT : '#fff';
      ctx.strokeStyle = selectedC ? ACCENT : INK;
      ctx.lineWidth = hair * 1.3;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      ctx.strokeRect(c.x - r, c.y - r, r * 2, r * 2);
    }

    ctx.restore();

    // ---- labels in screen space ----
    for (const l of labels) {
      const s = this.toScreen(l);
      ctx.save();
      ctx.translate(s.x, s.y);
      if (l.angle) ctx.rotate(l.angle);
      ctx.font = `${l.bold ? 600 : 500} ${l.size ?? 12}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(244, 243, 240, 0.9)';
      ctx.strokeText(l.text, 0, 0);
      ctx.fillStyle = l.color ?? INK;
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
  }
}
