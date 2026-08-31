import { describe, expect, it } from 'vitest';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { newWardrobePart } from '../../src/model/wardrobe';
import type { WardrobePartDef } from '../../src/model/types';

/**
 * A wardrobe's cove strip is a REAL fixture, and `toCatalogDef` is where that
 * becomes true for the rest of the app: `def.light` is what makes `addItem`
 * seed `item.light`, `<LightSection/>` show up in the inspector and View3D
 * build a source. The strip's emissive mesh comes from the panel list either
 * way — this is only about whether the light is LIVE.
 *
 * `local` is the custom-part discriminator: the catalog strip has none and
 * keeps `lightLocalY`, a wardrobe carries its own item-local position under
 * the top front edge.
 */

function wardrobe(light?: WardrobePartDef['light']): WardrobePartDef {
  const part = newWardrobePart();
  part.w = 2;
  part.d = 0.6;
  part.h = 2.4;
  if (light) part.light = light;
  return part;
}

describe('toCatalogDef — wardrobe cove light', () => {
  it('declares a bar light with an item-local source when the def asks for a cove', () => {
    const def = toCatalogDef(wardrobe({ cove: true, shelves: false }));

    expect(def.light).toEqual({
      kind: 'bar',
      on: true,
      intensity: 0.5,
      warmth: 0.75,
      local: { y: 2.4 - 0.06, z: 0.6 / 2 - 0.06 },
    });
  });

  it('tracks the part dimensions — the strip sits at the top front edge', () => {
    const part = wardrobe({ cove: true, shelves: true });
    part.h = 2.7;
    part.d = 0.5;

    const local = toCatalogDef(part).light!.local!;
    expect(local.y).toBeCloseTo(2.64, 12);
    expect(local.z).toBeCloseTo(0.19, 12);
  });

  it('stays dark without a cove: no light at all, shelf lights included', () => {
    expect(toCatalogDef(wardrobe()).light).toBeUndefined();
    expect(toCatalogDef(wardrobe({ cove: false, shelves: false })).light).toBeUndefined();
    // shelf strips are interior detail, not a room fixture
    expect(toCatalogDef(wardrobe({ cove: false, shelves: true })).light).toBeUndefined();
  });

  it('never fires for the other part types', () => {
    for (const id of ['base-cabinet', 'wall-cabinet']) {
      expect(toCatalogDef(presetPart(id)!).light).toBeUndefined();
    }
  });
});
