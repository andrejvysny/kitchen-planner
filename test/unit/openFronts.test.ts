import { describe, expect, it } from 'vitest';
import { OpenFronts } from '../../src/model/openFronts';
import { emptyDesign, Store } from '../../src/model/store';

describe('OpenFronts (ephemeral view state)', () => {
  it('toggles individual fronts and notifies', () => {
    const of = new OpenFronts();
    let notified = 0;
    of.onChange = () => notified++;
    expect(of.isOpen('i1', 'z0.front0')).toBe(false);
    of.toggle('i1', 'z0.front0');
    expect(of.isOpen('i1', 'z0.front0')).toBe(true);
    expect(of.isOpen('i1', 'z1.front0')).toBe(false);
    of.toggle('i1', 'z0.front0');
    expect(of.isOpen('i1', 'z0.front0')).toBe(false);
    expect(notified).toBe(2);
  });

  it('setAll opens everything; toggling then closes exactly that front', () => {
    const of = new OpenFronts();
    of.setAll(true);
    expect(of.allOpen).toBe(true);
    expect(of.isOpen('i1', 'a')).toBe(true);
    const units = [
      { itemId: 'i1', unit: 'a' },
      { itemId: 'i1', unit: 'b' },
      { itemId: 'i2', unit: 'a' },
    ];
    of.toggle('i1', 'a', () => units);
    expect(of.allOpen).toBe(false);
    expect(of.isOpen('i1', 'a')).toBe(false); // exactly the touched one closed
    expect(of.isOpen('i1', 'b')).toBe(true);
    expect(of.isOpen('i2', 'a')).toBe(true);
  });

  it('undo clears poses exactly like replaceDesign', () => {
    const store = new Store(emptyDesign());
    const item = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.commit();
    store.openFronts.toggle(item.id, 'z0.front0');
    store.undo(); // design swap — a stale pose must not survive it
    expect(store.openFronts.isOpen(item.id, 'z0.front0')).toBe(false);
  });

  it('clear resets everything', () => {
    const of = new OpenFronts();
    of.toggle('i1', 'a');
    of.setAll(true);
    of.clear();
    expect(of.allOpen).toBe(false);
    expect(of.isOpen('i1', 'a')).toBe(false);
  });
});
