import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_COMMANDS } from '../../../src/editor/commands/appCommands';
import { CommandRegistry } from '../../../src/editor/commands/registry';
import type { EditorContext } from '../../../src/editor/commands/types';
import { KEY_BINDINGS, matchBinding, matchBindings } from '../../../src/editor/keyboard/bindings';
import { KeyboardController } from '../../../src/editor/keyboard/KeyboardController';

// src/editor/keyboard/bindings.ts — the key map as data. Pure and DOM-free, so
// the whole table is checkable here; KeyboardController is the thin adapter
// that turns a keydown into one of these lookups (e2e covers that half).

const hit = (key: string, mod = false, shift = false): string | null =>
  matchBinding(key, { mod, shift }, KEY_BINDINGS)?.commandId ?? null;

/** Every candidate for a key, in priority order — one key may mean two things. */
const hits = (key: string, mod = false, shift = false): string[] =>
  matchBindings(key, { mod, shift }, KEY_BINDINGS).map((b) => b.commandId);

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

  it('the placement HUD’s Enter sits below the wall tool’s two rows', () => {
    // plain Enter: no ring in flight, so tool.finish declines and place.commit
    // is the fallback the controller reaches for
    expect(hits('enter')).toEqual(['tool.finish', 'place.commit']);
    // Shift+Enter still opens on tool.finishOpen — place.commit carries no
    // shift constraint of its own, so it trails rather than jumping the queue
    expect(hits('enter', false, true)[0]).toBe('tool.finishOpen');
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
    expect(hit('delete', true, true)).toBe('selection.delete');
    // Backspace carries FOUR meanings told apart by context, not by
    // modifiers: the wall tool's dimension box first (only while a character
    // is typed), then stepping the drawn ring back one corner, then the
    // placement HUD's own typed width, then deleting the selection once
    // nothing else claims the key
    expect(hits('backspace')).toEqual([
      'draw.backspace',
      'draw.undoVertex',
      'place.backspace',
      'selection.delete',
    ]);
  });

  it('r rotates 90°, Shift+R rotates 15°', () => {
    expect(hit('r')).toBe('transform.rotate90');
    expect(hit('r', false, true)).toBe('transform.rotate15');
  });

  it('Ctrl/Cmd+R is the browser reload — never bound', () => {
    expect(hit('r', true, false)).toBeNull();
    expect(hit('r', true, true)).toBeNull();
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
    // the wall tool's dimension box sits above them, then the placement HUD's
    // own — both fall through when neither is live, so a digit at rest is
    // still the workspace switch
    expect(hits('1')).toEqual(['draw.digit1', 'place.digit1', 'workspace.plan']);
    expect(hits('2')).toEqual(['draw.digit2', 'place.digit2', 'workspace.furnish']);
    expect(hits('3')).toEqual(['draw.digit3', 'place.digit3', 'workspace.workshop']);
    expect(hits('4')).toEqual(['draw.digit4', 'place.digit4', 'workspace.output']);
    // Ctrl/Cmd+digit switches BROWSER tabs — `mod: false` is a hard exclusion
    // here, not the usual don't-care
    expect(hit('1', true)).toBe(null);
    expect(hit('4', true)).toBe(null);
    // Shift is don't-care, as everywhere else in the table
    expect(hits('1', false, true)).toEqual(['draw.digit1', 'place.digit1', 'workspace.plan']);
  });

  it('the dimension keys outrank their at-rest twins, and only those', () => {
    const draw = KEY_BINDINGS.filter((b) => b.commandId.startsWith('draw.'));
    expect(draw.map((b) => b.key)).toEqual([
      'backspace', // edits the dimension box…
      'backspace', // …and, with it empty, steps the ring back one corner
      // Tab moves between the length and angle boxes. It has no at-rest twin,
      // so its position here is free — but it is still a typed-input key and
      // must obey the modal/typing gates asserted below.
      'tab',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '.',
    ]);
    // they are typed characters, so a part name field must not see them, and
    // Ctrl+digit stays the browser's tab switch
    for (const b of draw) expect(b.allowWhileTyping).toBeUndefined();
    expect(hits('5', true)).toEqual([]);
  });

  it('typing is the table’s ONLY opt-out — the Part Studio gate is gone', () => {
    // WS-SPEC WP 3.1 / decision D2: the studio holds no draft any more, so
    // suppressing the keyboard while it is open would only cost the user
    // Ctrl+Z. What the suppression really protected — editing a selection the
    // Workshop pane is covering — is `onCanvas` in appCommands.ts, per command.
    const fields = new Set(KEY_BINDINGS.flatMap((b) => Object.keys(b)));
    expect(fields.has('allowInModal')).toBe(false);
  });

  it('? opens the shortcut sheet, and Cmd+? is left to the browser', () => {
    // '?' is Shift+/ on most layouts and `e.key` is already the character, so
    // shift is don't-care here; `mod: false` keeps macOS's Cmd+? Help menu
    expect(hit('?', false, true)).toBe('help.shortcuts');
    expect(hit('?')).toBe('help.shortcuts');
    expect(hit('?', true, true)).toBe(null);
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
    // …and the rest stay reachable, in that same order, for the controller to
    // fall through to when the first command cannot run
    expect(matchBindings('x', { mod: false, shift: false }, table).map((b) => b.commandId)).toEqual(
      ['first', 'second']
    );
  });
});

/* ---------------- the one gate around the table: typing --------------------- */

// KeyboardController is the DOM adapter, and that gate is everything it decides
// on its own. Node has Event/EventTarget but none of the DOM classes
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
  blocked: Set<string>;
} {
  const ran: string[] = [];
  const blocked = new Set<string>();
  const reg = new CommandRegistry({} as EditorContext);
  const ids = new Set(KEY_BINDINGS.map((b) => b.commandId));
  reg.registerAll(
    [...ids].map((id) => ({
      id,
      label: id,
      canExecute: () => !blocked.has(id),
      execute: () => {
        ran.push(id);
      },
    }))
  );
  // neither the wall tool nor the placement HUD is live in these gate tests,
  // so both dimension boxes decline the key exactly as `draw.*`'s and
  // `place.*`'s canExecute do in the app
  for (const id of ids) if (id.startsWith('draw.') || id.startsWith('place.')) blocked.add(id);
  return { kb: new KeyboardController(reg), ran, blocked };
}

describe('KeyboardController gate', () => {
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

  it('a candidate that cannot run hands the key to the next one', () => {
    const { kb, ran, blocked } = setup();
    const target = new EventTarget();
    kb.attach(target);

    // at rest the dimension binding declines and the workspace switch runs
    expect(press(target, '2').defaultPrevented).toBe(true);
    expect(ran).toEqual(['workspace.furnish']);

    // drawing: the dimension binding takes the same key and stops there
    blocked.delete('draw.digit2');
    blocked.add('workspace.furnish');
    press(target, '2');
    expect(ran).toEqual(['workspace.furnish', 'draw.digit2']);
    kb.dispose();
  });

  it('an ordinary binding runs with the Part Studio open — the gate is gone', () => {
    // WP 3.1: the studio is a workspace pane holding no draft, so undo, rotate
    // and the rest reach the app from inside it. Nothing here even knows the
    // studio exists any more, which is the assertion: the controller takes no
    // modal option at all.
    const { kb, ran } = setup();
    const target = new EventTarget();
    kb.attach(target);

    expect(press(target, 'r').defaultPrevented).toBe(true);
    expect(press(target, 'z', { mod: true }).defaultPrevented).toBe(true);
    expect(ran).toEqual(['transform.rotate90', 'history.undo']);
    kb.dispose();
  });

  it('a digit typed into a text field types — the typing gate is untouched', () => {
    const { kb, ran } = setup();
    const input = new FakeInput();
    kb.attach(input);

    const ev = press(input, '1');
    expect(ran).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
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

  it('Escape is exempt from the typing gate and never preventDefaults', () => {
    const { kb, ran } = setup();
    const input = new FakeInput();
    kb.attach(input);

    const ev = press(input, 'escape');
    expect(ran).toEqual(['tool.cancel']);
    expect(ev.defaultPrevented).toBe(false);
    kb.dispose();
  });
});
