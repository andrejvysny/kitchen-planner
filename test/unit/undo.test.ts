import { describe, expect, it } from 'vitest';
import { catalogDef } from '../../src/model/catalog';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { defaultRoomStyle } from '../../src/model/rooms';
import {
  DESIGN_VERSION,
  defaultScene,
  emptyDesign,
  normalizeDesign,
  Store,
} from '../../src/model/store';
import type { Design, Item, Room } from '../../src/model/types';

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

  it('an immediate commit after undo pushes no new step (normalizeDesign idempotence)', () => {
    // restore() re-derives the design via `normalizeDesign(JSON.parse(json))`
    // rather than replaying the stored string verbatim. If that pass is not
    // byte-idempotent on an already-normalized design, the very next commit()
    // sees a "changed" design and silently pushes a ghost step — one that
    // undoes back to a state that looks identical, costing the user an extra
    // keypress. A real regression here shows as an extra entry on the stack.
    const store = new Store(emptyDesign());
    store.design.scene.brightness = 1.2;
    store.commit();
    store.design.scene.brightness = 1.4;
    store.commit();

    store.undo(); // restore() runs here — back to brightness 1.2
    expect(store.design.scene.brightness).toBe(1.2);
    expect(store.canRedo()).toBe(true);

    store.commit(); // nothing was mutated since restore() — must be a no-op
    expect(store.canRedo()).toBe(true); // a spurious push would have cleared this

    // exactly one step remains (the default-brightness baseline); a ghost
    // push would leave two, and this first undo would land back on 1.2 again
    store.undo();
    expect(store.design.scene.brightness).toBe(1);
    expect(store.canUndo()).toBe(false);
  });
});

/* ---------------- fit-to-room × undo ---------------- */

/** 4 × 3 room whose top wall (id 'Rc0') runs (0,0) → (4,0), inward = +y. */
function rectRoom(id = 'R'): Room {
  return {
    id,
    name: id,
    corners: [
      { id: `${id}c0`, x: 0, y: 0 },
      { id: `${id}c1`, x: 4, y: 0 },
      { id: `${id}c2`, x: 4, y: 3 },
      { id: `${id}c3`, x: 0, y: 3 },
    ],
    style: { ...defaultRoomStyle(), wallThickness: 0.1 },
    wallVisibility: {},
  };
}

/** A design with one room and one unattached, unfitted item on its top wall. */
function fitFixture(): { design: Design; itemId: string; wallId: string } {
  const room = rectRoom();
  const part = presetPart('wardrobe')!;
  const def = toCatalogDef(part);
  const it: Item = {
    id: 'w1',
    defId: 'wardrobe',
    x: 1,
    y: def.d / 2,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    roomId: room.id,
  };
  const design = normalizeDesign({
    version: DESIGN_VERSION,
    rooms: [room],
    openings: [],
    items: [it],
    customParts: [],
    variables: [],
    scene: defaultScene(),
  } as Design);
  return { design, itemId: it.id, wallId: `${room.id}c0` };
}

describe('fit-to-room x undo', () => {
  it('undo restores the pre-resync width after a wall edit resyncs a fitted item', () => {
    const { design, itemId, wallId } = fitFixture();
    const store = new Store(design);

    // `setItemFit` resyncs immediately: the item already spans the 4 m room
    store.setItemFit(itemId, { width: 'walls' });
    store.commit();
    const preResizeW = store.itemById(itemId)?.w;
    expect(preResizeW).toBeCloseTo(4, 6);

    // lengthening the item's own wall widens the alcove it is fitted into —
    // renormalizeRoom's syncDerived() call picks this up with no extra wiring
    store.setWallLength(wallId, 6);
    expect(store.itemById(itemId)?.w).toBeCloseTo(6, 6);
    store.commit();

    store.undo();
    expect(store.itemById(itemId)?.w).toBeCloseTo(preResizeW!, 6);
  });
});

/* ---------------- setItemFit / updateItem flag-clear ---------------- */

describe('store.setItemFit + updateItem flag-clear', () => {
  it('a manual updateItem({ w }) clears fit.width but keeps fit.height', () => {
    const store = new Store(emptyDesign());
    const it = store.addItem(catalogDef('stool'), 0, 0);
    store.setItemFit(it.id, { width: 'walls', height: 'ceiling' });
    expect(store.itemById(it.id)?.fit).toEqual({ width: 'walls', height: 'ceiling' });

    store.updateItem(it.id, { w: 1.2 });
    const after = store.itemById(it.id);
    expect(after?.w).toBe(1.2);
    expect(after?.fit).toEqual({ height: 'ceiling' });
  });

  it('clearing the only remaining fit key deletes `fit` entirely', () => {
    const store = new Store(emptyDesign());
    const it = store.addItem(catalogDef('stool'), 0, 0);
    store.setItemFit(it.id, { width: 'walls' });

    store.updateItem(it.id, { w: 1.0 });
    expect(store.itemById(it.id)?.fit).toBeUndefined();
  });
});
