import type { Point } from '../../model/types';

/**
 * Normalized editor input — the shape tools will receive once Phase C starts
 * moving gestures out of Plan2D. TYPES ONLY: nothing implements or consumes
 * this yet, and the DOM→editor adapter (`InputRouter`) lands with the first
 * tool that needs it.
 *
 * The rule that makes this worth declaring up front: **no DOM types cross this
 * boundary.** A tool never sees a `PointerEvent`, so a tool is testable from a
 * plain object, and a future non-browser host (Tauri, a pen/touch surface with
 * its own event model) swaps only the adapter. Plan2D keeps its own
 * `PointerEvent` handling until each gesture actually moves.
 *
 * Both coordinate spaces travel together on purpose. Hit radii and snap
 * tolerances are SCREEN quantities (the measure tool already divides an 11 px
 * radius by zoom); geometry is world metres. A tool that only got one of them
 * would have to reach back into the view for the other.
 */

/** Which half of a drag this is. Cancel is a fourth phase the router may add. */
export type InputPhase = 'down' | 'move' | 'up';

/** Editor-level button identity, not the browser's numbering. */
export type EditorButton = 'primary' | 'middle' | 'secondary' | 'none';

export type PointerKind = 'mouse' | 'touch' | 'pen';

/**
 * Modifier state at the moment of the event. `mod` deliberately does NOT
 * collapse ctrl and meta here (the keyboard layer does that for shortcuts):
 * gesture semantics may want to tell a Mac right-click-emulating ctrl-drag
 * apart from a cmd-drag.
 */
export interface InputModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

export interface PointerInput extends InputModifiers {
  phase: InputPhase;
  pointerId: number;
  pointerType: PointerKind;
  /** CSS pixels within the canvas — the space tolerances are expressed in */
  screen: Point;
  /** plan metres — x right, y down, the model's own space */
  world: Point;
  button: EditorButton;
}

export interface KeyInput extends InputModifiers {
  /** `KeyboardEvent.key`, lowercased — same normalization the key map uses */
  key: string;
  repeat: boolean;
}

/** CSS cursor keyword a tool asks the host to show. */
export type Cursor = string;
