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
  closeChainAgainstWalls,
  edgeCentrelineHits,
  faceRingPlan,
  REGULARIZE_TOL,
  regularizeDrawnRing,
  snapRingToNeighbours,
  splitRoomByChain,
  snapRectSides,
  wallCentrelines,
  type RoomWall,
} from '../model/rooms';
import {
  CLOSE_REACH_SCALE,
  contextMaterial,
  DEFAULT_SNAP_CONFIG,
  resolveSnap,
  type SnapConfig,
  type SnapContext,
  type SnapKind,
  type SnapResult,
} from '../model/snap';
import { unitPrefs } from '../model/prefs';
import { parseAngle, parseLength } from '../model/units';
import { nearestWall, snapItem, type Guide } from '../model/snapping';
import type { Store } from '../model/store';
import type { Item, Opening, Point } from '../model/types';
import { resolveDevice } from '../model/navPref';
import { isMac, type WheelLike } from '../view3d/wheelInput';
import { findHost } from '../model/attach';
import { toCatalogDef } from '../model/parts';
import type { EditorState, ToolId } from '../editor/editorState';
import type { DrawField, DrawHudState, DrawOutcome } from '../ui/drawHud';
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

/**
 * What the measure tool may snap to: real geometry only. Inference lines
 * (align / perpendicular / parallel / extension) are deliberately absent —
 * they would put the point where nothing is.
 */
const MEASURE_KINDS: ReadonlySet<SnapKind> = new Set<SnapKind>([
  'endpoint',
  'midpoint',
  'intersection',
  'onSegment',
]);

/** Shift locks the pending segment to this angular step (15°). */
/** Screen reach of the close target, kept in step with the engine's own. */
const CLOSE_REACH_PX = hitRadius(12) * CLOSE_REACH_SCALE;
const ANGLE_STEP = Math.PI / 12;
/** Below this on either side a drag is a click, not a rectangle (m). */
const MIN_RECT_SIDE = 0.4;
/** Screen px a press must travel before it counts as a rectangle drag. */
const RECT_DRAG_SLOP = 4;

/**
 * Fold an angle into (-π, π]. `wrapAngle` in src/ui/react/fields/convert.ts
 * wraps to [0, τ) and lives behind the React import boundary, and a RELATIVE
 * turn wants a sign anyway: a left turn should read −90°, not 270°.
 */
function wrapPi(a: number): number {
  const t = Math.PI * 2;
  const w = a - Math.floor(a / t) * t;
  return w > Math.PI ? w - t : w;
}

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
  private onDrawHud: (s: DrawHudState | null) => void;

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
  /** Typed angle for the pending segment, RELATIVE to the previous one; '' = free. */
  private drawAngle = '';
  /** Which of the two boxes the digits go into. Tab swaps them. */
  private drawField: DrawField = 'length';
  /** The live drag-rectangle's centreline ring, or null outside that gesture. */
  private drawRect: Point[] | null = null;
  /** Last cursor position + modifier, so a typed digit can re-snap without a move. */
  private lastPointer: Point | null = null;
  private lastShift = false;
  /** Alt: suppress every snap for as long as it is held (see `snapConfig`). */
  private lastAlt = false;

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
  constructor(
    store: Store,
    editor: EditorState,
    onHint: (hint: string) => void,
    /**
     * The wall tool's live length/angle readout, pushed out the same way the
     * status hint is. OPTIONAL so a headless construction (unit tests) needs no
     * fourth argument, and a callback rather than a `src/ui` import so this
     * module stays framework-free by contract.
     */
    onDrawHud?: (s: DrawHudState | null) => void
  ) {
    this.store = store;
    this.editor = editor;
    this.onHint = onHint;
    this.onDrawHud = onDrawHud ?? ((): void => {});
    this.editorOff = editor.subscribe(() => this.syncFromEditor());
  }

  /**
   * Push the current pending-segment readout, or null to hide it. Called from
   * every place that moves the rubber band — a pointermove, a typed digit, a
   * committed vertex, a tool switch — so the readout can never outlive the
   * gesture that owns it.
   */
  private pushDrawHud(): void {
    const anchor = this.drawPts[this.drawPts.length - 1];
    if (!this.drawRoomOn || !anchor || !this.drawHover) {
      this.onDrawHud(null);
      return;
    }
    const dx = this.drawHover.x - anchor.x;
    const dy = this.drawHover.y - anchor.y;
    const prev = this.prevHeading();
    const world = Math.atan2(dy, dx);
    this.onDrawHud({
      at: this.toScreen(this.drawHover),
      length: Math.hypot(dx, dy),
      angle: prev === null ? world : wrapPi(world - prev),
      relative: prev !== null,
      typedLength: this.drawLength,
      typedAngle: this.drawAngle,
      field: this.drawField,
      outcome: this.outcome,
      angleLock: this.angleLocked(this.lastShift),
    });
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

    // a detached view snaps nothing, so dropping the caches on attach covers
    // every change that landed while the subscription below was not held
    this.snapMaterial = null;
    this.measureMaterial = null;

    this.subs.push(
      this.store.on('change', () => {
        // walls or items moved ⇒ every candidate the snap engine reads is stale
        this.snapMaterial = null;
        this.measureMaterial = null;
        this.requestDraw();
      }),
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
    // Alt suppresses snapping, and a user reaches for it WITHOUT moving the
    // mouse — so the modifier has to be watched on its own, not only sampled
    // off pointer events. On `window` because the canvas never holds focus;
    // under the same AbortController, so detach() takes them with it.
    const altWatch = (e: KeyboardEvent): void => {
      if (e.key !== 'Alt' || !this.drawRoomOn) return;
      const held = e.type === 'keydown';
      if (held === this.lastAlt) return; // key repeat fires keydown forever
      this.lastAlt = held;
      this.refreshDrawHover();
    };
    window.addEventListener('keydown', altWatch, { signal });
    window.addEventListener('keyup', altWatch, { signal });
    // a window blur while Alt is down (Alt+Tab) would otherwise leave it stuck
    window.addEventListener(
      'blur',
      () => {
        if (!this.lastAlt) return;
        this.lastAlt = false;
        this.refreshDrawHover();
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
    this.drawAngle = '';
    this.drawField = 'length';
    this.drawRect = null;
    this.lastSnap = null;
    this.snapMaterial = null;
    this.outcome = 'none';
    this.onDrawHud(null);
  }

  /**
   * A room is committed, but the tool STAYS ARMED — a plan is a sequence of
   * rooms, and disarming after each one made the second and third cost an
   * extra trip to the toolbar. `addRoom` has already made the new room active,
   * so its Width/Depth/Ceiling are in the inspector to type into either way.
   * Escape (twice: ring, then tool) is how you leave.
   */
  private finishGesture(): void {
    this.resetDrawRing();
    this.updateHint();
    this.requestDraw();
  }

  setDrawRoom(on: boolean): void {
    this.resetDrawRing();
    this.editor.setTool(on ? 'drawRoom' : 'select');
    this.updateHint();
    this.requestDraw();
  }

  /**
   * Escape steps the ring BACK ONE CORNER; only an empty ring disarms the tool.
   *
   * It used to discard the whole chain, which made Escape the most expensive
   * key in the tool — every mis-click cost the entire outline, because nothing
   * else could take a corner back either. Walking it back one at a time reaches
   * the same "gone" state in the same number of presses for a short ring, and
   * costs nothing for a long one.
   */
  cancelDrawRoom(): void {
    if (this.drawRect) {
      this.resetDrawRing();
      this.updateHint();
      this.requestDraw();
      return;
    }
    if (!this.drawPts.length) {
      this.setDrawRoom(false);
      return;
    }
    this.undoDrawVertex();
  }

  /** The width every wall of the room being drawn gets (m). */
  private drawWidth(): number {
    return this.editor.wallWidth;
  }

  /**
   * The design-derived half of the snap context — every wall centreline plus
   * its ends and midpoint. Rebuilt on tool entry and whenever the design
   * changes, NEVER per pointermove: `wallCentrelines` walks every room and
   * mitres every ring, which is far too much work to redo at pointer rate.
   * Null means "rebuild on next use".
   */
  private snapMaterial: {
    segments: SnapContext['segments'];
    points: SnapContext['points'];
    junctions: Point[];
  } | null = null;

  /** The snap behind the current `drawHover`, for the glyph and the guides. */
  private lastSnap: SnapResult | null = null;

  /** Cache twin of `snapMaterial` for the measure flavour (walls + items). */
  private measureMaterial: SnapContext | null = null;

  /**
   * The measure tool's context: RAW walls (its subject is the drawing as built,
   * not the centreline abstraction the wall tool draws in) plus every item
   * outline, and item centres as extra vertices — those carry no segment, but
   * measuring to the middle of a cabinet is a thing people do.
   */
  private measureCtx(): SnapContext {
    if (!this.measureMaterial) {
      const segments: SnapContext['segments'] = [];
      for (const g of this.store.allWalls()) segments.push({ a: g.a, b: g.b, wallId: g.id });
      for (const it of this.store.design.items) {
        const o = itemOutlineWorld(this.store, it);
        for (let i = 0; i < o.length; i++) segments.push({ a: o[i], b: o[(i + 1) % o.length] });
      }
      const mat = contextMaterial(segments);
      for (const it of this.store.design.items) {
        mat.points.push({ p: { x: it.x, y: it.y }, kind: 'endpoint' });
      }
      this.measureMaterial = { ...mat, chain: [], anchor: null };
    }
    return this.measureMaterial;
  }

  /**
   * Snap context for dragging corner `id`: the room-side FACE rings, minus the
   * two edges that meet at it.
   *
   * Face space, NOT the centreline space the wall tool draws in — and that
   * difference is load-bearing rather than an inconsistency. The wall tool
   * commits through `faceRingPlan`, which converts centreline→face AND promotes
   * the neighbouring wall out to meet it (`alignWallToCentreline`). A corner
   * drag has no such conversion: it calls `moveCorner` and then `weldRoom`, and
   * `allWalls` only sees a partition when two rings hold literally the SAME
   * edge. So the thing a dragged corner must land on is the neighbour's ring —
   * its face — and snapping it to a centreline instead would leave the two
   * rings half a wall thickness apart with no weld possible at all.
   *
   * The two incident edges are dropped because they move WITH the corner: they
   * are stale the instant the drag starts, and the corner is one of their
   * endpoints, so it would snap to where it already is and refuse to budge. The
   * REST of its own room stays in, which is the gain over the old code — that
   * skipped the whole room and hand-rolled an axis lock against the two
   * adjacent corners only, so a corner could never line up with any of the
   * others, nor with a midpoint, nor with anything at all diagonally.
   */
  private cornerCtx(id: string): SnapContext {
    const segments: SnapContext['segments'] = [];
    for (const room of this.store.design.rooms) {
      const c = room.corners;
      for (let k = 0; k < c.length; k++) {
        const a = c[k];
        const b = c[(k + 1) % c.length];
        if (a.id === id || b.id === id) continue; // incident to the dragged corner
        segments.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, roomId: room.id });
      }
    }
    return { ...contextMaterial(segments), chain: [], anchor: null };
  }

  private snapCtx(): {
    segments: SnapContext['segments'];
    points: SnapContext['points'];
    junctions: Point[];
  } {
    if (!this.snapMaterial) {
      const { segments, rings } = wallCentrelines(this.store.design.rooms, this.store.design.walls);
      // The mitred RINGS join the segments here, and ONLY here. A segment ends
      // where its wall ends, so at a right-angled corner the two nearest
      // endpoints sit half a thickness off along either axis and the point a
      // neighbouring room's corner belongs on — where the two centrelines meet
      // — is not offered at all. That is the whole of why a room drawn against
      // an existing one came out t/2 wrong. It is safe HERE and nowhere else:
      // `commitRing` converts through `faceRingPlan`, which promotes the
      // neighbour's wall out to meet the drawn edge. The corner drag has no
      // such conversion and still snaps to the face ring — see `cornerCtx`.
      this.snapMaterial = {
        ...contextMaterial(segments),
        junctions: rings.flatMap((r) => r.points.map((p) => ({ x: p.x, y: p.y }))),
      };
    }
    return this.snapMaterial;
  }

  /**
   * Where the pending vertex would land.
   *
   * A typed length still wins outright — it is an instruction, not a hint — and
   * everything else is `resolveSnap`, which folds what used to be four
   * hand-rolled tiers (centreline snap, angle lock, two-vertex ortho assist,
   * 5 cm grid) into one scored ladder. The order those tiers implied is
   * preserved by `TYPE_WEIGHT`: a centreline endpoint (100) still beats the
   * angle lock (40), so landing on a neighbour still wins and the weld still
   * gets its clean partition.
   *
   * What is new is that the tiers can now COMBINE — an alignment and a
   * perpendicular are two lines, and the engine intersects them — and that
   * every one of them reports which it was, which is what the cursor glyph and
   * the guides are drawn from.
   */
  private snapDrawPoint(w: Point, shift = false, alt = false): Point {
    const anchor = this.drawPts[this.drawPts.length - 1] ?? null;
    const locked = this.angleLocked(shift);

    // A typed value is an INSTRUCTION, not a hint, so it outranks every snap.
    // The two are independent: typing only a length leaves the direction to the
    // cursor (and to the angle lock), typing only an angle leaves the distance
    // to the cursor, and typing both fixes the vertex outright.
    const typedLen = this.typedLength();
    const typedAng = this.typedAngle();
    // …with ONE exception. A typed dimension used to bypass `resolveSnap`
    // outright, which also switched off the close target: with a digit in the
    // box the ring could not be finished at all, and the glyph went blank. The
    // cursor sitting on the first corner is an unambiguous "close it here", so
    // it outranks the buffer — which `addDrawPoint` then clears anyway.
    const first = this.drawPts[0];
    if (first && this.drawPts.length >= 3) {
      if (Math.hypot(w.x - first.x, w.y - first.y) * this.zoom < CLOSE_REACH_PX) {
        this.lastSnap = { p: { ...first }, kind: 'close', kinds: ['close'], guides: [] };
        return { ...first };
      }
    }
    if (anchor && (typedLen !== null || typedAng !== null)) {
      const dir =
        typedAng !== null
          ? (() => {
              const a = (this.prevHeading() ?? 0) + typedAng;
              return { x: Math.cos(a), y: Math.sin(a) };
            })()
          : this.pendingDir(anchor, w, locked);
      const len = typedLen ?? Math.max(1e-4, (w.x - anchor.x) * dir.x + (w.y - anchor.y) * dir.y);
      this.lastSnap = null;
      return { x: anchor.x + dir.x * len, y: anchor.y + dir.y * len };
    }

    const res = resolveSnap(
      w,
      { ...this.snapCtx(), chain: this.drawPts, anchor },
      this.snapConfig(locked, alt)
    );
    this.lastSnap = res;
    return res.p;
  }

  /**
   * The reaches are SCREEN px divided by the live zoom — the measure tool's
   * policy (`measureSnap`), now the whole plan's — so a snap feels the same
   * distance away however far in you are. `maxWorldReach` is the other half of
   * that: without it, zooming OUT would turn the same rule into a magnet
   * spanning metres.
   */
  private snapConfig(locked: boolean, suppressed = false): SnapConfig {
    return {
      ...DEFAULT_SNAP_CONFIG,
      zoom: this.zoom,
      pointReachPx: hitRadius(12),
      lineReachPx: hitRadius(8),
      angleStep: locked && !suppressed ? ANGLE_STEP : null,
      gridStep: this.editor.snapGrid,
      suppressed,
    };
  }

  /**
   * Round to the snap grid, or leave the value alone when the grid is off.
   * The ONE place that rounding lives for the gestures the engine does not
   * resolve for (the drag rectangle's unsnapped sides, the corner drag).
   */
  private gridRound(v: number): number {
    const g = this.editor.snapGrid;
    return g === null || g <= 0 ? v : Math.round(v / g) * g;
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

  /**
   * Is `p` on the ring's first vertex, i.e. on the close target?
   *
   * The reach matches what the engine offers the `close` candidate
   * (`pointReachPx * CLOSE_REACH_SCALE`) rather than being a tighter number of
   * its own: a snap that lands you ON the first corner but a test that says you
   * are not there is how the loop refused to close.
   */
  private onCloseTarget(p: Point | null): boolean {
    const first = this.drawPts[0];
    if (!p || !first || this.drawPts.length < 3) return false;
    return Math.hypot(p.x - first.x, p.y - first.y) * this.zoom < CLOSE_REACH_PX;
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
    /*
     * Landing back on the walls the chain STARTED from closes it too.
     *
     * A loop made of three new walls and one existing one is finished the
     * moment that last corner lands, exactly as a loop made of four new walls
     * is finished when it lands on its own first corner — so it must not need
     * a keystroke the other does not. Three points minimum, or the second click
     * of a chain drawn along a wall would close a sliver nobody asked for; and
     * `closeChainAgainstWalls` refuses a chain through the room's interior, so
     * a cut still reaches `trySplit` instead of being stolen here.
     */
    if (
      this.drawPts.length >= 3 &&
      closeChainAgainstWalls(this.store.design.rooms, this.drawPts, this.store.design.walls)
    ) {
      this.closeDrawRoom();
      return;
    }
    // the typed values applied to THAT segment only
    this.drawLength = '';
    this.drawAngle = '';
    this.drawField = 'length';
    this.recomputeOutcome();
    this.pushDrawHud(); // after the clears, or the readout republishes stale text
    this.updateHint();
    this.requestDraw();
  }

  /* ---- type-in segment length and angle ---- */

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

  /**
   * The typed angle in radians, RELATIVE to the previous segment — so '90' is a
   * square corner whatever the previous wall's heading, which is the whole
   * reason to type an angle rather than lean on the world-absolute 15° lock.
   * With no previous segment there is no datum, and it reads as a world bearing.
   */
  private typedAngle(): number | null {
    if (!this.drawAngle) return null;
    return parseAngle(this.drawAngle);
  }

  /** Heading of the segment that ends at the anchor, or null if there isn't one. */
  private prevHeading(): number | null {
    const n = this.drawPts.length;
    if (n < 2) return null;
    const a = this.drawPts[n - 2];
    const b = this.drawPts[n - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return null;
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /** Whether a keystroke should feed the dimension box rather than a shortcut. */
  drawInputActive(): boolean {
    return this.drawRoomOn && this.drawPts.length > 0;
  }

  /** Append one typed character (digit, separator or unit suffix). */
  drawDigit(ch: string): void {
    if (!this.drawInputActive()) return;
    if (this.drawField === 'angle') {
      if (this.drawAngle.length >= 12) return;
      this.drawAngle += ch;
    } else {
      if (this.drawLength.length >= 12) return;
      this.drawLength += ch;
    }
    this.refreshDrawHover();
  }

  /**
   * Whether the dimension box holds a character at all. Backspace is bound
   * TWICE — dimension edit first, ring step-back second — and this is what
   * picks between them, so an empty box never eats the key.
   */
  drawBufferActive(): boolean {
    if (!this.drawInputActive()) return false;
    return (this.drawField === 'angle' ? this.drawAngle : this.drawLength).length > 0;
  }

  /**
   * Step the ring back one corner.
   *
   * The tool had no way to take back a single click: Backspace was swallowed by
   * the dimension box whether or not anything was typed, and Escape dropped the
   * WHOLE chain. On a ten-corner outline that is the difference between a
   * one-key correction and re-drawing the room.
   */
  undoDrawVertex(): void {
    if (!this.drawPts.length) return;
    this.drawPts.pop();
    this.drawLength = '';
    this.drawAngle = '';
    this.drawField = 'length';
    this.recomputeOutcome();
    this.refreshDrawHover();
    this.pushDrawHud();
    this.updateHint();
    this.requestDraw();
  }

  drawBackspace(): void {
    if (!this.drawInputActive()) return;
    if (this.drawField === 'angle') {
      if (!this.drawAngle) return;
      this.drawAngle = this.drawAngle.slice(0, -1);
    } else {
      if (!this.drawLength) return;
      this.drawLength = this.drawLength.slice(0, -1);
    }
    this.refreshDrawHover();
  }

  /**
   * Tab moves between the length and angle boxes. There is no focused `<input>`
   * anywhere — the digits arrive through the `draw.*` commands — so this is the
   * only thing that decides where they land.
   */
  drawToggleField(): void {
    if (!this.drawInputActive()) return;
    this.drawField = this.drawField === 'length' ? 'angle' : 'length';
    this.refreshDrawHover();
  }

  /** The typed LENGTH buffer, for the overlay's dimension box. */
  drawTyped(): string {
    return this.drawLength;
  }

  /**
   * Re-run the snap from the last known cursor position, so a typed digit moves
   * the rubber-banded vertex without waiting for a pointermove.
   */
  private refreshDrawHover(): void {
    if (this.lastPointer) {
      this.drawHover = this.snapDrawPoint(this.lastPointer, this.lastShift, this.lastAlt);
    }
    this.pushDrawHud();
    this.updateHint();
    this.requestDraw();
  }

  /**
   * Finish the chain. What it BECOMES depends on what it is, read in this
   * order:
   *
   *  1. closed on its own first corner (3+ points) → a ROOM (`commitRing`);
   *  2. both ends landed on one existing room's walls → a ROOM closed along
   *     that existing geometry (`closeChainAgainstWalls`);
   *  3. crossing one room twice → a SPLIT (`commitFreeWall` → `trySplit`);
   *  4. anything else → free-standing WALLS.
   *
   * Reading 2 is the half of "redraw a plan wall by wall" that was missing:
   * you draw only the walls that are NEW and the room closes along the ones
   * already there. Without it, three sides drawn against a neighbour commit as
   * free walls and the fourth has to be re-drawn on top of a wall that exists,
   * which is precisely how a plan ends up with doubled walls.
   *
   * It sits ABOVE the split because a chain hugging a room's OUTSIDE also
   * technically touches it; `closeChainAgainstWalls` refuses a chain running
   * through the interior, which is what keeps the two apart.
   *
   * `finishOpen` is the deliberate escape hatch (double-click, Shift+Enter):
   * it skips straight to reading 3, so a divider drawn against a wall stays a
   * divider.
   */
  closeDrawRoom(finishOpen = false): void {
    if (!finishOpen && this.ringIsClosed()) {
      if (!this.commitRing(this.drawPts)) return;
      this.finishGesture();
      return;
    }
    if (!finishOpen && this.drawPts.length >= 2) {
      const ring = closeChainAgainstWalls(
        this.store.design.rooms,
        this.drawPts,
        this.store.design.walls
      );
      if (ring && this.commitRing(ring)) {
        this.finishGesture();
        return;
      }
    }
    this.commitFreeWall();
  }

  /**
   * What the chain would become if it were finished right now.
   *
   * CACHED, and recomputed only when a vertex is added or removed — not on a
   * pointermove. That is exact rather than an approximation: `closeDrawRoom`
   * reads `drawPts`, never the rubber-banded hover, so the answer genuinely
   * cannot change between clicks. It matters because the reading involves a
   * planar subdivision and a split test per room, which is far too much work
   * to redo at pointer rate.
   */
  drawOutcome(): DrawOutcome {
    return this.outcome;
  }

  private outcome: DrawOutcome = 'none';

  private recomputeOutcome(): void {
    this.outcome = this.readChain();
  }

  private readChain(): DrawOutcome {
    if (!this.drawRoomOn || !this.drawPts.length) return 'none';
    if (this.ringIsClosed()) return 'room';
    if (this.drawPts.length < 2) return 'none';
    if (closeChainAgainstWalls(this.store.design.rooms, this.drawPts, this.store.design.walls)) {
      return 'reuse';
    }
    for (const room of this.store.design.rooms) {
      if (splitRoomByChain(room, this.drawPts)) return 'split';
    }
    return 'walls';
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
    this.finishGesture();
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
    const rooms = this.store.design.rooms;
    // Heal what a hand-drawn ring carries in: the stub a ring closed by Enter
    // leaves near its first corner (whose mitre would skew a whole wall), and
    // an edge that came down a couple of centimetres off the neighbour it was
    // aimed at. Everything downstream demands 1 mm coincidence and reports
    // NOTHING when it does not get it, so this is where the miss is closed.
    const ring = ccw(regularizeDrawnRing(rooms, this.store.design.walls, [...centreline]));
    if (ring.length < 3) {
      this.onHint('That outline is not a usable room — it crosses itself or is too small');
      return null;
    }
    // ONE pass over the rooms as they are now: which edges become partitions,
    // and which existing walls have to move out to meet them. Promoting first
    // and asking afterwards would not work — see faceRingPlan's doc comment.
    const plan = faceRingPlan(rooms, ring, width / 2, this.store.design.walls);
    // A promotion can be REFUSED (already shared, or an end anchors another
    // partition). An edge whose walls all refused and none of which is already
    // a partition would otherwise keep its 0 offset and land half a thickness
    // off the neighbour's face ring — two parallel slabs, silently. Downgrade
    // it to exterior instead. This is not a re-derivation: the plan is still
    // the one snapshot, only the rejected entries are undone.
    const promoted = this.store.alignWallsToCentreline(plan.promote);
    for (let i = 0; i < plan.edgeWalls.length; i++) {
      const walls = plan.edgeWalls[i];
      if (!walls.length) continue;
      const usable = walls.some((id) => promoted.has(id) || this.store.wallById(id)?.shared);
      if (!usable) plan.offsets[i] = width / 2;
    }
    const inset = insetPolygon(ring, plan.offsets);
    // last stop before the ring becomes a Room: the inset shortens a shared
    // edge by `half` at each end, and a corner left a few centimetres from the
    // neighbour's is in the exact band the weld can neither fold nor cut
    const face = inset && snapRingToNeighbours(rooms, inset, width / 2);
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
      this.finishGesture();
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
      Math.max(a.y, a.y + h),
      undefined,
      this.store.design.walls,
      Math.min(hitRadius(12) / this.zoom, DEFAULT_SNAP_CONFIG.maxWorldReach)
    );
    const grid = (v: number): number => this.gridRound(v);
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

  /**
   * Snap a screen point to the nearest meaningful spot for measuring. Vertices
   * (corners, item centres & outline corners) win over edges (walls, item
   * outlines); with nothing near, the bare cursor is returned as a free point.
   */
  private measureSnap(sx: number, sy: number): { p: Point; snapped: boolean } {
    const w = this.toWorld(sx, sy);
    const res = resolveSnap(w, this.measureCtx(), {
      ...DEFAULT_SNAP_CONFIG,
      zoom: this.zoom,
      pointReachPx: hitRadius(11),
      lineReachPx: hitRadius(11),
      // Measuring READS the drawing; it must never round or infer. No grid (a
      // measurement is not a placement), no angle lock, and none of the
      // inference lines — an alignment guide would move the point somewhere no
      // geometry actually is, and the number under it would be fiction.
      gridStep: null,
      angleStep: null,
      enabled: MEASURE_KINDS,
    });
    this.lastSnap = res;
    return { p: res.p, snapped: res.kind !== 'free' };
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
      if (!this.drawPts.length) {
        this.onHint(
          'Drag a rectangle, or click corner by corner · walls snap to wall centres · Esc exits'
        );
        return;
      }
      // The cursor HUD carries what ⏎ would produce; the status bar spells out
      // the gesture behind it, so the two do not repeat each other.
      const ENTER: Record<DrawOutcome, string> = {
        room: 'Enter closes the room',
        reuse: 'Enter closes it against the existing walls',
        split: 'Enter splits the room in two',
        walls: 'Enter finishes these as walls',
        none: 'Enter finishes',
      };
      this.onHint(
        `Click the next corner, or land on a wall to close · ${ENTER[this.outcome]} · Esc undoes one · ${shiftDoes}`
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
    /** snap grid step (m), or null when the grid is off */
    snapGrid: number | null;
  } {
    return {
      armedDefId: this.armedDef?.id ?? null,
      measure: this.measureOn,
      calibrate: this.calibrateOn,
      draw: this.drawRoomOn,
      checks: this.editor.checksOn,
      wallWidth: this.editor.wallWidth,
      snapGrid: this.editor.snapGrid,
    };
  }

  /**
   * The snap the overlay should be drawing, or null.
   *
   * Gated on the tool having something in flight rather than just being armed:
   * `lastSnap` outlives the pointermove that produced it, and a glyph left
   * hanging over the plan after the ring was committed is the same class of
   * bug `clearHover()` exists to prevent.
   */
  private activeSnap(): SnapResult | null {
    if (this.drawRoomOn) return this.drawHover ? this.lastSnap : null;
    // the measure tool snaps through the same engine, so it earns the same
    // glyph — what the cursor has locked onto is exactly what a measurement
    // needs the user to be sure of
    if (this.measureOn) return this.measure.hover ? this.lastSnap : null;
    // dragging a corner resolves through the engine too, so it earns the glyph:
    // "this landed exactly on the neighbour's wall" is the whole question when
    // the gesture's purpose is to make two rooms weld
    if (this.drag.type === 'corner') return this.lastSnap;
    return null;
  }

  /** Snapshot of the in-flight overlay state — the measure span and the draw ring. */
  overlayState(): {
    measure: Measure;
    drawRing: DrawRing | null;
    snap: SnapResult | null;
    hover: HoverOverlay;
  } {
    return {
      measure: this.measure,
      drawRing: this.drawRing(),
      snap: this.activeSnap(),
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
        this.addDrawPoint(this.snapDrawPoint(w, e.shiftKey, e.altKey));
      } else {
        this.drag = {
          type: 'drawRect',
          a: this.snapDrawPoint(w, e.shiftKey, e.altKey),
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
        const d = this.drag as Extract<Drag, { type: 'corner' }>;
        // Face space — see `cornerCtx`. What this buys over the old two-corner
        // axis lock is the rest of the engine: midpoints, other rooms' corners,
        // every corner of its own room, screen-relative reach and Alt suppress.
        const res = resolveSnap(w, this.cornerCtx(d.id), {
          ...DEFAULT_SNAP_CONFIG,
          zoom: this.zoom,
          pointReachPx: hitRadius(12),
          lineReachPx: hitRadius(8),
          gridStep: this.editor.snapGrid,
          angleStep: null, // no pending segment here, so no direction to lock
          suppressed: this.lastAlt,
        });
        this.guides = res.guides;
        this.lastSnap = res;
        this.store.moveCorner(d.id, res.p.x, res.p.y);
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
      // remember the cursor so a typed digit can re-snap from it WITHOUT
      // waiting for the next move — `refreshDrawHover` reads these two, and
      // until this assignment existed it silently did nothing at all
      this.lastPointer = w;
      this.lastShift = e.shiftKey;
      this.lastAlt = e.altKey;
      this.drawHover = this.snapDrawPoint(w, e.shiftKey, e.altKey);
      this.pushDrawHud();
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
        if (this.commitRing(ring)) this.finishGesture();
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
      // the two presses already placed the last corner; a double-click means
      // "done as drawn", so it never closes the chain into a room
      this.closeDrawRoom(true);
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
  /**
   * Which segments of the ring in flight would MERGE into an existing wall.
   *
   * Same test the commit runs (`edgeCentrelineHits` at the regularize
   * tolerance), so what the preview promises and what `faceRingPlan` then does
   * cannot disagree. Cheap: a ring is a handful of edges and the centreline
   * material is already cached per design change.
   */
  private sharedDrawEdges(): boolean[] {
    const path = [...this.drawPts];
    if (this.drawHover) path.push(this.drawHover);
    const { segments } = wallCentrelines(this.store.design.rooms, this.store.design.walls);
    const out: boolean[] = [];
    for (let i = 0; i + 1 < path.length; i++) {
      out.push(edgeCentrelineHits(segments, path[i], path[i + 1], REGULARIZE_TOL).length > 0);
    }
    return out;
  }

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
      sharedEdges: this.sharedDrawEdges(),
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
        // the snap engine's guides are additive: `this.guides` still carries
        // the clearance spans snapItem produces, which are a different thing
        guides: [...this.guides, ...(this.activeSnap()?.guides ?? [])],
        armedDef: this.armedDef,
        ghost: this.ghost,
        ghostOpening: this.ghostOpening,
        drawRing: this.drawRing(),
        snap: this.activeSnap(),
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
