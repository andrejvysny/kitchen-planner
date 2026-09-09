/**
 * PlaceHud — the wardrobe placement tool's live width readout: the free
 * segment span under the cursor, and whatever width the keyboard is typing
 * into it.
 *
 * Sibling of src/ui/drawHud.ts, deliberately NOT a mode grafted onto
 * `DrawHudState`: five of that shape's eight fields (length/angle/relative/
 * typedAngle/field/outcome/angleLock — everything but the shared `at`) are
 * wall-tool-only, and the two tools are mutually exclusive by construction
 * (`drawRoomOn` XOR an armed def), so there is no state a shared shape would
 * ever let collide — only a bridge channel worth sharing.
 *
 * Same contract as DrawHudState: never Design data, never undone, never
 * serialized — the same rule as `EditorState` and `store.openFronts`.
 *
 * Plan2D pushes into this through a constructor callback (`onPlaceHud`),
 * exactly as it already does for `onDrawHud`, so src/plan2d never imports
 * src/ui.
 */

import type { Point } from '../model/types';

export interface PlaceHudState {
  /** where to float the readout, in CSS px relative to the plan canvas */
  at: Point;
  /** metres — the free segment's own length, regardless of what is typed */
  span: number;
  /** raw keyboard buffer; '' = the width follows the segment (fills it) */
  typedWidth: string;
  /** the segment itself is too short for this def — a click here would refuse */
  tooNarrow: boolean;
  /** the armed def's own label, so the HUD says what is being placed */
  label: string;
}

let state: PlaceHudState | null = null;
const listeners = new Set<() => void>();

export function placeHud(): PlaceHudState | null {
  return state;
}

/**
 * Null hides the readout. Identical content is NOT diffed: the caller only
 * emits on a real pointer move or keystroke, and deep-comparing a 5-field
 * object at pointer rate would cost more than the render it saves.
 */
export function setPlaceHud(next: PlaceHudState | null): void {
  if (state === null && next === null) return;
  state = next;
  for (const fn of [...listeners]) fn();
}

/** Returns a disposer that unsubscribes `fn`; calling it twice is a no-op. */
export function onPlaceHudChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
