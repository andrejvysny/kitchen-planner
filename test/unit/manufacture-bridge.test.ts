import { describe, expect, it } from 'vitest';
import { catalogDef, defaultParams, type CatalogDef } from '../../src/model/catalog';
import type { Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { emptyDesign } from '../../src/model/store';
import { bridgeItem, COUNTER_T } from '../../src/model/manufacture/catalogBridge';

const design = emptyDesign();

function item(defId: string, patch: Partial<Item> = {}): Item {
  const def: CatalogDef = catalogDef(defId);
  return {
    id: uid('i'),
    defId,
    x: 1,
    y: 1,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    params: defaultParams(def),
    ...patch,
  };
}

const COUNTER_KINDS = new Set(['baseCabinet', 'baseDrawers', 'sink', 'hob', 'oven', 'island']);
const APPLIANCE_ONLY = ['fridge', 'dishwasher', 'hood'];
const NULL_IDS = ['door', 'window', 'water', 'outlet', 'pendant', 'spot', 'strip', 'table', 'chair', 'stool'];
const MAPPED = [
  'base-cabinet',
  'base-drawers',
  'base-sink',
  'base-hob',
  'base-oven',
  'island',
  'pantry',
  'oven-tower',
  'wall-cabinet',
  'wall-shelf',
  'backsplash',
  'wood-plane',
];

describe('catalog → panel bridge', () => {
  it('bridged outer dims equal the item dims (counter kinds carry the carcass under the slab)', () => {
    for (const id of MAPPED) {
      const it = item(id);
      const b = bridgeItem(design, it)!;
      expect(b, id).not.toBeNull();
      expect(b.dims.w, `${id} w`).toBeCloseTo(it.w);
      expect(b.dims.d, `${id} d`).toBeCloseTo(it.d);
      const kind = catalogDef(id).kind;
      if (COUNTER_KINDS.has(kind)) {
        expect(b.dims.h + COUNTER_T, `${id} h+counter`).toBeCloseTo(it.h);
        expect(b.worktop, `${id} worktop flag`).toBe(true);
      } else {
        expect(b.dims.h, `${id} h`).toBeCloseTo(it.h);
        expect(b.worktop, `${id} worktop flag`).toBe(false);
      }
    }
  });

  it('null for lights, furniture, markers and openings', () => {
    for (const id of NULL_IDS) {
      expect(bridgeItem(design, item(id)), id).toBeNull();
    }
  });

  it('appliances-only kinds produce an appliance entry, no part', () => {
    for (const id of APPLIANCE_ONLY) {
      const b = bridgeItem(design, item(id))!;
      expect(b.part, id).toBeNull();
      expect(b.panels, id).toBeUndefined();
      expect(b.appliance, id).toHaveLength(1);
      expect(b.appliance![0].kind, id).toBe(catalogDef(id).kind);
    }
  });

  it('base cabinet respects the doors param (1 → door, 2 → doorPair)', () => {
    const one = bridgeItem(design, item('base-cabinet', { params: { doors: 1 } }))!;
    expect(one.part!.face).toEqual({ kind: 'leaf', fill: 'door' });
    const two = bridgeItem(design, item('base-cabinet', { params: { doors: 2 } }))!;
    expect(two.part!.face).toEqual({ kind: 'leaf', fill: 'doorPair' });
  });

  it('drawer unit respects the drawers param', () => {
    const b = bridgeItem(design, item('base-drawers', { params: { drawers: 4 } }))!;
    expect(b.part!.face).toEqual({ kind: 'leaf', fill: 'drawers', drawers: 4 });
  });

  it('wall cabinet: 3 doors become a 3-way vertical split, no plinth', () => {
    const b = bridgeItem(design, item('wall-cabinet', { params: { doors: 3 } }))!;
    const face = b.part!.face;
    expect(face.kind).toBe('split');
    if (face.kind === 'split') {
      expect(face.dir).toBe('v');
      expect(face.children).toHaveLength(3);
      expect(face.children.every((c) => c.kind === 'leaf' && c.fill === 'door')).toBe(true);
    }
    expect(b.part!.plinth).toBe(false);
  });

  it('pantry sections + door count mirror the builder', () => {
    const wide = bridgeItem(design, item('pantry', { w: 0.9, params: { split: 3 } }))!;
    const face = wide.part!.face;
    expect(face.kind).toBe('split');
    if (face.kind === 'split') {
      expect(face.children).toHaveLength(3);
      // w > 0.75 ⇒ two doors per section
      expect(face.children.every((c) => c.kind === 'leaf' && c.fill === 'doorPair')).toBe(true);
    }
    const narrow = bridgeItem(design, item('pantry', { w: 0.6, params: { split: 1 } }))!;
    expect(narrow.part!.face).toEqual({ kind: 'leaf', fill: 'door' });
  });

  it('sink: door front, false-front note and a bowl-cutout appliance', () => {
    const b = bridgeItem(design, item('base-sink'))!;
    expect(b.part!.face).toEqual({ kind: 'leaf', fill: 'door' });
    expect(b.note).toMatch(/false front/i);
    expect(b.appliance).toHaveLength(1);
    expect(b.appliance![0].note).toMatch(/cutout/i);
  });

  it('hob: drawers front + hob-cutout appliance', () => {
    const b = bridgeItem(design, item('base-hob'))!;
    expect(b.part!.face).toEqual({ kind: 'leaf', fill: 'drawers', drawers: 2 });
    expect(b.appliance![0].note).toMatch(/hob cutout/i);
  });

  it('oven: door + appliance bay with a 600×600 niche note', () => {
    const b = bridgeItem(design, item('base-oven'))!;
    const face = b.part!.face;
    expect(face.kind).toBe('split');
    if (face.kind === 'split') {
      expect(face.dir).toBe('h');
      expect(face.children[0]).toEqual({ kind: 'leaf', fill: 'door' });
      expect(face.children[1]).toEqual({ kind: 'leaf', fill: 'open', shelves: 0 });
    }
    expect(b.appliance![0].note).toMatch(/600×600/);
  });

  it('oven tower: N appliance bays produce N appliance rows and N+1 dividers worth of splits', () => {
    const b = bridgeItem(design, item('oven-tower', { params: { appliances: 3 } }))!;
    expect(b.appliance).toHaveLength(3);
    const face = b.part!.face;
    if (face.kind === 'split') expect(face.children).toHaveLength(5); // door + 3 bays + door
  });

  it('open shelves and slab kinds carry a direct panel list, no part', () => {
    const shelf = bridgeItem(design, item('wall-shelf', { params: { shelves: 3 } }))!;
    expect(shelf.part).toBeNull();
    expect(shelf.panels).toHaveLength(3);
    expect(shelf.panels!.every((p) => p.role === 'shelf')).toBe(true);

    const bs = bridgeItem(design, item('backsplash'))!;
    expect(bs.part).toBeNull();
    expect(bs.panels).toHaveLength(1);
    expect(bs.panels![0].role).toBe('board');
  });
});
