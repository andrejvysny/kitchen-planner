import type { Store } from '../../model/store';
import type { CommandRegistry } from '../commands/registry';
import type { EditorState } from '../editorState';
import type { Cursor, KeyInput, PointerInput } from '../input/types';

/**
 * The Tool contract Phase C will extract Plan2D's gestures into. TYPES ONLY —
 * no `ToolManager` yet, on purpose: a manager with nothing registered is dead
 * code, and the class lands in M12 together with the first tool that exercises
 * it. See src/editor/README.md for the migration order and why Select goes last.
 *
 * What this is, and is not:
 *
 * - a Tool owns ONE gesture mode's behaviour (measure, place, draw a room). It
 *   does not own the tool CHOICE — that stays `EditorState.tool`, which the
 *   React buttons and Plan2D's mirrors already read. The manager's job will be
 *   to turn a change there into `deactivate`/`activate`, which is exactly what
 *   Plan2D's `syncFromEditor()` leaving-tool cleanup does by hand today.
 * - a Tool never touches the DOM (`PointerInput`/`KeyInput`, never
 *   `PointerEvent`) and never touches React. It reads the Store and asks for a
 *   redraw; it does not render.
 * - a Tool takes undo steps the way everything else does: mutate, then
 *   `store.commit()` at gesture end. Nothing here changes the history model.
 */

/**
 * What a Tool is allowed to reach. Deliberately NOT the whole app: no view, no
 * canvas, no React. `requestDraw` and `setHint` are ports the host fills in, so
 * a tool can be driven headlessly in a unit test.
 */
export interface ToolContext {
  store: Store;
  editor: EditorState;
  commands: CommandRegistry;
  /** current zoom in px per metre — screen-space tolerances derive from it */
  zoom: number;
  /** ask the host to repaint; coalesced by the host, never synchronous */
  requestDraw(): void;
  /** status-bar one-liner: what this tool expects next */
  setHint(text: string): void;
}

/**
 * Whether the host should stop processing this input.
 *
 * 'passthrough' is what lets the select tool fall through to a pan, and what
 * lets an unhandled key reach the global command map — the same rule the
 * keyboard controller already follows with `registry.execute`'s boolean.
 */
export type ToolResult = 'handled' | 'passthrough';

export interface Tool {
  readonly id: string;

  /** entering the tool: reset accumulated gesture state, set the first hint */
  activate(ctx: ToolContext): void;
  /** leaving it: drop ghosts/rings/partial measurements, commit nothing */
  deactivate(ctx: ToolContext): void;
  /**
   * Escape while the tool stays active. Two-stage by convention: cancel the
   * gesture in progress and report 'handled'; report 'passthrough' when there
   * was nothing to cancel, so the host drops back to 'select'.
   */
  cancel(ctx: ToolContext): ToolResult;

  pointerDown(input: PointerInput, ctx: ToolContext): ToolResult;
  pointerMove(input: PointerInput, ctx: ToolContext): ToolResult;
  pointerUp(input: PointerInput, ctx: ToolContext): ToolResult;

  keyDown?(input: KeyInput, ctx: ToolContext): ToolResult;

  /** cursor to show while this tool is active and idle */
  cursor?(ctx: ToolContext): Cursor;
}
