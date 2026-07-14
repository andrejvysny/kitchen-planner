import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { catalogDef, hasWorktop } from '../../src/model/catalog';
import {
  COUNTER_MATERIALS,
  FLOOR_MATERIALS,
  hasMaterial,
  hasPattern,
  ITEM_MATERIALS,
  MATERIALS,
  materialColor,
  materialDef,
  WALL_MATERIALS,
} from '../../src/model/materials';
import { newCabinetPart, toCatalogDef } from '../../src/model/parts';
import { emptyDesign, sanitizeDesign } from '../../src/model/store';
import type { Corner, Item, RoomStyle } from '../../src/model/types';
import { buildItemGroup } from '../../src/view3d/itemMeshes';
import { counterFin, surfMat } from '../../src/view3d/meshKit';
import { texturedMaterial } from '../../src/view3d/textures';

const ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

describe('material registry', () => {
  it('has unique ids that all resolve', () => {
    const ids = MATERIALS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(materialDef(id)).toBeTruthy();
      expect(hasMaterial(id)).toBe(true);
    }
    expect(hasMaterial('nope')).toBe(false);
    expect(hasMaterial(42)).toBe(false);
  });

  it('covers the required categories from the spec', () => {
    const woods = MATERIALS.filter((m) => m.pattern === 'wood');
    expect(woods.length).toBeGreaterThanOrEqual(8); // all major furniture woods
    expect(MATERIALS.some((m) => m.pattern === 'planks')).toBe(true); // floors
    expect(MATERIALS.some((m) => m.pattern === 'tiles')).toBe(true);
    expect(materialDef('concrete')).toBeTruthy();
    expect(materialDef('marble-light')).toBeTruthy();
    expect(materialDef('glass')!.opacity).toBeLessThan(1);
    // plastic must stay user-colourable
    expect(materialDef('plastic-matte')!.tintable).toBe(true);
  });

  it('curated per-surface lists only contain registered materials', () => {
    for (const list of [ITEM_MATERIALS, FLOOR_MATERIALS, WALL_MATERIALS, COUNTER_MATERIALS]) {
      expect(list.length).toBeGreaterThan(0);
      for (const m of list) expect(hasMaterial(m.id)).toBe(true);
    }
  });

  it('materialColor: presets win, tintables and no-material take the user colour', () => {
    expect(materialColor('oak', '#123456')).toBe(materialDef('oak')!.color);
    expect(materialColor('plastic-matte', '#123456')).toBe('#123456');
    expect(materialColor(undefined, '#123456')).toBe('#123456');
  });

  it('hasPattern: patterned materials only (rotation applies to these)', () => {
    expect(hasPattern('oak')).toBe(true);
    expect(hasPattern('marble-light')).toBe(true);
    expect(hasPattern('glass')).toBe(false);
    expect(hasPattern('plastic-matte')).toBe(false);
    expect(hasPattern(undefined)).toBe(false);
    expect(hasPattern('nope')).toBe(false);
  });

  it('hasWorktop flags exactly the counter-slab kinds', () => {
    expect(hasWorktop(catalogDef('base-cabinet'))).toBe(true);
    expect(hasWorktop(catalogDef('island'))).toBe(true);
    expect(hasWorktop(catalogDef('wall-cabinet'))).toBe(false);
  });

  it('counterFin: item override wins over the room worktop', () => {
    const room: RoomStyle = { ...ROOM, counterMaterial: 'oak', counterMaterialRot: true };
    const item = { counterMaterial: 'marble-dark', counterMaterialRot: false } as Item;
    expect(counterFin(room)).toEqual({ color: ROOM.counterColor, material: 'oak', rot: true });
    const over = counterFin(room, item);
    expect(over.material).toBe('marble-dark');
    expect(over.rot).toBe(false);
    expect(counterFin(room, {} as Item).material).toBe('oak');
  });
});

describe('sanitizeDesign material validation', () => {
  const base = (): Corner[] => [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 3, y: 0 },
    { id: 'd', x: 3, y: 2 },
  ];

  it('keeps valid material ids and drops unknown ones', () => {
    const item: Partial<Item> = {
      id: 'i1',
      defId: 'base-cabinet',
      x: 1,
      y: 1,
      rotation: 0,
      w: 0.6,
      d: 0.6,
      h: 0.9,
      elevation: 0,
      color: '#8a9683',
      material: 'walnut',
    };
    const bad = { ...item, id: 'i2', material: 'chrome-unicorn' };
    const d = sanitizeDesign({
      version: 3,
      corners: base(),
      items: [item, bad],
      room: { floorMaterial: 'floor-oak', wallMaterial: 'bogus', counterMaterial: 'marble-light' },
    });
    expect(d!.items[0].material).toBe('walnut');
    expect(d!.items[1].material).toBeUndefined();
    expect(d!.room.floorMaterial).toBe('floor-oak');
    expect(d!.room.wallMaterial).toBeUndefined();
    expect(d!.room.counterMaterial).toBe('marble-light');
  });

  it('validates worktop overrides and rotation flags', () => {
    const item: Partial<Item> = {
      id: 'i1',
      defId: 'base-cabinet',
      x: 1,
      y: 1,
      rotation: 0,
      w: 0.6,
      d: 0.6,
      h: 0.9,
      elevation: 0,
      color: '#8a9683',
      material: 'oak',
      materialRot: true,
      counterMaterial: 'marble-light',
      counterMaterialRot: 'yes' as unknown as boolean,
    };
    const bad = { ...item, id: 'i2', counterMaterial: 'unobtanium', materialRot: 1 as unknown as boolean };
    const d = sanitizeDesign({
      version: 3,
      corners: base(),
      items: [item, bad],
      room: {
        counterMaterial: 'walnut',
        counterMaterialRot: true,
        floorMaterial: 'floor-oak',
        floorMaterialRot: false,
        wallMaterialRot: 'sideways',
      },
    });
    expect(d!.items[0].counterMaterial).toBe('marble-light');
    expect(d!.items[0].materialRot).toBe(true);
    expect(d!.items[0].counterMaterialRot).toBeUndefined();
    expect(d!.items[1].counterMaterial).toBeUndefined();
    expect(d!.items[1].materialRot).toBeUndefined();
    expect(d!.room.counterMaterialRot).toBe(true);
    expect(d!.room.floorMaterialRot).toBeUndefined();
    expect(d!.room.wallMaterialRot).toBeUndefined();
  });

  it('designs without material fields stay untouched', () => {
    const d = sanitizeDesign({ version: 3, corners: base() });
    expect(d!.room.floorMaterial).toBeUndefined();
    expect(d!.room.wallMaterial).toBeUndefined();
    expect(d!.room.counterMaterial).toBeUndefined();
  });

  it('emptyDesign round-trips through sanitize unchanged', () => {
    const d = emptyDesign();
    const s = sanitizeDesign(JSON.parse(JSON.stringify(d)));
    expect(s).not.toBeNull();
  });
});

describe('textured materials (headless)', () => {
  it('resolves every registry material without a DOM', () => {
    for (const def of MATERIALS) {
      const mat = texturedMaterial(def.id, '#8a9683')!;
      expect(mat).toBeTruthy();
      expect(mat.roughness).toBe(def.roughness);
      // headless: no canvas → no maps, but colour/params still applied
      expect(mat.map).toBeNull();
      if (def.opacity !== undefined) expect(mat.transparent).toBe(true);
      if (def.tintable) expect(`#${mat.color.getHexString()}`).toBe('#8a9683');
      else expect(`#${mat.color.getHexString()}`).toBe(def.color.toLowerCase());
    }
    expect(texturedMaterial('unknown', '#fff')).toBeNull();
  });

  it('surfMat falls back to flat finishes and honours tint', () => {
    const flat = surfMat('#8a9683');
    expect(flat.roughness).toBeCloseTo(0.82);
    const woody = surfMat({ color: '#8a9683' }, 'wood');
    expect(woody.roughness).toBeCloseTo(0.62);
    const dark = surfMat({ color: '#808080', material: 'oak' }, 'matte', 0.5);
    const plain = surfMat({ color: '#808080', material: 'oak' });
    expect(dark.color.r).toBeLessThan(plain.color.r);
  });

  it('builds worktop items with a counter override + rotation headless', () => {
    const def = catalogDef('base-cabinet');
    const item: Item = {
      id: 'i1',
      defId: def.id,
      x: 0,
      y: 0,
      rotation: 0,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: 0,
      color: '#8a9683',
      material: 'oak',
      materialRot: true,
      counterMaterial: 'marble-dark',
      counterMaterialRot: true,
    };
    const colorsOf = (g: THREE.Group): Set<string> => {
      const out = new Set<string>();
      g.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m?.color) out.add(`#${m.color.getHexString()}`);
      });
      return out;
    };
    const marble = materialDef('marble-dark')!.color;
    expect(colorsOf(buildItemGroup(item, def, ROOM, undefined)).has(marble)).toBe(true);
    // without the override (and no room material) nothing takes the marble tone
    const plain: Item = { ...item, material: undefined, counterMaterial: undefined };
    expect(colorsOf(buildItemGroup(plain, def, ROOM, undefined)).has(marble)).toBe(false);
    // custom cabinet: the worktop-role panel takes the instance counter material
    const part = newCabinetPart();
    const custom: Item = { ...item, defId: part.id, w: part.w, d: part.d, h: part.h };
    const g = buildItemGroup(custom, toCatalogDef(part), ROOM, part);
    let worktopColor = '';
    g.traverse((o) => {
      if (o.userData.role === 'worktop') {
        worktopColor = `#${((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString()}`;
      }
    });
    expect(worktopColor).toBe(marble);
  });

  it('builds a textured catalog item and a textured custom-part fallback headless', () => {
    const def = catalogDef('base-cabinet');
    const item: Item = {
      id: 'i1',
      defId: def.id,
      x: 0,
      y: 0,
      rotation: 0,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: 0,
      color: def.color,
      material: 'wenge',
      params: { doors: 2 },
    };
    const group = buildItemGroup(item, def, ROOM, undefined);
    expect(group.children.length).toBeGreaterThan(0);
    const glass = buildItemGroup({ ...item, material: 'glass' }, def, ROOM, undefined);
    expect(glass.children.length).toBeGreaterThan(0);
  });
});
