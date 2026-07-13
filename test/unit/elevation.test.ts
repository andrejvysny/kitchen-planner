import { describe, expect, it } from 'vitest';
import { catalogDef } from '../../src/model/catalog';
import { wallElevation } from '../../src/model/elevation';
import { snapItem } from '../../src/model/snapping';
import { demoDesign, emptyDesign, Store } from '../../src/model/store';
import type { Item } from '../../src/model/types';

/** minimal store-backed Item factory using the snapper (mirrors real placement) */
function placeSnapped(store: Store, defId: string, x: number, y: number): Item {
  const def = store.defOf(defId);
  const s = snapItem(store, def, null, x, y, 0);
  return store.addItem(def, s.x, s.y, s.rotation);
}

describe('wallElevation', () => {
  it('returns only items attached to the wall, excluding free-standing furniture', () => {
    const store = new Store(demoDesign());
    const topWall = store.design.corners[0].id; // (0,0)->(4.2,0) run with the worktop

    const elev = wallElevation(store.design, topWall)!;
    expect(elev).not.toBeNull();

    const kinds = elev.items.map((i) => store.defOf(i.defId).kind);
    // furniture backed onto the top wall shows up
    expect(kinds).toContain('baseCabinet');
    expect(kinds).toContain('wallCabinet');
    expect(kinds).toContain('hood');
    expect(kinds).toContain('outlet');
    // free-standing / ceiling items never do
    expect(kinds).not.toContain('island');
    expect(kinds).not.toContain('stool');
    expect(kinds).not.toContain('pendant');
    expect(kinds).not.toContain('spot');
    // the fridge lives on the right wall, not this one
    expect(kinds).not.toContain('fridge');

    // the window on this wall is reported with its sill/head heights
    expect(elev.openings).toHaveLength(1);
    expect(elev.openings[0].type).toBe('window');
    expect(elev.openings[0].z0).toBeCloseTo(0.95);
    expect(elev.openings[0].z1).toBeCloseTo(0.95 + 1.15);
  });

  it('places the fridge on the right wall only', () => {
    const store = new Store(demoDesign());
    const rightWall = store.design.corners[1].id; // (4.2,0)->(4.2,3.4)
    const elev = wallElevation(store.design, rightWall)!;
    expect(elev.items.map((i) => store.defOf(i.defId).kind)).toContain('fridge');
  });

  it('maps an item to its along-wall position and floor-relative height band', () => {
    const store = new Store(emptyDesign()); // 4x3 room
    const bottom = store.walls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y > 2.9)!;
    const cab = placeSnapped(store, 'base-cabinet', 2.0, 2.8);
    const elev = wallElevation(store.design, bottom.id)!;
    const row = elev.items.find((i) => i.id === cab.id)!;
    expect(row).toBeTruthy();
    // width maps to along-wall span, height to a floor-anchored band
    expect(row.halfW).toBeCloseTo(cab.w / 2);
    expect(row.z0).toBeCloseTo(0);
    expect(row.z1).toBeCloseTo(catalogDef('base-cabinet').h);
    // centre sits at the item's distance along the wall (roughly mid-wall)
    expect(row.center).toBeGreaterThan(0.5);
    expect(row.center).toBeLessThan(bottom.len - 0.5);
  });

  it('excludes a free-standing table dropped near a wall', () => {
    const store = new Store(emptyDesign());
    const bottom = store.walls().find((w) => Math.abs(w.dir.y) < 1e-6 && w.a.y > 2.9)!;
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
