import { describe, expect, it } from 'vitest';
import { CLEARANCE, DOOR_LANDING, runChecks, type Warning } from '../../src/model/checks';
import { catalogDef, type CatalogDef } from '../../src/model/catalog';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { defaultRoomStyle } from '../../src/model/rooms';
import {
  DESIGN_VERSION,
  defaultScene,
  demoDesign,
  normalizeDesign,
  Store,
} from '../../src/model/store';
import type {
  CabinetPartDef,
  Corner,
  CustomPartDef,
  Design,
  Item,
  Opening,
  Point,
  Room,
} from '../../src/model/types';

/* ---------------- fixtures ---------------- */

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
const rectRoom = (id = 'A', x = 0): Room =>
  room(id, [
    [x, 0],
    [x + 4, 0],
    [x + 4, 3],
    [x, 3],
  ]);

let seq = 0;
function makeItem(def: CatalogDef, x: number, y: number, patch: Partial<Item>): Item {
  return {
    id: `i${++seq}`,
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

/** an item of a built-in preset part or catalog def, at its natural size */
function item(defId: string, x: number, y: number, patch: Partial<Item> = {}): Item {
  const part = presetPart(defId);
  return makeItem(part ? toCatalogDef(part) : catalogDef(defId), x, y, patch);
}

/** an item of a design-local custom part */
const partItem = (part: CustomPartDef, x: number, y: number, patch: Partial<Item> = {}): Item =>
  makeItem(toCatalogDef(part), x, y, patch);

function design(o: {
  rooms?: Room[];
  items?: Item[];
  openings?: Opening[];
  parts?: CustomPartDef[];
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

const kinds = (ws: Warning[]) => ws.map((w) => w.kind);

/* ---------------- overlap ---------------- */

describe('overlap check', () => {
  it('flags two cabinets sharing floor space, with the penetration depth', () => {
    const a = item('base-cabinet', 1, 1);
    const b = item('base-cabinet', 1.4, 1);
    const w = runChecks(design({ items: [a, b] }));
    expect(kinds(w)).toEqual(['overlap']);
    expect(w[0].severity).toBe('error');
    expect(w[0].itemIds.sort()).toEqual([a.id, b.id].sort());
    expect(w[0].value).toBeCloseTo(0.2, 6);
    expect(w[0].detail).toContain('20 cm');
    expect(w[0].id).toBe(`overlap:${[a.id, b.id].sort().join('+')}`);
  });

  it('leaves flush edge-snapped neighbours alone', () => {
    // exactly what snapItem produces: 0.6 wide units 0.6 apart
    const w = runChecks(
      design({ items: [item('base-cabinet', 1, 1), item('base-cabinet', 1.6, 1)] })
    );
    expect(w).toEqual([]);
    // and 4 mm of slop is still within TOUCH_EPS
    expect(
      runChecks(design({ items: [item('base-cabinet', 1, 1), item('base-cabinet', 1.596, 1)] }))
    ).toEqual([]);
  });

  it('is 2.5D: a wall cabinet directly above a base cabinet is fine', () => {
    const base = item('base-cabinet', 1, 0.4);
    const wall = item('wall-cabinet', 1, 0.3); // elevation 1.45, clears the 0.9 base
    expect(runChecks(design({ items: [base, wall] }))).toEqual([]);
    // drop it into the base cabinet's band and it does clash
    const low = item('wall-cabinet', 1, 0.3, { elevation: 0.5 });
    expect(kinds(runChecks(design({ items: [base, low] })))).toEqual(['overlap']);
  });

  it('skips decorative items even when they do share the space', () => {
    const table = item('table', 2, 1.5);
    // a pendant hung down INTO the tabletop band — decorative, so still quiet
    const pendant = item('pendant', 2, 1.5, { elevation: 0.5 });
    expect(runChecks(design({ items: [table, pendant] }))).toEqual([]);
  });

  it('skips an appliance against its own host', () => {
    const host = item('base-cabinet', 1, 1);
    const oven = item('appl-oven', 1, 1, {
      elevation: 0.2,
      attach: { kind: 'zone', hostId: host.id, path: [0] },
    });
    expect(runChecks(design({ items: [host, oven] }))).toEqual([]);
    // the very same geometry without the attachment is a real clash
    const loose = { ...oven, attach: undefined };
    expect(kinds(runChecks(design({ items: [host, loose] })))).toEqual(['overlap']);
  });

  it('handles rotated pairs', () => {
    const r = Math.PI / 6;
    const along = (t: number) => ({ x: 1 + Math.cos(r) * t, y: 1 + Math.sin(r) * t });
    const a = item('base-cabinet', 1, 1, { rotation: r });
    const near = along(0.3);
    const hit = item('base-cabinet', near.x, near.y, { rotation: r });
    expect(kinds(runChecks(design({ items: [a, hit] })))).toEqual(['overlap']);
    const far = along(0.61);
    const miss = item('base-cabinet', far.x, far.y, { rotation: r });
    expect(runChecks(design({ items: [a, miss] }))).toEqual([]);
  });

  it('uses the true outline of a notched footprint, not its bounding box', () => {
    const part: CabinetPartDef = {
      id: 'corner-l',
      name: 'Corner unit',
      type: 'cabinet',
      w: 1,
      d: 1,
      h: 0.9,
      elevation: 0,
      color: '#fff',
      accentColor: '#c9a87c',
      footprint: { kind: 'cornerL', notch: 'left', nw: 0.4, nd: 0.4, face2: 'panel' },
      plinth: true,
      worktop: true,
      face: { kind: 'leaf', fill: 'door' },
    };
    const corner = partItem(part, 2, 1.5);
    // the notch is world x 1.5..1.9, y 1.6..2.0 — inside the bbox, outside the part
    const inNotch = item('stool', 1.7, 1.8);
    expect(runChecks(design({ items: [corner, inNotch], parts: [part] }))).toEqual([]);
    const inBody = item('stool', 2.3, 1.8);
    expect(kinds(runChecks(design({ items: [corner, inBody], parts: [part] })))).toEqual([
      'overlap',
    ]);
  });
});

/* ---------------- through wall ---------------- */

describe('through-wall check', () => {
  it('flags a cabinet pushed out through an exterior wall', () => {
    const it = item('base-cabinet', 0.5, 0.1); // back edge at y = -0.2
    const w = runChecks(design({ items: [it] }));
    expect(kinds(w)).toEqual(['throughWall']);
    expect(w[0].severity).toBe('error');
    expect(w[0].itemIds).toEqual([it.id]);
    expect(w[0].geom).toEqual({ kind: 'segment', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } });
  });

  it('downgrades free-placement items to a warning', () => {
    const w = runChecks(design({ items: [item('island', 1.5, 0.1)] })); // island: placement 'free'
    expect(w[0].kind).toBe('throughWall');
    expect(w[0].severity).toBe('warn');
  });

  it('is faceOffset-aware: a cabinet flush against a partition is fine', () => {
    const a = rectRoom('A');
    const b = rectRoom('B', 4); // shares the x = 4 edge, so faceOffset = 0.05 each
    const flush = item('base-cabinet', 4 - 0.05 - 0.3, 1.5, { roomId: 'A' });
    expect(runChecks(design({ rooms: [a, b], items: [flush] }))).toEqual([]);
    // half a wall further and it pokes into the neighbouring room
    const buried = item('base-cabinet', 4.05, 1.5, { roomId: 'A' });
    expect(kinds(runChecks(design({ rooms: [a, b], items: [buried] })))).toEqual(['throughWall']);
  });

  it('ignores wall-mounted markers that live in the wall face by design', () => {
    expect(runChecks(design({ items: [item('outlet', 1, 0.015)] }))).toEqual([]);
    expect(runChecks(design({ items: [item('backsplash', 1.5, 0.01)] }))).toEqual([]);
  });
});

/* ---------------- doors ---------------- */

/** door on the top wall of the 4 × 3 room, hinge left, swinging in */
const door = (roomId = 'A'): Opening => ({
  id: 'o1',
  wallId: `${roomId}c0`,
  type: 'door',
  offset: 1,
  width: 0.9,
  height: 2.05,
  sill: 0,
});

describe('door checks', () => {
  it('flags an item standing in the swing', () => {
    const it = item('base-cabinet', 1, 0.4);
    const w = runChecks(design({ items: [it], openings: [door()] }));
    expect(kinds(w)).toEqual(['blocksDoor']); // the weaker landing line is suppressed
    expect(w[0].severity).toBe('warn');
    expect(w[0].openingId).toBe('o1');
    expect(w[0].itemIds).toEqual([it.id]);
    expect(w[0].geom?.kind).toBe('polygon');
    expect(w[0].id).toBe(`blocksDoor:${['o1', it.id].sort().join('+')}`);
  });

  it('follows the hinge and swing sides', () => {
    // swinging out, the quarter disc leaves the room entirely: only the
    // landing (which a door needs on BOTH sides) still applies
    const across = item('base-cabinet', 1, 0.4);
    expect(
      kinds(runChecks(design({ items: [across], openings: [{ ...door(), swing: 'out' }] })))
    ).toEqual(['doorLanding']);
    // deep on the hinge side: swept by a left-hinged leaf, missed by a
    // right-hinged one whose arc is centred on the far jamb
    const byHinge = item('stool', 0.5, 0.8);
    expect(kinds(runChecks(design({ items: [byHinge], openings: [door()] })))).toEqual([
      'blocksDoor',
    ]);
    expect(
      kinds(runChecks(design({ items: [byHinge], openings: [{ ...door(), hinge: 'right' }] })))
    ).toEqual(['doorLanding']);
  });

  it('reports a tight landing as info', () => {
    // clear of the 0.9 swing radius but inside the 0.9 landing strip
    const it = item('stool', 1.4, 0.85);
    const w = runChecks(design({ items: [it], openings: [door()] }));
    expect(kinds(w)).toEqual(['doorLanding']);
    expect(w[0].severity).toBe('info');
    expect(w[0].limit).toBe(DOOR_LANDING);
    expect(w[0].openingId).toBe('o1');
  });

  it('leaves items clear of both zones alone, and ignores overhead lights', () => {
    // mid-room, so it is clear of the ergonomic checks too (a cabinet parked
    // 20 cm off the far wall cannot open its door)
    expect(
      runChecks(design({ items: [item('base-cabinet', 3, 1.5)], openings: [door()] }))
    ).toEqual([]);
    // a ceiling spot right over the door: decorative and far above the leaf
    expect(runChecks(design({ items: [item('spot', 1, 0.4)], openings: [door()] }))).toEqual([]);
  });

  it('checks a partition door from the room it opens into, once', () => {
    const a = rectRoom('A');
    const b = rectRoom('B', 4);
    // door on the shared wall; A's edge is (4,0) → (4,3), i.e. wall 'Ac1'
    const shared: Opening = {
      id: 'o2',
      wallId: 'Ac1',
      type: 'door',
      offset: 1,
      width: 0.9,
      height: 2.05,
      sill: 0,
    };
    const inB = item('base-cabinet', 4.5, 1.4, { roomId: 'B' });
    const w = runChecks(design({ rooms: [a, b], items: [inB], openings: [shared] }));
    // swing 'in' means into A, so B only ever sees the landing strip
    expect(kinds(w)).toEqual(['doorLanding']);
    expect(w.filter((x) => x.openingId === 'o2')).toHaveLength(1);
    expect(w[0].roomId).toBe('B');
  });
});

/* ---------------- walkways and work aisles ---------------- */

const seg = (w: Warning): { a: Point; b: Point } => {
  expect(w.geom?.kind).toBe('segment');
  const g = w.geom as { kind: 'segment'; a: Point; b: Point };
  return { a: g.a, b: g.b };
};

const segLen = (w: Warning): number => {
  const { a, b } = seg(w);
  return Math.hypot(b.x - a.x, b.y - a.y);
};

describe('facing-gap checks', () => {
  it('flags a tight walkway between two facing runs, and measures it', () => {
    // wardrobe fronts 80 cm apart: 1.0 m of shared run, neither side is work
    const a = item('wardrobe', 2, 0.8);
    const b = item('wardrobe', 2, 2.2, { rotation: Math.PI });
    const w = runChecks(design({ items: [a, b] }));
    expect(kinds(w)).toEqual(['walkway']);
    expect(w[0].severity).toBe('warn');
    expect(w[0].value).toBeCloseTo(0.8, 6);
    expect(w[0].limit).toBe(CLEARANCE.WALKWAY);
    expect(w[0].itemIds).toEqual([a.id, b.id].sort());
    expect(w[0].id).toBe(`walkway:${[a.id, b.id].sort().join('+')}`);
    expect(w[0].detail).toContain('80 cm');
    expect(segLen(w[0])).toBeCloseTo(0.8, 6);
  });

  it('holds two worktops to the larger work-aisle figure', () => {
    // 1.00 m clears a walkway but not the 1.07 m NKBA work aisle
    const a = item('base-cabinet', 2, 0.9);
    const b = item('base-cabinet', 2, 2.5, { rotation: Math.PI });
    const w = runChecks(design({ items: [a, b] }));
    expect(kinds(w)).toEqual(['workAisle']);
    expect(w[0].value).toBeCloseTo(1.0, 6);
    expect(w[0].limit).toBe(CLEARANCE.WORK_AISLE);
    expect(w[0].detail).toContain('107 cm');
    expect(w[0].detail).toContain('122 cm'); // the two-cook figure, quoted only
    // the very same gap between plain furniture is simply a walkway, and passes
    const c = item('dresser', 2, 1.0);
    const d = item('dresser', 2, 2.45, { rotation: Math.PI });
    expect(runChecks(design({ items: [c, d] }))).toEqual([]);
  });

  it('wants a real run of passage, not a corner clipping past another', () => {
    // same 80 cm gap, but the two fronts only share 40 cm along the passage
    const a = item('wardrobe', 2, 0.8);
    const b = item('wardrobe', 2.6, 2.2, { rotation: Math.PI });
    expect(runChecks(design({ items: [a, b] }))).toEqual([]);
  });

  it('leaves near-touching pairs to the collision family', () => {
    const a = item('wardrobe', 2, 0.8);
    const b = item('wardrobe', 2, 1.5, { rotation: Math.PI }); // 10 cm apart
    const w = runChecks(design({ items: [a, b] }));
    expect(kinds(w)).not.toContain('walkway');
    expect(kinds(w)).toContain('frontClearance'); // the doors still cannot open
  });

  it('measures to the wall FACE, so a partition costs half its thickness', () => {
    const rooms = [rectRoom('A'), rectRoom('B', 4)];
    // wardrobe facing the shared wall; its face sits 5 cm inside the ring
    const wd = item('wardrobe', 2.95, 1.5, { rotation: -Math.PI / 2, roomId: 'A' });
    const w = runChecks(design({ rooms, items: [wd] }));
    expect(kinds(w)).toEqual(['walkway']);
    expect(w[0].itemIds).toEqual([wd.id]);
    expect(w[0].value).toBeCloseTo(0.7, 6); // 0.75 to the ring, 0.70 to the face
    expect(w[0].roomId).toBe('A');
    expect(w[0].detail).toContain('the wall');
  });
});

/* ---------------- front clearance ---------------- */

const of = (ws: Warning[], kind: string, id?: string): Warning | undefined =>
  ws.find((w) => w.kind === kind && (id === undefined || w.itemIds.includes(id)));

describe('front clearance', () => {
  it('asks a hinged door for its leaf width', () => {
    // wardrobe doorPair on a 1.0 m body: each leaf is (1.0 - 3 gaps) / 2
    const tight = item('wardrobe', 2, 0.7, { rotation: Math.PI }); // 40 cm to the wall
    const w = of(runChecks(design({ items: [tight] })), 'frontClearance');
    expect(w?.severity).toBe('warn');
    expect(w?.itemIds).toEqual([tight.id]);
    expect(w?.value).toBeCloseTo(0.4, 6);
    expect(w?.limit).toBeCloseTo(0.494, 3);
    expect(w?.detail).toContain('needs 49 cm to open, has 40 cm');
    expect(segLen(w!)).toBeCloseTo(0.4, 6);
    // 60 cm is enough for the leaf (the walkway is still tight — different news)
    const ok = item('wardrobe', 2, 0.9, { rotation: Math.PI });
    expect(kinds(runChecks(design({ items: [ok] })))).not.toContain('frontClearance');
  });

  it('asks a drawer for its slide travel instead', () => {
    // 3-drawer unit, 60 cm deep: travel is the cavity depth × 0.9
    const tight = item('base-drawers', 2, 0.75, { rotation: Math.PI });
    const w = of(runChecks(design({ items: [tight] })), 'frontClearance');
    expect(w?.value).toBeCloseTo(0.45, 6);
    expect(w?.limit).toBeCloseTo(0.513, 3); // travel, not the 0.59 front width
    const ok = item('base-drawers', 2, 0.9, { rotation: Math.PI });
    expect(kinds(runChecks(design({ items: [ok] })))).not.toContain('frontClearance');
  });

  it('says nothing about a part with no moving fronts', () => {
    // open bookcase 20 cm off the wall: a tight walkway, but nothing to open
    const bc = item('bookcase', 2, 0.36, { rotation: Math.PI });
    expect(kinds(runChecks(design({ items: [bc] })))).toEqual(['walkway']);
  });

  it('only counts blockers that share the front’s height band', () => {
    // the base cabinet is 25 cm in front of the wall unit — and 55 cm below it
    const base = item('base-cabinet', 2, 0.3);
    const wall = item('wall-cabinet', 2, 0.175);
    expect(runChecks(design({ items: [base, wall] }))).toEqual([]);
  });

  it('measures identical parts identically (one shared panel list)', () => {
    const a = item('wardrobe', 1.2, 0.7, { rotation: Math.PI });
    const b = item('wardrobe', 2.4, 0.7, { rotation: Math.PI });
    const w = runChecks(design({ items: [a, b] })).filter((x) => x.kind === 'frontClearance');
    expect(w).toHaveLength(2);
    expect(w[0].limit).toBe(w[1].limit);
  });
});

/* ---------------- bed access ---------------- */

describe('bed access', () => {
  const bedAt = (wardrobeX: number): Design => {
    const bed = item('bed-double', 0.75, 1.5); // long sides at x 0.05 and 1.45
    const wd = item('wardrobe', wardrobeX, 1.5, { rotation: -Math.PI / 2 });
    return design({ items: [bed, wd] });
  };

  it('flags a bed hemmed in on both long sides', () => {
    const w = of(runChecks(bedAt(1.9)), 'bedAccess');
    expect(w?.severity).toBe('warn');
    expect(w?.value).toBeCloseTo(0.15, 6); // the roomier of the two sides
    expect(w?.limit).toBe(CLEARANCE.BED_SIDE);
    expect(w?.detail).toContain('5 cm');
    expect(w?.detail).toContain('15 cm');
    expect(segLen(w!)).toBeCloseTo(0.15, 6);
  });

  it('is happy with one clear side, however tight the other is', () => {
    expect(kinds(runChecks(bedAt(2.6)))).not.toContain('bedAccess');
  });

  it('ignores a nightstand that only covers the head of the bed', () => {
    const bed = item('bed-double', 0.75, 1.5);
    // 45 cm wide, up at the headboard: it takes no part of the way in
    const ns = item('nightstand', 1.75, 0.65, { rotation: -Math.PI / 2 });
    expect(kinds(runChecks(design({ items: [bed, ns] })))).not.toContain('bedAccess');
  });
});

/* ---------------- work triangle ---------------- */

/** sink / hob / fridge laid out on the top wall; hobX moves the middle leg */
function kitchen(hobX: number, extra: Item[] = []): Design {
  return design({
    items: [
      item('fridge', 1.0, 0.4),
      item('appl-sink', 2.2, 0.3),
      item('appl-hob', hobX, 0.3),
      ...extra,
    ],
  });
}

describe('work triangle', () => {
  it('says nothing at all about a compliant kitchen', () => {
    expect(runChecks(kitchen(3.5))).toEqual([]);
  });

  it('reports every leg once one of them is too short', () => {
    const w = runChecks(kitchen(2.8));
    expect(kinds(w)).toEqual(['workTriangle']);
    expect(w[0].severity).toBe('info');
    expect(w[0].itemIds).toHaveLength(3);
    expect(w[0].detail).toContain('Sink→hob 60 cm');
    expect(w[0].detail).toContain('Hob→fridge');
    expect(w[0].detail).toContain('Fridge→sink');
    expect(w[0].detail).toContain('120 cm–270 cm');
    expect(w[0].geom?.kind).toBe('polygon');
    expect((w[0].geom as { points: Point[] }).points).toHaveLength(3);
  });

  it('skips a room that is not a kitchen', () => {
    // no fridge: two of three corners is not a triangle
    expect(
      runChecks(design({ items: [item('appl-sink', 2.2, 0.3), item('appl-hob', 2.8, 0.3)] }))
    ).toEqual([]);
  });

  it('judges the tightest triple when an appliance is doubled', () => {
    const second = item('appl-sink', 3.6, 0.3);
    const w = runChecks(kitchen(2.8, [second]));
    expect(kinds(w)).toEqual(['workTriangle']);
    expect(w[0].detail).toContain('closest of 2 combinations');
    expect(w[0].detail).toContain('Sink→hob 60 cm'); // the near sink, not the far one
    expect(w[0].itemIds).not.toContain(second.id);
  });
});

/* ---------------- output shape ---------------- */

describe('runChecks output', () => {
  it('sorts by severity and keeps ids stable under item reordering', () => {
    const items = [
      item('base-cabinet', 1, 1),
      item('base-cabinet', 1.4, 1),
      item('island', 2.5, 0.1), // free item through the top wall => warn
    ];
    const first = runChecks(design({ items }));
    expect(kinds(first)).toEqual(['overlap', 'throughWall']);
    const second = runChecks(design({ items: [...items].reverse() }));
    expect(second.map((w) => w.id)).toEqual(first.map((w) => w.id));
  });

  it('finds only the known demo hint, and does fire once it is broken', () => {
    // The demo is collision- and clearance-clean (the fridge was moved south
    // once frontClearance caught it against the appliance tower). One real
    // hint stays visible on purpose: sink and hob are 70 cm apart, under the
    // 120 cm shortest work-triangle leg — info severity, a nudge not a defect.
    const demo = runChecks(demoDesign());
    expect(kinds(demo)).toEqual(['workTriangle']);
    expect(demo.every((w) => w.severity !== 'error')).toBe(true);
    const broken = demoDesign();
    const fridge = broken.items.find((i) => i.defId === 'fridge')!;
    fridge.x += 0.5; // shove it through the east wall, into the bedroom
    const w = runChecks(broken);
    expect(new Set(w.map((x) => x.id)).size).toBe(w.length);
    expect(w.some((x) => x.kind === 'throughWall' && x.itemIds[0] === fridge.id)).toBe(true);
    for (const x of w) expect(x.roomId).not.toBe('');
  });
});

/* ---------------- store cache ---------------- */

describe('store warnings cache', () => {
  it('memoizes until the next notify', () => {
    const store = new Store(
      design({ items: [item('base-cabinet', 1, 1), item('base-cabinet', 1.4, 1)] })
    );
    const first = store.warnings();
    expect(first).toHaveLength(1);
    expect(store.warnings()).toBe(first); // same array identity, no recompute

    store.design.items[1].x = 3;
    expect(store.warnings()).toBe(first); // still stale: nothing announced the edit
    store.notify({ structural: false });
    const second = store.warnings();
    expect(second).not.toBe(first);
    expect(second).toEqual([]);
  });

  it('invalidates through undo and replaceDesign', () => {
    const store = new Store(
      design({ items: [item('base-cabinet', 1, 1), item('base-cabinet', 1.4, 1)] })
    );
    expect(store.warnings()).toHaveLength(1);
    store.replaceDesign(design({ items: [item('base-cabinet', 1, 1)] }));
    expect(store.warnings()).toEqual([]);
    store.undo();
    expect(store.warnings()).toHaveLength(1);
  });
});
