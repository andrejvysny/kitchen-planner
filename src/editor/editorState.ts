/**
 * EditorState v1 — the SINGLE SOURCE OF TRUTH for tool state: which tool is
 * armed, which catalog def it carries, and whether the checks layer is drawn.
 * Framework-free by contract: no DOM types, no React, no three, no Store
 * import. It is a plain observable, so the views and the React shell all read
 * the same thing instead of gossiping through callbacks.
 *
 * NEVER serialized, never in an undo step, never autosaved — the same contract
 * as `store.openFronts` and `store.activeRoomId`. A tool choice is not part of
 * the design.
 *
 * Plan2D's tool fields are read-only MIRRORS of this, reconciled by its
 * `syncFromEditor()`; its `setX()` methods only ever write back here. The React
 * tool buttons call `setTool`/`setChecks` directly.
 */

/**
 * `drawRoom` is the ONE wall tool: drag a rectangle or click corner by corner.
 * The old separate `room` (drop-a-preset) tool folded into it — a drag IS the
 * preset drop, with the size under the cursor instead of fixed at 4×3.
 */
export type ToolId = 'select' | 'place' | 'measure' | 'calibrate' | 'drawRoom';

export class EditorState {
  /** the gesture mode the plan is in; 'select' is the resting state */
  tool: ToolId = 'select';
  /** catalog def armed for placement — only meaningful while tool === 'place' */
  armedDefId: string | null = null;
  /** clearance-warning overlay: a display layer, not a tool, so it is orthogonal */
  checksOn = false;
  /**
   * Width (m) the wall tool draws with — `DEFAULT_WALL_W` (src/model/rooms.ts)
   * repeated as a literal, because this module stays import-free by contract.
   * A tool PREFERENCE, exactly like
   * `armedDefId`: ephemeral, never serialized, never in an undo step. It seeds
   * the new room's `style.wallThickness`; per-wall overrides are design data
   * and live on the Room (`wallWidths`).
   */
  wallWidth = 0.115;
  /**
   * Angle snapping for the wall tool: ON by default, because a floor plan is
   * overwhelmingly right angles and a wall a degree off reads as a mistake.
   * Shift INVERTS it for the duration of the keypress, so the escape hatch is
   * always one modifier away in either direction. A tool preference like
   * `wallWidth` — ephemeral, never serialized, never undone.
   */
  angleSnap = true;
  /**
   * Snap grid step in METRES, or null for none — the LOWEST-priority fallback,
   * applied only when no snap and no guide fired. It used to be a hardcoded
   * 5 cm rounding repeated at four call sites in Plan2D, which meant it fought
   * the inference layer instead of catching what the inference layer missed.
   *
   * NOT the same thing as the visual grid renderPlan draws (0.1 m / 0.5 m by
   * zoom) — hence the name. A tool preference like `wallWidth`: ephemeral,
   * never serialized, never in an undo step.
   */
  snapGrid: number | null = 0.05;

  private subs = new Set<() => void>();
  private version = 0;

  /** Returns a disposer that unsubscribes `fn` — same contract as `Store.on`. */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** Monotonic counter, bumped once per real change — the useSyncExternalStore snapshot. */
  getVersion(): number {
    return this.version;
  }

  /**
   * Switch tool. `armedDefId` defaults to null (leaving 'place' disarms), so
   * arming is always explicit. Identical state is a no-op: no bump, no emit.
   */
  setTool(t: ToolId, armedDefId: string | null = null): void {
    if (this.tool === t && this.armedDefId === armedDefId) return;
    this.tool = t;
    this.armedDefId = armedDefId;
    this.bump();
  }

  /** Sugar for `tool === t` — reads better at the call sites that only ask. */
  isTool(t: ToolId): boolean {
    return this.tool === t;
  }

  setChecks(on: boolean): void {
    if (this.checksOn === on) return;
    this.checksOn = on;
    this.bump();
  }

  setAngleSnap(on: boolean): void {
    if (this.angleSnap === on) return;
    this.angleSnap = on;
    this.bump();
  }

  /** null turns the grid off; anything else is clamped to a sane drawing step. */
  setSnapGrid(m: number | null): void {
    const next = m === null ? null : Math.min(1, Math.max(0.001, m));
    if (this.snapGrid === next || (next !== null && !Number.isFinite(next))) return;
    this.snapGrid = next;
    this.bump();
  }

  /** Clamped to the same range as a per-wall override (src/model/store.ts). */
  setWallWidth(m: number): void {
    const next = Math.min(0.4, Math.max(0.05, m));
    if (this.wallWidth === next || !Number.isFinite(next)) return;
    this.wallWidth = next;
    this.bump();
  }

  private bump(): void {
    this.version++;
    // snapshot: a subscriber that unsubscribes mid-dispatch must not skip a sibling
    for (const fn of [...this.subs]) fn();
  }
}
