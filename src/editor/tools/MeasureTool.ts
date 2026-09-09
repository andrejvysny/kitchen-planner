import { resolveSnap } from '../../model/snap';
import { DEFAULT_SNAP_CONFIG } from '../../model/snap/types';
import type { SnapContext, SnapKind, SnapResult } from '../../model/snap/types';
import type { Point } from '../../model/types';
import type { Cursor, PointerInput } from '../input/types';
import type { Tool, ToolContext, ToolResult } from './Tool';
import { emptyMeasure, type Measure } from './measureState';

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

/** Screen px a press must travel before it counts as a drag rather than a click. */
const DRAG_SLOP = 4;

/**
 * Host-specific dependencies, passed at CONSTRUCTION rather than added to
 * `ToolContext`.
 *
 * `ToolContext` is the shape every tool shares; widening it for one tool's
 * needs would make each new tool grow it again until it is the app. Both of
 * these are genuinely the host's:
 *
 * - `hitRadius` reads `matchMedia('(pointer: coarse)')`, so it cannot leave the
 *   browser layer;
 * - `snapContext` is Plan2D's cached measure material, which is built from
 *   `itemOutlineWorld` — a plan-geometry helper that lives in renderPlan.ts.
 *   Moving that into `src/model` is a worthwhile refactor and deliberately not
 *   part of this one.
 */
export interface MeasureDeps {
  /** raw walls + item outlines + item centres, rebuilt only when the design changes */
  snapContext(): SnapContext;
  /** screen px, scaled up for a coarse pointer */
  hitRadius(px: number): number;
}

/**
 * Two clicks (or one drag) reporting a distance. Reads the drawing and never
 * mutates it, so it takes no undo step at all — the one tool for which
 * "mutate, then commit" does not apply.
 */
export class MeasureTool implements Tool {
  readonly id = 'measure';

  /** The live span, read by the host's overlay. Replaced, never aliased out. */
  state: Measure = emptyMeasure();

  /** The winning snap behind `state.hover`, for the cursor glyph. */
  snap: SnapResult | null = null;

  /** Screen point of the press, while the button is down; null between gestures. */
  private press: { screen: Point; moved: boolean } | null = null;

  constructor(private readonly deps: MeasureDeps) {}

  activate(ctx: ToolContext): void {
    this.reset();
    ctx.setHint(this.hintText());
  }

  deactivate(ctx: ToolContext): void {
    this.reset();
    ctx.requestDraw();
  }

  /**
   * Two-stage, the convention the wall tool's ring already follows: a
   * measurement IN PROGRESS goes first and the tool keeps the floor, so one
   * mis-clicked first point does not cost the tool.
   *
   * A COMPLETED span deliberately does not count. It is a result, not a
   * gesture — Escape over one has always left the tool, and swallowing the key
   * to clear a number the user is still reading would be the wrong trade.
   */
  cancel(ctx: ToolContext): ToolResult {
    if (!this.state.measuring) return 'passthrough';
    this.reset();
    ctx.setHint(this.hintText());
    ctx.requestDraw();
    return 'handled';
  }

  pointerDown(input: PointerInput, ctx: ToolContext): ToolResult {
    if (input.button !== 'primary') return 'passthrough';
    const p = this.resolve(input, ctx);
    if (this.state.measuring) {
      // second click closes the span; a drag from here would start a new one
      this.state = { ...this.state, b: p.p, measuring: false };
      this.press = null;
    } else {
      this.state = { a: p.p, b: null, hover: p.p, snapped: p.snapped, measuring: true };
      this.press = { screen: input.screen, moved: false };
    }
    ctx.setHint(this.hintText());
    ctx.requestDraw();
    return 'handled';
  }

  pointerMove(input: PointerInput, ctx: ToolContext): ToolResult {
    const p = this.resolve(input, ctx);
    if (this.press && !this.press.moved) {
      const d = Math.hypot(
        input.screen.x - this.press.screen.x,
        input.screen.y - this.press.screen.y
      );
      if (d > DRAG_SLOP) this.press.moved = true;
    }
    this.state = { ...this.state, hover: p.p, snapped: p.snapped };
    ctx.requestDraw();
    return 'handled';
  }

  pointerUp(input: PointerInput, ctx: ToolContext): ToolResult {
    const press = this.press;
    this.press = null;
    // Not our gesture: the second CLICK of a two-click span comes up with
    // nothing pressed, and the host's own pointerup teardown still has to run
    // (it bumps the gesture counter the tests wait on, and clears guides).
    if (!press) return 'passthrough';
    // a real drag completes the measurement; a bare click waits for a 2nd click
    if (press.moved) {
      const p = this.resolve(input, ctx);
      this.state = { ...this.state, b: p.p, measuring: false };
    }
    ctx.setHint(this.hintText());
    ctx.requestDraw();
    return 'handled';
  }

  cursor(): Cursor {
    return 'crosshair';
  }

  /**
   * Drop everything in flight WITHOUT leaving the tool. The host's entry reset:
   * re-arming the tool that is already live is a no-op both upstream (in
   * `EditorState.setTool`) and in `ToolManager`, so nothing else would clear it.
   */
  clear(): void {
    this.reset();
  }

  private reset(): void {
    this.state = emptyMeasure();
    this.snap = null;
    this.press = null;
  }

  /**
   * PUBLIC because the host's hint dispatcher is called from ~19 places that
   * know nothing about tools; letting it ask for the string keeps one copy of
   * the wording here rather than a stale duplicate over there.
   */
  hintText(): string {
    return this.state.measuring
      ? 'Click the second point · snaps to corners, edges & walls · Esc exits'
      : 'Click two points to measure · snaps to corners, edges & walls · Esc exits';
  }

  /**
   * Snap to the nearest meaningful spot. Measuring READS the drawing; it must
   * never round or infer — no grid (a measurement is not a placement), no angle
   * lock, and none of the inference lines: an alignment guide would move the
   * point somewhere no geometry actually is, and the number under it would be
   * fiction.
   */
  private resolve(input: PointerInput, ctx: ToolContext): { p: Point; snapped: boolean } {
    const reach = this.deps.hitRadius(11);
    const res = resolveSnap(input.world, this.deps.snapContext(), {
      ...DEFAULT_SNAP_CONFIG,
      zoom: ctx.zoom,
      pointReachPx: reach,
      lineReachPx: reach,
      gridStep: null,
      angleStep: null,
      enabled: MEASURE_KINDS,
    });
    this.snap = res;
    return { p: res.p, snapped: res.kind !== 'free' };
  }
}
