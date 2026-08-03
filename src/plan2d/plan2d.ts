import { isWallMounted, snapsToWall, type CatalogDef } from '../model/catalog';
import type { Severity, Warning } from '../model/checks';
import {
  clamp,
  fmtCm,
  pointInPolygon,
  pointInRect,
  polygonCentroid,
  projectOnWall,
  rot,
  wallPoint,
} from '../model/geometry';
import { footprintPolygon } from '../model/parts';
import type { RoomWall } from '../model/rooms';
import { nearestWall, snapItem, type Guide } from '../model/snapping';
import type { AddRoomOptions, Store } from '../model/store';
import type { CustomPartDef, Item, Opening, Point } from '../model/types';
import { resolveColor } from '../model/variables';
import { resolveDevice } from '../model/navPref';
import { isMac, type WheelLike } from '../view3d/wheelInput';
import { findHost } from '../model/attach';
import { drawPlanSymbol, isOverhead } from './symbols';

const INK = '#3a3934';
const ACCENT = '#2f6f5e';
const GUIDE = '#c26d3f';
const MEASURE = '#2563eb';
/** Walls (and labels) of rooms that are not the active one. */
const MUTED = '#9a978f';
const LABEL_MUTED = '#a09d95';

/** Spatial-check overlay, one colour per severity. */
const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#c0392b',
  warn: '#d98324',
  info: '#2563eb',
};
/**
 * Plan labels are centred single lines, so a long detail runs off the pane.
 * Clip it here — the props panel carries the sentence in full.
 */
const CHECK_LABEL_MAX = 52;

/** Seed size of a room dropped by the add-room tool (m). */
const NEW_ROOM_W = 4;
const NEW_ROOM_D = 3;
/** How close to a wall the cursor must be for the tool to attach the room to it. */
const ROOM_WALL_REACH = 0.45;
/**
 * Mirrors store's MIN_WALL_SEG: splitWall refuses to leave a stub shorter than
 * this, so `addRoom({against})` silently widens a span whose end lands inside
 * it. The ghost snaps the same way, or it would lie about what a click builds.
 */
const MIN_SPAN_STUB = 0.1;

/**
 * Where a wall slab's centreline sits relative to its polygon edge, measured
 * along the edge's inward normal. Room corners are the ROOM-SIDE wall face, so
 * an exterior wall lies wholly outside (−t/2) and a partition straddles (0).
 */
const bandCenter = (g: RoomWall): number => g.faceOffset - g.thickness / 2;

/** How far a wall must run past its corners for the joint to close. */
const bandExtend = (g: RoomWall): number => g.thickness - g.faceOffset;

interface Label {
  x: number;
  y: number;
  text: string;
  angle?: number;
  color?: string;
  size?: number;
  bold?: boolean;
  /** screen-space nudge (px), so stacked lines keep their spacing at any zoom */
  dy?: number;
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
  | { type: 'rotate'; id: string }
  | { type: 'measure'; sx: number; sy: number; moved: boolean };

/**
 * Preview of the room the add-room tool would create: the exact polygon plus
 * the `addRoom` call that produces it, so the click cannot drift from the ghost.
 */
interface RoomGhost {
  poly: Point[];
  opts: AddRoomOptions;
  /** hung off an existing wall (vs. free-standing) — drawn slightly differently */
  attached: boolean;
}

/** Transient two-point distance measurement (overlay only — never touches the model). */
interface Measure {
  a: Point | null; // first point
  b: Point | null; // second point, set once the measurement is complete
  hover: Point | null; // snapped cursor while measuring / before the first click
  snapped: boolean; // whether `hover` locked onto a corner/edge (vs. a free point)
  measuring: boolean; // first point placed, waiting for the second
}

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

  measureOn = false;
  onMeasureChange: (() => void) | null = null;
  private measure: Measure = { a: null, b: null, hover: null, snapped: false, measuring: false };

  /**
   * Whether the advisory (warn / info) findings are drawn. Errors ignore this
   * and always show: a cabinet inside another one is never worth hiding.
   */
  checksOn = false;
  onChecksChange: (() => void) | null = null;

  roomToolOn = false;
  onRoomToolChange: (() => void) | null = null;
  private roomGhost: RoomGhost | null = null;

  private ghost: { x: number; y: number; rotation: number; valid: boolean } | null = null;
  private ghostOpening: { wallId: string; t: number; valid: boolean } | null = null;
  private drag: Drag = { type: 'none' };
  private pointers = new Map<number, Point>(); // active pointers, for touch pinch/pan
  private guides: Guide[] = [];
  private pointerWorld: Point = { x: 0, y: 0 };
  private raf = 0;
  private fitted = false;
  private readonly isMac = isMac(navigator.platform, navigator.userAgent);

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
    // the active room drives floor/wall shading and the handle set
    store.on('activeRoom', () => {
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
        this.roomGhost = null;
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
    const c = this.store.design.rooms.flatMap((r) => r.corners);
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
    // arming, measuring and the room tool are mutually exclusive
    if (def && this.measureOn) {
      this.measureOn = false;
      this.resetMeasure();
      this.onMeasureChange?.();
    }
    if (def && this.roomToolOn) {
      this.roomToolOn = false;
      this.roomGhost = null;
      this.onRoomToolChange?.();
    }
    this.canvas.style.cursor = def ? 'crosshair' : 'default';
    this.updateHint();
    this.onArmedChange?.();
    this.requestDraw();
  }

  /* ---------------- measure tool ---------------- */

  private resetMeasure(): void {
    this.measure = { a: null, b: null, hover: null, snapped: false, measuring: false };
  }

  setMeasure(on: boolean): void {
    this.measureOn = on;
    this.resetMeasure();
    // arming, measuring and the room tool are mutually exclusive
    if (on && this.armedDef) {
      this.armedDef = null;
      this.ghost = null;
      this.ghostOpening = null;
      this.onArmedChange?.();
    }
    if (on && this.roomToolOn) {
      this.roomToolOn = false;
      this.roomGhost = null;
      this.onRoomToolChange?.();
    }
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
    this.updateHint();
    this.onMeasureChange?.();
    this.requestDraw();
  }

  /* ---------------- checks overlay ---------------- */

  /**
   * Not a tool — a display toggle, so it takes no gestures and stays on
   * alongside arming, measuring or the room tool.
   */
  setChecks(on: boolean): void {
    this.checksOn = on;
    this.onChecksChange?.();
    this.requestDraw();
  }

  /* ---------------- add-room tool ---------------- */

  setRoomTool(on: boolean): void {
    this.roomToolOn = on;
    this.roomGhost = null;
    // arming, measuring and the room tool are mutually exclusive
    if (on && this.armedDef) {
      this.armedDef = null;
      this.ghost = null;
      this.ghostOpening = null;
      this.onArmedChange?.();
    }
    if (on && this.measureOn) {
      this.measureOn = false;
      this.resetMeasure();
      this.onMeasureChange?.();
    }
    this.canvas.style.cursor = on ? 'crosshair' : 'default';
    this.updateHint();
    this.onRoomToolChange?.();
    this.requestDraw();
  }

  /**
   * The nearest wall a new room could be hung off: exterior walls only, from
   * any room. A partition already has a room on both sides, and `addRoom`
   * refuses it.
   */
  private nearestFreeWall(p: Point): { wall: RoomWall; t: number } | null {
    let best: { wall: RoomWall; t: number } | null = null;
    let bestPerp = ROOM_WALL_REACH;
    for (const g of this.store.allWalls()) {
      if (g.shared) continue;
      const pr = projectOnWall(g, p);
      if (pr.t < -0.1 || pr.t > g.len + 0.1) continue;
      const perp = Math.abs(pr.side);
      if (perp > bestPerp) continue;
      bestPerp = perp;
      best = { wall: g, t: clamp(pr.t, 0, g.len) };
    }
    return best;
  }

  /** What a click at `w` would add: a room against the wall under the cursor, else a free one. */
  private roomGhostAt(w: Point): RoomGhost {
    const near = this.nearestFreeWall(w);
    if (near) {
      const g = near.wall;
      const width = Math.min(g.len, NEW_ROOM_W);
      let t0 = clamp(near.t - width / 2, 0, g.len - width);
      let t1 = t0 + width;
      // stubs shorter than a wall segment are never cut — match addRoom exactly
      if (t0 < MIN_SPAN_STUB) t0 = 0;
      if (g.len - t1 < MIN_SPAN_STUB) t1 = g.len;
      const out = { x: -g.inward.x, y: -g.inward.y };
      const a = wallPoint(g, t0);
      const b = wallPoint(g, t1);
      const whole = t0 === 0 && t1 === g.len;
      return {
        poly: [
          b,
          a,
          { x: a.x + out.x * NEW_ROOM_D, y: a.y + out.y * NEW_ROOM_D },
          { x: b.x + out.x * NEW_ROOM_D, y: b.y + out.y * NEW_ROOM_D },
        ],
        opts: { against: { wallId: g.id, ...(whole ? {} : { span: { t0, t1 } }) }, d: NEW_ROOM_D },
        attached: true,
      };
    }
    // free-standing: a w×d rectangle centred on the cursor, on the drag grid
    const x = Math.round((w.x - NEW_ROOM_W / 2) * 20) / 20;
    const y = Math.round((w.y - NEW_ROOM_D / 2) * 20) / 20;
    return {
      poly: [
        { x, y },
        { x: x + NEW_ROOM_W, y },
        { x: x + NEW_ROOM_W, y: y + NEW_ROOM_D },
        { x, y: y + NEW_ROOM_D },
      ],
      opts: { at: { x, y }, w: NEW_ROOM_W, d: NEW_ROOM_D },
      attached: false,
    };
  }

  private placeRoom(w: Point, keep: boolean): void {
    const ghost = this.roomGhostAt(w);
    const room = this.store.addRoom(ghost.opts);
    if (!room) return; // the host wall became a partition since the ghost was built
    this.store.select({ kind: 'none' }); // the new room's panel is the no-selection one
    this.store.commit();
    this.roomGhost = null;
    if (!keep) this.setRoomTool(false);
    else this.requestDraw();
  }

  /** An item's plan outline in world coordinates (custom footprint or the bounding rect). */
  private itemOutlineWorld(it: Item): Point[] {
    const local =
      this.footprintOf(it) ??
      [
        { x: -it.w / 2, y: -it.d / 2 },
        { x: it.w / 2, y: -it.d / 2 },
        { x: it.w / 2, y: it.d / 2 },
        { x: -it.w / 2, y: it.d / 2 },
      ];
    return local.map((p) => {
      const r = rot(p, it.rotation);
      return { x: it.x + r.x, y: it.y + r.y };
    });
  }

  private closestOnSeg(p: Point, a: Point, b: Point): Point {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return { x: a.x, y: a.y };
    const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  /**
   * Snap a screen point to the nearest meaningful spot for measuring. Vertices
   * (corners, item centres & outline corners) win over edges (walls, item
   * outlines); with nothing near, the bare cursor is returned as a free point.
   */
  private measureSnap(sx: number, sy: number): { p: Point; snapped: boolean } {
    const w = this.toWorld(sx, sy);
    const thr = 11 / this.zoom; // ~11 px reach, in world units

    let best: Point | null = null;
    let bestD = thr;
    const tryV = (p: Point): void => {
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    };
    for (const r of this.store.design.rooms) for (const c of r.corners) tryV(c);
    for (const it of this.store.design.items) {
      tryV({ x: it.x, y: it.y });
      for (const v of this.itemOutlineWorld(it)) tryV(v);
    }
    if (best) return { p: best, snapped: true };

    bestD = thr;
    const tryE = (a: Point, b: Point): void => {
      const q = this.closestOnSeg(w, a, b);
      const d = Math.hypot(q.x - w.x, q.y - w.y);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    };
    for (const g of this.store.allWalls()) tryE(g.a, g.b);
    for (const it of this.store.design.items) {
      const o = this.itemOutlineWorld(it);
      for (let i = 0; i < o.length; i++) tryE(o[i], o[(i + 1) % o.length]);
    }
    if (best) return { p: best, snapped: true };

    return { p: w, snapped: false };
  }

  /* ---------------- hints ---------------- */

  private updateHint(): void {
    if (this.roomToolOn) {
      this.onHint('Click to place a room · hover a wall to attach it · Shift keeps the tool · Esc cancels');
      return;
    }
    if (this.measureOn) {
      this.onHint(
        this.measure.measuring
          ? 'Click the second point · snaps to corners, edges & walls · Esc exits'
          : 'Click two points to measure · snaps to corners, edges & walls · Esc exits'
      );
      return;
    }
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
        this.onHint(
          this.store.design.rooms.length > 1
            ? 'Click a room to work in it · drag its corners to reshape · scroll zooms, drag empty space pans'
            : 'Drag corners to reshape the room · pick items from the left · scroll zooms, drag empty space pans'
        );
    }
  }

  /* ---------------- pointer handling ---------------- */

  private hitCorner(s: Point): string | null {
    for (const c of this.store.activeRoom().corners) {
      const cs = this.toScreen(c);
      if (Math.hypot(cs.x - s.x, cs.y - s.y) < 9) return c.id;
    }
    return null;
  }

  /**
   * The room a click lands in: the last one containing the point (same rule as
   * store.roomContaining), except that the active room wins wherever rooms
   * overlap — clicking where you already work must never move you elsewhere.
   */
  private hitRoom(w: Point): string | null {
    const activeId = this.store.activeRoomId;
    let hit: string | null = null;
    for (const r of this.store.design.rooms) {
      if (!pointInPolygon(w, r.corners)) continue;
      if (r.id === activeId) return activeId;
      hit = r.id;
    }
    return hit;
  }

  /**
   * One click both switches rooms and selects: picking a wall/opening of an
   * inactive room activates that room first. A partition counts as belonging to
   * either of its rooms, so it never drags you off the side you are working on.
   */
  private activateForWall(g: RoomWall | undefined): void {
    if (!g) return;
    const activeId = this.store.activeRoomId;
    if (g.roomId === activeId || g.shared?.roomId === activeId) return;
    this.store.setActiveRoom(g.roomId);
  }

  /** Wall-bend handles belong to the active room only (like the corner handles). */
  private hitMidpoint(s: Point): string | null {
    for (const w of this.store.activeWalls()) {
      const m = this.toScreen(wallPoint(w, w.len / 2));
      if (Math.hypot(m.x - s.x, m.y - s.y) < 8) return w.id;
    }
    return null;
  }

  private hitRotateHandle(s: Point): string | null {
    const sel = this.store.selection;
    if (sel.kind !== 'item') return null;
    const it = this.store.itemById(sel.id);
    if (!it || it.attach) return null; // attached items derive their rotation
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
    for (const o of this.store.design.openings) {
      const g = this.store.wallById(o.wallId);
      if (!g) continue;
      const pr = projectOnWall(g, w);
      const perp = Math.abs(pr.side - bandCenter(g));
      if (perp < g.thickness / 2 + 8 / this.zoom && Math.abs(pr.t - o.offset) < o.width / 2) {
        return o;
      }
    }
    return null;
  }

  /** The item's true plan outline (custom parts only), in item-local coords. */
  private footprintOf(it: Item): Point[] | null {
    const part = this.store.partOf(it.defId);
    return part ? footprintPolygon(part, it.w, it.d) : null;
  }

  private partOf(it: Item): CustomPartDef | undefined {
    return this.store.partOf(it.defId);
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
    const tol = 5 / this.zoom;
    for (const g of this.store.allWalls()) {
      const pr = projectOnWall(g, w);
      if (pr.t < -tol || pr.t > g.len + tol) continue;
      if (Math.abs(pr.side - bandCenter(g)) <= g.thickness / 2 + tol) return g.id;
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

    // measuring: click sets a point; a second click (or a drag) sets the other
    if (this.measureOn) {
      const snap = this.measureSnap(s.x, s.y);
      if (this.measure.measuring) {
        this.measure.b = snap.p;
        this.measure.measuring = false;
        this.drag = { type: 'none' };
      } else {
        this.measure = { a: snap.p, b: null, hover: snap.p, snapped: snap.snapped, measuring: true };
        this.drag = { type: 'measure', sx: s.x, sy: s.y, moved: false };
      }
      this.updateHint();
      this.requestDraw();
      return;
    }

    // dropping a new room
    if (this.roomToolOn) {
      this.placeRoom(w, e.shiftKey);
      return;
    }

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
      this.activateForWall(this.store.wallById(opening.wallId));
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
      this.activateForWall(this.store.wallById(wallId));
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
    // hosted appliances only place ONTO a host (worktop / free niche)
    const mount = def.appliance?.mount;
    if (mount === 'counter' || mount === 'zone') {
      const hit = findHost(this.store.design, def, w, null);
      if (!hit) return;
      const item = this.store.addItem(def, w.x, w.y, 0);
      this.store.setAttachment(item.id, hit.attach);
      this.store.select({ kind: 'item', id: item.id });
      this.store.commit();
      if (!keep) this.setArmed(null);
      this.drag = { type: 'item', id: item.id, ox: 0, oy: 0, moved: false };
      return;
    }
    const snapped = snapItem(this.store, def, null, w.x, w.y, 0);
    if ((def.marker || isWallMounted(def)) && !snapped.wallId) return; // markers need a wall
    const item = this.store.addItem(def, snapped.x, snapped.y, snapped.rotation);
    item.roomId = snapped.roomId;
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
        const dragId = (this.drag as { id: string }).id;
        const c = this.store.roomOfCorner(dragId)?.corners ?? [];
        const idx = c.findIndex((k) => k.id === dragId);
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
        // hosted appliances hop between hosts; off-host they detach and roam
        const mount = def.appliance?.mount;
        if (mount === 'counter' || mount === 'zone') {
          const p = { x: w.x - d.ox, y: w.y - d.oy };
          const hit = findHost(this.store.design, def, p, it.id);
          if (hit) {
            this.store.setAttachment(it.id, hit.attach);
          } else {
            if (it.attach) this.store.setAttachment(it.id, undefined);
            this.store.updateItem(it.id, { x: p.x, y: p.y }, { structural: false, transient: true });
          }
          return;
        }
        const res = snapItem(this.store, def, it.id, w.x - d.ox, w.y - d.oy, it.rotation);
        this.guides = res.guides;
        this.store.updateItem(
          it.id,
          { x: res.x, y: res.y, rotation: res.rotation, roomId: res.roomId },
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
      case 'measure': {
        const d = this.drag;
        if (Math.hypot(s.x - d.sx, s.y - d.sy) > 4) d.moved = true;
        const snap = this.measureSnap(s.x, s.y);
        this.measure.hover = snap.p;
        this.measure.snapped = snap.snapped;
        this.requestDraw();
        return;
      }
      case 'none':
        break;
    }

    // add-room tool: preview exactly what a click would build
    if (this.roomToolOn) {
      this.roomGhost = this.roomGhostAt(w);
      this.canvas.style.cursor = 'crosshair';
      this.requestDraw();
      return;
    }

    // measuring, between clicks: keep the snapped hover / rubber-band live
    if (this.measureOn) {
      const snap = this.measureSnap(s.x, s.y);
      this.measure.hover = snap.p;
      this.measure.snapped = snap.snapped;
      this.canvas.style.cursor = 'crosshair';
      this.requestDraw();
      return;
    }

    // not dragging: ghost preview / hover cursor
    if (this.armedDef) {
      if (this.armedDef.opening) {
        const near = nearestWall(this.store, w, 0.6);
        this.ghostOpening = near ? { wallId: near.wall.id, t: near.t, valid: true } : null;
        this.ghost = null;
      } else if (
        this.armedDef.appliance?.mount === 'counter' ||
        this.armedDef.appliance?.mount === 'zone'
      ) {
        // hosted appliances preview on their would-be host, red off-host
        const hit = findHost(this.store.design, this.armedDef, w, null);
        this.ghost = { x: w.x, y: w.y, rotation: 0, valid: !!hit };
        this.ghostOpening = null;
        this.guides = [];
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
    if (wasDrag.type === 'measure') {
      // a real drag completes the measurement; a bare click waits for a 2nd click
      if (wasDrag.moved) {
        const snap = this.measureSnap(e.offsetX, e.offsetY);
        this.measure.b = snap.p;
        this.measure.measuring = false;
      }
      this.drag = { type: 'none' };
      this.canvas.style.cursor = 'crosshair';
      this.updateHint();
      this.requestDraw();
      return;
    }
    if (wasDrag.type === 'maybe-pan' && !wasDrag.moved) {
      // a click on empty floor of another room switches to it; a drag only pans
      const roomId = this.hitRoom(this.toWorld(wasDrag.sx, wasDrag.sy));
      if (roomId) this.store.setActiveRoom(roomId);
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
    this.canvas.style.cursor =
      this.armedDef || this.measureOn || this.roomToolOn ? 'crosshair' : 'default';
    if (['corner', 'opening', 'item', 'rotate'].includes(wasDrag.type)) {
      this.store.commit();
    }
    this.requestDraw();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // macOS trackpad: a two-finger swipe pans, a pinch (ctrl+wheel) zooms at the
    // cursor. Mouse wheel and every non-mac platform keep classic scroll-zoom.
    if (!e.ctrlKey && this.isMac && resolveDevice(e as unknown as WheelLike) === 'trackpad') {
      this.panX -= e.deltaX; // negate so the plan follows the fingers
      this.panY -= e.deltaY;
      this.requestDraw();
      return;
    }
    const before = this.toWorld(e.offsetX, e.offsetY);
    this.zoom = clamp(this.zoom * Math.exp(-e.deltaY * 0.0011), 15, 400);
    this.panX = e.offsetX - before.x * this.zoom;
    this.panY = e.offsetY - before.y * this.zoom;
    this.requestDraw();
  }

  private onDblClick(e: PointerEvent | MouseEvent): void {
    const w = this.toWorld(e.offsetX, e.offsetY);
    if (this.armedDef || this.roomToolOn) return;
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
      // wall panels and rugs are surfaces: everything else paints over them
      if (def.kind === 'backsplash' || def.kind === 'rug') return 0;
      // mounted appliances paint above their host cabinets and worktops
      if (it.attach) return 3;
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
    const sel = this.store.selection;
    const activeId = this.store.activeRoomId;
    // a lone room needs no name plate — keep the single-room plan pixel-identical
    const multiRoom = design.rooms.length > 1;

    // ---- floors ----
    for (const room of design.rooms) {
      const corners = room.corners;
      if (corners.length < 3) continue;
      const isActive = room.id === activeId;
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = resolveColor(design, room.style.floorColor);
      ctx.globalAlpha = isActive ? 0.42 : 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;

      const c = polygonCentroid(corners);
      const area = `${this.store.floorArea(room.id).toFixed(1)} m²`;
      if (!multiRoom) {
        labels.push({ x: c.x, y: c.y, text: area, color: LABEL_MUTED, size: 13 });
        continue;
      }
      labels.push({
        x: c.x,
        y: c.y,
        dy: -8,
        text: room.name,
        color: isActive ? INK : MUTED,
        size: 13,
        bold: isActive,
      });
      labels.push({ x: c.x, y: c.y, dy: 9, text: area, color: LABEL_MUTED, size: 13 });
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
        color: resolveColor(design, it.color),
        selected,
        pxPerM: this.zoom,
        overhead:
          def.kind === 'custom' ? (part?.type === 'board' ? false : it.elevation > 0.5) : undefined,
        bodyAlpha: part?.type === 'board' ? 0.5 : undefined,
        footprint: this.footprintOf(it) ?? undefined,
        gangs: it.params?.gangs,
        seats: it.params?.seats,
      });
      ctx.restore();

      if (selected && !it.attach) {
        // rotation handle (attached appliances follow their host)
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
      const armedPart = this.store.partOf(this.armedDef.id);
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
    const walls = this.store.allWalls();
    for (const g of walls) {
      // both halves of a partition describe the same slab — draw the owner's
      if (g.shared && !g.shared.owner) continue;
      // selecting either half highlights the one partition on screen
      const selectedWall = sel.kind === 'wall' && (sel.id === g.id || sel.id === g.shared?.wallId);
      const mine = g.roomId === activeId || g.shared?.roomId === activeId;
      ctx.strokeStyle = selectedWall ? ACCENT : mine ? INK : MUTED;
      ctx.lineWidth = g.thickness;
      // the slab sits outside the room-side face; extend it past both corners
      // so the joints close
      const off = bandCenter(g);
      const ext = bandExtend(g);
      ctx.beginPath();
      ctx.moveTo(g.a.x - g.dir.x * ext + g.inward.x * off, g.a.y - g.dir.y * ext + g.inward.y * off);
      ctx.lineTo(g.b.x + g.dir.x * ext + g.inward.x * off, g.b.y + g.dir.y * ext + g.inward.y * off);
      ctx.stroke();

      if (g.shared) {
        // hairline down the seam, so a partition reads apart from an exterior wall
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.moveTo(g.a.x, g.a.y);
        ctx.lineTo(g.b.x, g.b.y);
        ctx.stroke();
      }

      // dimension label — only for walls the active room can actually edit
      if (!mine) continue;
      const mid = wallPoint(g, g.len / 2);
      // a partition has no "outside" to hang the label off; sit it on the seam
      const lblOff = g.shared ? 0 : 0.32;
      let ang = g.angle;
      if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI; // keep text upright
      labels.push({
        x: mid.x - g.inward.x * lblOff,
        y: mid.y - g.inward.y * lblOff,
        text: fmtCm(g.len),
        angle: ang,
        color: selectedWall ? ACCENT : '#8a877f',
        size: 12,
        bold: selectedWall,
      });
    }

    // ---- add-room ghost ----
    if (this.roomToolOn && this.roomGhost) {
      const poly = this.roomGhost.poly;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
      ctx.fillStyle = ACCENT;
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = hair * 2;
      ctx.setLineDash([hair * 7, hair * 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const c = polygonCentroid(poly);
      labels.push({
        x: c.x,
        y: c.y,
        text: this.roomGhost.attached ? 'New room · shares this wall' : 'New room',
        color: ACCENT,
        size: 12,
        bold: true,
      });
    }

    // ---- openings ----
    for (const o of design.openings) {
      const g = this.store.wallById(o.wallId);
      if (!g) continue;
      const t = g.thickness;
      const p = wallPoint(g, o.offset);
      const off = bandCenter(g);
      const selectedO = sel.kind === 'opening' && sel.id === o.id;
      ctx.save();
      // local +y is the wall's inward normal, so translating by the band centre
      // puts the cut symbol on the slab whatever the face offset is
      ctx.translate(p.x + g.inward.x * off, p.y + g.inward.y * off);
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
        const dimOff = -0.32;
        const gp = (tp: number): Point => ({
          x: g.a.x + g.dir.x * tp + g.inward.x * dimOff,
          y: g.a.y + g.dir.y * tp + g.inward.y * dimOff,
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
        const t = g.thickness;
        const off = bandCenter(g);
        const p = wallPoint(g, this.ghostOpening.t);
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.translate(p.x + g.inward.x * off, p.y + g.inward.y * off);
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

    // ---- corner + midpoint handles (active room only, like every gesture) ----
    for (const g of walls) {
      if (g.roomId !== activeId) continue;
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
    for (const c of this.store.activeRoom().corners) {
      const selectedC = sel.kind === 'corner' && sel.id === c.id;
      const r = (selectedC ? 6.5 : 5) / this.zoom;
      ctx.fillStyle = selectedC ? ACCENT : '#fff';
      ctx.strokeStyle = selectedC ? ACCENT : INK;
      ctx.lineWidth = hair * 1.3;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      ctx.strokeRect(c.x - r, c.y - r, r * 2, r * 2);
    }

    // ---- spatial checks + measure overlays (on top of everything) ----
    this.drawChecks(ctx, hair, labels);
    if (this.measureOn) this.drawMeasure(ctx, hair, labels);

    ctx.restore();

    // ---- labels in screen space ----
    for (const l of labels) {
      const s = this.toScreen(l);
      ctx.save();
      ctx.translate(s.x, s.y + (l.dy ?? 0));
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

  /**
   * The spatial-check overlay: every flagged item outlined in its severity
   * colour, plus the region the check measured (a wall segment, a door sector,
   * a clearance rectangle). Errors are unconditional; warn/info wait for the ⚠
   * toggle, and only then does each finding get its detail spelled out.
   */
  private drawChecks(
    ctx: CanvasRenderingContext2D,
    hair: number,
    labels: Label[]
  ): void {
    const warnings = this.store.warnings();
    if (!warnings.length) return;
    const byId = new Map(this.store.design.items.map((it) => [it.id, it]));
    // two findings about the same wall share a midpoint; stack their lines
    const stacked = new Map<string, number>();

    for (const w of warnings) {
      if (w.severity !== 'error' && !this.checksOn) continue;
      const color = SEVERITY_COLOR[w.severity];
      ctx.strokeStyle = color;
      ctx.lineWidth = hair * 2;

      for (const id of w.itemIds) {
        const it = byId.get(id);
        if (!it) continue;
        const o = this.itemOutlineWorld(it);
        ctx.beginPath();
        ctx.moveTo(o[0].x, o[0].y);
        for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
        ctx.closePath();
        ctx.stroke();
      }

      const anchor = this.drawWarningGeom(ctx, hair, w, color);
      if (!this.checksOn) continue;
      const at = anchor ?? this.warningItemCenter(w, byId);
      if (!at) continue;
      const key = `${at.x.toFixed(2)},${at.y.toFixed(2)}`;
      const n = stacked.get(key) ?? 0;
      stacked.set(key, n + 1);
      const text =
        w.detail.length > CHECK_LABEL_MAX
          ? `${w.detail.slice(0, CHECK_LABEL_MAX - 1).trimEnd()}…`
          : w.detail;
      labels.push({ x: at.x, y: at.y, dy: n * 14, text, color, size: 11, bold: true });
    }
  }

  /** Draws a warning's region (dashed); returns the point to hang its label off. */
  private drawWarningGeom(
    ctx: CanvasRenderingContext2D,
    hair: number,
    w: Warning,
    color: string
  ): Point | null {
    const g = w.geom;
    if (!g) return null;
    ctx.strokeStyle = color;
    ctx.lineWidth = hair * 1.8;
    ctx.setLineDash([hair * 6, hair * 4]);
    if (g.kind === 'segment') {
      ctx.beginPath();
      ctx.moveTo(g.a.x, g.a.y);
      ctx.lineTo(g.b.x, g.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    }
    const pts = g.points;
    if (pts.length < 2) {
      ctx.setLineDash([]);
      return null;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.08;
    ctx.fill();
    ctx.globalAlpha = 1;
    return polygonCentroid(pts);
  }

  /** Fallback label anchor for a geom-less warning: the first item it names. */
  private warningItemCenter(w: Warning, byId: Map<string, Item>): Point | null {
    for (const id of w.itemIds) {
      const it = byId.get(id);
      if (it) return { x: it.x, y: it.y };
    }
    return null;
  }

  /** Draws the two-point measurement: dashed line, endpoint dots, snap ring, label. */
  private drawMeasure(
    ctx: CanvasRenderingContext2D,
    hair: number,
    labels: Label[]
  ): void {
    const a = this.measure.a;
    const hover = this.measure.hover;
    // while measuring the hover position stands in for the second point
    const b = this.measure.b ?? (this.measure.measuring ? hover : null);

    const dot = (p: Point): void => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 / this.zoom, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = hair * 1.8;
      ctx.strokeStyle = MEASURE;
      ctx.stroke();
    };

    if (a && b) {
      ctx.strokeStyle = MEASURE;
      ctx.lineWidth = hair * 1.8;
      ctx.setLineDash([hair * 6, hair * 4]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      dot(a);
      dot(b);

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // nudge the label off the line so it stays readable
      const len = Math.max(1e-6, dist);
      const off = 0.24;
      labels.push({
        x: mid.x - (dy / len) * off,
        y: mid.y + (dx / len) * off,
        text: `${fmtCm(dist)}  (${Math.round(Math.abs(dx) * 100)}×${Math.round(Math.abs(dy) * 100)})`,
        color: MEASURE,
        size: 12,
        bold: true,
      });
    } else if (a) {
      dot(a);
    }

    // snap indicator on the live cursor (before the segment is complete)
    if (hover && this.measure.snapped && !this.measure.b) {
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, 6.5 / this.zoom, 0, Math.PI * 2);
      ctx.strokeStyle = MEASURE;
      ctx.lineWidth = hair * 1.4;
      ctx.stroke();
    }
  }
}
