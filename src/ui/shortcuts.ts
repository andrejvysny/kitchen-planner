/**
 * The shortcut sheet's content (WS-SPEC §5.5, WP 2.5) — every keyboard and
 * mouse gesture the editor answers to, as DATA.
 *
 * This is the ONE place the gestures are written down for the user. It is
 * deliberately a plain array rather than something derived from
 * `KEY_BINDINGS`: half of what a user needs to know is not a key at all
 * (drag, scroll, double-click, right-click), and the binding table carries
 * command ids, not the plain-English promise a help sheet has to make. The two
 * are kept honest by hand — a new binding that a user is expected to find
 * belongs here too.
 *
 * `keys` is display text, not a parseable chord. `Ctrl` covers Cmd on macOS
 * (see `matchBinding`'s `mod`), and the sheet says so once in its footer
 * rather than in every row.
 *
 * Framework-free, so a future command palette or printable sheet can read the
 * same list.
 */

export type ShortcutGroup = 'Navigate' | 'Edit' | 'Tools' | 'Mouse';

export interface ShortcutEntry {
  /** display text for the key or gesture, e.g. 'Ctrl+D' or 'Double-click' */
  keys: string;
  /** what it does, sentence case, no trailing period */
  does: string;
  group: ShortcutGroup;
}

/** Render order of the four groups. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Navigate', 'Edit', 'Tools', 'Mouse'];

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { group: 'Navigate', keys: '1 … 4', does: 'Plan, Furnish, Workshop or Output workspace' },
  { group: 'Navigate', keys: '?', does: 'Show this sheet' },
  { group: 'Navigate', keys: 'Esc', does: 'Close this sheet' },

  { group: 'Edit', keys: 'Ctrl+Z', does: 'Undo' },
  { group: 'Edit', keys: 'Ctrl+Shift+Z  ·  Ctrl+Y', does: 'Redo' },
  { group: 'Edit', keys: 'Ctrl+D', does: 'Duplicate the selected item' },
  { group: 'Edit', keys: 'R  ·  Shift+R', does: 'Rotate the selection by 90° or 15°' },
  { group: 'Edit', keys: 'Arrows', does: 'Nudge the selection by 1 cm' },
  { group: 'Edit', keys: 'Shift+arrows', does: 'Nudge the selection by 10 cm' },
  { group: 'Edit', keys: 'Delete  ·  Backspace', does: 'Remove the selection' },

  { group: 'Tools', keys: 'Esc', does: 'Cancel the live tool, then clear the selection' },
  { group: 'Tools', keys: 'Enter', does: 'Finish the walls you are drawing (a closed loop makes a room)' },
  { group: 'Tools', keys: 'Shift while drawing', does: 'Invert the 15° angle snap for one wall' },
  { group: 'Tools', keys: 'Digits while drawing', does: 'Type the exact wall length' },
  { group: 'Tools', keys: 'Shift while placing', does: 'Keep the tool armed and place several' },

  { group: 'Mouse', keys: 'Drag with the wall tool', does: 'Draw a rectangular room' },

  { group: 'Mouse', keys: 'Drag empty space', does: 'Pan the plan' },
  { group: 'Mouse', keys: 'Scroll', does: 'Zoom the plan' },
  { group: 'Mouse', keys: 'Right-click', does: 'Menu for whatever is under the pointer' },
  { group: 'Mouse', keys: 'Double-click a wall', does: 'Add a corner there' },
  { group: 'Mouse', keys: 'Double-click a front in 3D', does: 'Open or close that door or drawer' },
  { group: 'Mouse', keys: 'Drag in 3D', does: 'Orbit the camera · scroll zooms' },
];
