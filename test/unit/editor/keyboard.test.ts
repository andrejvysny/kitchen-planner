import { describe, expect, it } from 'vitest';
import { APP_COMMANDS } from '../../../src/editor/commands/appCommands';
import { KEY_BINDINGS, matchBinding } from '../../../src/editor/keyboard/bindings';

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
