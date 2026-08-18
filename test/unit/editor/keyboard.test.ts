import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_COMMANDS } from '../../../src/editor/commands/appCommands';
import { CommandRegistry } from '../../../src/editor/commands/registry';
import type { EditorContext } from '../../../src/editor/commands/types';
import { KEY_BINDINGS, matchBinding } from '../../../src/editor/keyboard/bindings';
import { KeyboardController } from '../../../src/editor/keyboard/KeyboardController';

// src/editor/keyboard/bindings.ts — the key map as data. Pure and DOM-free, so
// the whole table is checkable here; KeyboardController is the thin adapter
// that turns a keydown into one of these lookups (e2e covers that half).

const hit = (key: string, mod = false, shift = false): string | null =>
  matchBinding(key, { mod, shift }, KEY_BINDINGS)?.commandId ?? null;

describe('key bindings', () => {
  it('every binding points at a registered command', () => {
    const ids = new Set(APP_COMMANDS.map((c) => c.id));
    for (const b of KEY_BINDINGS) expect(ids.has(b.commandId)).toBe(true);
  });

  it('binding keys are stored lowercased — matchBinding is fed e.key.toLowerCase()', () => {
    for (const b of KEY_BINDINGS) expect(b.key).toBe(b.key.toLowerCase());
  });

  it('Escape cancels, survives typing, and never preventDefaults', () => {
    const esc = matchBinding('escape', { mod: false, shift: false }, KEY_BINDINGS)!;
    expect(esc.commandId).toBe('tool.cancel');
    // it sat ABOVE the typing gate in the old listener — cancelling a tool from
    // inside an inspector field is deliberate
    expect(esc.allowWhileTyping).toBe(true);
    // Escape has browser meaning inside a text field, and never had one before
    expect(esc.preventDefault).toBe(false);
  });

  it('Escape ignores modifiers', () => {
    expect(hit('escape')).toBe('tool.cancel');
    expect(hit('escape', true)).toBe('tool.cancel');
    expect(hit('escape', false, true)).toBe('tool.cancel');
  });

  it('Escape is the ONLY binding that runs while typing', () => {
    const typingSafe = KEY_BINDINGS.filter((b) => b.allowWhileTyping);
    expect(typingSafe.map((b) => b.key)).toEqual(['escape']);
  });

  it('Enter maps to tool.finish — the drawRoom guard lives in the command', () => {
    expect(hit('enter')).toBe('tool.finish');
    const finish = APP_COMMANDS.find((c) => c.id === 'tool.finish')!;
    expect(finish.canExecute).toBeTypeOf('function');
  });

  it('undo/redo: Shift+Ctrl+Z beats Ctrl+Z on order, and Ctrl+Y is redo', () => {
    expect(hit('z', true, false)).toBe('history.undo');
    expect(hit('z', true, true)).toBe('history.redo');
    expect(hit('y', true)).toBe('history.redo');
    expect(hit('y', true, true)).toBe('history.redo'); // shift is don't-care here
    // no modifier: not a binding at all, so 'z' types normally
    expect(hit('z')).toBe(null);
  });

  it('Ctrl+D duplicates; the selection guard is the command, not the chord', () => {
    expect(hit('d', true)).toBe('selection.duplicate');
    expect(hit('d')).toBe(null);
  });

  it('Delete and Backspace both delete, with or without modifiers', () => {
    expect(hit('delete')).toBe('selection.delete');
    expect(hit('backspace')).toBe('selection.delete');
    expect(hit('delete', true, true)).toBe('selection.delete');
  });

  it('r rotates 90°, Shift+R rotates 15°', () => {
    expect(hit('r')).toBe('transform.rotate90');
    expect(hit('r', false, true)).toBe('transform.rotate15');
  });

  it('arrows nudge, and Shift picks the coarse step', () => {
    expect(hit('arrowleft')).toBe('transform.nudgeLeft');
    expect(hit('arrowright')).toBe('transform.nudgeRight');
    expect(hit('arrowup')).toBe('transform.nudgeUp');
    expect(hit('arrowdown')).toBe('transform.nudgeDown');
    expect(hit('arrowleft', false, true)).toBe('transform.nudgeLeftCoarse');
    expect(hit('arrowright', false, true)).toBe('transform.nudgeRightCoarse');
    expect(hit('arrowup', false, true)).toBe('transform.nudgeUpCoarse');
    expect(hit('arrowdown', false, true)).toBe('transform.nudgeDownCoarse');
  });

  it('1-4 pick a workspace, and Ctrl/Cmd+digit is left to the browser', () => {
    expect(hit('1')).toBe('workspace.plan');
    expect(hit('2')).toBe('workspace.furnish');
    expect(hit('3')).toBe('workspace.workshop');
    expect(hit('4')).toBe('workspace.output');
    // Ctrl/Cmd+digit switches BROWSER tabs — `mod: false` is a hard exclusion
    // here, not the usual don't-care
    expect(hit('1', true)).toBe(null);
    expect(hit('4', true)).toBe(null);
    // Shift is don't-care, as everywhere else in the table
    expect(hit('1', false, true)).toBe('workspace.plan');
  });

  it('? opens the shortcut sheet, and Cmd+? is left to the browser', () => {
    // '?' is Shift+/ on most layouts and `e.key` is already the character, so
    // shift is don't-care here; `mod: false` keeps macOS's Cmd+? Help menu
    expect(hit('?', false, true)).toBe('help.shortcuts');
    expect(hit('?')).toBe('help.shortcuts');
    expect(hit('?', true, true)).toBe(null);
  });

  it('the workspace keys and ? are the ones that survive an open modal', () => {
    const inModal = KEY_BINDINGS.filter((b) => b.allowInModal);
    // help has to be reachable from the Workshop, where the Part Studio is open
    // for as long as that workspace is showing
    expect(inModal.map((b) => b.key)).toEqual(['1', '2', '3', '4', '?']);
    // allowInModal is about the MODAL only: typing still wins
    for (const b of inModal) expect(b.allowWhileTyping).toBeUndefined();
  });

  it('an unbound key matches nothing', () => {
    expect(hit('q')).toBe(null);
    expect(hit('f5')).toBe(null);
  });

  it('first match wins — order in the table is the priority', () => {
    const table = [
      { key: 'x', commandId: 'first' },
      { key: 'x', commandId: 'second' },
    ];
    expect(matchBinding('x', { mod: false, shift: false }, table)!.commandId).toBe('first');
  });
});

/* ---------------- the two gates around the table: typing and the modal ------ */

// KeyboardController is the DOM adapter, and everything it decides on its own
// is those two gates. Node has Event/EventTarget but none of the DOM classes
// `isTyping` does `instanceof` against, and this suite runs without jsdom (see
// test/unit/workspaceState.test.ts) — so stub the three constructors and
// dispatch a plain Event carrying the four fields the controller reads.

class FakeInput extends EventTarget {}
class FakeTextArea extends EventTarget {}
class FakeElement extends EventTarget {}

type DomCtors = {
  HTMLInputElement?: unknown;
  HTMLTextAreaElement?: unknown;
  HTMLElement?: unknown;
};

/** Dispatch a keydown on `target` and hand back the event, for defaultPrevented. */
function press(
  target: EventTarget,
  key: string,
  mods: { mod?: boolean; shift?: boolean } = {}
): Event {
  const ev = Object.assign(new Event('keydown', { cancelable: true }), {
    key,
    ctrlKey: !!mods.mod,
    metaKey: false,
    shiftKey: !!mods.shift,
  });
  target.dispatchEvent(ev);
  return ev;
}

/**
 * A controller over PROBE commands — one per binding id, recording only that it
 * ran. The context is empty because nothing here reads it: the registry only
 * passes it through, and these commands ignore it.
 */
function setup(): {
  kb: KeyboardController;
  ran: string[];
  modal: { open: boolean };
} {
  const ran: string[] = [];
  const reg = new CommandRegistry({} as EditorContext);
  reg.registerAll(
    KEY_BINDINGS.map((b) => ({
      id: b.commandId,
      label: b.commandId,
      execute: () => {
        ran.push(b.commandId);
      },
    }))
  );
  const modal = { open: false };
  return { kb: new KeyboardController(reg, { modalOpen: () => modal.open }), ran, modal };
}

describe('KeyboardController gates', () => {
  beforeEach(() => {
    const g = globalThis as unknown as DomCtors;
    g.HTMLInputElement = FakeInput;
    g.HTMLTextAreaElement = FakeTextArea;
    g.HTMLElement = FakeElement;
  });

  afterEach(() => {
    const g = globalThis as unknown as DomCtors;
    delete g.HTMLInputElement;
    delete g.HTMLTextAreaElement;
    delete g.HTMLElement;
  });

  it('runs a binding and swallows the key when the command ran', () => {
    const { kb, ran } = setup();
    const target = new EventTarget();
    kb.attach(target);

    const ev = press(target, '2');
    expect(ran).toEqual(['workspace.furnish']);
    expect(ev.defaultPrevented).toBe(true);
    kb.dispose();
  });

  it('allowInModal: the workspace keys still run while the Part Studio is open', () => {
    const { kb, ran, modal } = setup();
    const target = new EventTarget();
    kb.attach(target);
    modal.open = true;

    press(target, '3');
    expect(ran).toEqual(['workspace.workshop']);
    kb.dispose();
  });

  it('an ordinary binding is still blocked by an open modal — the gate only moved', () => {
    const { kb, ran, modal } = setup();
    const target = new EventTarget();
    kb.attach(target);
    modal.open = true;

    const ev = press(target, 'r');
    expect(ran).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    kb.dispose();
  });

  it('typing beats allowInModal: a digit in a text field types, modal or not', () => {
    const { kb, ran, modal } = setup();
    const input = new FakeInput();
    kb.attach(input);
    modal.open = true;

    const ev = press(input, '1');
    expect(ran).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);

    modal.open = false;
    press(input, '1');
    expect(ran).toEqual([]);
    kb.dispose();
  });

  it('a ? typed into a text field is a question mark, not the help sheet', () => {
    const { kb, ran } = setup();
    const input = new FakeInput();
    kb.attach(input);

    const ev = press(input, '?', { shift: true });
    expect(ran).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
    kb.dispose();
  });

  it('Escape is exempt from both gates and never preventDefaults', () => {
    const { kb, ran, modal } = setup();
    const input = new FakeInput();
    kb.attach(input);
    modal.open = true;

    const ev = press(input, 'escape');
    expect(ran).toEqual(['tool.cancel']);
    expect(ev.defaultPrevented).toBe(false);
    kb.dispose();
  });
});
