/**
 * EditorState v0 — the editor's own ephemeral state: which tool is armed, and
 * whether the checks layer is drawn. Framework-free by contract: no DOM types,
 * no React, no three, no Store import. It is a plain observable so both the
 * legacy views and the React shell can read the same thing.
 *
 * NEVER serialized, never in an undo step, never autosaved — the same contract
 * as `store.openFronts` and `store.activeRoomId`. A tool choice is not part of
 * the design.
 *
 * Nothing consumes it yet: Plan2D keeps its own tool flags until the migration
 * ports the gestures (phase B5). It exists now so StoreBridge and the React
 * shell have their observable from day one, with tests pinning the contract.
 */

export type ToolId = 'select' | 'place' | 'measure' | 'calibrate' | 'room' | 'drawRoom';

export class EditorState {
  /** the gesture mode the plan is in; 'select' is the resting state */
  tool: ToolId = 'select';
  /** catalog def armed for placement — only meaningful while tool === 'place' */
  armedDefId: string | null = null;
  /** clearance-warning overlay: a display layer, not a tool, so it is orthogonal */
  checksOn = false;

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

  setChecks(on: boolean): void {
    if (this.checksOn === on) return;
    this.checksOn = on;
    this.bump();
  }

  private bump(): void {
    this.version++;
    // snapshot: a subscriber that unsubscribes mid-dispatch must not skip a sibling
    for (const fn of [...this.subs]) fn();
  }
}
