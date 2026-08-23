import type { CommandId } from '../commands/types';

/**
 * The global key map, as DATA. Pure and DOM-free — `matchBinding` takes a
 * lowercased key name plus two booleans, so the whole table is unit-testable
 * without a browser (test/unit/editor/keyboard.test.ts).
 *
 * The table reproduces the old `keydown` listener's cascade EXACTLY, including
 * three details that are easy to lose in a port (the fourth, an `allowInModal`
 * opt-out of a Part-Studio suppression, went with the studio's drafts in
 * WS-SPEC WP 3.1 — see KeyboardController):
 *
 * 1. **Escape runs even while typing.** In the listener its branch sat above
 *    the `typing || studio.isOpen()` early return — cancelling the live tool
 *    from inside an inspector field is deliberate. `allowWhileTyping` is how
 *    that survives.
 * 2. **Escape never calls preventDefault.** It did not before, and Escape has
 *    browser meaning inside a text field. Hence `preventDefault: false`.
 * 3. **Everything else swallows the key only when the command actually ran.**
 *    `Ctrl+D` with no item selected used to fall through to the browser,
 *    because the selection check was part of the `if` that guarded
 *    `preventDefault`. That is now the command's `canExecute`, and
 *    KeyboardController calls `preventDefault` on a true return from
 *    `registry.execute` — same outcome, one rule instead of eight.
 *
 * `mod` means ctrl OR meta. A binding leaves `mod`/`shift` undefined to mean
 * "don't care", which is how the listener behaved: it never checked modifiers
 * for `r`, the arrows, Delete or Escape.
 */
export interface KeyBinding {
  /** `KeyboardEvent.key`, lowercased — 'z', 'escape', 'arrowleft', … */
  key: string;
  /** ctrl-or-meta: true = required, false = forbidden, undefined = don't care */
  mod?: boolean;
  /** shift: true = required, false = forbidden, undefined = don't care */
  shift?: boolean;
  commandId: CommandId;
  /** survives focus in an input/textarea/contentEditable */
  allowWhileTyping?: boolean;
  /** default true — suppressed only when the command ran; see the note above */
  preventDefault?: boolean;
}

export interface KeyMods {
  /** ctrl OR meta — one flag, because the app treats them the same */
  mod: boolean;
  shift: boolean;
}

/**
 * First match that CAN RUN wins, so ORDER IS LOAD-BEARING (Shift+Ctrl+Z before
 * Ctrl+Z). A key may appear more than once: the earlier row is tried first, and
 * a command whose `canExecute` says no hands the key to the next candidate —
 * see `matchBindings`.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    key: 'escape',
    commandId: 'tool.cancel',
    allowWhileTyping: true,
    preventDefault: false,
  },
  // guarded to the drawRoom tool by tool.finish's canExecute; a plain Enter
  // anywhere else therefore stays the browser's. Shift+Enter is the escape
  // hatch: finish the chain as OPEN walls, never closing it into a room — so
  // it has to sit ABOVE the plain row, which does not care about shift.
  { key: 'enter', shift: true, commandId: 'tool.finishOpen' },
  { key: 'enter', commandId: 'tool.finish' },

  { key: 'z', mod: true, shift: true, commandId: 'history.redo' },
  { key: 'z', mod: true, shift: false, commandId: 'history.undo' },
  { key: 'y', mod: true, commandId: 'history.redo' },
  { key: 'd', mod: true, commandId: 'selection.duplicate' },
  { key: 'a', mod: true, commandId: 'selection.all' },

  // The wall tool's dimension box comes FIRST, and `draw.*`'s canExecute is
  // what makes that safe: while a ring is in flight Backspace edits the typed
  // length and a digit appends to it; at rest both fall through to the
  // bindings below (delete the selection, switch workspace). First match wins,
  // so these rows must stay above their at-rest twins.
  { key: 'backspace', commandId: 'draw.backspace' },
  // …and with the box EMPTY the same key steps the ring back one corner, which
  // is the only non-destructive way out of a long chain. `draw.backspace`'s
  // canExecute now requires a typed character, so exactly one of these two can
  // ever run and no third row is shadowed.
  { key: 'backspace', commandId: 'draw.undoVertex' },
  // Tab is otherwise unbound, so this needs no ordering care; preventDefault
  // stays on (its default) or focus would leave the canvas mid-gesture
  { key: 'tab', commandId: 'draw.toggleField' },
  { key: '0', mod: false, commandId: 'draw.digit0' },
  { key: '1', mod: false, commandId: 'draw.digit1' },
  { key: '2', mod: false, commandId: 'draw.digit2' },
  { key: '3', mod: false, commandId: 'draw.digit3' },
  { key: '4', mod: false, commandId: 'draw.digit4' },
  { key: '5', mod: false, commandId: 'draw.digit5' },
  { key: '6', mod: false, commandId: 'draw.digit6' },
  { key: '7', mod: false, commandId: 'draw.digit7' },
  { key: '8', mod: false, commandId: 'draw.digit8' },
  { key: '9', mod: false, commandId: 'draw.digit9' },
  { key: '.', mod: false, commandId: 'draw.digitDot' },

  { key: 'delete', commandId: 'selection.delete' },
  { key: 'backspace', commandId: 'selection.delete' },

  // `mod: false` is REQUIRED: Ctrl/Cmd+R is the browser's reload. The old
  // listener never checked modifiers here and swallowed it (TODO.md M11 note);
  // rotating an item is never worth eating a reload.
  { key: 'r', mod: false, shift: true, commandId: 'transform.rotate15' },
  { key: 'r', mod: false, shift: false, commandId: 'transform.rotate90' },

  { key: 'arrowleft', shift: false, commandId: 'transform.nudgeLeft' },
  { key: 'arrowright', shift: false, commandId: 'transform.nudgeRight' },
  { key: 'arrowup', shift: false, commandId: 'transform.nudgeUp' },
  { key: 'arrowdown', shift: false, commandId: 'transform.nudgeDown' },
  { key: 'arrowleft', shift: true, commandId: 'transform.nudgeLeftCoarse' },
  { key: 'arrowright', shift: true, commandId: 'transform.nudgeRightCoarse' },
  { key: 'arrowup', shift: true, commandId: 'transform.nudgeUpCoarse' },
  { key: 'arrowdown', shift: true, commandId: 'transform.nudgeDownCoarse' },

  // Workspace tabs. `mod: false` is REQUIRED, not don't-care: Ctrl/Cmd+digit is
  // the browser's own tab switch and must never be swallowed.
  { key: '1', mod: false, commandId: 'workspace.plan' },
  { key: '2', mod: false, commandId: 'workspace.furnish' },
  { key: '3', mod: false, commandId: 'workspace.workshop' },
  { key: '4', mod: false, commandId: 'workspace.output' },

  // The shortcut sheet. `?` is Shift+/ on most layouts, so `shift` stays
  // don't-care — `e.key` is the produced CHARACTER, and it is already '?'.
  // `mod: false` because Cmd+? opens the Help menu on macOS, and a help sheet
  // has no business swallowing that. Still blocked while typing — a '?' typed
  // into a part name is a '?'.
  { key: '?', mod: false, commandId: 'help.shortcuts' },
];

/**
 * EVERY binding whose key and modifier constraints hold, in table order.
 *
 * One key may legitimately carry several meanings that are told apart by
 * CONTEXT rather than by modifiers — Backspace types into the wall tool's
 * dimension box while a ring is in flight and deletes the selection at rest;
 * a digit is a length there and a workspace switch here. Which one applies is
 * the command's `canExecute`, not the table's, so the table hands the caller
 * the whole candidate list and `KeyboardController` takes the first that can
 * actually run. Order is still load-bearing — it is the priority.
 */
export function matchBindings(
  key: string,
  mods: KeyMods,
  bindings: readonly KeyBinding[] = KEY_BINDINGS
): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of bindings) {
    if (b.key !== key) continue;
    if (b.mod !== undefined && b.mod !== mods.mod) continue;
    if (b.shift !== undefined && b.shift !== mods.shift) continue;
    out.push(b);
  }
  return out;
}

/** The highest-priority candidate, ignoring whether its command can run. */
export function matchBinding(
  key: string,
  mods: KeyMods,
  bindings: readonly KeyBinding[] = KEY_BINDINGS
): KeyBinding | null {
  return matchBindings(key, mods, bindings)[0] ?? null;
}
