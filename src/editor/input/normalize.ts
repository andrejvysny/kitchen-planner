import type { Point } from '../../model/types';
import type { EditorButton, KeyInput, PointerInput, PointerKind, InputPhase } from './types';

/**
 * The DOM→editor adapter, as FUNCTIONS rather than a listener-owning
 * `InputRouter` class.
 *
 * The host that would own those listeners already exists: Plan2D attaches them
 * behind an `AbortController` in `attach()/detach()` (the lifecycle contract
 * e2e/lifecycle.spec.ts gates) and owns the canvas transform that turns an
 * offset into world metres. A second listener owner would duplicate both and
 * add a teardown path that could leak. What the tools actually need is the
 * NORMALIZATION — no `PointerEvent` crossing into `src/editor` — and that is
 * pure, so it is testable without a DOM and reusable by any future host.
 */

/** `PointerEvent.button` → editor button identity. -1 is "no button changed". */
function toButton(button: number): EditorButton {
  switch (button) {
    case 0:
      return 'primary';
    case 1:
      return 'middle';
    case 2:
      return 'secondary';
    default:
      return 'none';
  }
}

function toPointerKind(t: string): PointerKind {
  return t === 'touch' || t === 'pen' ? t : 'mouse';
}

/**
 * `screen` and `world` are passed IN rather than derived: the transform lives
 * on the view, and a tool needs both spaces (tolerances are screen px, geometry
 * is metres) without reaching back for either.
 */
export function toPointerInput(
  e: PointerEvent,
  phase: InputPhase,
  screen: Point,
  world: Point
): PointerInput {
  return {
    phase,
    pointerId: e.pointerId,
    pointerType: toPointerKind(e.pointerType),
    screen,
    world,
    button: toButton(e.button),
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
  };
}

export function toKeyInput(e: KeyboardEvent): KeyInput {
  return {
    key: e.key.toLowerCase(),
    repeat: e.repeat,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
  };
}
