import type { CommandDefinition, EditorContext } from './types';

/**
 * The seed command set — the eight behaviours the global keyboard map used to
 * hold as `if` branches, lifted here verbatim. Behaviour is byte-identical on
 * purpose: this is a naming change, not a redesign, and test/interact.mjs drives
 * every one of them.
 *
 * Two conventions worth stating once:
 *
 * - **`canExecute` carries what used to be part of the key match.** In the old
 *   listener `Ctrl+D` only matched when an ITEM was selected, and otherwise fell
 *   through to the browser un-`preventDefault`ed. Keeping the guard here (rather
 *   than inside `execute`) is what lets the keyboard layer reproduce that: it
 *   only swallows the key when the command actually ran.
 * - **every mutating command ends in `store.commit()`.** That is the whole undo
 *   contract (mutations do not auto-commit; a missing commit is a broken undo
 *   step), and `commit()` is a no-op when nothing changed — which is why the
 *   `wall` selection case of `selection.delete` is harmless.
 */

/** Arrow nudge: the fine step, and the ×10 coarse step Shift used to select. */
const NUDGE_FINE = 0.01;
const NUDGE_COARSE = 0.1;

/** Rotation steps: 90° plain, 15° with Shift. */
const ROT_COARSE = Math.PI / 2;
const ROT_FINE = Math.PI / 12;

const itemSelected = (ctx: EditorContext): boolean => ctx.store.selection.kind === 'item';

/** Move the selected item by (dx, dy) meters — non-structural, then commit. */
function nudge(ctx: EditorContext, dx: number, dy: number): void {
  const sel = ctx.store.selection;
  if (sel.kind !== 'item') return;
  const it = ctx.store.itemById(sel.id);
  if (!it) return;
  ctx.store.updateItem(sel.id, { x: it.x + dx, y: it.y + dy }, { structural: false });
  ctx.store.commit();
}

function rotate(ctx: EditorContext, step: number): void {
  const sel = ctx.store.selection;
  if (sel.kind !== 'item') return;
  const it = ctx.store.itemById(sel.id);
  if (!it) return;
  ctx.store.updateItem(sel.id, { rotation: it.rotation + step }, { structural: false });
  ctx.store.commit();
}

function nudgeCommand(id: string, label: string, dx: number, dy: number): CommandDefinition {
  return {
    id,
    label,
    canExecute: itemSelected,
    execute: (ctx) => nudge(ctx, dx, dy),
  };
}

export const APP_COMMANDS: readonly CommandDefinition[] = [
  {
    id: 'history.undo',
    label: 'Undo',
    execute: (ctx) => ctx.store.undo(),
  },
  {
    id: 'history.redo',
    label: 'Redo',
    execute: (ctx) => ctx.store.redo(),
  },

  {
    id: 'selection.duplicate',
    label: 'Duplicate',
    canExecute: itemSelected,
    execute: (ctx) => {
      const sel = ctx.store.selection;
      if (sel.kind !== 'item') return;
      const copy = ctx.store.duplicateItem(sel.id);
      if (copy) ctx.store.select({ kind: 'item', id: copy.id });
      ctx.store.commit();
    },
  },
  {
    id: 'selection.delete',
    label: 'Delete',
    // 'wall' is deliberately inside the guard and outside the switch: that is
    // what the keyboard map did, and a wall has no delete operation of its own.
    canExecute: (ctx) => ctx.store.selection.kind !== 'none',
    execute: (ctx) => {
      const sel = ctx.store.selection;
      if (sel.kind === 'item') ctx.store.deleteItem(sel.id);
      else if (sel.kind === 'opening') ctx.store.deleteOpening(sel.id);
      else if (sel.kind === 'corner') ctx.store.deleteCorner(sel.id);
      ctx.store.commit();
    },
  },

  {
    id: 'transform.rotate90',
    label: 'Rotate 90°',
    canExecute: itemSelected,
    execute: (ctx) => rotate(ctx, ROT_COARSE),
  },
  {
    id: 'transform.rotate15',
    label: 'Rotate 15°',
    canExecute: itemSelected,
    execute: (ctx) => rotate(ctx, ROT_FINE),
  },

  nudgeCommand('transform.nudgeLeft', 'Nudge left', -NUDGE_FINE, 0),
  nudgeCommand('transform.nudgeRight', 'Nudge right', NUDGE_FINE, 0),
  nudgeCommand('transform.nudgeUp', 'Nudge up', 0, -NUDGE_FINE),
  nudgeCommand('transform.nudgeDown', 'Nudge down', 0, NUDGE_FINE),
  nudgeCommand('transform.nudgeLeftCoarse', 'Nudge left ×10', -NUDGE_COARSE, 0),
  nudgeCommand('transform.nudgeRightCoarse', 'Nudge right ×10', NUDGE_COARSE, 0),
  nudgeCommand('transform.nudgeUpCoarse', 'Nudge up ×10', 0, -NUDGE_COARSE),
  nudgeCommand('transform.nudgeDownCoarse', 'Nudge down ×10', 0, NUDGE_COARSE),

  {
    id: 'tool.cancel',
    label: 'Cancel',
    // One tool is live at a time, so this chain is a PRIORITY LIST, not a
    // cascade: the modal outranks the tools, and 'select' falls through to
    // dropping the selection. Order is load-bearing — e2e/tools.spec.ts pins it.
    execute: (ctx) => {
      const { store, editor, plan, modal } = ctx;
      if (modal.isOpen()) modal.handleEscape();
      else if (editor.isTool('place')) plan.setArmed(null);
      else if (editor.isTool('calibrate')) plan.setCalibrate(false);
      else if (editor.isTool('measure')) plan.setMeasure(false);
      else if (editor.isTool('room')) plan.setRoomTool(false);
      // two-stage: the ring in progress goes first, the tool only when empty
      else if (editor.isTool('drawRoom')) plan.cancelDrawRoom();
      else store.select({ kind: 'none' });
    },
  },
  {
    id: 'tool.finish',
    label: 'Finish',
    canExecute: (ctx) => ctx.editor.isTool('drawRoom'),
    execute: (ctx) => ctx.plan.closeDrawRoom(),
  },
];
