import { describe, expect, it } from 'vitest';
import { emptyDesign, Store } from '../../src/model/store';

// src/model/store.ts on()/emit(): on() now returns a disposer, and emit()
// dispatches over a snapshot of the handler array so unsubscribing during
// dispatch can't skip or rerun a sibling handler in the same emit.
describe('Store event disposers', () => {
  it('disposer removes exactly its own handler', () => {
    const store = new Store(emptyDesign());
    const calls: string[] = [];
    const disposeA = store.on('selection', () => calls.push('a'));
    store.on('selection', () => calls.push('b'));

    disposeA();
    store.select({ kind: 'none' });

    expect(calls).toEqual(['b']);
  });

  it('double-dispose is a no-op and does not remove a different handler', () => {
    const store = new Store(emptyDesign());
    const calls: string[] = [];
    const disposeA = store.on('selection', () => calls.push('a'));
    store.on('selection', () => calls.push('b'));

    disposeA();
    disposeA(); // second call: indexOf finds nothing, must not touch 'b'
    store.select({ kind: 'none' });

    expect(calls).toEqual(['b']);
  });

  it('a handler that disposes itself during dispatch does not block the next handler in the same dispatch', () => {
    const store = new Store(emptyDesign());
    const calls: string[] = [];
    let disposeH1: () => void = () => {};
    const h1 = () => {
      calls.push('h1');
      disposeH1();
    };
    const h2 = () => calls.push('h2');
    disposeH1 = store.on('selection', h1);
    store.on('selection', h2);

    store.select({ kind: 'none' });
    expect(calls).toEqual(['h1', 'h2']); // h1 still ran this dispatch despite disposing itself

    calls.length = 0;
    store.select({ kind: 'none' });
    expect(calls).toEqual(['h2']); // h1 is gone from the next dispatch onward
  });

  it('emit is a no-op once every handler has been disposed', () => {
    const store = new Store(emptyDesign());
    const calls: string[] = [];
    const disposeA = store.on('history', () => calls.push('a'));
    const disposeB = store.on('history', () => calls.push('b'));
    disposeA();
    disposeB();

    store.design.scene.brightness = 1.5; // must actually change vs. lastCommitted, or commit() no-ops before emitting
    expect(() => store.commit()).not.toThrow();
    expect(calls).toEqual([]);
  });

  it("a disposer for one event does not affect another event's handlers", () => {
    const store = new Store(emptyDesign());
    const calls: string[] = [];
    const fn = () => calls.push('fired');
    const disposeSelection = store.on('selection', fn);
    store.on('change', fn); // same function instance, registered under a different event

    disposeSelection();

    store.select({ kind: 'none' });
    expect(calls).toEqual([]); // the 'selection' registration is gone

    store.notify({ structural: false, transient: false });
    expect(calls).toEqual(['fired']); // the 'change' registration is untouched
  });
});
