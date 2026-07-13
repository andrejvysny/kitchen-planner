import { describe, expect, it } from 'vitest';
import { catalogDef } from '../../src/model/catalog';
import { signedArea } from '../../src/model/geometry';
import { snapItem } from '../../src/model/snapping';
import { emptyDesign, normalizeDesign, sanitizeDesign, Store } from '../../src/model/store';
import type { Corner, Design } from '../../src/model/types';

const c = (id: string, x: number, y: number): Corner => ({ id, x, y });

function rectDesign(): Design {
  const d = emptyDesign();
  d.corners = [c('c0', 0, 0), c('c1', 4, 0), c('c2', 4, 3), c('c3', 0, 3)];
  return normalizeDesign(d);
}

describe('normalizeDesign', () => {
  it('reverses clockwise polygons and remaps openings to the flipped walls', () => {
    const d = emptyDesign();
    // clockwise in y-down plan space => signed area negative => must reverse
    d.corners = [c('a', 0, 0), c('b', 0, 3), c('d', 4, 3), c('e', 4, 0)];
    d.openings = [
      { id: 'o1', wallId: 'a', type: 'door', offset: 1, width: 0.9, height: 2, sill: 0 },
    ];
    expect(signedArea(d.corners)).toBeLessThan(0);
    normalizeDesign(d);
    expect(signedArea(d.corners)).toBeGreaterThan(0);
    // wall a→b (len 3) became b→a: same world spot means offset mirrors
    expect(d.openings[0].wallId).toBe('b');
    expect(d.openings[0].offset).toBeCloseTo(2);
  });

  it('keeps counter-clockwise polygons untouched', () => {
    const d = rectDesign();
    const ids = d.corners.map((k) => k.id);
    normalizeDesign(d);
    expect(d.corners.map((k) => k.id)).toEqual(ids);
  });
});

describe('sanitizeDesign', () => {
  it('rejects unusable payloads', () => {
    expect(sanitizeDesign(null)).toBeNull();
    expect(sanitizeDesign('x')).toBeNull();
    expect(sanitizeDesign({})).toBeNull();
    expect(sanitizeDesign({ version: 3, corners: rectDesign().corners })).toBeNull();
    expect(sanitizeDesign({ version: 1, corners: [c('a', 0, 0), c('b', 1, 0)] })).toBeNull();
  });

  it('repairs a minimal payload with defaults', () => {
    const d = sanitizeDesign({ version: 1, corners: [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)] });
    expect(d).not.toBeNull();
    expect(Array.isArray(d!.items)).toBe(true);
    expect(Array.isArray(d!.openings)).toBe(true);
    expect(Array.isArray(d!.customParts)).toBe(true);
    expect(d!.room.wallThickness).toBeGreaterThan(0);
    expect(d!.scene.timeOfDay).toBe(13); // no legacy night → midday default
    expect(d!.scene.envPreset).toBe('studio');
    expect(d!.scene.exposure).toBeGreaterThan(0);
    expect(signedArea(d!.corners)).toBeGreaterThan(0);
  });

  it('migrates a legacy { night } scene to a time-of-day', () => {
    const base = [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)];
    const day = sanitizeDesign({ version: 2, corners: base, scene: { night: false } });
    const night = sanitizeDesign({ version: 2, corners: base, scene: { night: true } });
    expect(day!.scene.timeOfDay).toBe(13);
    expect(night!.scene.timeOfDay).toBe(22);
    // the dead flag is dropped, not carried forward
    expect('night' in (night!.scene as object)).toBe(false);
  });
});

describe('Store mutations', () => {
  it('moveCorner keeps the CCW invariant when the polygon is dragged inside-out', () => {
    const store = new Store(rectDesign());
    store.addOpening(catalogDef('window'), store.walls()[0].id, 2);
    store.commit();
    store.moveCorner('c0', 5.5, 4.5, false);
    store.commit();
    expect(signedArea(store.design.corners)).toBeGreaterThan(0);
    for (const o of store.design.openings) {
      const g = store.wallById(o.wallId)!;
      expect(g).toBeTruthy();
      expect(o.offset).toBeGreaterThanOrEqual(0);
      expect(o.offset).toBeLessThanOrEqual(g.len);
    }
  });

  it('clamps opening offsets sanely on very short walls', () => {
    const store = new Store(rectDesign());
    const left = store.walls().find((w) => Math.abs(w.dir.x) < 1e-6)!;
    store.addOpening(catalogDef('door'), left.id, 1.5);
    store.setWallLength(left.id, 0.35);
    const o = store.design.openings[0];
    const g = store.wallById(o.wallId)!;
    expect(o.offset).toBeGreaterThanOrEqual(0);
    expect(o.offset).toBeLessThanOrEqual(g.len);
  });

  it('deleteCorner re-projects openings onto the merged wall', () => {
    const store = new Store(rectDesign());
    const bottomStart = store.walls().find((w) => w.a.y === 0 && w.b.y === 0)!;
    const mid = store.splitWall(bottomStart.id, bottomStart.len / 2)!;
    // opening at world x=3 on the second half of the split wall
    store.addOpening(catalogDef('window'), mid.id, 1);
    store.deleteCorner(mid.id);
    const o = store.design.openings[0];
    const g = store.wallById(o.wallId)!;
    const world = { x: g.a.x + g.dir.x * o.offset, y: g.a.y + g.dir.y * o.offset };
    expect(world.x).toBeCloseTo(3);
    expect(world.y).toBeCloseTo(0);
  });

  it('setWallLength keeps rectangles rectangular', () => {
    const store = new Store(rectDesign());
    const left = store.walls().find((w) => Math.abs(w.dir.x) < 1e-6)!;
    store.setWallLength(left.id, 3.5);
    const rect = store.rectangleSize();
    expect(rect).not.toBeNull();
    expect([rect!.w, rect!.d].sort()).toEqual([3.5, 4]);
  });

  it('undo with an uncommitted gesture lands on the last committed state', () => {
    const store = new Store(rectDesign());
    const item = store.addItem(catalogDef('base-cabinet'), 1, 1);
    store.commit();
    store.updateItem(item.id, { x: 2 }); // gesture without commit
    store.undo();
    expect(store.itemById(item.id)!.x).toBe(1);
    store.redo();
    expect(store.itemById(item.id)!.x).toBe(2);
  });
});

describe('snapItem', () => {
  it('snaps an item back-to-wall with auto-rotation', () => {
    const store = new Store(rectDesign());
    const res = snapItem(store, catalogDef('base-cabinet'), null, 2, 2.8, 0);
    expect(res.wallId).toBeTruthy();
    expect(res.y).toBeCloseTo(2.65);
    expect(Math.abs(Math.abs(res.rotation) - Math.PI)).toBeLessThan(0.01);
  });

  it('edge snapping cannot push a wall-snapped item past the wall end', () => {
    const store = new Store(rectDesign());
    // neighbour sitting beyond the wall end lures the edge snap outward
    const rogue = store.addItem(catalogDef('base-cabinet'), 4.55, 2.65, Math.PI);
    expect(rogue).toBeTruthy();
    const res = snapItem(store, catalogDef('base-cabinet'), null, 3.9, 2.75, 0);
    expect(res.wallId).toBeTruthy();
    expect(res.x).toBeLessThanOrEqual(3.71);
    expect(res.x).toBeGreaterThanOrEqual(0.29);
  });
});
