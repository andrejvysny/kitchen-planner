import { describe, expect, it } from 'vitest';
import { presetPart } from '../../src/model/presets';
import { demoDesign, emptyDesign, Store } from '../../src/model/store';
import { newWardrobePart } from '../../src/model/wardrobe';
import type {
  CabinetPartDef,
  ChangeInfo,
  CustomPartDef,
  WardrobePartDef,
} from '../../src/model/types';

/**
 * The three store mutations behind the Part Studio's LIVE-APPLY mode
 * (WS-SPEC WP 3.1): `updateCustomPart` (the write path), `materializePart`
 * (opening a preset shadows it design-locally, decision D4) and
 * `discardPristineShadow` (leaving throws an untouched shadow away again).
 *
 * The studio itself is imperative DOM and this suite runs without jsdom, so
 * these cover the model half; e2e/live-apply.spec.ts drives the editor.
 */

const PRESET_ID = 'base-cabinet';

/** Record every notify a mutation makes, so `structural`/`transient` is checkable. */
function watch(store: Store): ChangeInfo[] {
  const seen: ChangeInfo[] = [];
  store.on('change', (info) => seen.push(info));
  return seen;
}

/** The one custom part `emptyDesign()` starts with (the shared library sample). */
function resident(store: Store): CustomPartDef {
  return store.design.customParts[0];
}

describe('Store.updateCustomPart', () => {
  it('mutates the RESIDENT object in place and notifies structural', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);
    const seen = watch(store);

    expect(store.updateCustomPart(part.id, (p) => (p.name = 'Live'))).toBe(true);
    // same object, not a replacement — the studio holds this reference
    expect(store.customPartById(part.id)).toBe(part);
    expect(part.name).toBe('Live');
    expect(seen).toEqual([{ structural: true, transient: false }]);
  });

  it('carries `transient` through to the notify, for mid-drag ticks', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);
    const seen = watch(store);

    store.updateCustomPart(part.id, (p) => (p.w = 0.7), true);
    expect(seen).toEqual([{ structural: true, transient: true }]);
  });

  it('re-runs sanitizePart, so the clamps hold MID-EDIT', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);

    store.updateCustomPart(part.id, (p) => (p.w = 99));
    // sanitizePart's clamp(w, 0.05, 4.0) — a def the 3D view is already
    // building meshes from cannot be allowed to hold nonsense
    expect(store.customPartById(part.id)!.w).toBe(4);

    store.updateCustomPart(part.id, (p) => (p.name = 'x'.repeat(50)));
    expect(store.customPartById(part.id)!.name).toHaveLength(32);
  });

  it('skips the sanitize on a transient tick, and catches up at gesture end', () => {
    // sanitizing rebuilds leaf objects and re-winds board outlines; doing that
    // at pointer rate would invalidate the editor's own live references
    const store = new Store(emptyDesign());
    const part = resident(store);

    store.updateCustomPart(part.id, (p) => (p.w = 99), true);
    expect(store.customPartById(part.id)!.w).toBe(99);

    store.updateCustomPart(part.id, () => {});
    expect(store.customPartById(part.id)!.w).toBe(4);
  });

  it('refuses an id that is not design-local — a preset is exactly that case', () => {
    const store = new Store(emptyDesign());
    let ran = 0;
    expect(store.updateCustomPart(PRESET_ID, () => ran++)).toBe(false);
    expect(store.updateCustomPart('no-such-part', () => ran++)).toBe(false);
    expect(ran).toBe(0);
    expect(presetPart(PRESET_ID)!.name).toBe('Base cabinet'); // preset untouched
  });

  it('does NOT commit — the caller owns the undo step', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);
    expect(store.canUndo()).toBe(false);

    store.updateCustomPart(part.id, (p) => (p.name = 'A'));
    store.updateCustomPart(part.id, (p) => (p.name = 'B'));
    expect(store.canUndo()).toBe(false);

    store.commit();
    expect(store.canUndo()).toBe(true);
    store.undo();
    // one gesture, one step: both writes went back together
    expect(store.customPartById(part.id)!.name).not.toBe('B');
  });

  it('a placed instance resolves through to the edit at once', () => {
    const store = new Store(demoDesign());
    const part = resident(store);
    const item = store.addItem(store.defOf(part.id), 1, 1);

    store.updateCustomPart(part.id, (p) => (p.h = 1.1));
    expect(store.partOf(store.itemById(item.id)!.defId)!.h).toBeCloseTo(1.1, 12);
  });
});

describe('applyCustomPart — light reseed', () => {
  /** A design-local wardrobe plus one placed instance of it. */
  function placedWardrobe(): { store: Store; partId: string; itemId: string } {
    const store = new Store(demoDesign());
    const part = newWardrobePart();
    store.upsertCustomPart(part);
    const item = store.addItem(store.defOf(part.id), 1, 1);
    return { store, partId: part.id, itemId: item.id };
  }

  it('seeds `item.light` on every instance when the def GAINS a cove light', () => {
    const { store, partId, itemId } = placedWardrobe();
    expect(store.itemById(itemId)!.light).toBeUndefined();

    store.updateCustomPart(
      partId,
      (p) => ((p as WardrobePartDef).light = { cove: true, shelves: false })
    );

    // else switching the cove on after placement would leave the wardrobes dark
    expect(store.itemById(itemId)!.light).toEqual({ on: true, intensity: 0.5, warmth: 0.75 });
  });

  it('drops `item.light` again when the def LOSES it', () => {
    const { store, partId, itemId } = placedWardrobe();
    store.updateCustomPart(
      partId,
      (p) => ((p as WardrobePartDef).light = { cove: true, shelves: false })
    );
    store.updateCustomPart(
      partId,
      (p) => ((p as WardrobePartDef).light = { cove: false, shelves: false })
    );

    // no stranded <LightSection/> for a fixture that is gone
    expect(store.itemById(itemId)!.light).toBeUndefined();
  });

  it('keeps a per-instance light the user has already tuned', () => {
    const { store, partId, itemId } = placedWardrobe();
    store.updateCustomPart(
      partId,
      (p) => ((p as WardrobePartDef).light = { cove: true, shelves: false })
    );
    store.updateItem(itemId, { light: { on: false, intensity: 0.9, warmth: 0.2 } });

    store.updateCustomPart(partId, (p) => (p.name = 'Alcove run'));
    expect(store.itemById(itemId)!.light).toEqual({ on: false, intensity: 0.9, warmth: 0.2 });
  });

  it('leaves instances of OTHER parts alone', () => {
    const { store, partId } = placedWardrobe();
    const other = store.addItem(store.defOf(PRESET_ID), 2, 2);

    store.updateCustomPart(
      partId,
      (p) => ((p as WardrobePartDef).light = { cove: true, shelves: false })
    );
    expect(store.itemById(other.id)!.light).toBeUndefined();
  });
});

describe('Store.materializePart', () => {
  it('shadows a preset design-locally under the SAME id', () => {
    const store = new Store(emptyDesign());
    const preset = presetPart(PRESET_ID)!;
    const n = store.design.customParts.length;

    const shadow = store.materializePart(preset);
    expect(shadow.id).toBe(PRESET_ID);
    expect(shadow).not.toBe(preset); // the preset is deep-frozen; this is a copy
    expect(JSON.parse(JSON.stringify(shadow))).toEqual(JSON.parse(JSON.stringify(preset)));
    expect(store.design.customParts).toHaveLength(n + 1);
    expect(store.customPartById(PRESET_ID)).toBe(shadow);
    // …and the shadow is now what the whole design resolves that id to
    expect(store.partOf(PRESET_ID)).toBe(shadow);
  });

  it('is idempotent: a resident part comes back untouched, never duplicated', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);
    part.name = 'Mine';

    expect(store.materializePart(part)).toBe(part);
    expect(store.materializePart(presetPart(PRESET_ID)!)).toBe(
      store.materializePart(presetPart(PRESET_ID)!)
    );
    expect(store.design.customParts.filter((p) => p.id === PRESET_ID)).toHaveLength(1);
    expect(store.customPartById(part.id)!.name).toBe('Mine');
  });

  it('costs no undo step — merely opening a preset is not an edit', () => {
    const store = new Store(emptyDesign());
    store.materializePart(presetPart(PRESET_ID)!);
    expect(store.canUndo()).toBe(false);
  });

  it('makes placed instances of the preset follow the shadow', () => {
    const store = new Store(demoDesign());
    const item = store.addItem(store.defOf(PRESET_ID), 1, 1);
    const shadow = store.materializePart(presetPart(PRESET_ID)!) as CabinetPartDef;

    store.updateCustomPart(PRESET_ID, (p) => (p.w = 0.8));
    expect(store.itemById(item.id)!.defId).toBe(PRESET_ID); // no fork
    expect(store.partOf(item.defId)).toBe(shadow);
    expect(store.partOf(item.defId)!.w).toBeCloseTo(0.8, 12);
  });
});

describe('Store.discardPristineShadow', () => {
  it('removes an UNTOUCHED shadow and leaves the instances resolving to the preset', () => {
    const store = new Store(demoDesign());
    const item = store.addItem(store.defOf(PRESET_ID), 1, 1);
    store.commit();
    const items = store.design.items.length;

    store.materializePart(presetPart(PRESET_ID)!);
    expect(store.discardPristineShadow(PRESET_ID)).toBe(true);
    expect(store.customPartById(PRESET_ID)).toBeUndefined();
    // NOT deleteCustomPart: nothing placed goes with it
    expect(store.design.items).toHaveLength(items);
    expect(store.partOf(store.itemById(item.id)!.defId)).toBe(presetPart(PRESET_ID));
  });

  it('keeps a shadow that was actually EDITED', () => {
    const store = new Store(emptyDesign());
    store.materializePart(presetPart(PRESET_ID)!);
    store.updateCustomPart(PRESET_ID, (p) => (p.name = 'My base cabinet'));

    expect(store.discardPristineShadow(PRESET_ID)).toBe(false);
    expect(store.customPartById(PRESET_ID)!.name).toBe('My base cabinet');
  });

  it('never touches a part that shadows no preset', () => {
    const store = new Store(emptyDesign());
    const part = resident(store);
    expect(store.discardPristineShadow(part.id)).toBe(false);
    expect(store.discardPristineShadow('no-such-part')).toBe(false);
    expect(store.customPartById(part.id)).toBe(part);
  });

  it('open-then-leave untouched costs NOTHING: the commit dedupes to a no-op', () => {
    // the studio's whole round trip — materialize on open, discard on close —
    // must leave the undo stack exactly where it found it
    const store = new Store(emptyDesign());
    store.commit();
    const depth = store.canUndo();

    store.materializePart(presetPart(PRESET_ID)!);
    expect(store.discardPristineShadow(PRESET_ID)).toBe(true);
    store.commit();

    expect(store.canUndo()).toBe(depth);
    expect(store.customPartById(PRESET_ID)).toBeUndefined();
  });

  it('open-then-EDIT-then-leave keeps the shadow', () => {
    const store = new Store(emptyDesign());
    store.materializePart(presetPart(PRESET_ID)!);
    store.updateCustomPart(PRESET_ID, (p) => (p.h = 0.95));
    store.commit();

    expect(store.discardPristineShadow(PRESET_ID)).toBe(false);
    expect(store.customPartById(PRESET_ID)!.h).toBeCloseTo(0.95, 12);
  });
});
