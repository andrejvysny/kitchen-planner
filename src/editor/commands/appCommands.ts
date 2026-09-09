import { roomOfItem } from '../../model/rooms';
import type { CustomPartDef, Item } from '../../model/types';
import { rotateAbout, selectionCentre, withoutCarried } from '../selectionOps';
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

/**
 * The selected items, minus the ones another selected item carries. One list,
 * so nudge / rotate / delete / duplicate cannot disagree about what "the
 * selection" means.
 */
function selectedItems(ctx: EditorContext): Item[] {
  const items = ctx.editor
    .selectedItemIds()
    .map((id) => ctx.store.itemById(id))
    .filter((it): it is Item => !!it);
  return withoutCarried(items);
}

/** A manufactured carcass — the only thing `store.setItemFit` means anything for. */
function isFittablePart(part: CustomPartDef | undefined): boolean {
  return !!part && (part.type === 'cabinet' || part.type === 'wardrobe');
}

/** Move the whole selection by (dx, dy) meters — non-structural, then commit. */
function nudge(ctx: EditorContext, dx: number, dy: number): void {
  const items = selectedItems(ctx);
  if (!items.length) return;
  for (const it of items) {
    ctx.store.updateItem(it.id, { x: it.x + dx, y: it.y + dy }, { structural: false });
  }
  ctx.store.commit();
}

/**
 * Turn the selection. Several items turn about the middle of the set, not each
 * about its own centre — rotating a dining set one chair at a time is never
 * what is wanted — and `selectionCentre` returns the lone item's own centre for
 * a set of one, so the single-selection behaviour is not a special case here.
 */
function rotate(ctx: EditorContext, step: number): void {
  const items = selectedItems(ctx);
  const centre = selectionCentre(items);
  if (!centre) return;
  for (const p of rotateAbout(items, centre, step)) {
    ctx.store.updateItem(p.id, { x: p.x, y: p.y, rotation: p.rotation }, { structural: false });
  }
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
      const ids = ctx.editor.selectedItemIds();
      if (!ids.length) return;
      // the copies become the selection, so a second Ctrl+D duplicates THEM —
      // the same promise the single-item version always made
      const copies = ids
        .map((id) => ctx.store.duplicateItem(id))
        .filter((c): c is Item => !!c)
        .map((c) => ({ kind: 'item', id: c.id }) as const);
      if (copies.length) ctx.editor.selectRefs(copies);
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
      if (sel.kind === 'item')
        for (const id of ctx.editor.selectedItemIds()) ctx.store.deleteItem(id);
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
    id: 'item.fitToRoom',
    label: 'Fit to alcove',
    // menu-only today (no key binding), but gated like every other item
    // command: onCanvas so it never touches a selection the Workshop/Output
    // panes have covered, and at least one member has to be fittable
    canExecute: (ctx) =>
      itemSelected(ctx) &&
      selectedItems(ctx).some((it) => isFittablePart(ctx.store.partOf(it.defId))),
    execute: (ctx) => {
      for (const it of selectedItems(ctx)) {
        if (!isFittablePart(ctx.store.partOf(it.defId))) continue;
        ctx.store.setItemFit(it.id, { width: 'walls', height: 'ceiling' });
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
      else if (editor.isTool('place')) {
        // two-stage, like the wall tool's ring: a typed width goes first, the
        // def disarms only once the box is already empty
        if (plan.placeBufferActive()) plan.clearPlaceWidth();
        else plan.setArmed(null);
      } else if (editor.isTool('calibrate')) plan.setCalibrate(false);
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

  /*
   * Type-in width for the wardrobe placement HUD (P3) — the same
   * DIMENSION_KEYS box as the wall tool, one gate narrower:
   * `placeInputActive` requires an armed def AND a ghost that has actually
   * landed on a free segment, so a digit never steals a workspace switch
   * while some OTHER def is merely armed over empty floor.
   */
  ...DIMENSION_KEYS.map((ch) => ({
    id: `place.digit${ch === '.' ? 'Dot' : ch}`,
    label: `Placement width ${ch}`,
    canExecute: (ctx: EditorContext) => onCanvas(ctx) && ctx.plan.placeInputActive(),
    execute: (ctx: EditorContext) => ctx.plan.placeDigit(ch),
  })),
  {
    id: 'place.backspace',
    label: 'Placement width backspace',
    // an EMPTY box hands Backspace on to `selection.delete`, exactly the
    // split `draw.backspace` makes against `draw.undoVertex`
    canExecute: (ctx) => onCanvas(ctx) && ctx.plan.placeBufferActive(),
    execute: (ctx) => ctx.plan.placeBackspace(),
  },
  {
    id: 'place.commit',
    label: 'Place here',
    canExecute: (ctx) => onCanvas(ctx) && ctx.plan.placeInputActive(),
    execute: (ctx) => {
      ctx.plan.commitPlace();
    },
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
