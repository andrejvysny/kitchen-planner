import type { CommandId } from '../commands/types';

/**
 * The global key map, as DATA. Pure and DOM-free — `matchBinding` takes a
 * lowercased key name plus two booleans, so the whole table is unit-testable
 * without a browser (test/unit/editor/keyboard.test.ts).
 *
 * The table reproduces the old `keydown` listener's cascade EXACTLY, including
 * three details that are easy to lose in a port:
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
  /** survives focus in an input/textarea/contentEditable and an open modal */
  allowWhileTyping?: boolean;
  /**
   * Runs even while the modal (Part Studio) is open — the switch helper owns
   * the dirty guard. Still blocked while typing.
   */
  allowInModal?: boolean;
  /** default true — suppressed only when the command ran; see the note above */
  preventDefault?: boolean;
}

export interface KeyMods {
  /** ctrl OR meta — one flag, because the app treats them the same */
  mod: boolean;
  shift: boolean;
}

/** First match wins, so ORDER IS LOAD-BEARING (Shift+Ctrl+Z before Ctrl+Z). */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  {
    key: 'escape',
    commandId: 'tool.cancel',
    allowWhileTyping: true,
    preventDefault: false,
  },
  // guarded to the drawRoom tool by tool.finish's canExecute; a plain Enter
  // anywhere else therefore stays the browser's
  { key: 'enter', commandId: 'tool.finish' },

  { key: 'z', mod: true, shift: true, commandId: 'history.redo' },
  { key: 'z', mod: true, shift: false, commandId: 'history.undo' },
  { key: 'y', mod: true, commandId: 'history.redo' },
  { key: 'd', mod: true, commandId: 'selection.duplicate' },

  { key: 'delete', commandId: 'selection.delete' },
  { key: 'backspace', commandId: 'selection.delete' },

  { key: 'r', shift: true, commandId: 'transform.rotate15' },
  { key: 'r', shift: false, commandId: 'transform.rotate90' },

  { key: 'arrowleft', shift: false, commandId: 'transform.nudgeLeft' },
  { key: 'arrowright', shift: false, commandId: 'transform.nudgeRight' },
  { key: 'arrowup', shift: false, commandId: 'transform.nudgeUp' },
  { key: 'arrowdown', shift: false, commandId: 'transform.nudgeDown' },
  { key: 'arrowleft', shift: true, commandId: 'transform.nudgeLeftCoarse' },
  { key: 'arrowright', shift: true, commandId: 'transform.nudgeRightCoarse' },
  { key: 'arrowup', shift: true, commandId: 'transform.nudgeUpCoarse' },
  { key: 'arrowdown', shift: true, commandId: 'transform.nudgeDownCoarse' },

  // Workspace tabs. `mod: false` is REQUIRED, not don't-care: Ctrl/Cmd+digit is
  // the browser's own tab switch and must never be swallowed. `allowInModal`
  // because leaving the Workshop while the Part Studio is open is a legitimate
  // move — the switch helper asks about unsaved edits before it happens.
  { key: '1', mod: false, commandId: 'workspace.plan', allowInModal: true },
  { key: '2', mod: false, commandId: 'workspace.furnish', allowInModal: true },
  { key: '3', mod: false, commandId: 'workspace.workshop', allowInModal: true },
  { key: '4', mod: false, commandId: 'workspace.output', allowInModal: true },
];

/** First binding whose key and modifier constraints all hold, or null. */
export function matchBinding(
  key: string,
  mods: KeyMods,
  bindings: readonly KeyBinding[] = KEY_BINDINGS
): KeyBinding | null {
  for (const b of bindings) {
    if (b.key !== key) continue;
    if (b.mod !== undefined && b.mod !== mods.mod) continue;
    if (b.shift !== undefined && b.shift !== mods.shift) continue;
    return b;
  }
  return null;
}
