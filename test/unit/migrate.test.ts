import { describe, expect, it } from 'vitest';
import {
  cabinetTreeFromCounts,
  countsFromTree,
  deskBoards,
  migrateDesignV1,
  migratePartV1,
} from '../../src/model/partsMigrate';
import { sanitizeDesign } from '../../src/model/store';
import type { CabinetPartDef, FreeformPartDef } from '../../src/model/types';

function v1Part(options: Record<string, number>, template = 'cabinet', id = 'p1') {
  return {
    id,
    name: 'Old part',
    template,
    w: 1.2,
    d: 0.42,
    h: 0.75,
    elevation: 0,
    color: '#e6dfd0',
    accentColor: '#c9a87c',
    options,
  };
}

function v1Item(defId: string, params?: Record<string, number>, id = 'i1') {
  return {
    id,
    defId,
    x: 1,
    y: 1,
    rotation: 0,
    w: 1.2,
    d: 0.42,
    h: 0.75,
    elevation: 0,
    color: '#e6dfd0',
    params,
  };
}

const CORNERS = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 4, y: 0 },
  { id: 'c', x: 4, y: 3 },
  { id: 'd', x: 0, y: 3 },
];

describe('cabinetTreeFromCounts / countsFromTree', () => {
  it('round-trips every v1 option combination', () => {
    for (let drawers = 0; drawers <= 5; drawers++) {
      for (let doors = 0; doors <= 2; doors++) {
        for (const shelves of [0, 1, 4]) {
          const tree = cabinetTreeFromCounts({ drawers, doors, shelves });
          const back = countsFromTree(tree);
          // all-zero falls back to a single door — the v1 renderer did the same
          const expected =
            drawers === 0 && doors === 0 && shelves === 0
              ? { drawers: 0, doors: 1, shelves: 0 }
              : { drawers, doors, shelves };
          expect(back).toEqual(expected);
        }
      }
    }
  });

  it('preserves the v1 zone weight ratios', () => {
    const tree = cabinetTreeFromCounts({ drawers: 2, doors: 1, shelves: 2 });
    expect(tree.kind).toBe('split');
    if (tree.kind === 'split') {
      const [wd, wdoor, wopen] = tree.weights;
      expect(wd).toBeCloseTo(0.4);
      expect(wdoor).toBeCloseTo(0.5);
      expect(wopen).toBeCloseTo(0.51);
    }
  });
});

describe('migratePartV1', () => {
  it('cabinet options map to plinth/worktop booleans and a face tree', () => {
    const p = migratePartV1(v1Part({ drawers: 1, doors: 2, shelves: 1, plinth: 0, worktop: 1 })) as CabinetPartDef;
    expect(p.type).toBe('cabinet');
    expect(p.plinth).toBe(false);
    expect(p.worktop).toBe(true);
    expect(countsFromTree(p.face)).toEqual({ drawers: 1, doors: 2, shelves: 1 });
    expect(p.footprint).toEqual({ kind: 'rect' });
  });

  it('desk becomes freeform with the v1 board layout', () => {
    const p = migratePartV1(v1Part({ drawers: 2, panelLegs: 0 }, 'desk')) as FreeformPartDef;
    expect(p.type).toBe('freeform');
    expect(p.boards.find((b) => b.id === 'top')).toBeTruthy();
    expect(p.boards.filter((b) => b.id.startsWith('leg-'))).toHaveLength(4);
    expect(p.boards.filter((b) => b.id.startsWith('dr-'))).toHaveLength(2);
    const panel = migratePartV1(v1Part({ drawers: 0, panelLegs: 1 }, 'desk')) as FreeformPartDef;
    expect(panel.boards.filter((b) => b.id.startsWith('panel-'))).toHaveLength(2);
    expect(panel.boards.some((b) => b.shape === 'cyl')).toBe(false);
  });

  it('rejects junk', () => {
    expect(migratePartV1(null)).toBeNull();
    expect(migratePartV1({ name: 'no id' })).toBeNull();
  });
});

describe('sanitizeDesign v1 → v2', () => {
  it('migrates parts, splits variants and strips custom item params', () => {
    const raw = {
      version: 1,
      corners: CORNERS,
      customParts: [v1Part({ drawers: 2, doors: 0, shelves: 0, plinth: 1, worktop: 1 })],
      items: [
        v1Item('p1', { drawers: 2, doors: 0, shelves: 0, plinth: 1, worktop: 1 }, 'i1'),
        v1Item('p1', { drawers: 5, doors: 1, shelves: 0, plinth: 1, worktop: 1 }, 'i2'),
      ],
    };
    const d = sanitizeDesign(raw)!;
    expect(d).not.toBeNull();
    expect(d.version).toBe(4);
    expect(d.customParts).toHaveLength(2);
    const variant = d.customParts.find((p) => p.name.includes('variant')) as CabinetPartDef;
    expect(variant).toBeTruthy();
    expect(countsFromTree(variant.face)).toEqual({ drawers: 5, doors: 1, shelves: 0 });
    const i1 = d.items.find((i) => i.id === 'i1')!;
    const i2 = d.items.find((i) => i.id === 'i2')!;
    expect(i1.defId).toBe('p1');
    expect(i2.defId).toBe(variant.id);
    expect(i1.params).toBeUndefined();
    expect(i2.params).toBeUndefined();
  });

  it('two identical variants share one cloned part', () => {
    const params = { drawers: 4, doors: 0, shelves: 0, plinth: 1, worktop: 1 };
    const raw = {
      version: 1,
      corners: CORNERS,
      customParts: [v1Part({ drawers: 2, doors: 0, shelves: 0, plinth: 1, worktop: 1 })],
      items: [v1Item('p1', { ...params }, 'i1'), v1Item('p1', { ...params }, 'i2')],
    };
    const d = sanitizeDesign(raw)!;
    expect(d.customParts).toHaveLength(2);
    expect(d.items[0].defId).toBe(d.items[1].defId);
  });

  it('drops items whose defId resolves nowhere', () => {
    const raw = {
      version: 1,
      corners: CORNERS,
      items: [v1Item('ghost-part'), { ...v1Item('base-cabinet'), id: 'ok' }],
    };
    const d = sanitizeDesign(raw)!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0].id).toBe('ok');
  });

  it('accepts v2/v3/v4 payloads and rejects future versions', () => {
    expect(sanitizeDesign({ version: 2, corners: CORNERS })).not.toBeNull();
    expect(sanitizeDesign({ version: 3, corners: CORNERS })).not.toBeNull();
    expect(sanitizeDesign({ version: 4, corners: CORNERS })).not.toBeNull();
    expect(sanitizeDesign({ version: 5, corners: CORNERS })).toBeNull();
  });

  it('drops junk part entries instead of nuking the design', () => {
    const raw = {
      version: 2,
      corners: CORNERS,
      customParts: [42, { type: 'cabinet' }, null, { ...migratePartV1(v1Part({ drawers: 1, doors: 0, shelves: 0 })) }],
    };
    const d = sanitizeDesign(raw)!;
    expect(d.customParts).toHaveLength(1);
    expect(d.customParts[0].type).toBe('cabinet');
  });
});

describe('deskBoards geometry', () => {
  it('matches the v1 desk formulas', () => {
    const dims = { w: 1.4, d: 0.7, h: 0.75 };
    const boards = deskBoards({ drawers: 3, panelLegs: 0 }, dims);
    const top = boards.find((b) => b.id === 'top')!;
    expect(top.y).toBeCloseTo(0.75 - 0.035);
    expect(top.h).toBeCloseTo(0.035);
    const leg = boards.find((b) => b.id === 'leg-0')!;
    expect(leg.shape).toBe('cyl');
    expect(leg.w).toBeCloseTo(0.044);
    expect(leg.h).toBeCloseTo(0.75 - 0.035);
    expect(Math.abs(leg.x)).toBeCloseTo(1.4 / 2 - 0.06);
    const drawers = boards.filter((b) => b.id.startsWith('dr-'));
    expect(drawers).toHaveLength(3);
    expect(drawers.every((b) => b.style === 'front')).toBe(true);
  });
});
