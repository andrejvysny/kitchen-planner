import { describe, expect, it } from 'vitest';
import { catalogDef, type CatalogDef } from '../../src/model/catalog';
import { FIT_MIN_W, fitItem, syncFits, type FitPatch } from '../../src/model/fit';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { defaultRoomStyle } from '../../src/model/rooms';
import { DESIGN_VERSION, defaultScene, normalizeDesign } from '../../src/model/store';
import type { Corner, CustomPartDef, Design, Item, Opening, Room } from '../../src/model/types';

/* ---------------- fixtures (same shape as checks.test.ts) ---------------- */

const c = (id: string, x: number, y: number): Corner => ({ id, x, y });

function room(id: string, pts: [number, number][]): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => c(`${id}c${i}`, x, y)),
    style: { ...defaultRoomStyle(), wallThickness: 0.1 },
  };
}

/** 4 × 3 room whose top wall (id 'Ac0') runs (0,0) → (4,0), inward = +y. */
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
    id: `f${++seq}`,
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

/**
 * An item standing back-to-wall on the 4 × 3 room's TOP wall: rotation 0 puts
 * its back on y = 0 (the exterior wall's face, faceOffset 0), so its centre
 * sits d/2 into the room.
 */
function onTopWall(x: number, patch: Partial<Item> = {}, defId = 'wardrobe'): Item {
  const d = patch.d ?? 0.6;
  return item(defId, x, d / 2, { w: 0.8, d, h: 2, elevation: 0, rotation: 0, ...patch });
}

let oseq = 0;
function opening(wallId: string, patch: Partial<Opening> = {}): Opening {
  return {
    id: `o${++oseq}`,
    wallId,
    type: 'door',
    offset: 1,
    width: 0.9,
    height: 2.02,
    sill: 0,
    ...patch,
  };
}

function design(o: {
  rooms?: Room[];
  items?: Item[];
  parts?: CustomPartDef[];
  openings?: Opening[];
}): Design {
  const rooms = o.rooms ?? [rectRoom()];
  return normalizeDesign({
    version: DESIGN_VERSION,
    rooms,
    openings: o.openings ?? [],
    items: (o.items ?? []).map((it) => ({ roomId: rooms[0].id, ...it })),
    customParts: o.parts ?? [],
    variables: [],
    scene: defaultScene(),
  } as Design);
}

/** A + B, sharing A's right edge reversed, so Ac1 is a partition. */
const twoRooms = (): Room[] => [
  rectRoom('A'),
  room('B', [
    [4, 3],
    [4, 0],
    [8, 0],
    [8, 3],
  ]),
];

/** exact key SET, values to 1 µm */
function expectPatch(p: FitPatch | null, want: FitPatch): void {
  expect(p).not.toBeNull();
  expect(Object.keys(p ?? {}).sort()).toEqual(Object.keys(want).sort());
  const got = (p ?? {}) as Record<string, number>;
  for (const [k, v] of Object.entries(want)) expect(got[k]).toBeCloseTo(v as number, 6);
}

const span = (it: Item): [number, number] => [it.x - it.w / 2, it.x + it.w / 2];

/* ---------------- width ---------------- */

describe('fitItem — width', () => {
  it('spans the alcove between the two flanking wall faces', () => {
    const d = design({ items: [onTopWall(1, { fit: { width: 'walls' } })] });
    // both flanking walls are exterior, so their faces are the ring itself:
    // x = 0 and x = 4. The centre lands at the midpoint, not where it stood.
    expectPatch(fitItem(d, d.items[0]), { w: 4, x: 2 });
  });

  it('stops at a neighbouring item on the same wall', () => {
    const d = design({
      items: [onTopWall(1, { fit: { width: 'walls' } }), onTopWall(3, { w: 1 })],
    });
    // left bound = wall face at 0, right bound = the neighbour's edge at 2.5
    expectPatch(fitItem(d, d.items[0]), { w: 2.5, x: 1.25 });
  });

  it('drops the width keys when the alcove is narrower than FIT_MIN_W', () => {
    const neighbours = [onTopWall(0.95, { w: 1.9 }), onTopWall(3.05, { w: 1.9 })];
    const gap = 0.2;
    expect(gap).toBeLessThan(FIT_MIN_W);

    const wOnly = design({ items: [onTopWall(2, { fit: { width: 'walls' } }), ...neighbours] });
    expect(fitItem(wOnly, wOnly.items[0])).toBeNull();

    // the height half of the same request still lands — only w/x/y are dropped
    const both = design({
      items: [onTopWall(2, { fit: { width: 'walls', height: 'ceiling' } }), ...neighbours],
    });
    expectPatch(fitItem(both, both.items[0]), { h: 2.6 });
  });

  it('reads a partition at its FACE, not at the ring edge that is its centreline', () => {
    // room B shares A's right edge reversed, so that wall becomes a partition:
    // its face sits thickness/2 inside A's ring.
    const d = design({
      rooms: twoRooms(),
      items: [onTopWall(1, { fit: { width: 'walls' } })],
    });
    const patch = fitItem(d, d.items[0]);
    expect(patch?.w).toBeCloseTo(3.95, 6);
    expect(patch?.x).toBeCloseTo(1.975, 6);
    // the naive corner-ring answer would be 4 — exactly half a thickness more
    expect(4 - (patch?.w ?? 0)).toBeCloseTo(0.1 / 2, 6);
  });
});

/* ---------------- openings ---------------- */

describe('fitItem — openings', () => {
  it('stops at a door jamb', () => {
    const d = design({
      openings: [opening('Ac0', { offset: 1, width: 0.9 })],
      items: [onTopWall(0.3, { fit: { width: 'walls' } })],
    });
    // the swing of an in-swinging door covers exactly its own opening on its
    // own wall, so the run ends at the near jamb either way
    expectPatch(fitItem(d, d.items[0]), { w: 0.55, x: 0.275 });
  });

  it('a window splits the run in two', () => {
    const win = opening('Ac0', {
      type: 'window',
      offset: 2,
      width: 1.3,
      height: 1.2,
      sill: 0.95,
    });
    const left = design({ openings: [win], items: [onTopWall(1, { fit: { width: 'walls' } })] });
    expectPatch(fitItem(left, left.items[0]), { w: 1.35, x: 0.675 });

    const right = design({ openings: [win], items: [onTopWall(3, { fit: { width: 'walls' } })] });
    expectPatch(fitItem(right, right.items[0]), { w: 1.35, x: 3.325 });
  });

  it('a fitted base cabinet stops at a window jamb, high sill or not', () => {
    // DECIDED behaviour change: windows always cut a run, whatever its
    // vertical band. A worktop run under a window used to span the whole wall.
    const d = design({
      openings: [
        opening('Ac0', { type: 'window', offset: 2, width: 1.3, height: 1.2, sill: 0.95 }),
      ],
      items: [
        onTopWall(1, { w: 0.6, h: 0.87, elevation: 0, fit: { width: 'walls' } }, 'base-cabinet'),
      ],
    });
    expectPatch(fitItem(d, d.items[0]), { w: 1.35, x: 0.675 });
  });

  it('an item standing over a doorway lands in the NEAREST segment', () => {
    // door [0.55, 1.45]; t = 1.2 is 0.65 from the left run and 0.25 from the right
    const d = design({
      openings: [opening('Ac0', { offset: 1, width: 0.9 })],
      items: [onTopWall(1.2, { fit: { width: 'walls' } })],
    });
    expectPatch(fitItem(d, d.items[0]), { w: 2.55, x: 2.725 });
  });

  it('breaks an equidistant tie towards the WIDER segment', () => {
    // t = 1.0 is the door centre: 0.45 either way, 0.55 m left vs 2.55 m right
    const d = design({
      openings: [opening('Ac0', { offset: 1, width: 0.9 })],
      items: [onTopWall(1, { fit: { width: 'walls' } })],
    });
    expectPatch(fitItem(d, d.items[0]), { w: 2.55, x: 2.725 });
  });

  it('breaks an equidistant tie of EQUAL widths towards the lower t', () => {
    // a centred door leaves 1.55 m either side, and t = 2.0 is 0.45 from both
    const d = design({
      openings: [opening('Ac0', { offset: 2, width: 0.9 })],
      items: [onTopWall(2, { fit: { width: 'walls' } })],
    });
    expectPatch(fitItem(d, d.items[0]), { w: 1.55, x: 0.775 });
  });

  it('reads a partition twin door from the far room, mirrored', () => {
    // the door is stored once, on A's side of the shared wall; the item stands
    // in B, hugging the same partition from the other face
    const cx = 4 + (0.1 / 2 + 0.6 / 2);
    const d = design({
      rooms: twoRooms(),
      openings: [opening('Ac1', { offset: 1, width: 0.8 })],
      items: [
        item('wardrobe', cx, 2, {
          roomId: 'B',
          w: 0.8,
          d: 0.6,
          h: 2,
          elevation: 0,
          rotation: -Math.PI / 2,
          fit: { width: 'walls' },
        }),
      ],
    });
    // offset 1.0 on the 3 m wall reads as 2.0 from B's end, so B's near run is
    // [0, 1.6] — measured from (4,3), which puts the centre at y = 2.2
    expectPatch(fitItem(d, d.items[0]), { w: 1.6, y: 2.2 });
  });
});

/* ---------------- height ---------------- */

describe('fitItem — height', () => {
  it('reaches the ceiling from the floor', () => {
    const d = design({ items: [onTopWall(2, { fit: { height: 'ceiling' } })] });
    expectPatch(fitItem(d, d.items[0]), { h: 2.6 });
  });

  it('reaches the ceiling from an off-floor elevation', () => {
    const d = design({ items: [onTopWall(2, { fit: { height: 'ceiling' }, elevation: 0.1 })] });
    expectPatch(fitItem(d, d.items[0]), { h: 2.5 });
  });
});

/* ---------------- refusals ---------------- */

describe('fitItem — refusals', () => {
  it('returns null when the item is not square to a wall', () => {
    const d = design({ items: [onTopWall(2, { fit: { width: 'walls' }, rotation: 0.3 })] });
    expect(fitItem(d, d.items[0])).toBeNull();
  });

  it('returns null when the item does not stand on the wall face', () => {
    // back 0.2 off the face — well past FIT_BACK_TOL
    const d = design({ items: [onTopWall(2, { fit: { width: 'walls' }, y: 0.5 })] });
    expect(fitItem(d, d.items[0])).toBeNull();
  });

  it('never fits an attached item', () => {
    const host = onTopWall(1, { w: 0.6 });
    const mounted = onTopWall(1, {
      fit: { width: 'walls', height: 'ceiling' },
      attach: { kind: 'counter', hostId: host.id, u: 0, v: 0 },
    });
    const d = design({ items: [host, mounted] });
    expect(fitItem(d, d.items[1])).toBeNull();
    expect(syncFits(d)).toBe(false);
  });

  it('returns null for a fit flag that asks for nothing', () => {
    const d = design({ items: [onTopWall(2, { fit: {} })] });
    expect(fitItem(d, d.items[0])).toBeNull();
  });
});

/* ---------------- syncFits ---------------- */

describe('syncFits', () => {
  it('converges: two fitted items tile the wall with no gap and no overlap', () => {
    const d = design({
      items: [onTopWall(1, { fit: { width: 'walls' } }), onTopWall(3, { fit: { width: 'walls' } })],
    });
    expect(syncFits(d)).toBe(true);
    // second call is a fixed point — nothing left to move
    expect(syncFits(d)).toBe(false);

    const [left, right] = d.items;
    const [l0, l1] = span(left);
    const [r0, r1] = span(right);
    expect(l0).toBeCloseTo(0, 6);
    expect(l1).toBeCloseTo(r0, 6);
    expect(r1).toBeCloseTo(4, 6);
    expect(left.w + right.w).toBeCloseTo(4, 6);
  });

  it('converges with a door in the wall: each item tiles its own segment', () => {
    const d = design({
      openings: [opening('Ac0', { offset: 2, width: 0.9 })],
      items: [
        onTopWall(0.5, { fit: { width: 'walls' } }),
        onTopWall(3, { fit: { width: 'walls' } }),
      ],
    });
    expect(syncFits(d)).toBe(true);
    expect(syncFits(d)).toBe(false);

    const [l0, l1] = span(d.items[0]);
    const [r0, r1] = span(d.items[1]);
    expect(l0).toBeCloseTo(0, 6);
    expect(l1).toBeCloseTo(1.55, 6);
    expect(r0).toBeCloseTo(2.45, 6);
    expect(r1).toBeCloseTo(4, 6);
  });
});
