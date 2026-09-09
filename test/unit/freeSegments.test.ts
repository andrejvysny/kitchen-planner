import { describe, expect, it } from 'vitest';
import { catalogDef, type CatalogDef } from '../../src/model/catalog';
import { FREE_SEG_DEPTH, fitItem, wallFreeSegments, type FreeSegment } from '../../src/model/fit';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { allWalls, defaultRoomStyle, wallsOf, type RoomWall } from '../../src/model/rooms';
import { DESIGN_VERSION, defaultScene, normalizeDesign } from '../../src/model/store';
import type { Corner, Design, Item, Opening, Room } from '../../src/model/types';

/* ---------------- fixtures (same shape as fit.test.ts) ---------------- */

const c = (id: string, x: number, y: number): Corner => ({ id, x, y });

function room(id: string, pts: [number, number][]): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => c(`${id}c${i}`, x, y)),
    style: { ...defaultRoomStyle(), wallThickness: 0.1 },
  };
}

/**
 * 4 × 3 room. Wall 'Ac0' runs (0,0) → (4,0) with inward = +y (the "top" wall);
 * 'Ac3' runs (0,3) → (0,0), so ITS t = 0 is the far corner and t = 3 is the
 * corner Ac0 starts at.
 */
const rectRoom = (id = 'A'): Room =>
  room(id, [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]);

let seq = 0;
function makeItem(def: CatalogDef, x: number, y: number, patch: Partial<Item>): Item {
  return {
    id: `s${++seq}`,
    defId: def.id,
    x,
    y,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    ...patch,
  };
}

function item(defId: string, x: number, y: number, patch: Partial<Item> = {}): Item {
  const part = presetPart(defId);
  return makeItem(part ? toCatalogDef(part) : catalogDef(defId), x, y, patch);
}

/** back-to-wall on Ac0: rotation 0 puts the back on y = 0, the centre at d/2. */
function onTopWall(x: number, patch: Partial<Item> = {}): Item {
  const d = patch.d ?? 0.6;
  return item('wardrobe', x, d / 2, { w: 0.8, d, h: 2, elevation: 0, rotation: 0, ...patch });
}

let oseq = 0;
function opening(wallId: string, patch: Partial<Opening> = {}): Opening {
  return {
    id: `w${++oseq}`,
    wallId,
    type: 'door',
    offset: 1,
    width: 0.9,
    height: 2.02,
    sill: 0,
    ...patch,
  };
}

function design(o: { rooms?: Room[]; items?: Item[]; openings?: Opening[] }): Design {
  const rooms = o.rooms ?? [rectRoom()];
  return normalizeDesign({
    version: DESIGN_VERSION,
    rooms,
    openings: o.openings ?? [],
    items: (o.items ?? []).map((it) => ({ roomId: rooms[0].id, ...it })),
    customParts: [],
    variables: [],
    scene: defaultScene(),
  } as Design);
}

function wall(d: Design, id: string): RoomWall {
  const g = allWalls(d.rooms).find((w) => w.id === id);
  if (!g) throw new Error(`no wall ${id}`);
  return g;
}

const R = (v: number): number => Number(v.toFixed(6));

function expectSegs(segs: FreeSegment[], want: [number, number][]): void {
  expect(segs.map((s) => [R(s.t0), R(s.t1)])).toEqual(want);
}

/* ---------------- the wall itself ---------------- */

describe('wallFreeSegments — the bare wall', () => {
  it('reports the whole wall when nothing stands on it', () => {
    const d = design({});
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0')), [[0, 4]]);
  });

  it('is what fitItem fills: the segment the item stands in, centred', () => {
    // one fixed neighbour spanning [2.5, 3.5] splits the wall in two, so the
    // three probes cover a contained t on either side of it
    for (const t of [0.4, 2.2, 3.8]) {
      const d = design({
        items: [onTopWall(t, { fit: { width: 'walls' } }), onTopWall(3, { w: 1 })],
      });
      const me = d.items[0];
      const segs = wallFreeSegments(d, wall(d, 'Ac0'), {
        exceptId: me.id,
        depth: me.d,
        elevation: me.elevation,
        height: me.h,
      });
      const seg = segs.find((s) => t >= s.t0 && t <= s.t1);
      expect(seg).toBeDefined();
      const patch = fitItem(d, me);
      // Ac0 starts at the origin and runs along +x, so t IS the world x
      expect(patch?.w).toBeCloseTo((seg?.t1 ?? 0) - (seg?.t0 ?? 0), 6);
      expect(patch?.x).toBeCloseTo(((seg?.t0 ?? 0) + (seg?.t1 ?? 0)) / 2, 6);
    }
  });
});

/* ---------------- openings ---------------- */

describe('wallFreeSegments — openings', () => {
  it('a door splits the wall at its two jambs', () => {
    const d = design({ openings: [opening('Ac0', { offset: 1, width: 0.9 })] });
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0')), [
      [0, 0.55],
      [1.45, 4],
    ]);
  });

  it('an out-swinging door cuts exactly the same: a swing adds nothing on its own wall', () => {
    const d = design({ openings: [opening('Ac0', { offset: 1, width: 0.9, swing: 'out' })] });
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0')), [
      [0, 0.55],
      [1.45, 4],
    ]);
  });

  it('a window cuts whatever the run reaches to — the sill is never consulted', () => {
    const d = design({
      openings: [
        opening('Ac0', { type: 'window', offset: 2, width: 1.3, height: 1.2, sill: 0.95 }),
      ],
    });
    const want: [number, number][] = [
      [0, 1.35],
      [2.65, 4],
    ];
    // a base run entirely under the sill, and a tall one through it
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0'), { elevation: 0, height: 0.9 }), want);
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0'), { elevation: 0, height: 2.4 }), want);
  });
});

/* ---------------- door swings ---------------- */

describe('wallFreeSegments — door swings', () => {
  it('a door near a corner sweeps across the PERPENDICULAR wall', () => {
    // Ac3 runs (0,3) → (0,0); a right hinge puts the pivot at t = 2.95, i.e.
    // 5 cm from the corner Ac0 starts at, and the 0.9 m leaf sweeps into it.
    const d = design({ openings: [opening('Ac3', { offset: 2.5, width: 0.9, hinge: 'right' })] });
    const segs = wallFreeSegments(d, wall(d, 'Ac0'));
    expect(segs).toHaveLength(1);
    // the leaf lies flat along Ac0 when fully open, one door width in
    expect(segs[0].t0).toBeCloseTo(0.9, 6);
    expect(segs[0].t1).toBeCloseTo(4, 6);
    // and that is the FREE_SEG_DEPTH band, which is the default
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0'), { depth: FREE_SEG_DEPTH }), [
      [R(segs[0].t0), 4],
    ]);
  });
});

/* ---------------- partitions ---------------- */

describe('wallFreeSegments — a partition twin', () => {
  // B shares A's right edge reversed, so Ac1 becomes a partition. The door is
  // stored once, on A's side.
  const twins = (): Design =>
    design({
      rooms: [
        rectRoom('A'),
        room('B', [
          [4, 3],
          [4, 0],
          [8, 0],
          [8, 3],
        ]),
      ],
      openings: [opening('Ac1', { offset: 1, width: 0.8 })],
    });

  it('cuts the owner side at the stored offset', () => {
    const d = twins();
    expectSegs(wallFreeSegments(d, wall(d, 'Ac1')), [
      [0, 0.6],
      [1.4, 3],
    ]);
  });

  it('cuts the far side at the MIRRORED offset, and its swing does not leak through', () => {
    const d = twins();
    const twin = wallsOf(d.rooms, 'B').find((w) => w.shared);
    expect(twin).toBeDefined();
    // offset 1.0 on a 3 m wall reads as 2.0 from the other end; the in-swing
    // mirrors to 'out', so room B sees the hole and nothing else
    expectSegs(wallFreeSegments(d, twin as RoomWall), [
      [0, 1.6],
      [2.4, 3],
    ]);
  });
});

/* ---------------- items ---------------- */

describe('wallFreeSegments — items', () => {
  it('merges a cut that touches a jamb instead of leaving a zero-width sliver', () => {
    const d = design({
      openings: [opening('Ac0', { offset: 1, width: 0.9 })],
      items: [onTopWall(1.95, { w: 1 })], // spans [1.45, 2.45] — flush to the jamb
    });
    expectSegs(wallFreeSegments(d, wall(d, 'Ac0')), [
      [0, 0.55],
      [2.45, 4],
    ]);
  });

  it('exceptId takes one item out of the scan', () => {
    const d = design({ items: [onTopWall(1.5, { w: 1 })] });
    const g = wall(d, 'Ac0');
    expectSegs(wallFreeSegments(d, g), [
      [0, 1],
      [2, 4],
    ]);
    expectSegs(wallFreeSegments(d, g, { exceptId: d.items[0].id }), [[0, 4]]);
  });

  it('an item above the run does not cut it', () => {
    const d = design({ items: [onTopWall(2, { w: 1, elevation: 2.2, h: 0.3 })] });
    const g = wall(d, 'Ac0');
    expectSegs(wallFreeSegments(d, g, { elevation: 0, height: 2 }), [[0, 4]]);
    // raise the run into it and it bounds again
    expectSegs(wallFreeSegments(d, g, { elevation: 0, height: 2.4 }), [
      [0, 1.5],
      [2.5, 4],
    ]);
  });
});
