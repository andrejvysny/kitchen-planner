import { Box3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import { defOfDesign, partOfDesign } from '../../src/model/attach';
import { makeRoom } from '../../src/model/rooms';
import { emptyDesign } from '../../src/model/store';
import { surfacesOfItem, type Surface } from '../../src/model/surfaces';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { hostContexts } from '../../src/model/worktops';
import { buildItemGroup } from '../../src/view3d/itemMeshes';

/**
 * The anti-drift gate.
 *
 * `src/model/surfaces.ts` reads the panel IR; `src/view3d/partMeshes.ts` turns
 * the SAME list into meshes. Both walk `panel.y`, `shape.h` and `rotY`, and
 * both could quietly stop agreeing — a `+rotY` for a `−rotY`, a thickness
 * added once and not the other time — with nothing to catch it but a mug
 * hovering a centimetre above a shelf in a render nobody looks at closely.
 *
 * So: for every surface, the real mesh whose name IS the surface's `localId`
 * must have its world bounding-box TOP at exactly `Surface.top`, and its plan
 * centre at the surface's centroid. Same instinct as the render manifest's
 * shared golden — one fact, checked from both sides.
 */

const ROOM_STYLE = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.115,
};

function oneRoomDesign(): Design {
  const design = emptyDesign();
  design.rooms = [makeRoom({ name: 'Room 1', x: 0, y: 0, w: 5, d: 4 })];
  design.rooms[0].style = { ...design.rooms[0].style, ...ROOM_STYLE };
  return design;
}

function place(design: Design, defId: string, over: Partial<Item> = {}): Item {
  const def = defOfDesign(design, defId);
  if (!def) throw new Error(`no def ${defId}`);
  const it: Item = {
    id: uid('i'),
    defId,
    x: 1,
    y: 0.5,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    roomId: design.rooms[0].id,
    ...over,
  };
  design.items.push(it);
  return it;
}

/** Every mesh a real View3D rebuild would place, in WORLD space. */
function worldMeshes(design: Design, it: Item): Map<string, Object3D[]> {
  const hosts = hostContexts(design);
  const part = partOfDesign(design, it.defId);
  const g = buildItemGroup(it, defOfDesign(design, it.defId)!, design, part, hosts.get(it.id));
  // exactly what View3D.placeItem does (view3d.ts) — item.elevation is the
  // base Y for everything except ceiling spots, which are not parts
  g.position.set(it.x, it.elevation, it.y);
  g.rotation.y = -it.rotation;
  g.updateMatrixWorld(true);

  const out = new Map<string, Object3D[]>();
  g.traverse((o) => {
    if (!o.name) return;
    const list = out.get(o.name) ?? [];
    list.push(o);
    out.set(o.name, list);
  });
  return out;
}

/** Plan bounds of a polygon — compared against the mesh's own bounding box,
 *  since a chamfered slab's vertex mean is not its bbox centre. */
function planBounds(poly: { x: number; y: number }[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

/** `top` and world plan bounds of a surface's own mesh, or null when it has none. */
function meshFacts(
  meshes: Map<string, Object3D[]>,
  s: Surface
): { top: number; minX: number; maxX: number; minY: number; maxY: number } | null {
  const list = meshes.get(s.localId);
  if (!list?.length) return null;
  // `precise` matters: without it Box3 transforms the geometry's own AABB
  // corners, which over-states a ROTATED non-rectangular prism (an L-shaped
  // corner worktop reports the notch it does not actually fill).
  const box = new Box3();
  for (const o of list) box.union(new Box3().setFromObject(o, true));
  if (box.isEmpty()) return null;
  // three's z IS the plan's y
  return { top: box.max.y, minX: box.min.x, maxX: box.max.x, minY: box.min.z, maxY: box.max.z };
}

const CASES: { defId: string; over?: Partial<Item> }[] = [
  { defId: 'base-cabinet' },
  { defId: 'base-cabinet', over: { rotation: Math.PI / 2 } },
  { defId: 'base-cabinet', over: { rotation: 0.7, w: 1.1 } },
  { defId: 'base-drawers' },
  { defId: 'bookcase' },
  { defId: 'bookcase', over: { rotation: Math.PI } },
  { defId: 'wall-cabinet' },
  { defId: 'wall-shelf' },
  { defId: 'island' },
  { defId: 'pantry' },
  { defId: 'oven-tower' },
  { defId: 'corner-base' },
  { defId: 'corner-base', over: { rotation: -Math.PI / 4 } },
  { defId: 'tv-bench' },
  { defId: 'nightstand' },
  { defId: 'dresser' },
  { defId: 'wardrobe' },
  { defId: 'walk-in-shelving' },
  { defId: 'hallway-unit' },
];

describe('surfaces.ts agrees with the meshes the renderer builds', () => {
  for (const { defId, over } of CASES) {
    const label = over?.rotation ? `${defId} @ ${over.rotation.toFixed(2)} rad` : defId;

    it(`${label}: every surface top matches its mesh bbox top`, () => {
      const design = oneRoomDesign();
      const it0 = place(design, defId, over);
      const surfaces = surfacesOfItem(design, it0, hostContexts(design).get(it0.id));
      expect(surfaces.length).toBeGreaterThan(0);

      const meshes = worldMeshes(design, it0);
      let checked = 0;
      for (const s of surfaces) {
        const m = meshFacts(meshes, s);
        if (!m) continue; // bespoke tops carry no panel mesh; covered separately
        expect(m.top, `${s.id} top`).toBeCloseTo(s.top, 6);
        const b = planBounds(s.outline);
        expect(m.minX, `${s.id} minX`).toBeCloseTo(b.minX, 6);
        expect(m.maxX, `${s.id} maxX`).toBeCloseTo(b.maxX, 6);
        expect(m.minY, `${s.id} minY`).toBeCloseTo(b.minY, 6);
        expect(m.maxY, `${s.id} maxY`).toBeCloseTo(b.maxY, 6);
        checked++;
      }
      expect(checked, 'no surface was matched to a mesh').toBeGreaterThan(0);
    });
  }

  it('a merged run: the leader mesh and the leader surface span the same slab', () => {
    const design = oneRoomDesign();
    const a = place(design, 'base-cabinet', { x: 0.4, y: 0.5 });
    const b = place(design, 'base-cabinet', { x: 0.4 + a.w, y: 0.5 });
    const hosts = hostContexts(design);

    for (const it0 of [a, b]) {
      const s = surfacesOfItem(design, it0, hosts.get(it0.id)).find((x) => x.kind === 'worktop');
      const m = meshFacts(worldMeshes(design, it0), { localId: 'worktop' } as Surface);
      if (!s) {
        expect(m, 'a follower must emit no worktop mesh either').toBeNull();
        continue;
      }
      expect(m).not.toBeNull();
      expect(m!.top).toBeCloseTo(s.top, 6);
      const xs = s.outline.map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(a.w + b.w - 0.05);
    }
  });

  it('a bespoke table top matches the mesh the builder makes', () => {
    const design = oneRoomDesign();
    const t = place(design, 'table', { x: 2, y: 2 });
    const s = surfacesOfItem(design, t)[0];
    const g = buildItemGroup(t, defOfDesign(design, t.defId)!, design, undefined, undefined);
    g.position.set(t.x, t.elevation, t.y);
    g.updateMatrixWorld(true);
    expect(new Box3().setFromObject(g).max.y).toBeCloseTo(s.top, 6);
  });
});
