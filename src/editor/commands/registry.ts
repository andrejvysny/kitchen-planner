import type { CommandDefinition, CommandId, EditorContext } from './types';

/**
 * The command table. One instance per app, built in src/app; it holds the
 * definitions and the EditorContext they run against, so callers only ever
 * quote an id.
 *
 * Unknown ids are a NO-OP that reports false, never a throw — the same
 * null-safety rule `Plan2D.resolveArmed` follows for stale armed def ids. A
 * keybinding, a menu entry or a spec that names a command which no longer
 * exists must not take the app down with it.
 */
export class CommandRegistry {
  private readonly defs = new Map<CommandId, CommandDefinition>();
  private readonly ctx: EditorContext;

  constructor(ctx: EditorContext) {
    this.ctx = ctx;
  }

  /** Last registration wins — re-registering an id replaces it. */
  register(def: CommandDefinition): void {
    this.defs.set(def.id, def);
  }

  registerAll(defs: readonly CommandDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  get(id: CommandId): CommandDefinition | undefined {
    return this.defs.get(id);
  }

  /** Every registered command, in registration order (Map preserves it). */
  list(): CommandDefinition[] {
    return [...this.defs.values()];
  }

  /** False for an unknown id as well as for a command whose guard says no. */
  canExecute(id: CommandId): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    return def.canExecute ? def.canExecute(this.ctx) : true;
  }

  /** Runs the command if it is known AND allowed; returns whether it ran. */
  execute(id: CommandId): boolean {
    const def = this.defs.get(id);
    if (!def) return false;
    if (def.canExecute && !def.canExecute(this.ctx)) return false;
    def.execute(this.ctx);
    return true;
  }
}
