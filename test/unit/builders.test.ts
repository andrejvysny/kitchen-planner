import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CATALOG, defaultParams, type CatalogDef } from '../../src/model/catalog';
import {
  newBoardPart,
  newCabinetPart,
  newFreeformPart,
  samplePart,
  toCatalogDef,
} from '../../src/model/parts';
import { partPanels } from '../../src/model/panels';
import { PRESETS } from '../../src/model/presets';
import { deskBoards } from './fixtures';
import type { BoardPartDef, CabinetPartDef, CustomPartDef, Design, Item, RoomStyle, Zone } from '../../src/model/types';
import { buildItemGroup } from '../../src/view3d/itemMeshes';

const ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

// buildItemGroup resolves colours against the whole design (for variable refs);
// these smoke tests use literal colours, so an empty variables registry suffices.
const DESIGN = { variables: [], room: ROOM } as unknown as Design;

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
        const group = buildItemGroup(itemFor(def, params), def, DESIGN, undefined);
        expect(group.children.length).toBeGreaterThan(0);
      }
    });
  }

  it('builds every cabinet preset through both the mesh and panel pipelines', () => {
    for (const { part } of PRESETS) {
      const def = toCatalogDef(part);
      const group = buildItemGroup(itemFor(def), def, DESIGN, part);
      expect(group.children.length).toBeGreaterThan(0);
      const panels = partPanels(part, {
        w: part.w,
        d: part.d,
        h: part.h,
        elevation: part.elevation,
      });
      expect(panels.length).toBeGreaterThan(0);
      expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
    }
  });

  it('builds every custom part type', () => {
    const parts: CustomPartDef[] = [
      samplePart(),
      newCabinetPart(),
      newBoardPart(),
      { ...newFreeformPart(), boards: deskBoards(3, { w: 1.4, d: 0.7, h: 0.75 }) },
      { ...newFreeformPart(), boards: deskBoards(0, { w: 1.2, d: 0.6, h: 0.72 }) },
    ];
    for (const p of parts) {
      const def = toCatalogDef(p);
      const group = buildItemGroup(itemFor(def), def, DESIGN, p);
      expect(group.children.length).toBeGreaterThan(0);
    }
  });

  it('builds cabinets with extreme zone trees and angled footprints', () => {
    const base = newCabinetPart();
    const many: Zone = {
      kind: 'split',
      dir: 'v',
      weights: [1, 1, 1],
      children: [
        { kind: 'leaf', fill: 'drawers', drawers: 5 },
        {
          kind: 'split',
          dir: 'h',
          weights: [1, 1, 1, 1],
          children: [
            { kind: 'leaf', fill: 'open', shelves: 4 },
            { kind: 'leaf', fill: 'glass' },
            { kind: 'leaf', fill: 'panel' },
            { kind: 'leaf', fill: 'doorPair' },
          ],
        },
        { kind: 'leaf', fill: 'door' },
      ],
    };
    const variants: CabinetPartDef[] = [
      { ...base, face: many },
      { ...base, footprint: { kind: 'chamfer', corner: 'left', cx: 0.3, cz: 0.3, face: 'angled' }, w: 0.9, d: 0.9 },
      { ...base, footprint: { kind: 'chamfer', corner: 'right', cx: 0.2, cz: 0.2, face: 'front' } },
      { ...base, footprint: { kind: 'cornerL', notch: 'left', nw: 0.4, nd: 0.3, face2: 'door' }, w: 1.0, d: 1.0 },
      { ...base, footprint: { kind: 'cornerL', notch: 'right', nw: 0.4, nd: 0.3, face2: 'panel' }, w: 1.0, d: 1.0 },
    ];
    for (const p of variants) {
      const def = toCatalogDef(p);
      const group = buildItemGroup(itemFor(def), def, DESIGN, p);
      expect(group.children.length).toBeGreaterThan(2);
    }
  });

  it('builds a concave board with cutouts and sane bounds', () => {
    const p: BoardPartDef = {
      ...newBoardPart(),
      w: 2.4,
      d: 1.2,
      outline: [
        { x: -1.2, y: -0.6 },
        { x: 1.2, y: -0.6 },
        { x: 1.2, y: 0.6 },
        { x: 0.2, y: 0.6 },
        { x: 0.2, y: 0 },
        { x: -1.2, y: 0 },
      ],
      holes: [{ x: -0.6, y: -0.3, w: 0.5, d: 0.35 }],
    };
    const def = toCatalogDef(p);
    const group = buildItemGroup(itemFor(def), def, DESIGN, p);
    expect(group.children.length).toBe(1);
    const bounds = new Box3().setFromObject(group);
    // plan +y (front) must land on world +z, thickness on +y
    expect(bounds.max.z).toBeCloseTo(0.6, 2);
    expect(bounds.min.z).toBeCloseTo(-0.6, 2);
    expect(bounds.min.y).toBeCloseTo(0, 3);
    expect(bounds.max.y).toBeCloseTo(p.h, 3);
    expect(bounds.max.x).toBeCloseTo(1.2, 2);
  });

});
