import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CATALOG, defaultParams, type CatalogDef } from '../../src/model/catalog';
import { parseMaterialName, type MaterialDesc } from '../../src/model/materialName';
import { materialDef } from '../../src/model/materials';
import { newCabinetPart, toCatalogDef } from '../../src/model/parts';
import { PRESETS } from '../../src/model/presets';
import type { CustomPartDef, Design, Item, RoomStyle } from '../../src/model/types';
import { buildItemGroup } from '../../src/view3d/itemMeshes';
import { steelMat, surfMat, wood } from '../../src/view3d/meshKit';
import { texturedMaterial } from '../../src/view3d/textures';

/**
 * Every three.js material is stamped with its semantic identity at creation
 * (src/model/materialName.ts): the render pipeline exports the scene to glTF
 * and the name is the ONLY thing that survives the trip and tells the worker
 * which library entry / flat finish / bought product a baked colour came from.
 *
 * These run headless (no DOM → no texture canvases), which is exactly the path
 * where a name could silently go missing, and the sweep at the bottom is the
 * standing guarantee: no builder may mint an unnamed or mis-coloured material.
 */

const ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

// colours resolve against the whole design (variable refs); literal colours
// here, so an empty registry wrapping ROOM is all these builders need.
const DESIGN = {
  variables: [],
  rooms: [{ id: 'r1', name: 'Room', corners: [], style: ROOM }],
} as unknown as Design;

function itemFor(def: CatalogDef): Item {
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
    params: defaultParams(def),
  };
}

/** Every distinct material under an object, in build order. */
function materialsOf(root: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out = new Set<THREE.MeshStandardMaterial>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as
      THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => out.add(x));
    else if (m) out.add(m);
  });
  return [...out];
}

function descOf(mat: THREE.Material): MaterialDesc | null {
  return parseMaterialName(mat.name);
}

describe('material stamping: library materials', () => {
  it('texturedMaterial names the library id, colour and rotation', () => {
    const flat = texturedMaterial('oak', '#c9a87c')!;
    expect(descOf(flat)).toEqual({
      kind: 'library',
      matId: 'oak',
      hex6: flat.color.getHexString(),
      rot: false,
    });
    // the name carries the CONSTRUCTED colour, not the requested one: oak is a
    // preset material, so it imposes its own
    expect(flat.color.getHexString()).toBe(materialDef('oak')!.color.slice(1).toLowerCase());

    const rotated = texturedMaterial('oak', '#c9a87c', true)!;
    expect(rotated.name.endsWith(':r')).toBe(true);
    expect(descOf(rotated)).toMatchObject({ kind: 'library', matId: 'oak', rot: true });
    // …and the userData copy the exporter carries as glTF extras agrees
    expect(rotated.userData.kp).toEqual(descOf(rotated));
  });

  it('a tinted library material re-stamps to its POST-tint colour', () => {
    const tinted = surfMat({ color: '#aabbcc', material: 'oak' }, 'matte', 0.8);
    const desc = descOf(tinted);
    expect(desc).toMatchObject({ kind: 'library', matId: 'oak', rot: false });
    expect(desc && 'hex6' in desc && desc.hex6).toBe(tinted.color.getHexString());
    // the tint really moved the colour, so this is not a vacuous match
    expect(tinted.color.getHexString()).not.toBe(
      texturedMaterial('oak', '#aabbcc')!.color.getHexString()
    );
  });

  it('a tinted rotation flag survives the re-stamp', () => {
    const m = surfMat({ color: '#aabbcc', material: 'oak', rot: true }, 'matte', 0.5);
    expect(descOf(m)).toEqual({
      kind: 'library',
      matId: 'oak',
      hex6: m.color.getHexString(),
      rot: true,
    });
  });
});

describe('material stamping: flat finishes and products', () => {
  it('surfMat without a library material is a plain matte colour', () => {
    const m = surfMat('#aabbcc');
    expect(descOf(m)).toEqual({ kind: 'plain', hex6: 'aabbcc', fallback: 'matte' });
  });

  it('a shaded fallback names the SHADED colour', () => {
    const m = surfMat({ color: '#808080' }, 'matte', 0.5);
    expect(descOf(m)).toEqual({ kind: 'plain', hex6: m.color.getHexString(), fallback: 'matte' });
    expect(m.color.getHexString()).not.toBe('808080');
  });

  it('wood() is a plain wood fallback', () => {
    expect(descOf(wood('#123456'))).toEqual({
      kind: 'plain',
      hex6: '123456',
      fallback: 'wood',
    });
  });

  it('steelMat() is a product, and products carry no colour in the name', () => {
    const m = steelMat();
    expect(m.name).toBe('kp:p:steel');
    expect(descOf(m)).toEqual({ kind: 'product', product: 'steel' });
  });
});

describe('material stamping: panel-driven parts', () => {
  it('a glass zone front names as the library glass material', () => {
    const part: CustomPartDef = {
      ...newCabinetPart(),
      face: { kind: 'leaf', fill: 'glass' },
    };
    const def = toCatalogDef(part);
    const glass = materialsOf(buildItemGroup(itemFor(def), def, DESIGN, part)).filter(
      (m) => descOf(m)?.kind === 'library' && (descOf(m) as { matId: string }).matId === 'glass'
    );
    expect(glass.length).toBeGreaterThan(0);
    expect(glass[0].transparent).toBe(true);
  });

  it('a routed groove names as the groove product', () => {
    // the default cabinet is two drawers, and every drawer front is grooved
    const part = newCabinetPart();
    const def = toCatalogDef(part);
    const names = materialsOf(buildItemGroup(itemFor(def), def, DESIGN, part)).map((m) => m.name);
    expect(names).toContain('kp:p:groove');
  });
});

describe('material stamping: every builder', () => {
  // ids of materials a builder is knowingly allowed to leave unnamed — the
  // whole point of this list is that it stays empty
  const UNSTAMPABLE: string[] = [];

  const cases: { id: string; group: () => THREE.Group }[] = [
    ...CATALOG.flatMap((s) => s.items)
      .filter((d) => !d.opening && d.kind !== 'custom')
      .map((def) => ({ id: def.id, group: () => buildItemGroup(itemFor(def), def, DESIGN) })),
    ...PRESETS.map(({ part }) => {
      const def = toCatalogDef(part);
      return { id: part.id, group: () => buildItemGroup(itemFor(def), def, DESIGN, part) };
    }),
  ];

  it('names every material it mints (nothing falls through unstamped)', () => {
    const unnamed: string[] = [];
    for (const c of cases) {
      if (UNSTAMPABLE.includes(c.id)) continue;
      for (const m of materialsOf(c.group())) {
        if (!parseMaterialName(m.name)) unnamed.push(`${c.id}: "${m.name}"`);
      }
    }
    expect(unnamed).toEqual([]);
    expect(cases.length).toBeGreaterThan(20);
  });

  it('every colour-carrying name matches the colour the viewport shows', () => {
    const drift: string[] = [];
    for (const c of cases) {
      for (const m of materialsOf(c.group())) {
        const desc = parseMaterialName(m.name);
        if (!desc || !('hex6' in desc)) continue;
        if (desc.hex6 !== m.color.getHexString()) {
          drift.push(`${c.id}: ${m.name} vs #${m.color.getHexString()}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });
});
