/**
 * DrawHud — the wall tool's live dimension readout: the pending segment's
 * length and angle, and which of the two the keyboard is currently typing into.
 *
 * Shaped like src/ui/shellState.ts (module singleton + one listener set) but
 * deliberately SEPARATE from it. ShellState changes at human speed and its
 * consumers are two `<span>`s; this changes at pointer rate, and folding it in
 * would wake the status hint, the catalog drawer and the wall label sixty times
 * a second for a value none of them read.
 *
 * Never Design data, never undone, never serialized — the same contract as
 * `EditorState` and `store.openFronts`.
 *
 * Plan2D pushes into this through a constructor callback (`onDrawHud`), exactly
 * as it already does for the status hint, so src/plan2d never imports src/ui.
 */

import type { Point } from '../model/types';

/** Which box the digits are going into. */
export type DrawField = 'length' | 'angle';

export interface DrawHudState {
  /** where to float the readout, in CSS px relative to the plan canvas */
  at: Point;
  /** metres — the live length of the pending segment */
  length: number;
  /**
   * Radians, measured off the PREVIOUS segment rather than off the world, so
   * "90" means a square corner whatever the previous wall's heading. With no
   * previous segment there is no datum and this is the world bearing.
   */
  angle: number;
  /** true once a previous segment exists, i.e. `angle` really is relative */
  relative: boolean;
  /** raw keyboard buffers; '' = that field is following the cursor */
  typedLength: string;
  typedAngle: string;
  field: DrawField;
}

let state: DrawHudState | null = null;
const listeners = new Set<() => void>();

export function drawHud(): DrawHudState | null {
  return state;
}

/**
 * Null hides the readout. Identical content is NOT diffed: the caller only
 * emits on a real pointer move or keystroke, and deep-comparing a 7-field
 * object at pointer rate would cost more than the render it saves.
 */
export function setDrawHud(next: DrawHudState | null): void {
  if (state === null && next === null) return;
  state = next;
  for (const fn of [...listeners]) fn();
}

/** Returns a disposer that unsubscribes `fn`; calling it twice is a no-op. */
export function onDrawHudChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
