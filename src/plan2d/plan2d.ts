import { catalogDef, hasCatalogDef, isWallMounted, type CatalogDef } from '../model/catalog';
import {
  clamp,
  pointInPolygon,
  pointInRect,
  projectOnWall,
  rot,
  wallPoint,
} from '../model/geometry';
import { snapPointToRooms, snapRoomRect, type RoomWall } from '../model/rooms';
import { nearestWall, snapItem, type Guide } from '../model/snapping';
import type { Store } from '../model/store';
import type { Item, Opening, Point } from '../model/types';
import { resolveDevice } from '../model/navPref';
import { isMac, type WheelLike } from '../view3d/wheelInput';
import { findHost } from '../model/attach';
import { toCatalogDef } from '../model/parts';
import type { EditorState, ToolId } from '../editor/editorState';
import { hitRadius, PinchGesture } from './pinch';
import type { ContextHit } from './planHit';
import { underlayHits } from '../model/underlay';
import {
  bandCenter,
  footprintOf,
  itemOutlineWorld,
  renderPlan,
  rotateHandlePos,
  sortedItems,
  underlayImage,
  type DrawRing,
  type ItemGhost,
  type Measure,
  type OpeningGhost,
  type RoomGhost,
} from './renderPlan';

/** Seed size of a room dropped by the add-room tool (m). */
const NEW_ROOM_W = 4;
const NEW_ROOM_D = 3;
/** Ortho assist for the draw-room tool — snapping.ts' ALIGN_SNAP_DIST. */
const DRAW_ALIGN = 0.06;
/** How close to a wall the cursor must be for the tool to attach the room to it. */
const ROOM_WALL_REACH = 0.45;
/**
 * Mirrors store's MIN_WALL_SEG: splitWall refuses to leave a stub shorter than
 * this, so `addRoom({against})` silently widens a span whose end lands inside
 * it. The ghost snaps the same way, or it would lie about what a click builds.
 */
const MIN_SPAN_STUB = 0.1;

type Drag =
  | { type: 'none' }
  | { type: 'maybe-pan'; sx: number; sy: number; panX0: number; panY0: number; moved: boolean }
  | { type: 'pan'; sx: number; sy: number; panX0: number; panY0: number }
  | { type: 'maybe-split'; wallId: string; sx: number; sy: number }
  | { type: 'pinch' }
  | { type: 'item'; id: string; ox: number; oy: number; moved: boolean; cycleTo?: string | null }
  | { type: 'corner'; id: string }
  | { type: 'opening'; id: string }
  | { type: 'rotate'; id: string }
  | { type: 'measure'; sx: number; sy: number; moved: boolean }
  /** dragging the tracing photo; `ox/oy` = grab offset from its top-left */
  | { type: 'underlay'; ox: number; oy: number; sx: number; sy: number; moved: boolean };

export class Plan2D {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private store: Store;
  private editor: EditorState;
  private onHint: (hint: string) => void;

  private zoom = 90; // px per meter
  private panX = 60;
  private panY = 60;
  private cssW = 100;
  private cssH = 100;

  /*
   * The six fields below are READ-ONLY MIRRORS of EditorState, recomputed by
   * syncFromEditor(). Nothing in this class assigns them anywhere else, and the
   * setX() methods only write back to the editor — see the header comment on
   * syncFromEditor for why that direction is one-way.
   */

  armedDef: CatalogDef | null = null;
  /** The def object handed to setArmed(), so identity survives the id round-trip. */
  private lastArmedDef: CatalogDef | null = null;

  measureOn = false;
  private measure: Measure = { a: null, b: null, hover: null, snapped: false, measuring: false };

  /**
   * Underlay scale calibration: the measure tool's two-click gesture, but the
   * points are NEVER snapped (they mark features in the photo, not in the
   * model) and the completed distance is handed to the owner, which asks for
   * the real-world length and rescales.
   */
  calibrateOn = false;
  /** the two clicks were `dWorld` metres apart at the current scale */
  onCalibrateDone: ((dWorld: number) => void) | null = null;
  private calibrate: Measure = { a: null, b: null, hover: null, snapped: false, measuring: false };

  /**
   * Whether the advisory (warn / info) findings are drawn. Errors ignore this
   * and always show: a cabinet inside another one is never worth hiding.
   */
  checksOn = false;

  roomToolOn = false;
  private roomGhost: RoomGhost | null = null;

  drawRoomOn = false;
  private drawPts: Point[] = [];
  private drawHover: Point | null = null;

  private ghost: ItemGhost | null = null;
  private ghostOpening: OpeningGhost | null = null;
  private drag: Drag = { type: 'none' };
  private pinch = new PinchGesture(); // two-finger pinch-zoom / pan (touch)
  private guides: Guide[] = [];
  private raf = 0;
  private fitted = false;
  /** Test/debug seam (`debug()`): counts full `draw()` executions. */
  private drawCount = 0;
  /** Test/debug seam (`debug()`): counts `endGesture()` calls. */
  private gestureCount = 0;
  private readonly isMac = isMac(navigator.platform, navigator.userAgent);

  /* ---------------- lifecycle ---------------- */

  /** Aborts every DOM listener registered by the CURRENT attach(); null while detached. */
  private ac: AbortController | null = null;
  private ro: ResizeObserver | null = null;
  /** store.on() disposers of the current attach(), run and cleared by detach(). */
  private subs: (() => void)[] = [];
  private attached = false;
  /** EditorState subscription — taken in the constructor, released by dispose(). */
  private editorOff: () => void;
  /** Which tool the last sync saw, so the NEXT one knows what it is leaving. */
  private lastTool: ToolId = 'select';

  /**
   * Constructed DETACHED: the canvas arrives from `attach()`, which is what a
   * React ref effect calls once the element is in the document. Nothing here
   * touches the DOM, so the view can be built before the shell renders.
   *
   * The editor subscription is taken HERE and not in attach(): tool state is
   * app state, so a detached view must still track it (its mirrors, its hint
   * and the cursor it re-applies on the next attach) rather than wake up stale.
   */
  constructor(store: Store, editor: EditorState, onHint: (hint: string) => void) {
    this.store = store;
    this.editor = editor;
    this.onHint = onHint;
    this.editorOff = editor.subscribe(() => this.syncFromEditor());
  }

  /**
   * Bind to `canvas`: DOM listeners, the parent ResizeObserver and the store
   * subscriptions. Re-attaching the canvas already held is a no-op, so a
   * double-mount (React StrictMode) costs nothing and double-subscribes
   * nothing; a different canvas re-wires onto it.
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
    this.resize();

    this.subs.push(
      this.store.on('change', () => this.requestDraw()),
      this.store.on('selection', () => {
        this.updateHint();
        this.requestDraw();
      }),
      // the active room drives floor/wall shading and the handle set
      this.store.on('activeRoom', () => {
        this.updateHint();
        this.requestDraw();
      })
    );

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal });
    canvas.addEventListener(
      'pointercancel',
      (e) => {
        this.pinch.up(e.pointerId);
        this.endGesture();
      },
      { signal }
    );
    canvas.addEventListener(
      'pointerleave',
      () => {
        if (this.drag.type === 'none') {
          this.ghost = null;
          this.ghostOpening = null;
          this.roomGhost = null;
          this.drawHover = null; // the ring stays; only its rubber band leaves
          this.requestDraw();
        }
      },
      { signal }
    );
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal });
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e), { signal });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    this.updateHint();
    // a tool armed while this view was detached still owns the cursor
    canvas.style.cursor = this.toolCursor();
  }

  /**
   * Release everything attach() wired: listeners, observer, subscriptions and
   * any pending frame. A detached view paints nothing and hears nothing;
   * calling it twice is a no-op. View state (pan/zoom, armed tool) survives.
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

  /** Permanent teardown: detach, plus the editor subscription attach() never took. */
  dispose(): void {
    this.detach();
    this.editorOff();
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

  /** Snapshot of the current pan/zoom transform, for callers outside the render loop. */
  viewport(): { zoom: number; panX: number; panY: number; cssW: number; cssH: number } {
    return { zoom: this.zoom, panX: this.panX, panY: this.panY, cssW: this.cssW, cssH: this.cssH };
  }

  /** Assign the given viewport fields and redraw — the public way to move/zoom the camera. */
  setViewport(v: Partial<{ zoom: number; panX: number; panY: number }>): void {
    if (v.zoom !== undefined) this.zoom = v.zoom;
    if (v.panX !== undefined) this.panX = v.panX;
    if (v.panY !== undefined) this.panY = v.panY;
    this.requestDraw();
  }

  /* ---------------- tool reconcile (EditorState → this view) ---------------- */

  /**
   * Reconcile this view with EditorState. The ONE place the six tool fields are
   * written, and the replacement for the old closeOtherTools(keep) — switching
   * tools now means cleaning up after the tool being LEFT, not reaching into
   * every other tool's state from whichever setter happened to fire.
   *
   * Strictly one-way: this method never writes to the editor. A write here
   * would re-enter through the subscription that called it.
   */
  private syncFromEditor(): void {
    const tool = this.editor.tool;
    if (tool !== this.lastTool) {
      // drop whatever the tool we are leaving had in flight
      switch (this.lastTool) {
        case 'calibrate':
          this.resetCalibrate();
          break;
        case 'place':
          this.ghost = null;
          this.ghostOpening = null;
          break;
        case 'measure':
          this.resetMeasure();
          break;
        case 'room':
          this.roomGhost = null;
          break;
        case 'drawRoom':
          this.resetDrawRing();
          break;
      }
      this.lastTool = tool;
    }
    this.armedDef = tool === 'place' ? this.resolveArmed(this.editor.armedDefId) : null;
    this.measureOn = tool === 'measure';
    this.calibrateOn = tool === 'calibrate';
    this.roomToolOn = tool === 'room';
    this.drawRoomOn = tool === 'drawRoom';
    this.checksOn = this.editor.checksOn;
    if (this.attached) this.canvas.style.cursor = this.toolCursor();
    this.updateHint();
    this.requestDraw();
  }

  /**
   * defId → CatalogDef, NULL-SAFE. `store.defOf` THROWS on an id that resolves
   * nowhere, and an armed id can go stale under the tool (deleting the custom
   * part it points at), so a miss yields null instead. The object setArmed()
   * was handed wins while the ids match — the catalog builds a fresh def per
   * render and the ghost compares by identity in places.
   */
  private resolveArmed(id: string | null): CatalogDef | null {
    if (!id) return null;
    if (this.lastArmedDef?.id === id) return this.lastArmedDef;
    const part = this.store.partOf(id);
    if (part) return toCatalogDef(part);
    return hasCatalogDef(id) ? catalogDef(id) : null;
  }

  /** Whichever tool owns the cursor wants a crosshair. */
  private toolCursor(): string {
    return this.armedDef || this.measureOn || this.roomToolOn || this.drawRoomOn || this.calibrateOn
      ? 'crosshair'
      : 'default';
  }

  /* ---------------- arming (placement from catalog) ---------------- */

  /*
   * Every setX() below is a DELEGATE: it performs its own entry reset (the
   * state that must go even when the tool is re-armed while already live —
   * re-clicking the draw tool drops the ring in progress) and then hands the
   * switch to EditorState, which calls back into syncFromEditor(). Re-arming
   * the tool already selected is a no-op upstream, so each delegate repaints
   * itself afterwards — the entry reset must be visible immediately even when
   * syncFromEditor() never runs (coalesced, so a double repaint is free).
   */

  setArmed(def: CatalogDef | null): void {
    this.ghost = null;
    this.ghostOpening = null;
    this.lastArmedDef = def;
    this.editor.setTool(def ? 'place' : 'select', def?.id ?? null);
    this.updateHint();
    this.requestDraw();
  }

  /* ---------------- measure tool ---------------- */

  private resetMeasure(): void {
    this.measure = { a: null, b: null, hover: null, snapped: false, measuring: false };
  }

  setMeasure(on: boolean): void {
    this.resetMeasure();
    this.editor.setTool(on ? 'measure' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /* ---------------- underlay calibration ---------------- */

  private resetCalibrate(): void {
    this.calibrate = { a: null, b: null, hover: null, snapped: false, measuring: false };
  }

  setCalibrate(on: boolean): void {
    this.resetCalibrate();
    this.editor.setTool(on ? 'calibrate' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /** The second click closes the span and hands its length to the owner. */
  private calibrateClick(w: Point): void {
    if (!this.calibrate.measuring) {
      this.calibrate = { a: w, b: null, hover: w, snapped: false, measuring: true };
      this.updateHint();
      this.requestDraw();
      return;
    }
    const a = this.calibrate.a!;
    this.calibrate.b = w;
    this.calibrate.measuring = false;
    // paint the finished span NOW: the owner answers with a blocking prompt,
    // and a requestAnimationFrame draw would not land until after it closes
    this.draw();
    const d = Math.hypot(w.x - a.x, w.y - a.y);
    if (d > 1e-6) this.onCalibrateDone?.(d);
    this.setCalibrate(false);
  }

  /* ---------------- tracing underlay ---------------- */

  /**
   * Whether a plan drag should grab the photo instead of panning. Requires the
   * pointer to be OVER the image: outside it the plan still pans, so an
   * unlocked underlay never takes the pan gesture hostage.
   */
  private hitUnderlay(w: Point): boolean {
    const ref = this.store.underlayRef();
    if (!ref || !ref.u.visible || ref.u.locked) return false;
    // a hover can beat the first draw to the cache, so this path arms the
    // redraw callback too — whichever caller creates the entry owns it
    const img = underlayImage(ref.src, () => this.requestDraw());
    return !!img && underlayHits(ref.u, img.naturalWidth, img.naturalHeight, w);
  }

  /* ---------------- checks overlay ---------------- */

  /**
   * Not a tool — a display toggle, so it takes no gestures and stays on
   * alongside arming, measuring or the room tool.
   */
  setChecks(on: boolean): void {
    this.editor.setChecks(on);
  }

  /* ---------------- add-room tool ---------------- */

  setRoomTool(on: boolean): void {
    this.roomGhost = null;
    this.editor.setTool(on ? 'room' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /* ---------------- draw-room tool ---------------- */

  private resetDrawRing(): void {
    this.drawPts = [];
    this.drawHover = null;
  }

  setDrawRoom(on: boolean): void {
    this.resetDrawRing();
    this.editor.setTool(on ? 'drawRoom' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /** Esc drops the in-progress ring first; only an empty one disarms the tool. */
  cancelDrawRoom(): void {
    if (!this.drawPts.length) {
      this.setDrawRoom(false);
      return;
    }
    this.resetDrawRing();
    this.updateHint();
    this.requestDraw();
  }

  /**
   * Where the pending vertex would land: another room's corner or wall wins
   * outright (that flushness is what the weld turns into a partition), else the
   * 5 cm grid with an ortho assist onto the previous and first vertices.
   */
  private snapDrawPoint(w: Point): Point {
    const near = snapPointToRooms(this.store.design.rooms, w);
    if (near.hit) return near.p;
    const p = { x: Math.round(w.x * 20) / 20, y: Math.round(w.y * 20) / 20 };
    for (const v of [this.drawPts[this.drawPts.length - 1], this.drawPts[0]]) {
      if (!v) continue;
      if (Math.abs(w.x - v.x) < DRAW_ALIGN) p.x = v.x;
      if (Math.abs(w.y - v.y) < DRAW_ALIGN) p.y = v.y;
    }
    return p;
  }

  /** Is `p` on the ring's first vertex, i.e. on the close target? */
  private onCloseTarget(p: Point | null): boolean {
    const first = this.drawPts[0];
    if (!p || !first || this.drawPts.length < 3) return false;
    return Math.hypot(p.x - first.x, p.y - first.y) * this.zoom < hitRadius(10);
  }

  private addDrawPoint(p: Point): void {
    if (this.onCloseTarget(p)) {
      this.closeDrawRoom();
      return;
    }
    // a double-click's second press repeats the first — never a zero-length wall
    const last = this.drawPts[this.drawPts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) return;
    this.drawPts.push(p);
    this.updateHint();
    this.requestDraw();
  }

  /** Turn the drawn ring into a room. An unusable outline stays up to be fixed. */
  closeDrawRoom(): void {
    if (this.drawPts.length < 3) return;
    const room = this.store.addRoom({ polygon: this.drawPts });
    if (!room) {
      this.onHint('That outline is not a usable room — it crosses itself or is too small');
      return;
    }
    this.store.select({ kind: 'none' }); // the new room's panel is the no-selection one
    this.store.commit();
    this.setDrawRoom(false);
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
    // free-standing: a w×d rectangle centred on the cursor. A side within reach
    // of another room goes exactly flush with it (addRoom then welds the two
    // into a partition); the drag grid only rules the axes that did not snap.
    const flush = snapRoomRect(
      this.store.design.rooms,
      w.x - NEW_ROOM_W / 2,
      w.y - NEW_ROOM_D / 2,
      NEW_ROOM_W,
      NEW_ROOM_D
    );
    const x = flush.snappedX ? flush.x : Math.round(flush.x * 20) / 20;
    const y = flush.snappedY ? flush.y : Math.round(flush.y * 20) / 20;
    return {
      poly: [
        { x, y },
        { x: x + NEW_ROOM_W, y },
        { x: x + NEW_ROOM_W, y: y + NEW_ROOM_D },
        { x, y: y + NEW_ROOM_D },
      ],
      opts: { at: { x, y }, w: NEW_ROOM_W, d: NEW_ROOM_D },
      attached: false,
      flush: flush.snappedX || flush.snappedY,
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
    const thr = hitRadius(11) / this.zoom; // ~11 px reach, in world units

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
      for (const v of itemOutlineWorld(this.store, it)) tryV(v);
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
      const o = itemOutlineWorld(this.store, it);
      for (let i = 0; i < o.length; i++) tryE(o[i], o[(i + 1) % o.length]);
    }
    if (best) return { p: best, snapped: true };

    return { p: w, snapped: false };
  }

  /* ---------------- hints ---------------- */

  private updateHint(): void {
    if (this.calibrateOn) {
      this.onHint(
        this.calibrate.measuring
          ? 'Click the other end of the known distance · Esc cancels'
          : 'Click both ends of a distance you know in the photo · Esc cancels'
      );
      return;
    }
    if (this.roomToolOn) {
      this.onHint(
        'Click to place a room · hover a wall to attach it · Shift keeps the tool · Esc cancels'
      );
      return;
    }
    if (this.drawRoomOn) {
      this.onHint(
        this.drawPts.length >= 3
          ? 'Click the first corner (or Enter) to close the room · Esc discards it'
          : 'Click each corner of the room · corners snap to neighbouring rooms · Esc exits'
      );
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
        this.onHint(
          `Click on a wall to place the ${this.armedDef.label.toLowerCase()} · Esc cancels`
        );
      } else if (this.armedDef.marker) {
        this.onHint(
          `Click near a wall to mark the ${this.armedDef.label.toLowerCase()} · Shift places several · Esc cancels`
        );
      } else {
        this.onHint(
          'Click to place · items snap to walls and neighbours · Shift places several · Esc cancels'
        );
      }
      return;
    }
    const sel = this.store.selection;
    switch (sel.kind) {
      case 'item':
        this.onHint(
          'Drag to move · click again for the item underneath · R rotates · arrows nudge · Ctrl+D duplicates · Delete removes'
        );
        break;
      case 'corner':
        this.onHint('Drag the corner to reshape the room · Delete removes it');
        break;
      case 'wall':
        this.onHint(
          'Edit the wall length in the panel · drag ◆ on a wall to bend it · double-click adds a corner'
        );
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

  /**
   * Snapshot of which single-gesture tool (if any) is currently armed — the
   * mirrors, so it is what this view will actually DRAW, not what the editor
   * intends. They agree by construction; a divergence is the bug worth seeing.
   */
  toolState(): {
    armedDefId: string | null;
    measure: boolean;
    calibrate: boolean;
    room: boolean;
    draw: boolean;
    checks: boolean;
  } {
    return {
      armedDefId: this.armedDef?.id ?? null,
      measure: this.measureOn,
      calibrate: this.calibrateOn,
      room: this.roomToolOn,
      draw: this.drawRoomOn,
      checks: this.editor.checksOn,
    };
  }

  /** Snapshot of the in-flight overlay state — the measure span, room-tool ghost and draw ring. */
  overlayState(): { measure: Measure; roomGhost: RoomGhost | null; drawRing: DrawRing | null } {
    return { measure: this.measure, roomGhost: this.roomGhost, drawRing: this.drawRing() };
  }

  /* ---------------- pointer handling ---------------- */

  private hitCorner(s: Point): string | null {
    for (const c of this.store.activeRoom().corners) {
      const cs = this.toScreen(c);
      if (Math.hypot(cs.x - s.x, cs.y - s.y) < hitRadius(9)) return c.id;
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
      if (Math.hypot(m.x - s.x, m.y - s.y) < hitRadius(8)) return w.id;
    }
    return null;
  }

  private hitRotateHandle(s: Point): string | null {
    const sel = this.store.selection;
    if (sel.kind !== 'item') return null;
    const it = this.store.itemById(sel.id);
    if (!it || it.attach) return null; // attached items derive their rotation
    const h = rotateHandlePos(it);
    const hs = this.toScreen(h);
    if (Math.hypot(hs.x - s.x, hs.y - s.y) < hitRadius(9)) return it.id;
    return null;
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

  /** all items under the point, top-most first (reverse of draw order) */
  private hitItems(w: Point): Item[] {
    const out: Item[] = [];
    for (const it of [...sortedItems(this.store)].reverse()) {
      const fp = footprintOf(this.store, it);
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

  /**
   * What is under a VIEWPORT point (clientX/clientY), as a value — the read-only
   * half of `onPointerDown`, for callers that want to know rather than to drag.
   * The context menu (src/ui/react/ContextMenu.tsx) is the only one today.
   *
   * Deliberately NOT the full pointerdown cascade: the drag handles (corner,
   * rotate, wall-bend midpoint) are gestures with no menu of their own, and the
   * underlay is a tracing aid, so all four fall through to whatever they sit
   * over. What is left is the object cascade — item → wall → room — with an
   * opening reported as its host wall.
   *
   * No new geometry: every branch delegates to the private tester the pointer
   * path already uses. Detached (no canvas) it reports 'empty' rather than
   * throwing, the same null-safety rule `resolveArmed` follows.
   */
  hitAt(clientX: number, clientY: number): ContextHit {
    if (!this.attached) return { kind: 'empty' };
    const rect = this.canvas.getBoundingClientRect();
    const w = this.toWorld(clientX - rect.left, clientY - rect.top);

    const item = this.hitItem(w);
    if (item) return { kind: 'item', itemId: item.id };

    const opening = this.hitOpening(w);
    const wallId = opening ? opening.wallId : this.hitWall(w);
    if (wallId) {
      const g = this.store.wallById(wallId);
      // an opening can outlive its wall for one notify; fall through if so
      if (g) return { kind: 'wall', wallId, t: clamp(projectOnWall(g, w).t, 0, g.len) };
    }

    const roomId = this.hitRoom(w);
    return roomId ? { kind: 'room', roomId } : { kind: 'empty' };
  }

  private onPointerDown(e: PointerEvent): void {
    const s = { x: e.offsetX, y: e.offsetY };
    if (e.pointerType === 'touch') {
      if (this.pinch.down(e.pointerId, s)) {
        // second finger: abandon the single-finger gesture, start pinch zoom/pan
        if (['corner', 'opening', 'item', 'rotate', 'underlay'].includes(this.drag.type)) {
          this.store.commit();
        }
        this.drag = { type: 'pinch' };
        this.guides = [];
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.pinch.overflowing) return; // ignore extra fingers
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
        this.measure = {
          a: snap.p,
          b: null,
          hover: snap.p,
          snapped: snap.snapped,
          measuring: true,
        };
        this.drag = { type: 'measure', sx: s.x, sy: s.y, moved: false };
      }
      this.updateHint();
      this.requestDraw();
      return;
    }

    // calibrating the underlay: two raw (never snapped) clicks on the photo
    if (this.calibrateOn) {
      this.calibrateClick(w);
      return;
    }

    // dropping a new room
    if (this.roomToolOn) {
      this.placeRoom(w, e.shiftKey);
      return;
    }

    // drawing one corner by corner
    if (this.drawRoomOn) {
      this.addDrawPoint(this.snapDrawPoint(w));
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
    // nothing modelled here: an unlocked photo under the cursor takes the drag
    if (this.hitUnderlay(w)) {
      const u = this.store.design.underlay!;
      this.drag = {
        type: 'underlay',
        ox: w.x - u.x,
        oy: w.y - u.y,
        sx: s.x,
        sy: s.y,
        moved: false,
      };
      return;
    }
    // empty space: maybe-pan; deselect on plain click
    this.drag = {
      type: 'maybe-pan',
      sx: s.x,
      sy: s.y,
      panX0: this.panX,
      panY0: this.panY,
      moved: false,
    };
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
    if (this.pinch.has(e.pointerId)) this.pinch.track(e.pointerId, s);

    switch (this.drag.type) {
      case 'pinch': {
        const res = this.pinch.step({ zoom: this.zoom, panX: this.panX, panY: this.panY }, 15, 400);
        if (!res) return;
        this.zoom = res.zoom;
        this.panX = res.panX;
        this.panY = res.panY;
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
        const room = this.store.roomOfCorner(dragId);
        const c = room?.corners ?? [];
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
        // another room's corner or wall wins over both: landing exactly on it
        // is what lets endGesture weld the two rings into a partition
        const flush = snapPointToRooms(this.store.design.rooms, w, room?.id);
        if (flush.hit) {
          x = flush.p.x;
          y = flush.p.y;
        }
        this.store.moveCorner(dragId, x, y);
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
            this.store.updateItem(
              it.id,
              { x: p.x, y: p.y },
              { structural: false, transient: true }
            );
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
      case 'underlay': {
        const d = this.drag;
        // below the threshold this is still a click (which deselects), so the
        // photo must not creep on a shaky press
        if (!d.moved && Math.hypot(s.x - d.sx, s.y - d.sy) <= 4) return;
        d.moved = true;
        this.canvas.style.cursor = 'grabbing';
        this.store.updateUnderlay(
          { x: w.x - d.ox, y: w.y - d.oy },
          { structural: false, transient: true }
        );
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

    // draw-room tool: rubber-band the pending vertex
    if (this.drawRoomOn) {
      this.drawHover = this.snapDrawPoint(w);
      this.canvas.style.cursor = 'crosshair';
      this.requestDraw();
      return;
    }

    // calibrating, between clicks: rubber-band from the first raw point
    if (this.calibrateOn) {
      this.calibrate.hover = w;
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
        this.ghost = {
          x: res.x,
          y: res.y,
          rotation: res.rotation,
          valid: !needWall || !!res.wallId,
        };
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
            : this.hitUnderlay(w)
              ? 'grab'
              : 'default';
    this.canvas.style.cursor = hover;
  }

  private onPointerUp(e: PointerEvent): void {
    this.pinch.up(e.pointerId);
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
    if ((wasDrag.type === 'maybe-pan' || wasDrag.type === 'underlay') && !wasDrag.moved) {
      // a click on empty floor of another room switches to it; a drag only
      // pans (or, over the photo, moves it)
      const roomId = this.hitRoom(this.toWorld(wasDrag.sx, wasDrag.sy));
      if (roomId) this.store.setActiveRoom(roomId);
      this.store.select({ kind: 'none' });
    }
    if (wasDrag.type === 'maybe-split') {
      this.store.select({ kind: 'wall', id: wasDrag.wallId });
    }
    if (
      wasDrag.type === 'item' &&
      !wasDrag.moved &&
      wasDrag.cycleTo &&
      wasDrag.cycleTo !== wasDrag.id
    ) {
      this.store.select({ kind: 'item', id: wasDrag.cycleTo });
    }
    this.endGesture();
  }

  /** Shared teardown for pointerup and pointercancel — commits any in-flight edit. */
  private endGesture(): void {
    this.gestureCount++;
    const wasDrag = this.drag;
    this.drag = { type: 'none' };
    this.guides = [];
    this.canvas.style.cursor = this.toolCursor();
    if (wasDrag.type === 'corner') {
      // welding cuts other rings, so it belongs at the end of the gesture —
      // never on the pointermoves that drag the corner there
      const room = this.store.roomOfCorner(wasDrag.id);
      if (room) this.store.weldRoom(room.id);
    }
    if (['corner', 'opening', 'item', 'rotate', 'underlay'].includes(wasDrag.type)) {
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
    if (this.drawRoomOn) {
      this.closeDrawRoom(); // the two presses already placed the last corner
      return;
    }
    if (this.armedDef || this.roomToolOn || this.calibrateOn) return;
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
    if (this.raf || !this.attached) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private drawRing(): DrawRing | null {
    if (!this.drawRoomOn || !this.drawPts.length) return null;
    return {
      pts: this.drawPts,
      hover: this.drawHover,
      closing: this.onCloseTarget(this.drawHover),
    };
  }

  private draw(): void {
    this.drawCount++;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderPlan(
      ctx,
      this.store,
      { zoom: this.zoom, panX: this.panX, panY: this.panY, cssW: this.cssW, cssH: this.cssH },
      // on screen every layer is live; only the ⚠ advisory findings are opt-in
      {
        underlay: true,
        onUnderlayLoad: () => this.requestDraw(),
        handles: true,
        guides: true,
        ghosts: true,
        // calibration reuses the measurement overlay for its two-point span
        measure: this.measureOn || this.calibrateOn,
        checks: true,
        roomEmphasis: true,
      },
      {
        guides: this.guides,
        armedDef: this.armedDef,
        ghost: this.ghost,
        ghostOpening: this.ghostOpening,
        roomGhost: this.roomToolOn ? this.roomGhost : null,
        drawRing: this.drawRing(),
        measure: this.calibrateOn ? this.calibrate : this.measure,
        advisoryChecks: this.checksOn,
      }
    );
  }

  /** Test/debug seam: draw + gesture counters and the live drag kind — a no-sleep assertion hook. */
  debug(): { drawCount: number; gestureCount: number; dragKind: string } {
    return { drawCount: this.drawCount, gestureCount: this.gestureCount, dragKind: this.drag.type };
  }
}
