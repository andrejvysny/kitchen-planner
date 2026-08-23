import { describe, expect, it } from 'vitest';
import { EditorState } from '../../../src/editor/editorState';

// src/editor/editorState.ts — the framework-free editor observable. The
// contract React leans on: getVersion() is monotonic and bumps ONLY on a real
// change, subscribe() returns a disposer (same shape as Store.on).
describe('EditorState', () => {
  it('starts in the resting state at version 0', () => {
    const ed = new EditorState();
    expect(ed.tool).toBe('select');
    expect(ed.armedDefId).toBe(null);
    expect(ed.checksOn).toBe(false);
    expect(ed.getVersion()).toBe(0);
  });

  it('setTool bumps the version and notifies subscribers', () => {
    const ed = new EditorState();
    let calls = 0;
    ed.subscribe(() => calls++);

    ed.setTool('place', 'base-cabinet');
    expect(ed.tool).toBe('place');
    expect(ed.armedDefId).toBe('base-cabinet');
    expect(ed.getVersion()).toBe(1);
    expect(calls).toBe(1);
  });

  it('setTool with identical state is a no-op — no bump, no emit', () => {
    const ed = new EditorState();
    let calls = 0;
    ed.subscribe(() => calls++);

    ed.setTool('measure');
    ed.setTool('measure');
    expect(ed.getVersion()).toBe(1);
    expect(calls).toBe(1);

    // same tool, different armed def: still a real change
    ed.setTool('place', 'door');
    ed.setTool('place', 'window');
    expect(ed.getVersion()).toBe(3);
    expect(calls).toBe(3);
  });

  it('re-entering a tool without a def disarms', () => {
    const ed = new EditorState();
    ed.setTool('place', 'door');
    ed.setTool('select');
    expect(ed.armedDefId).toBe(null);
    expect(ed.getVersion()).toBe(2);
  });

  it('isTool answers for exactly one tool at a time', () => {
    const ed = new EditorState();
    expect(ed.isTool('select')).toBe(true);
    expect(ed.isTool('place')).toBe(false);

    ed.setTool('place', 'base-cabinet');
    expect(ed.isTool('place')).toBe(true);
    expect(ed.isTool('select')).toBe(false);

    // the checks LAYER is not a tool, so it never shows up here
    ed.setChecks(true);
    expect(ed.isTool('place')).toBe(true);

    ed.setTool('drawRoom');
    expect(ed.isTool('drawRoom')).toBe(true);
    expect(ed.isTool('place')).toBe(false);
  });

  it('setChecks is orthogonal to the tool and no-ops on the same value', () => {
    const ed = new EditorState();
    let calls = 0;
    ed.subscribe(() => calls++);

    ed.setChecks(true);
    ed.setChecks(true);
    expect(ed.checksOn).toBe(true);
    expect(ed.tool).toBe('select');
    expect(ed.getVersion()).toBe(1);
    expect(calls).toBe(1);

    ed.setChecks(false);
    expect(ed.getVersion()).toBe(2);
    expect(calls).toBe(2);
  });

  it('the disposer removes exactly its own subscriber, and double-dispose is a no-op', () => {
    const ed = new EditorState();
    const seen: string[] = [];
    const offA = ed.subscribe(() => seen.push('a'));
    ed.subscribe(() => seen.push('b'));

    offA();
    offA();
    ed.setTool('drawRoom');
    expect(seen).toEqual(['b']);
    // the version still advanced — a bump is state, not a side effect of listening
    expect(ed.getVersion()).toBe(1);
  });

  it('a subscriber that unsubscribes during dispatch does not skip a sibling', () => {
    const ed = new EditorState();
    const seen: string[] = [];
    let offFirst: () => void = () => {};
    offFirst = ed.subscribe(() => {
      seen.push('first');
      offFirst();
    });
    ed.subscribe(() => seen.push('second'));

    ed.setTool('drawRoom');
    expect(seen).toEqual(['first', 'second']);

    seen.length = 0;
    ed.setTool('select');
    expect(seen).toEqual(['second']);
  });

  /* ---------------- selection (M18) ---------------- */

  it('the selection starts empty and projects to the single-selection shape', () => {
    const ed = new EditorState();
    expect(ed.selection).toEqual({ kind: 'none' });
    expect(ed.entities).toEqual([]);
    expect(ed.primary).toBe(null);
    expect(ed.getSelectionVersion()).toBe(0);
  });

  it('selection and tool are separate channels — neither bumps the other', () => {
    const ed = new EditorState();
    let tool = 0;
    let sel = 0;
    ed.subscribe(() => tool++);
    ed.subscribeSelection(() => sel++);

    ed.select({ kind: 'item', id: 'i1' });
    expect([tool, sel]).toEqual([0, 1]);
    expect(ed.getVersion()).toBe(0);
    expect(ed.getSelectionVersion()).toBe(1);

    ed.setTool('measure');
    expect([tool, sel]).toEqual([1, 1]);
  });

  it('selecting what is already selected is a no-op — no bump, no emit', () => {
    const ed = new EditorState();
    let calls = 0;
    ed.subscribeSelection(() => calls++);

    ed.select({ kind: 'item', id: 'i1' });
    ed.select({ kind: 'item', id: 'i1' });
    expect(calls).toBe(1);
    // and clearing an already-empty selection likewise
    ed.select({ kind: 'none' });
    ed.select({ kind: 'none' });
    expect(calls).toBe(2);
  });

  it('primary projects; entities carries the whole set', () => {
    const ed = new EditorState();
    ed.selectRefs([
      { kind: 'item', id: 'a' },
      { kind: 'item', id: 'b' },
    ]);
    expect(ed.selectedItemIds()).toEqual(['a', 'b']);
    expect(ed.selection).toEqual({ kind: 'item', id: 'b' });
    expect(ed.isSelected({ kind: 'item', id: 'a' })).toBe(true);

    ed.toggleRef({ kind: 'item', id: 'b' });
    expect(ed.selection).toEqual({ kind: 'item', id: 'a' });
  });

  it('pruneSelection drops what the caller says is gone', () => {
    const ed = new EditorState();
    ed.selectRefs([
      { kind: 'item', id: 'a' },
      { kind: 'item', id: 'b' },
    ]);
    ed.pruneSelection((r) => r.id !== 'b');
    expect(ed.selectedItemIds()).toEqual(['a']);
  });

  it('subscribeSelection returns a disposer and counts its listeners', () => {
    const ed = new EditorState();
    const off = ed.subscribeSelection(() => {});
    expect(ed.selectionHandlerCount()).toBe(1);
    off();
    off();
    expect(ed.selectionHandlerCount()).toBe(0);
  });
});
