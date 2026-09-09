import { describe, expect, it } from 'vitest';
import { DIM_LIMITS } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { defaultRoomStyle } from '../../src/model/rooms';
import { DESIGN_VERSION, defaultScene, normalizeDesign, Store } from '../../src/model/store';
import { newWardrobePart } from '../../src/model/wardrobe';
import type { CustomPartDef, Design, Item, Room, WardrobePartDef } from '../../src/model/types';

/**
 * `Store.adoptItemDims` — the Workshop's on-the-way-in reconciliation (P4).
 *
 * A wardrobe is BUILT-IN furniture: `addItem` seeds `item.fit`, so the placed
 * instance takes its width from the wall segment it landed in while the DEF
 * still carries its catalog width. The column canvas draws the def, so without
 * this the editor lays a 3.0 m run out for a 4.0 m wardrobe and the entire
 * delta hides in the one `'fill'` column. These cases pin the four rules the
 * method's doc comment states, plus the two properties that keep the caller's
 * retarget loop finite: the write is CLAMPED up front, and adopting twice is a
 * no-op.
 */

const FITTED = 'wardrobe-fitted'; // presets.ts — w 3.0, d 0.6, h 2.4
const CABINET = 'base-cabinet'; // a cabinet preset: out of scope
const BOUGHT = 'fridge'; // a catalog product: no part def at all

/** 4 × 3 room whose TOP wall runs (0,0) → (4,0); ceiling 2.6. */
function rectRoom(): Room {
  const pts: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];
  return {
    id: 'A',
    name: 'A',
    corners: pts.map(([x, y], i) => ({ id: `Ac${i}`, x, y })),
    style: { ...defaultRoomStyle(), wallThickness: 0.1 },
  };
}

/** A store on that one room, with an explicit (usually empty) parts library. */
function store(parts: CustomPartDef[] = []): Store {
  return new Store(
    normalizeDesign({
      version: DESIGN_VERSION,
      rooms: [rectRoom()],
      openings: [],
      items: [],
      customParts: parts,
      variables: [],
      scene: defaultScene(),
    } as Design)
  );
}

const place = (st: Store, defId: string, x: number, y: number): Item =>
  st.addItem(st.defOf(defId), x, y, 0);

/** Back flush on the top wall at d/2, so `syncFits` measures it to the alcove. */
const placeOnWall = (st: Store, defId: string, x = 2): Item => place(st, defId, x, 0.3);

/** Mid-room and deliberately UNFITTED, so the item's dims are exactly what we set. */
function placeLoose(st: Store, defId: string, patch: Partial<Item>, x = 2): Item {
  const it = place(st, defId, x, 1.5);
  st.setItemFit(it.id, undefined);
  st.updateItem(it.id, patch);
  return it;
}

const partOf = (st: Store, defId: string): WardrobePartDef => st.partOf(defId) as WardrobePartDef;

describe('Store.adoptItemDims', () => {
  it('materializes a single-instance preset and writes the instance w/d/h into it', () => {
    const st = store();
    const it = placeOnWall(st, FITTED);
    st.commit();

    // the placement fitted it to the full 4 m alcove and the 2.6 m ceiling
    expect(it.w).toBeCloseTo(4, 6);
    expect(it.h).toBeCloseTo(2.6, 6);
    expect(st.customPartById(FITTED)).toBeUndefined(); // no shadow yet

    expect(st.adoptItemDims(it.id)).toEqual({ defId: FITTED, changed: true });

    // shadowed design-locally under the SAME id (decision D4), at the true size
    const shadow = st.customPartById(FITTED) as WardrobePartDef;
    expect(shadow.w).toBeCloseTo(it.w, 9);
    expect(shadow.d).toBeCloseTo(it.d, 9);
    expect(shadow.h).toBeCloseTo(it.h, 9);
    expect(st.itemById(it.id)!.defId).toBe(FITTED); // no fork: one instance
    expect(presetPart(FITTED)!.w).toBeCloseTo(3.0, 9); // the preset itself is untouched
  });

  it('leaves `elevation` alone — off-floor height is instance state, not the part', () => {
    const st = store();
    const it = placeOnWall(st, FITTED);
    st.updateItem(it.id, { elevation: 0.15 });
    st.commit();

    st.adoptItemDims(it.id);
    expect(partOf(st, FITTED).elevation).toBeCloseTo(presetPart(FITTED)!.elevation, 9);
    expect(st.itemById(it.id)!.elevation).toBeCloseTo(0.15, 9);
  });

  it('a second open adopts NOTHING: no fork, no write, no undo step', () => {
    const st = store();
    const it = placeOnWall(st, FITTED);
    st.commit();
    st.adoptItemDims(it.id);
    st.commit();

    const json = JSON.stringify(st.design);
    expect(st.adoptItemDims(it.id)).toEqual({ defId: FITTED, changed: false });
    expect(JSON.stringify(st.design)).toBe(json);
    st.commit();
    expect(JSON.stringify(st.design)).toBe(json); // the commit deduped to a no-op
  });

  it('the whole adopt is ONE undo step, and it does not swallow the placement', () => {
    const st = store();
    const it = placeOnWall(st, FITTED);
    st.commit();
    const partsBefore = JSON.stringify(st.design.customParts);

    st.adoptItemDims(it.id);
    st.commit();
    expect(JSON.stringify(st.design.customParts)).not.toBe(partsBefore);

    st.undo();
    expect(JSON.stringify(st.design.customParts)).toBe(partsBefore);
    expect(st.design.items).toHaveLength(1); // ...and the wardrobe is still placed
  });

  it('a SHARED def forks, and the other instance keeps the original width', () => {
    const shared = newWardrobePart(); // w 2, d 0.6, h 2.4
    const st = store([shared]);
    const a = placeLoose(st, shared.id, { w: 1.9, h: 2.2 }, 1);
    const b = placeLoose(st, shared.id, { w: 2.5, h: 2.3 }, 3);
    st.commit();

    const res = st.adoptItemDims(a.id)!;
    expect(res.changed).toBe(true);
    expect(res.defId).not.toBe(shared.id);

    // only the item that opened the studio moved onto the fork
    expect(st.itemById(a.id)!.defId).toBe(res.defId);
    expect(st.itemById(b.id)!.defId).toBe(shared.id);

    const fork = partOf(st, res.defId);
    expect(fork.w).toBeCloseTo(1.9, 9);
    expect(fork.h).toBeCloseTo(2.2, 9);
    // the twin's def is exactly where it was — 1.9 did not leak into it
    expect(partOf(st, shared.id).w).toBeCloseTo(2, 9);
    expect(partOf(st, shared.id).h).toBeCloseTo(2.4, 9);
    expect(st.itemById(b.id)!.w).toBeCloseTo(2.5, 9);
  });

  it('an instance already at the def size changes nothing and leaves no shadow', () => {
    const st = store();
    const def = presetPart(FITTED)!;
    const it = placeLoose(st, FITTED, { w: def.w, d: def.d, h: def.h });
    st.commit();

    expect(st.adoptItemDims(it.id)).toEqual({ defId: FITTED, changed: false });
    expect(st.customPartById(FITTED)).toBeUndefined();
  });

  it('is gated to wardrobes — a cabinet instance is refused outright', () => {
    const st = store();
    const it = placeOnWall(st, CABINET, 1);
    st.updateItem(it.id, { w: 1.1 });
    expect(st.adoptItemDims(it.id)).toBeNull();
    expect(st.customPartById(CABINET)).toBeUndefined();
  });

  it('returns null for a bought product and for an id that names no item', () => {
    const st = store();
    const it = placeOnWall(st, BOUGHT, 1);
    expect(st.adoptItemDims(it.id)).toBeNull();
    expect(st.adoptItemDims('no-such-item')).toBeNull();
  });

  it('clamps ONE WAY — the part takes the limit, the item is never written back', () => {
    const st = store();
    const max = DIM_LIMITS.wardrobe.w[1];
    const it = placeLoose(st, FITTED, { w: max + 3 });
    st.commit();

    expect(st.adoptItemDims(it.id)).toEqual({ defId: FITTED, changed: true });
    expect(partOf(st, FITTED).w).toBeCloseTo(max, 9);
    expect(st.itemById(it.id)!.w).toBeCloseTo(max + 3, 9);

    // ...and that is a FIXED POINT: without the up-front clamp the gate would
    // never match and WorkshopPane's retarget would loop forever
    expect(st.adoptItemDims(it.id)).toEqual({ defId: FITTED, changed: false });
  });

  it('does not disturb the fit: the instance keeps the width its wall gave it', () => {
    const st = store();
    const it = placeOnWall(st, FITTED);
    st.commit();
    const before = { w: it.w, h: it.h, x: it.x, y: it.y };

    st.adoptItemDims(it.id);

    // `updateCustomPart` re-runs syncFits; a fitted item's size comes from the
    // wall segment, never from `part.w`, so the write settles where it landed
    const after = st.itemById(it.id)!;
    expect(after.w).toBeCloseTo(before.w, 9);
    expect(after.h).toBeCloseTo(before.h, 9);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(after.fit).toEqual({ width: 'walls', height: 'ceiling' });
  });
});
