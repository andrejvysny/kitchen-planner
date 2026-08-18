import { catalogDef, hasCatalogDef, isWallMounted, type CatalogDef } from '../model/catalog';
import {
  clamp,
  insetPolygon,
  pointInPolygon,
  pointInRect,
  projectOnWall,
  rot,
  signedArea,
} from '../model/geometry';
import {
  faceRingPlan,
  snapPointToCentrelines,
  snapPointToRooms,
  snapRectSides,
  type RoomWall,
} from '../model/rooms';
import { unitPrefs } from '../model/prefs';
import { parseLength } from '../model/units';
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
import { underlayCorners, underlayHits } from '../model/underlay';
import {
  bandCenter,
  cornerHandlePositions,
  footprintOf,
  midpointHandlePos,
  itemOutlineWorld,
  renderPlan,
  rotateHandlePos,
  sortedItems,
  underlayImage,
  type DrawRing,
  type HoverOverlay,
  type ItemGhost,
  type Measure,
  type OpeningGhost,
} from './renderPlan';

/** Ortho assist for the wall tool — snapping.ts' ALIGN_SNAP_DIST. */
const DRAW_ALIGN = 0.06;
/** Shift locks the pending segment to this angular step (15°). */
const ANGLE_STEP = Math.PI / 12;
/** Below this on either side a drag is a click, not a rectangle (m). */
const MIN_RECT_SIDE = 0.4;
/** Screen px a press must travel before it counts as a rectangle drag. */
const RECT_DRAG_SLOP = 4;

/** Re-wind a ring counter-clockwise, which is what `insetPolygon` needs. */
function ccw(pts: Point[]): Point[] {
  return signedArea(pts) > 0 ? pts : [...pts].reverse();
}

type Drag =
  | { type: 'none' }
  | { type: 'maybe-pan'; sx: number; sy: number; panX0: number; panY0: number; moved: boolean }
  | { type: 'pan'; sx: number; sy: number; panX0: number; panY0: number }
  | { type: 'maybe-split'; wallId: string; sx: number; sy: number }
  /**
   * The wall tool's press, before it is known to be a drag: below
   * RECT_DRAG_SLOP it releases as a plain click (the first corner of a ring),
   * past it the rectangle takes over. `a` is the already-snapped anchor.
   */
  | { type: 'drawRect'; a: Point; sx: number; sy: number; moved: boolean }
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

  drawRoomOn = false;
  /**
   * The ring being drawn, in wall-CENTRELINE space — NOT the room-side face
   * ring the model stores. `closeDrawRoom` insets it by half the wall width to
   * make the face polygon `addRoom` takes.
   */
  private drawPts: Point[] = [];
  private drawHover: Point | null = null;
  /** Typed dimension for the pending segment; '' = follow the cursor. */
  private drawLength = '';
  /** The live drag-rectangle's centreline ring, or null outside that gesture. */
  private drawRect: Point[] | null = null;
  /** Last cursor position + modifier, so a typed digit can re-snap without a move. */
  private lastPointer: Point | null = null;
  private lastShift = false;

  private ghost: ItemGhost | null = null;
  private ghostOpening: OpeningGhost | null = null;
  /**
   * WP 2.3 (WS-SPEC §5.3): what the cursor sits over in select mode, so
   * renderPlan can grow/fill a handle or pre-highlight a wall. Pure paint —
   * set only from hit testers onPointerMove already runs, never drives a
   * store write. Must not go stale once the pointer leaves it (see
   * clearHover()'s callers).
   */
  private hover: HoverOverlay = { handle: null, wallId: null };
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
        this.clearHover();
        if (this.drag.type === 'none') {
          this.ghost = null;
          this.ghostOpening = null;
          this.lastPointer = null;
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

  /**
   * Frame everything there is to look at: every room corner PLUS the tracing
   * reference's four corners. A design being traced has no rooms yet, so
   * fitting rooms alone left the freshly imported plan wherever it happened to
   * land — usually off-canvas, which reads as "nothing was imported".
   */
  zoomFit(): void {
    const c = this.store.design.rooms.flatMap((r) => r.corners) as Point[];
    const ref = this.store.underlayRef();
    // the natural size lives in the decoded bitmap, not in the Design (the
    // transform is all that is stored) — a miss just means "not decoded yet",
    // and the requestDraw the loader triggers is not a refit, so callers that
    // import then fit go through `zoomFitWhenReady`
    const img = ref ? underlayImage(ref.src) : null;
    if (ref && img) c.push(...underlayCorners(ref.u, img.naturalWidth, img.naturalHeight));
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

  /**
   * `zoomFit`, but waiting for the tracing reference to finish decoding first.
   * An import fits IMMEDIATELY on a cached image and on the load callback
   * otherwise, so "I picked a plan and nothing appeared" cannot happen either
   * way. Gives up rather than hanging if the image never loads.
   */
  zoomFitWhenReady(): void {
    const ref = this.store.underlayRef();
    if (!ref || underlayImage(ref.src, () => this.zoomFit())) this.zoomFit();
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
      // hover is select-mode-only paint; any tool switch (in or out of
      // select) must not leave it behind
      this.clearHover();
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
        case 'drawRoom':
          this.resetDrawRing();
          break;
      }
      this.lastTool = tool;
    }
    this.armedDef = tool === 'place' ? this.resolveArmed(this.editor.armedDefId) : null;
    this.measureOn = tool === 'measure';
    this.calibrateOn = tool === 'calibrate';
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
    return this.armedDef || this.measureOn || this.drawRoomOn || this.calibrateOn
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

  /* ---------------- wall tool (draw rooms) ---------------- */

  /*
   * ONE tool, two gestures, both in CENTRELINE space:
   *
   *   drag  → an axis-aligned rectangle sized under the cursor
   *   click → a corner-by-corner ring, closed on the first corner or Enter
   *
   * Everything here works on wall CENTRELINES, not on the room-side face ring
   * the model stores. That is the whole fix for the old tool: snapping the face
   * ring left a drawn corner half a wall thickness off its neighbour, and the
   * weld then cut the mismatch into stub segments. `closeDrawRoom` insets the
   * centreline ring by the half width to reach the face ring the Design wants,
   * which is the same conversion migrate.ts already does for a v5 design.
   */

  private resetDrawRing(): void {
    this.drawPts = [];
    this.drawHover = null;
    this.drawLength = '';
    this.drawRect = null;
  }

  setDrawRoom(on: boolean): void {
    this.resetDrawRing();
    this.editor.setTool(on ? 'drawRoom' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /** Esc drops the in-progress ring first; only an empty one disarms the tool. */
  cancelDrawRoom(): void {
    if (!this.drawPts.length && !this.drawRect) {
      this.setDrawRoom(false);
      return;
    }
    this.resetDrawRing();
    this.updateHint();
    this.requestDraw();
  }

  /** The width every wall of the room being drawn gets (m). */
  private drawWidth(): number {
    return this.editor.wallWidth;
  }

  /**
   * Where the pending vertex would land, in order of authority:
   *
   *  1. another room's wall CENTRELINE — a mitred junction, then a segment;
   *     landing there is what makes the finished face rings flush, so the weld
   *     produces one clean partition instead of stubs;
   *  2. a typed length, which fixes the distance and leaves only the direction
   *     to the cursor;
   *  3. `shift`, locking the direction to 15° off the previous vertex;
   *  4. the ortho assist onto the previous and first vertices, then the 5 cm grid.
   */
  private snapDrawPoint(w: Point, shift = false): Point {
    const anchor = this.drawPts[this.drawPts.length - 1];
    const locked = this.angleLocked(shift);

    const typed = this.typedLength();
    if (typed !== null && anchor) {
      const dir = this.pendingDir(anchor, w, locked);
      return { x: anchor.x + dir.x * typed, y: anchor.y + dir.y * typed };
    }

    // an existing wall centreline still outranks the angle lock: landing on a
    // neighbour is what makes the rooms share a partition, and no angle is
    // worth breaking that
    const near = snapPointToCentrelines(this.store.design.rooms, w);
    if (near.hit) return near.p;

    if (locked && anchor) {
      const dir = this.pendingDir(anchor, w, true);
      const len = Math.hypot(w.x - anchor.x, w.y - anchor.y);
      return { x: anchor.x + dir.x * len, y: anchor.y + dir.y * len };
    }

    const p = { x: Math.round(w.x * 20) / 20, y: Math.round(w.y * 20) / 20 };
    for (const v of [anchor, this.drawPts[0]]) {
      if (!v) continue;
      if (Math.abs(w.x - v.x) < DRAW_ALIGN) p.x = v.x;
      if (Math.abs(w.y - v.y) < DRAW_ALIGN) p.y = v.y;
    }
    return p;
  }

  /**
   * Whether the pending segment's angle is quantised. The preference decides,
   * and Shift INVERTS it: a plan is nearly all right angles, so snapping is the
   * default and Shift is the escape hatch — but with the preference off, Shift
   * still gets you one snapped wall without turning it back on.
   */
  private angleLocked(shift: boolean): boolean {
    return this.editor.angleSnap !== shift;
  }

  /**
   * Unit direction of the pending segment, quantised to ANGLE_STEP (15°) when
   * locked — which covers right angles as the 0/90° cases and the 45°
   * diagonals a floor plan actually uses.
   */
  private pendingDir(anchor: Point, w: Point, locked: boolean): Point {
    let a = Math.atan2(w.y - anchor.y, w.x - anchor.x);
    if (locked) a = Math.round(a / ANGLE_STEP) * ANGLE_STEP;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  /** Is `p` on the ring's first vertex, i.e. on the close target? */
  private onCloseTarget(p: Point | null): boolean {
    const first = this.drawPts[0];
    if (!p || !first || this.drawPts.length < 3) return false;
    return Math.hypot(p.x - first.x, p.y - first.y) * this.zoom < hitRadius(10);
  }

  private addDrawPoint(p: Point): void {
    if (this.onCloseTarget(p)) {
      // land the click on the first corner exactly, so `ringIsClosed` sees a
      // ring rather than an open chain that happens to end nearby
      this.drawPts.push({ ...this.drawPts[0] });
      this.closeDrawRoom();
      return;
    }
    // a double-click's second press repeats the first — never a zero-length wall
    const last = this.drawPts[this.drawPts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-6) return;
    this.drawPts.push(p);
    this.drawLength = ''; // the typed length applied to THAT segment only
    this.updateHint();
    this.requestDraw();
  }

  /* ---- type-in segment length ---- */

  /**
   * The typed buffer as metres, or null when nothing usable is pending. Parsed
   * by src/model/units.ts in the user's own unit, so '2400' is 2.4 m in a mm
   * profile and '1.2m' works anywhere.
   */
  private typedLength(): number | null {
    if (!this.drawLength) return null;
    const m = parseLength(this.drawLength, unitPrefs());
    return m !== null && m > 1e-4 ? m : null;
  }

  /** Whether a keystroke should feed the dimension box rather than a shortcut. */
  drawInputActive(): boolean {
    return this.drawRoomOn && this.drawPts.length > 0;
  }

  /** Append one typed character (digit, separator or unit suffix). */
  drawDigit(ch: string): void {
    if (!this.drawInputActive() || this.drawLength.length >= 12) return;
    this.drawLength += ch;
    this.refreshDrawHover();
  }

  drawBackspace(): void {
    if (!this.drawInputActive() || !this.drawLength) return;
    this.drawLength = this.drawLength.slice(0, -1);
    this.refreshDrawHover();
  }

  /** The typed buffer, for the overlay's dimension box. */
  drawTyped(): string {
    return this.drawLength;
  }

  /**
   * Re-run the snap from the last known cursor position, so a typed digit moves
   * the rubber-banded vertex without waiting for a pointermove.
   */
  private refreshDrawHover(): void {
    if (this.lastPointer) this.drawHover = this.snapDrawPoint(this.lastPointer, this.lastShift);
    this.updateHint();
    this.requestDraw();
  }

  /**
   * Finish the chain. What it BECOMES depends on what it is:
   *
   * - closed on its own first corner (3+ points) → a room, via `commitRing`;
   * - anything else → a free-standing wall chain (`store.addFreeWall`).
   *
   * The second case is the point: a plan is redrawn wall by wall, and a
   * divider, a peninsula or a corner stub encloses nothing. Enter and
   * double-click both land here, so "I am done" is one gesture whichever kind
   * of thing was being drawn.
   */
  closeDrawRoom(): void {
    if (this.ringIsClosed()) {
      if (!this.commitRing(this.drawPts)) return;
      this.setDrawRoom(false);
      return;
    }
    this.commitFreeWall();
  }

  /**
   * Does the chain come back to its own start? Only then is it a room. Uses the
   * same reach as the close TARGET, so what the overlay offers and what Enter
   * does cannot disagree.
   */
  private ringIsClosed(): boolean {
    const pts = this.drawPts;
    if (pts.length < 3) return false;
    const a = pts[0];
    const b = pts[pts.length - 1];
    return Math.hypot(b.x - a.x, b.y - a.y) * this.zoom < hitRadius(10);
  }

  /**
   * Commit an OPEN chain, trying the two useful readings in order:
   *
   *  1. it crosses a room twice → it is a partition, and the room is CUT in
   *     two along it (`store.splitRoom`). This is the redraw workflow: you draw
   *     only the new wall, not the three that were already there.
   *  2. otherwise → free-standing walls (a divider, a peninsula, a stub).
   *
   * Order matters: a chain drawn right across a room is almost never meant to
   * be a free wall floating inside it, and a chain that misses every room can
   * never be a split.
   */
  private commitFreeWall(): void {
    if (this.drawPts.length < 2) {
      // a single stray click is not a wall; drop it rather than warning
      this.resetDrawRing();
      this.updateHint();
      this.requestDraw();
      return;
    }
    if (this.trySplit()) return;
    const chain = this.store.addFreeWall(this.drawPts, this.drawWidth());
    if (!chain) {
      this.onHint('That chain is too short to be a wall');
      return;
    }
    this.store.select({ kind: 'wall', id: chain.corners[0].id });
    this.store.commit();
    this.setDrawRoom(false);
  }

  /**
   * Shared tail of both gestures: centreline ring → room, selection, commit.
   *
   * The inset is PER EDGE (`faceRingOffsets`), not uniform: a `Room`'s ring is
   * the room-side face on an exterior wall but the CENTRELINE on a partition,
   * so an edge drawn onto a neighbour's centreline has to stay put or the two
   * rooms end up a wall's thickness apart with nothing for the weld to join.
   */
  private commitRing(centreline: Point[]): ReturnType<Store['addRoom']> {
    const width = this.drawWidth();
    // closing ON the first corner leaves it in the list twice; a zero-length
    // edge makes insetPolygon bail, so drop the repeat before converting
    const pts = [...centreline];
    while (
      pts.length > 3 &&
      Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < 1e-6
    ) {
      pts.pop();
    }
    const ring = ccw(pts);
    // ONE pass over the rooms as they are now: which edges become partitions,
    // and which existing walls have to move out to meet them. Promoting first
    // and asking afterwards would not work — see faceRingPlan's doc comment.
    const plan = faceRingPlan(this.store.design.rooms, ring, width / 2);
    for (const wallId of plan.promote) this.store.alignWallToCentreline(wallId);
    const face = insetPolygon(ring, plan.offsets);
    if (!face) {
      this.onHint('That outline is not a usable room — it crosses itself or is too small');
      return null;
    }
    const room = this.store.addRoom({ polygon: face, style: { wallThickness: width } });
    if (!room) {
      this.onHint('That outline is not a usable room — it crosses itself or is too small');
      return null;
    }
    this.store.select({ kind: 'none' }); // the new room's panel is the no-selection one
    this.store.commit();
    return room;
  }

  /**
   * Cut whichever room the chain actually crosses. Tries every room rather than
   * only the active one — you draw where the wall goes, not where the selection
   * happens to be — and takes the first clean cut. Returns whether it split.
   */
  private trySplit(): boolean {
    for (const room of this.store.design.rooms) {
      const made = this.store.splitRoom(room.id, this.drawPts);
      if (!made) continue;
      this.store.select({ kind: 'none' });
      this.store.commit();
      this.setDrawRoom(false);
      return true;
    }
    return false;
  }

  /* ---- drag gesture: a rectangle sized under the cursor ---- */

  /**
   * The rectangle a drag from `a` to `b` would build, as a CCW centreline ring.
   * Sides within reach of another room's wall centreline land exactly on it,
   * so the two rooms weld into one partition; the 5 cm grid rules whichever
   * axis did not snap. `shift` forces a square.
   */
  private rectRing(a: Point, b: Point, shift: boolean): Point[] {
    let w = b.x - a.x;
    let h = b.y - a.y;
    if (shift) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    // each SIDE snaps on its own (snapRectSides, not a whole-rectangle slide):
    // a room laid against an existing one has to put its shared side on that
    // wall's centreline AND its flanking sides on the neighbour's, or the
    // contact comes out a few centimetres short of a weldable seam
    const snap = snapRectSides(
      this.store.design.rooms,
      Math.min(a.x, a.x + w),
      Math.min(a.y, a.y + h),
      Math.max(a.x, a.x + w),
      Math.max(a.y, a.y + h)
    );
    const grid = (v: number): number => Math.round(v * 20) / 20;
    const x0 = snap.snapped.x0 ? snap.x0 : grid(snap.x0);
    const y0 = snap.snapped.y0 ? snap.y0 : grid(snap.y0);
    const x1 = snap.snapped.x1 ? snap.x1 : grid(snap.x1);
    const y1 = snap.snapped.y1 ? snap.y1 : grid(snap.y1);
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
  }

  /** Smallest drag that counts as a rectangle rather than a click (m per side). */
  private rectUsable(ring: Point[]): boolean {
    const w = Math.abs(ring[1].x - ring[0].x);
    const h = Math.abs(ring[2].y - ring[1].y);
    return w >= MIN_RECT_SIDE && h >= MIN_RECT_SIDE;
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
    if (this.drawRoomOn) {
      const shiftDoes = this.editor.angleSnap ? 'Shift frees the angle' : 'Shift snaps to 15°';
      this.onHint(
        !this.drawPts.length
          ? 'Drag a rectangle, or click corner by corner · walls snap to wall centres · Esc cancels'
          : this.drawPts.length >= 3
            ? `Click the first corner to make a room, or Enter to finish the walls · ${shiftDoes}`
            : `Click the next corner · ${shiftDoes} · type a length · Enter finishes the walls`
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
    draw: boolean;
    checks: boolean;
    /** the wall tool's width (m) — one number, so a test can assert the ring */
    wallWidth: number;
  } {
    return {
      armedDefId: this.armedDef?.id ?? null,
      measure: this.measureOn,
      calibrate: this.calibrateOn,
      draw: this.drawRoomOn,
      checks: this.editor.checksOn,
      wallWidth: this.editor.wallWidth,
    };
  }

  /** Snapshot of the in-flight overlay state — the measure span and the draw ring. */
  overlayState(): {
    measure: Measure;
    drawRing: DrawRing | null;
    hover: HoverOverlay;
  } {
    return {
      measure: this.measure,
      drawRing: this.drawRing(),
      hover: { ...this.hover },
    };
  }

  /* ---------------- pointer handling ---------------- */

  /**
   * Drop the hover affordance and repaint once, iff something was actually
   * showing. Called on gesture start, on pointerleave and on a tool switch —
   * a stale glow after the pointer moved on is the bug this exists to avoid.
   */
  private clearHover(): void {
    if (this.hover.handle === null && this.hover.wallId === null) return;
    this.hover = { handle: null, wallId: null };
    this.requestDraw();
  }

  /**
   * Corner handles hit-test where they DRAW — at the wall centreline junction,
   * not at the raw face-ring corner. `cornerHandlePositions` is the one source
   * for both; grabbing a handle still returns the CORNER id, so the drag itself
   * keeps moving the face ring exactly as before.
   */
  private hitCorner(s: Point): string | null {
    const room = this.store.activeRoom();
    if (!room) return null;
    const handles = cornerHandlePositions(this.store, room.id);
    for (const c of room.corners) {
      const cs = this.toScreen(handles.get(c.id) ?? c);
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
      const m = this.toScreen(midpointHandlePos(w));
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
    // a gesture starting freezes the hover branch below (its updates are
    // skipped mid-drag), so leaving a stale handle/wall glow painted is the
    // failure mode clearHover() exists to prevent
    this.clearHover();
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

    // the wall tool: an empty ring may still become a drag-rectangle, so the
    // press only ARMS the gesture; onPointerUp decides drag vs. click. Once the
    // ring has a vertex the tool is committed to corner-by-corner mode.
    if (this.drawRoomOn) {
      if (this.drawPts.length) {
        this.addDrawPoint(this.snapDrawPoint(w, e.shiftKey));
      } else {
        this.drag = {
          type: 'drawRect',
          a: this.snapDrawPoint(w, e.shiftKey),
          sx: s.x,
          sy: s.y,
          moved: false,
        };
      }
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
      case 'drawRect': {
        const d = this.drag;
        if (!d.moved && Math.hypot(s.x - d.sx, s.y - d.sy) <= RECT_DRAG_SLOP) return;
        d.moved = true;
        // a rectangle is axis-aligned by construction, so the angle lock has
        // nothing to say here — Shift means SQUARE instead
        this.drawRect = this.rectRing(d.a, this.snapDrawPoint(w, false), e.shiftKey);
        this.requestDraw();
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

    // wall tool: rubber-band the pending vertex
    if (this.drawRoomOn) {
      this.drawHover = this.snapDrawPoint(w, e.shiftKey);
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

    // select mode, nothing armed, no drag: cursor feedback AND the WP 2.3
    // hover affordance share one hit-test pass — same testers, same priority
    // order the cursor logic already used, results reused rather than
    // re-run. The rotate handle has no hover paint of its own (it only ever
    // shows on the current selection), so it still only affects the cursor.
    const s2 = { x: e.offsetX, y: e.offsetY };
    const cornerId = this.hitCorner(s2);
    const rotateId = cornerId ? null : this.hitRotateHandle(s2);
    const midpointId = cornerId || rotateId ? null : this.hitMidpoint(s2);
    const handleHit = cornerId || rotateId || midpointId;
    const openingHit = handleHit ? null : this.hitOpening(w);
    const itemHit = handleHit || openingHit ? null : this.hitItem(w);
    const wallId = handleHit || openingHit || itemHit ? null : this.hitWall(w);
    this.canvas.style.cursor = handleHit
      ? 'pointer'
      : openingHit || itemHit
        ? 'move'
        : wallId
          ? 'pointer'
          : this.hitUnderlay(w)
            ? 'grab'
            : 'default';

    const nextHandle: HoverOverlay['handle'] = cornerId
      ? { kind: 'corner', id: cornerId }
      : midpointId
        ? { kind: 'midpoint', id: midpointId }
        : null;
    const nextWallId = nextHandle ? null : wallId;
    const prev = this.hover;
    if (
      prev.handle?.kind !== nextHandle?.kind ||
      prev.handle?.id !== nextHandle?.id ||
      prev.wallId !== nextWallId
    ) {
      this.hover = { handle: nextHandle, wallId: nextWallId };
      this.requestDraw();
    }
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
    if (wasDrag.type === 'drawRect') {
      // a press that never travelled is the ring's FIRST corner, not a
      // rectangle — the two gestures share one press, and this is where they
      // part. A drag too small to be a room falls back the same way.
      const ring = this.drawRect;
      this.drawRect = null;
      if (wasDrag.moved && ring && this.rectUsable(ring)) {
        if (this.commitRing(ring)) this.setDrawRoom(false);
      } else {
        this.addDrawPoint(wasDrag.a);
      }
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
    if (this.armedDef || this.calibrateOn) return;
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

  /**
   * The wall tool's overlay. ONE shape serves both gestures: the drag
   * rectangle is just a `closed` ring with no rubber band, so renderPlan draws
   * the preview through a single code path and the drag and the click produce
   * pixel-identical walls.
   */
  private drawRing(): DrawRing | null {
    if (!this.drawRoomOn) return null;
    if (this.drawRect) {
      return {
        pts: this.drawRect,
        hover: null,
        closing: false,
        closed: true,
        width: this.drawWidth(),
        typed: '',
        angleSnap: this.editor.angleSnap,
      };
    }
    if (!this.drawPts.length) return null;
    return {
      pts: this.drawPts,
      hover: this.drawHover,
      closing: this.onCloseTarget(this.drawHover),
      closed: false,
      width: this.drawWidth(),
      typed: this.drawLength,
      angleSnap: this.editor.angleSnap,
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
        drawRing: this.drawRing(),
        measure: this.calibrateOn ? this.calibrate : this.measure,
        advisoryChecks: this.checksOn,
        hover: this.hover,
      }
    );
  }

  /** Test/debug seam: draw + gesture counters and the live drag kind — a no-sleep assertion hook. */
  debug(): { drawCount: number; gestureCount: number; dragKind: string } {
    return { drawCount: this.drawCount, gestureCount: this.gestureCount, dragKind: this.drag.type };
  }
}
