import { describe, expect, it } from 'vitest';
import { instanceIdsOf, instancesOf } from '../../src/model/partUsage';
import { emptyDesign } from '../../src/model/store';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';

/** A minimal placed item — instancesOf only cares about id + defId. */
function place(design: Design, defId: string): Item {
  const it: Item = {
    id: uid('i'),
    defId,
    x: 0,
    y: 0,
    rotation: 0,
    w: 0.6,
    d: 0.6,
    h: 0.9,
    elevation: 0,
    color: '#ffffff',
  };
  design.items.push(it);
  return it;
}

describe('instancesOf / instanceIdsOf', () => {
  it('is zero/empty for a def with nothing placed', () => {
    const design = emptyDesign();
    expect(instancesOf(design, 'base-cabinet')).toBe(0);
    expect(instanceIdsOf(design, 'base-cabinet')).toEqual([]);
  });

  it('counts exactly the items sharing the def, ignoring others', () => {
    const design = emptyDesign();
    const a = place(design, 'base-cabinet');
    const b = place(design, 'base-cabinet');
    place(design, 'wall-cabinet');
    expect(instancesOf(design, 'base-cabinet')).toBe(2);
    expect(new Set(instanceIdsOf(design, 'base-cabinet'))).toEqual(new Set([a.id, b.id]));
  });

  it('a single instance counts as one', () => {
    const design = emptyDesign();
    const a = place(design, 'my-part-1');
    expect(instancesOf(design, 'my-part-1')).toBe(1);
    expect(instanceIdsOf(design, 'my-part-1')).toEqual([a.id]);
  });
});
