import { describe, expect, it } from 'vitest';
import { CATALOG, defaultParams, type CatalogDef } from '../../src/model/catalog';
import { samplePart, toCatalogDef } from '../../src/model/parts';
import type { Item, RoomStyle } from '../../src/model/types';
import { buildItemGroup } from '../../src/view3d/itemMeshes';

const ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

function itemFor(def: CatalogDef, params?: Record<string, number>): Item {
  return {
    id: `t_${def.id}`,
    defId: def.id,
    x: 0,
    y: 0,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    light: def.light
      ? { on: def.light.on, intensity: def.light.intensity, warmth: def.light.warmth }
      : undefined,
    params: params ?? defaultParams(def),
  };
}

// every mesh builder runs headless — a throwing builder fails here instead of in the browser
describe('mesh builders', () => {
  const defs = CATALOG.flatMap((s) => s.items).filter((d) => !d.opening);

  for (const def of defs) {
    it(`builds ${def.id} (defaults, min and max params)`, () => {
      const variants: (Record<string, number> | undefined)[] = [defaultParams(def)];
      if (def.params?.length) {
        variants.push(Object.fromEntries(def.params.map((p) => [p.key, p.min])));
        variants.push(Object.fromEntries(def.params.map((p) => [p.key, p.max])));
      }
      for (const params of variants) {
        const group = buildItemGroup(itemFor(def, params), def, ROOM, undefined);
        expect(group.children.length).toBeGreaterThan(0);
      }
    });
  }

  it('builds custom parts for both templates', () => {
    const part = samplePart();
    for (const template of ['cabinet', 'desk'] as const) {
      const p = { ...part, template };
      const def = toCatalogDef(p);
      const group = buildItemGroup(itemFor(def, { ...p.options }), def, ROOM, p);
      expect(group.children.length).toBeGreaterThan(0);
    }
  });
});
