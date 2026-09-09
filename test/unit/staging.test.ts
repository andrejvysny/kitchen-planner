import { describe, expect, it } from 'vitest';
import { defOfDesign } from '../../src/model/attach';
import { isDecor } from '../../src/model/catalog';
import { obbOverlap, pointInPolygon } from '../../src/model/geometry';
import { makeRoom } from '../../src/model/rooms';
import { hashString, isStagedItem, planStaging } from '../../src/model/staging';
import { emptyDesign, Store } from '../../src/model/store';
import { surfacesOf } from '../../src/model/surfaces';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';

/* ---------------- fixtures ---------------- */

/** A 4x3 room with a three-unit kitchen run along the top wall, sink in the middle. */
function kitchen(): Design {
  const design = emptyDesign();
  design.rooms = [makeRoom({ name: 'Kitchen', x: 0, y: 0, w: 4, d: 3 })];
  const roomId = design.rooms[0].id;
  const place = (defId: string, x: number, y: number, over: Partial<Item> = {}): Item => {
    const def = defOfDesign(design, defId)!;
    const it: Item = {
      id: uid('i'),
      defId,
      x,
      y,
      rotation: 0,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: def.elevation,
      color: def.color,
      roomId,
      ...over,
    };
    design.items.push(it);
    return it;
  };
  // a 1.8 m run: cabinet · sink base · cabinet
  const a = place('base-cabinet', 0.9, 0.3);
  const host = place('base-cabinet', 1.5, 0.3);
  place('base-cabinet', 2.1, 0.3);
  const sink = place('appl-sink', 1.5, 0.3);
  sink.attach = { kind: 'counter', hostId: host.id, u: 0, v: 0 };
  void a;
  return design;
}

const defIds = (specs: { defId: string }[]): string[] => specs.map((s) => s.defId);

/* ---------------- determinism ---------------- */

describe('determinism', () => {
  it('the same seed reproduces the same arrangement', () => {
    const d = kitchen();
    const a = planStaging(d, d.rooms[0].id, 0.6, 42);
    const b = planStaging(d, d.rooms[0].id, 0.6, 42);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('a different seed gives a different arrangement', () => {
    const d = kitchen();
    const a = planStaging(d, d.rooms[0].id, 0.9, 1);
    const b = planStaging(d, d.rooms[0].id, 0.9, 999);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('the default seed is a pure function of the room id', () => {
    const d = kitchen();
    const a = planStaging(d, d.rooms[0].id, 0.6);
    const b = planStaging(d, d.rooms[0].id, 0.6, hashString(d.rooms[0].id));
    expect(a).toEqual(b);
  });

  it('density 0 stages nothing; density 1 stages more than density 0.2', () => {
    const d = kitchen();
    expect(planStaging(d, d.rooms[0].id, 0)).toEqual([]);
    const low = planStaging(d, d.rooms[0].id, 0.2, 7).length;
    const high = planStaging(d, d.rooms[0].id, 1, 7).length;
    expect(high).toBeGreaterThan(low);
  });
});

/* ---------------- the rules ---------------- */

describe('placement rules', () => {
  it('everything staged is decor, and sits at a real surface height', () => {
    const d = kitchen();
    for (const sp of planStaging(d, d.rooms[0].id, 0.8, 3)) {
      const def = defOfDesign(d, sp.defId)!;
      expect(isDecor(def), sp.defId).toBe(true);
      expect(Number.isFinite(sp.elevation)).toBe(true);
      expect(sp.elevation).toBeGreaterThanOrEqual(0);
    }
  });

  it('nothing lands inside a sink cutout', () => {
    const d = kitchen();
    const worktops = surfacesOf(d).filter((s) => s.kind === 'worktop');
    const holes = worktops.flatMap((s) => s.holes);
    expect(holes.length).toBeGreaterThan(0);
    for (const sp of planStaging(d, d.rooms[0].id, 1, 5)) {
      for (const h of holes) {
        expect(pointInPolygon({ x: sp.x, y: sp.y }, h), `${sp.defId} in a cutout`).toBe(false);
      }
    }
  });

  it('nothing on a worktop lands within the hob exclusion zone', () => {
    const d = kitchen();
    // swap the sink for a hob so the exclusion is the thing under test
    const sink = d.items.find((i) => i.defId === 'appl-sink')!;
    sink.defId = 'appl-hob';
    const hob = { x: sink.x, y: sink.y };
    for (const sp of planStaging(d, d.rooms[0].id, 1, 11)) {
      if (sp.elevation < 0.5) continue; // floor items are not on the run
      expect(Math.hypot(sp.x - hob.x, sp.y - hob.y), sp.defId).toBeGreaterThan(0.44);
    }
  });

  it('staged items never overlap each other at the same height', () => {
    const d = kitchen();
    const specs = planStaging(d, d.rooms[0].id, 1, 21);
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        const a = specs[i];
        const b = specs[j];
        const da = defOfDesign(d, a.defId)!;
        const db = defOfDesign(d, b.defId)!;
        const vert =
          Math.min(a.elevation + da.h, b.elevation + db.h) - Math.max(a.elevation, b.elevation);
        if (vert <= 0.001) continue;
        const hit = obbOverlap(
          { cx: a.x, cy: a.y, w: da.w, d: da.d, rot: a.rotation },
          { cx: b.x, cy: b.y, w: db.w, d: db.d, rot: b.rotation }
        );
        expect(hit, `${a.defId} overlaps ${b.defId}`).toBeNull();
      }
    }
  });

  it('every worktop item sits on a worktop surface it fits inside', () => {
    const d = kitchen();
    const worktops = surfacesOf(d).filter((s) => s.kind === 'worktop');
    for (const sp of planStaging(d, d.rooms[0].id, 1, 33)) {
      const on = worktops.find((s) => Math.abs(s.top - sp.elevation) < 1e-6);
      if (!on) continue;
      expect(pointInPolygon({ x: sp.x, y: sp.y }, on.outline), sp.defId).toBe(true);
    }
  });

  it('an empty room with no surfaces but a floor still gets its plant', () => {
    const d = emptyDesign();
    d.rooms = [makeRoom({ name: 'Empty', x: 0, y: 0, w: 4, d: 3 })];
    const specs = planStaging(d, d.rooms[0].id, 0.6, 2);
    expect(defIds(specs)).toContain('decor-plant');
    expect(specs.filter((s) => s.defId === 'decor-plant').length).toBe(1);
  });

  it('nothing is staged for a room id that is not in the design', () => {
    const d = kitchen();
    expect(planStaging(d, 'nope', 1, 1)).toEqual([]);
  });

  it('a shelf behind a closed door is never staged', () => {
    const d = emptyDesign();
    d.rooms = [makeRoom({ name: 'R', x: 0, y: 0, w: 4, d: 3 })];
    const def = defOfDesign(d, 'base-cabinet')!;
    d.items.push({
      id: uid('i'),
      defId: 'base-cabinet',
      x: 1,
      y: 0.3,
      rotation: 0,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: def.elevation,
      color: def.color,
      roomId: d.rooms[0].id,
    });
    const hidden = surfacesOf(d).filter((s) => s.kind === 'shelf' && !s.visible);
    expect(hidden.length).toBeGreaterThan(0);
    for (const sp of planStaging(d, d.rooms[0].id, 1, 4)) {
      for (const s of hidden) {
        expect(
          Math.abs(sp.elevation - s.top) > 1e-6 || !pointInPolygon({ x: sp.x, y: sp.y }, s.outline)
        ).toBe(true);
      }
    }
  });
});

/* ---------------- the Store side ---------------- */

describe('Store.stageRoom', () => {
  it('stages, and takes exactly one undo step', () => {
    const store = new Store(kitchen());
    const before = store.design.items.length;
    store.stageRoom(undefined, 0.8, 5);
    store.commit();
    expect(store.design.items.length).toBeGreaterThan(before);

    store.undo();
    expect(store.design.items.length).toBe(before);
  });

  it('restaging clears first — pressing twice does not double up', () => {
    const store = new Store(kitchen());
    store.stageRoom(undefined, 0.8, 5);
    store.commit();
    const once = store.design.items.length;
    store.stageRoom(undefined, 0.8, 5);
    store.commit();
    expect(store.design.items.length).toBe(once);
  });

  it('unstageRoom removes only the set dressing', () => {
    const store = new Store(kitchen());
    const bare = store.design.items.length;
    store.stageRoom(undefined, 0.8, 5);
    store.commit();
    expect(store.hasStaging()).toBe(true);

    store.unstageRoom();
    store.commit();
    expect(store.design.items.length).toBe(bare);
    expect(store.hasStaging()).toBe(false);
  });

  it('a hand-placed decor item counts as staging and is cleared too', () => {
    const store = new Store(kitchen());
    const bare = store.design.items.length;
    store.addItem(store.defOf('decor-vase'), 2, 2, 0);
    store.commit();
    expect(store.hasStaging()).toBe(true);
    store.unstageRoom();
    store.commit();
    expect(store.design.items.length).toBe(bare);
  });

  it('isStagedItem is false for cabinets and appliances', () => {
    const d = kitchen();
    for (const it of d.items) expect(isStagedItem(d, it), it.defId).toBe(false);
  });

  it('staged items belong to the room they were staged into', () => {
    const store = new Store(kitchen());
    const rid = store.design.rooms[0].id;
    for (const it of store.stageRoom(rid, 0.8, 5)) expect(it.roomId).toBe(rid);
  });
});
