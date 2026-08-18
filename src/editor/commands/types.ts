/**
 * Command layer contracts — framework-free, like the rest of src/editor.
 *
 * A command is a NAMED editor behaviour. Before this existed the eight things
 * the keyboard could do had no names at all: they lived as `if` branches inside
 * one `keydown` listener, so a toolbar button, a context menu or a command
 * palette had no way to invoke them. Now the keyboard is just the first caller.
 *
 * What a command is NOT: a history step. Undo stays what it has always been —
 * whole-design JSON snapshots taken by `store.commit()` — and every command
 * that mutates ends with that call, exactly as the keyboard map did. Command-
 * shaped history is a separate decision for a later milestone, and nothing here
 * pre-empts it.
 */

import type { Store } from '../../model/store';
import type { EditorState } from '../editorState';

/**
 * Dotted `area.verb` id. A string alias rather than a union: the registry is
 * open (a plugin, a future tool, a test can register its own), and the seed set
 * in appCommands.ts is a convention, not a closed world.
 */
export type CommandId = string;

/**
 * The plan view, as the command layer is allowed to see it.
 *
 * src/plan2d already imports src/editor (Plan2D holds an EditorState), so a
 * concrete import back would be a module cycle. This structural port is the
 * inversion: `Plan2D` satisfies it as-is, and src/app does the wiring. Only the
 * tool-cancelling surface is here — commands have no business reaching further
 * into the view.
 */
export interface PlanToolPort {
  /** null disarms placement; the wider signature stays in Plan2D itself */
  setArmed(def: null): void;
  setCalibrate(on: boolean): void;
  setMeasure(on: boolean): void;
  cancelDrawRoom(): void;
  closeDrawRoom(): void;
  /** whether a keystroke should feed the wall tool's dimension box */
  drawInputActive(): boolean;
  drawDigit(ch: string): void;
  drawBackspace(): void;
}

/**
 * A modal that swallows Escape before the tools see it — the Part Studio today.
 * Same inversion as PlanToolPort: `PartStudio` satisfies it structurally, and
 * src/editor never imports src/ui.
 */
export interface ModalPort {
  isOpen(): boolean;
  handleEscape(): void;
}

/**
 * The workspace shell as the commands see it — implemented by the app layer
 * (src/app/services.ts), like ModalPort/PlanToolPort, so src/editor never
 * imports src/ui. `switchTo` runs the guarded switch (dirty-check, tool reset)
 * and returns false when the user cancelled it.
 */
export interface WorkspacePort {
  workspace(): WorkspaceId;
  switchTo(w: WorkspaceId): boolean;
}

/**
 * The help surface, as the commands see it — implemented by the app layer
 * (src/app/services.ts) over the shell singleton, like WorkspacePort above, so
 * src/editor never imports src/ui. Toggling rather than opening is deliberate:
 * `?` is the same key twice, and the sheet is the only thing that key does.
 */
export interface HelpPort {
  toggleShortcuts(): void;
}

/** Everything a command is allowed to touch. Assembled once, in src/app. */
export interface EditorContext {
  store: Store;
  editor: EditorState;
  plan: PlanToolPort;
  modal: ModalPort;
  workspace: WorkspacePort;
  help: HelpPort;
}

export interface CommandDefinition {
  id: CommandId;
  /** human label — menus and a future command palette read this */
  label: string;
  /**
   * Whether the command applies right now (usually a selection-kind guard).
   * Optional: a command with no precondition is always available.
   */
  canExecute?(ctx: EditorContext): boolean;
  execute(ctx: EditorContext): void;
}

/** The four task-focused workspaces of the shell. WS-SPEC §2.1. */
export type WorkspaceId = 'plan' | 'furnish' | 'workshop' | 'output';
