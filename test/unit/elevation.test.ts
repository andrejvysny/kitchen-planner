import { describe, expect, it } from 'vitest';
import { wallElevation, type ElevationFront } from '../../src/model/elevation';
import { presetPart } from '../../src/model/presets';
import { snapItem } from '../../src/model/snapping';
import { demoDesign, emptyDesign, Store } from '../../src/model/store';
import type { CabinetPartDef, Item } from '../../src/model/types';
import { newWardrobePart } from '../../src/model/wardrobe';

/** minimal store-backed Item factory using the snapper (mirrors real placement) */
function placeSnapped(store: Store, defId: string, x: number, y: number): Item {
  const def = store.defOf(defId);
  const s = snapItem(store, def, null, x, y, 0);
  return store.addItem(def, s.x, s.y, s.rotation);
}

describe('wallElevation', () => {
  it('returns only items attached to the wall, excluding free-standing furniture', () => {
    const store = new Store(demoDesign());
    const topWall = store.rooms()[0].corners[0].id; // (0,0)->(4.2,0) run with the worktop

    const elev = wallElevation(store.design, topWall)!;
    expect(elev).not.toBeNull();

    const ids = elev.items.map((i) => i.defId);
    // furniture backed onto the top wall shows up
    expect(ids).toContain('base-cabinet');
    expect(ids).toContain('wall-cabinet');
    expect(ids).toContain('hood');
    expect(ids).toContain('outlet');
    // free-standing / ceiling items never do
    expect(ids).not.toContain('island');
    expect(ids).not.toContain('stool');
    expect(ids).not.toContain('pendant');
    expect(ids).not.toContain('spot');
    // the fridge lives on the right wall, not this one
    expect(ids).not.toContain('fridge');

    // the window on this wall is reported with its sill/head heights
    expect(elev.openings).toHaveLength(1);
    expect(elev.openings[0].type).toBe('window');
    expect(elev.openings[0].z0).toBeCloseTo(0.95);
    expect(elev.openings[0].z1).toBeCloseTo(0.95 + 1.15);
  });

  it('places the fridge on the right wall only', () => {
    const store = new Store(demoDesign());
    const rightWall = store.rooms()[0].corners[1].id; // (4.2,0)->(4.2,3.4)
    const elev = wallElevation(store.design, rightWall)!;
    expect(elev.items.map((i) => i.defId)).toContain('fridge');
  });

  it('maps an item to its along-wall position and floor-relative height band', () => {
    const store = new Store(emptyDesign());
    store.addRoom(); // 4x3 room at the origin
    const bottom = store.allWalls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y > 2.9)!;
    const cab = placeSnapped(store, 'base-cabinet', 2.0, 2.8);
    const elev = wallElevation(store.design, bottom.id)!;
    const row = elev.items.find((i) => i.id === cab.id)!;
    expect(row).toBeTruthy();
    // width maps to along-wall span, height to a floor-anchored band
    expect(row.halfW).toBeCloseTo(cab.w / 2);
    expect(row.z0).toBeCloseTo(0);
    expect(row.z1).toBeCloseTo(store.defOf('base-cabinet').h);
    // centre sits at the item's distance along the wall (roughly mid-wall)
    expect(row.center).toBeGreaterThan(0.5);
    expect(row.center).toBeLessThan(bottom.len - 0.5);
  });

  it('excludes a free-standing table dropped near a wall', () => {
    const store = new Store(emptyDesign());
    store.addRoom();
    const bottom = store.allWalls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y > 2.9)!;
    // a table does not snap/rotate to the wall, so it must not appear in the elevation
    const table = store.addItem(store.defOf('table'), 2.0, 2.2, 0);
    const elev = wallElevation(store.design, bottom.id)!;
    expect(elev.items.some((i) => i.id === table.id)).toBe(false);
  });

  it('returns null for an unknown wall id', () => {
    const store = new Store(emptyDesign());
    expect(wallElevation(store.design, 'nope')).toBeNull();
  });
});

/* ---------------- projected front layouts ---------------- */

/** the two horizontal walls of `store.addRoom()`'s 4x3 room, which run OPPOSITE
 *  ways: the bottom one's `dir` is (-1, 0), the top one's (+1, 0) */
function horizontalWalls(store: Store): { bottom: string; top: string } {
  const flat = store.allWalls().filter((w) => Math.abs(w.dir.y) < 1e-6);
  return {
    bottom: flat.find((w) => w.a.y > 2.9)!.id,
    top: flat.find((w) => w.a.y < 0.1)!.id,
  };
}

/** base-cabinet body with a deliberately LOPSIDED face: a narrow door on the
 *  part's own left, three wide drawers filling the rest */
function asymmetricPart(): CabinetPartDef {
  const part = JSON.parse(JSON.stringify(presetPart('base-cabinet'))) as CabinetPartDef;
  part.id = 'test-asym';
  part.name = 'Asymmetric';
  part.face = {
    kind: 'split',
    dir: 'v',
    weights: [0.25, 0.75],
    children: [
      { kind: 'leaf', fill: 'door', hinge: 'left' },
      { kind: 'leaf', fill: 'drawers', drawers: 3 },
    ],
  };
  return part;
}

const widest = (fronts: ElevationFront[]): ElevationFront =>
  fronts.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a));
const narrowest = (fronts: ElevationFront[]): ElevationFront =>
  fronts.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));

describe('wallElevation front layouts', () => {
  it("projects a cabinet's drawer fronts inside its own elevation rectangle", () => {
    const store = new Store(emptyDesign());
    store.addRoom();
    const { bottom } = horizontalWalls(store);
    const cab = placeSnapped(store, 'base-drawers', 2.0, 2.8);

    const row = wallElevation(store.design, bottom, { fronts: true })!.items.find(
      (i) => i.id === cab.id
    )!;
    const fronts = row.front!;
    expect(fronts.filter((f) => f.kind === 'front').length).toBeGreaterThanOrEqual(3);
    // every projected rectangle stays inside the body the view clips it to
    for (const f of fronts) {
      expect(f.t0).toBeGreaterThanOrEqual(row.center - row.halfW - 1e-9);
      expect(f.t1).toBeLessThanOrEqual(row.center + row.halfW + 1e-9);
      expect(f.z0).toBeGreaterThanOrEqual(row.z0 - 1e-9);
      expect(f.z1).toBeLessThanOrEqual(row.z1 + 1e-9);
      expect(f.z1).toBeGreaterThan(f.z0);
      expect(f.t1).toBeGreaterThan(f.t0);
    }
  });

  it('leaves a bought appliance without a front layout', () => {
    const store = new Store(demoDesign());
    const rightWall = store.rooms()[0].corners[1].id;
    const fridge = wallElevation(store.design, rightWall, { fronts: true })!.items.find(
      (i) => i.defId === 'fridge'
    )!;
    expect(fridge).toBeTruthy();
    // an appliance is a bought product — it has no panel list to project
    expect(fridge.front).toBeUndefined();

    // ...while a preset cabinet on the top wall does get one
    const topWall = store.rooms()[0].corners[0].id;
    const top = wallElevation(store.design, topWall, { fronts: true })!;
    expect(top.items.find((i) => i.defId === 'hood')!.front).toBeUndefined();
    expect(top.items.find((i) => i.defId === 'base-cabinet')!.front!.length).toBeGreaterThan(0);
  });

  it('computes no fronts at all unless asked (hitItem runs at pointer rate)', () => {
    const store = new Store(emptyDesign());
    store.addRoom();
    const { bottom } = horizontalWalls(store);
    placeSnapped(store, 'base-drawers', 2.0, 2.8);
    for (const row of wallElevation(store.design, bottom)!.items) {
      expect(row.front).toBeUndefined();
    }
  });

  it('maps item-local +x onto +t un-mirrored, whichever way the wall runs', () => {
    // The two walls run in OPPOSITE directions, so a projection that flipped
    // the sign — or flipped it per wall — cannot satisfy both assertions.
    const store = new Store(emptyDesign());
    store.addRoom();
    const { bottom, top } = horizontalWalls(store);
    store.materializePart(asymmetricPart());
    const onBottom = placeSnapped(store, 'test-asym', 2.0, 2.8);
    const onTop = placeSnapped(store, 'test-asym', 2.0, 0.2);

    for (const [wallId, item] of [
      [bottom, onBottom],
      [top, onTop],
    ] as const) {
      const row = wallElevation(store.design, wallId, { fronts: true })!.items.find(
        (i) => i.id === item.id
      )!;
      const fronts = row.front!;
      expect(fronts).toHaveLength(4); // one door + three drawer fronts
      // the narrow door is the face's LEFT column, so it sits at the SMALL t
      // end of the item's own span — on both walls, since local +x follows
      // whichever way the wall's `dir` points
      const door = narrowest(fronts);
      expect(door.hinge).toBe('left');
      expect((door.t0 + door.t1) / 2).toBeLessThan(row.center);
      expect(door.t0).toBeCloseTo(row.center - row.halfW, 1);
      // ...and every wide drawer front on the large-t side of the centre
      const drawer = widest(fronts);
      expect((drawer.t0 + drawer.t1) / 2).toBeGreaterThan(row.center);
      expect(drawer.t1).toBeCloseTo(row.center + row.halfW, 1);
    }
  });

  it("tags a sliding wardrobe's panels with the track lane each rides", () => {
    const store = new Store(emptyDesign());
    store.addRoom();
    const { bottom } = horizontalWalls(store);
    const part = newWardrobePart();
    part.front = { kind: 'sliding', panels: 3 };
    store.materializePart(part);
    const item = placeSnapped(store, part.id, 2.0, 2.8);

    const row = wallElevation(store.design, bottom, { fronts: true })!.items.find(
      (i) => i.id === item.id
    )!;
    const slides = row.front!.filter((f) => f.slide !== undefined);
    expect(slides).toHaveLength(3);
    // both lanes are represented — the outer one is what overlaps the others
    expect(slides.some((f) => f.slide === 1)).toBe(true);
    expect(slides.some((f) => f.slide === 0)).toBe(true);
    // a sliding panel never reports a hinge
    expect(slides.every((f) => f.hinge === undefined)).toBe(true);
  });
});
