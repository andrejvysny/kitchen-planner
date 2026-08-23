import { roomOfItem } from '../../model/rooms';
import type { CommandDefinition, EditorContext, WorkspaceId } from './types';

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

/**
 * Characters the wall tool's dimension box takes. Digits plus a decimal point:
 * the value is parsed by src/model/units.ts in the user's own unit, so '2400'
 * is 2.4 m in a mm profile — a unit SUFFIX is not typed here, since every
 * letter key is a shortcut.
 */
const DIMENSION_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.'] as const;

/**
 * Are the plan and 3D canvases the thing the user is looking at?
 *
 * The Workshop and Output panes COVER those canvases (they never unmount them),
 * so in either workspace the selection and any live tool are invisible. Until
 * WS-SPEC WP 3.1 that was handled bluntly, by suppressing the whole keyboard
 * while the Part Studio was open — which also suppressed Ctrl+Z, and live-apply
 * has since turned undo-in-the-Workshop into the headline feature. So the gate
 * moved here, to the commands that actually need it: the ones that would edit
 * something the user cannot see. Decision D2.
 */
const onCanvas = (ctx: EditorContext): boolean => {
  const w = ctx.workspace.workspace();
  return w === 'plan' || w === 'furnish';
};

const itemSelected = (ctx: EditorContext): boolean =>
  onCanvas(ctx) && ctx.editor.selection.kind === 'item';

/** Move the selected item by (dx, dy) meters — non-structural, then commit. */
function nudge(ctx: EditorContext, dx: number, dy: number): void {
  const sel = ctx.editor.selection;
  if (sel.kind !== 'item') return;
  const it = ctx.store.itemById(sel.id);
  if (!it) return;
  ctx.store.updateItem(sel.id, { x: it.x + dx, y: it.y + dy }, { structural: false });
  ctx.store.commit();
}

function rotate(ctx: EditorContext, step: number): void {
  const sel = ctx.editor.selection;
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

/**
 * Switch workspace. No `canExecute`: switching to the one already showing is a
 * cheap no-op inside the port, and a guard that refuses it would make the key
 * fall through to the browser for no gain. The dirty-check that CAN refuse the
 * switch lives in the port too — the command layer never asks the user
 * anything.
 */
function workspaceCommand(id: string, label: string, w: WorkspaceId): CommandDefinition {
  return {
    id,
    label,
    execute: (ctx) => {
      ctx.workspace.switchTo(w);
    },
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
    id: 'selection.all',
    label: 'Select all items',
    // Items only, and only in the ACTIVE room: a multi-selection is items-only
    // by construction, and "everything in the room I am working in" is what
    // Ctrl+A means in a plan that may hold a whole apartment.
    canExecute: (ctx) => onCanvas(ctx) && ctx.store.design.items.length > 0,
    execute: (ctx) => {
      const roomId = ctx.store.activeRoomId;
      const ids = ctx.store.design.items
        .filter((it) => (roomOfItem(ctx.store.design, it)?.id ?? null) === roomId)
        .map((it) => ({ kind: 'item', id: it.id }) as const);
      ctx.editor.selectRefs(ids);
    },
  },
  {
    id: 'selection.duplicate',
    label: 'Duplicate',
    canExecute: itemSelected,
    execute: (ctx) => {
      const sel = ctx.editor.selection;
      if (sel.kind !== 'item') return;
      const copy = ctx.store.duplicateItem(sel.id);
      if (copy) ctx.editor.select({ kind: 'item', id: copy.id });
      ctx.store.commit();
    },
  },
  {
    id: 'selection.delete',
    label: 'Delete',
    // A room's wall still has no delete of its own (you delete the room, or
    // move its corners) — but a FREE-STANDING chain is its own object, so
    // deleting one is exactly what Delete should do there.
    canExecute: (ctx) => onCanvas(ctx) && ctx.editor.selection.kind !== 'none',
    execute: (ctx) => {
      const sel = ctx.editor.selection;
      if (sel.kind === 'item') ctx.store.deleteItem(sel.id);
      else if (sel.kind === 'opening') ctx.store.deleteOpening(sel.id);
      else if (sel.kind === 'corner') ctx.store.deleteCorner(sel.id);
      else if (sel.kind === 'wall') {
        const chain = ctx.store.freeWallOf(sel.id);
        if (chain) ctx.store.deleteFreeWall(chain.id);
      }
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
      const { editor, plan, modal } = ctx;
      if (modal.isOpen()) modal.handleEscape();
      else if (editor.isTool('place')) plan.setArmed(null);
      else if (editor.isTool('calibrate')) plan.setCalibrate(false);
      else if (editor.isTool('measure')) plan.setMeasure(false);
      // two-stage: the ring in progress goes first, the tool only when empty
      else if (editor.isTool('drawRoom')) plan.cancelDrawRoom();
      else editor.select({ kind: 'none' });
    },
  },
  {
    id: 'tool.finish',
    label: 'Finish',
    canExecute: (ctx) => onCanvas(ctx) && ctx.editor.isTool('drawRoom'),
    execute: (ctx) => ctx.plan.closeDrawRoom(),
  },
  {
    id: 'tool.finishOpen',
    label: 'Finish as walls',
    canExecute: (ctx) => onCanvas(ctx) && ctx.editor.isTool('drawRoom'),
    execute: (ctx) => ctx.plan.closeDrawRoom(true),
  },

  /*
   * Type-in dimensions for the wall tool. These sit ABOVE the workspace digits
   * in the binding table, and `canExecute` is what keeps that honest: while a
   * ring is in flight a digit is a length, at rest it is still a workspace
   * switch. A command that cannot run does not swallow its key.
   */
  ...DIMENSION_KEYS.map((ch) => ({
    id: `draw.digit${ch === '.' ? 'Dot' : ch}`,
    label: `Dimension ${ch}`,
    canExecute: (ctx: EditorContext) => onCanvas(ctx) && ctx.plan.drawInputActive(),
    execute: (ctx: EditorContext) => ctx.plan.drawDigit(ch),
  })),
  {
    id: 'draw.backspace',
    label: 'Dimension backspace',
    // an EMPTY box must hand Backspace on to `draw.undoVertex` below it in the
    // table, so this asks for a typed character rather than just a live ring
    canExecute: (ctx) => onCanvas(ctx) && ctx.plan.drawBufferActive(),
    execute: (ctx) => ctx.plan.drawBackspace(),
  },
  {
    id: 'draw.undoVertex',
    label: 'Undo last corner',
    canExecute: (ctx) => onCanvas(ctx) && ctx.plan.drawInputActive(),
    execute: (ctx) => ctx.plan.undoDrawVertex(),
  },
  {
    id: 'draw.toggleField',
    label: 'Dimension: length / angle',
    canExecute: (ctx) => onCanvas(ctx) && ctx.plan.drawInputActive(),
    execute: (ctx) => ctx.plan.drawToggleField(),
  },

  /**
   * The shortcut sheet, behind `?`. No `canExecute` and no mutation: it is the
   * one command that changes nothing about the design, which is also why it
   * takes no `store.commit()` — there is no undo step in showing help.
   */
  {
    id: 'help.shortcuts',
    label: 'Keyboard & mouse',
    execute: (ctx) => ctx.help.toggleShortcuts(),
  },

  workspaceCommand('workspace.plan', 'Plan workspace', 'plan'),
  workspaceCommand('workspace.furnish', 'Furnish workspace', 'furnish'),
  workspaceCommand('workspace.workshop', 'Workshop workspace', 'workshop'),
  workspaceCommand('workspace.output', 'Output workspace', 'output'),
];
