import { describe, expect, it } from 'vitest';
import { emptyDesign, Store } from '../../src/model/store';

// src/model/store.ts commit(): `if (this.undoStack.length > 120) this.undoStack.shift();`
// — an inline literal, not a named exported constant. Pinned here so a
// future change to the cap shows up as a failing test, not a silent drift.
const UNDO_CAP = 120;

describe('undo stack depth', () => {
  it('caps at 120 entries, evicting the oldest commits first', () => {
    const store = new Store(emptyDesign());
    const extra = 5;
    const total = UNDO_CAP + extra;
    // OFFSET keeps every value clear of defaultScene()'s brightness (1), so
    // every commit below actually changes the design and gets pushed.
    const OFFSET = 1000;
    for (let i = 1; i <= total; i++) {
      store.design.scene.brightness = OFFSET + i;
      store.commit();
    }
    expect(store.canUndo()).toBe(true);

    const seen: number[] = [store.design.scene.brightness]; // OFFSET + total, pre-undo
    for (let i = 0; i < UNDO_CAP; i++) {
      store.undo();
      seen.push(store.design.scene.brightness);
    }

    // exactly UNDO_CAP steps existed: the stack is now empty
    expect(store.canUndo()).toBe(false);
    // walking back UNDO_CAP steps from `total` lands on `total - UNDO_CAP`
    // (= extra): the oldest `extra` commits were evicted and are unreachable
    expect(seen[seen.length - 1]).toBe(OFFSET + (total - UNDO_CAP));
    expect(seen).toEqual(Array.from({ length: UNDO_CAP + 1 }, (_, k) => OFFSET + total - k));
  });

  it('a fresh commit after undo clears the redo stack', () => {
    const store = new Store(emptyDesign());
    store.design.scene.brightness = 1.2;
    store.commit();
    store.design.scene.brightness = 1.4;
    store.commit();
    store.undo();
    expect(store.canRedo()).toBe(true);

    store.design.scene.brightness = 1.6;
    store.commit();
    expect(store.canRedo()).toBe(false);
  });
});
