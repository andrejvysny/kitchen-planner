import type { CommandRegistry } from '../commands/registry';
import { KEY_BINDINGS, matchBinding, type KeyBinding } from './bindings';

export interface KeyboardOptions {
  /** true while a modal owns the keyboard (the Part Studio today) */
  modalOpen: () => boolean;
  /** override for tests; defaults to the app table */
  bindings?: readonly KeyBinding[];
}

/**
 * The DOM adapter for the key map: it translates a `keydown` into a lookup in
 * the pure binding table and one `registry.execute()`. All of the decision-
 * making lives in those two — this class only owns a listener and its
 * lifecycle.
 *
 * Same lifecycle contract the three views have carried since Phase A:
 * `attach(target)` is idempotent for the target it already holds (React
 * StrictMode mounts effects twice), and `dispose()` aborts the listener and can
 * be called repeatedly.
 */
export class KeyboardController {
  private readonly commands: CommandRegistry;
  private readonly opts: KeyboardOptions;
  private readonly bindings: readonly KeyBinding[];

  private target: EventTarget | null = null;
  private ac: AbortController | null = null;

  constructor(commands: CommandRegistry, opts: KeyboardOptions) {
    this.commands = commands;
    this.opts = opts;
    this.bindings = opts.bindings ?? KEY_BINDINGS;
  }

  /** Listen on `target`. Re-attaching the SAME target is a no-op. */
  attach(target: EventTarget): void {
    if (this.target === target) return;
    this.detach();
    this.target = target;
    this.ac = new AbortController();
    target.addEventListener('keydown', this.onKeyDown as EventListener, {
      signal: this.ac.signal,
    });
  }

  /** Release the listener; idempotent. */
  detach(): void {
    this.ac?.abort();
    this.ac = null;
    this.target = null;
  }

  /** Permanent teardown — same shape as the views', nothing extra to free. */
  dispose(): void {
    this.detach();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const binding = matchBinding(
      e.key.toLowerCase(),
      { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey },
      this.bindings
    );
    if (!binding) return;

    if (!binding.allowWhileTyping && isTyping(e.target)) return;
    if (!binding.allowWhileTyping && !binding.allowInModal && this.opts.modalOpen()) return;

    // preventDefault only on a command that actually ran, so a binding whose
    // canExecute says no still reaches the browser (Ctrl+D with no selection)
    if (this.commands.execute(binding.commandId) && binding.preventDefault !== false) {
      e.preventDefault();
    }
  };
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
