import { describe, expect, it } from 'vitest';
import { defOfDesign, partOfDesign } from '../../src/model/attach';
import { CARCASS_T } from '../../src/model/interior';
import { partPanels, WORKTOP_T, type Panel } from '../../src/model/panels';
import { makeRoom } from '../../src/model/rooms';
import { emptyDesign } from '../../src/model/store';
import {
  clearanceAbove,
  DROP_CEIL,
  itemDims,
  restingElevation,
  surfaceAt,
  surfaceContains,
  surfacesOf,
  surfacesOfItem,
  type Surface,
} from '../../src/model/surfaces';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { hostContexts } from '../../src/model/worktops';

/* ---------------- fixtures ---------------- */

function oneRoomDesign(): Design {
  const design = emptyDesign();
  design.rooms = [makeRoom({ name: 'Room 1', x: 0, y: 0, w: 4, d: 3 })];
  return design;
}

function place(design: Design, defId: string, over: Partial<Item> = {}): Item {
  const def = defOfDesign(design, defId);
  if (!def) throw new Error(`no def ${defId}`);
  const it: Item = {
    id: uid('i'),
    defId,
    x: 1,
    y: 0.4,
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

const kinds = (ss: Surface[]): string[] => ss.map((s) => s.kind);
const byLocalId = (ss: Surface[], id: string): Surface | undefined =>
  ss.find((s) => s.localId === id);
function panelsOf(design: Design, it: Item): Panel[] {
  const part = partOfDesign(design, it.defId);
  if (!part) throw new Error(`no part ${it.defId}`);
  return partPanels(part, itemDims(it), hostContexts(design).get(it.id));
}

/* ---------------- worktops ---------------- */

describe('worktop surfaces', () => {
  it('a standalone cabinet worktop sits at elevation + h (the BOX path)', () => {
    const design = oneRoomDesign();
    const cab = place(design, 'base-cabinet');
    // no cutouts, no run: panels.ts emits a plain box worktop, not a prism
    const wt = panelsOf(design, cab).find((p) => p.role === 'worktop');
    expect(wt?.shape.kind).toBe('box');

    const s = byLocalId(surfacesOfItem(design, cab), 'worktop');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('worktop');
    expect(s!.top).toBeCloseTo(cab.elevation + cab.h, 9);
    expect(s!.visible).toBe(true);
  });

  it('the box worktop keeps its overhang offset, not the item footprint', () => {
    const design = oneRoomDesign();
    const cab = place(design, 'base-cabinet');
    const s = byLocalId(surfacesOfItem(design, cab), 'worktop')!;
    const xs = s.outline.map((p) => p.x);
    const ys = s.outline.map((p) => p.y);
    // overhang widens the slab beyond the carcass on both axes
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(cab.w);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(cab.d);
  });

  it('a merged run yields ONE worktop surface, on the leader', () => {
    const design = oneRoomDesign();
    const a = place(design, 'base-cabinet', { x: 0.4, y: 0.4 });
    const b = place(design, 'base-cabinet', { x: 0.4 + a.w, y: 0.4 });
    const hosts = hostContexts(design);
    const sa = surfacesOfItem(design, a, hosts.get(a.id)).filter((s) => s.kind === 'worktop');
    const sb = surfacesOfItem(design, b, hosts.get(b.id)).filter((s) => s.kind === 'worktop');
    expect(sa.length + sb.length).toBe(1);

    // and it spans the whole run, in world coordinates
    const run = [...sa, ...sb][0];
    const xs = run.outline.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(a.w + b.w - 0.05);
  });

  it('a sink cutout becomes a hole the surface does not contain', () => {
    const design = oneRoomDesign();
    const host = place(design, 'base-cabinet', { x: 1, y: 0.4 });
    const sink = place(design, 'appl-sink', { x: 1, y: 0.4 });
    sink.attach = { kind: 'counter', hostId: host.id, u: 0, v: 0 };

    const s = surfacesOfItem(design, host, hostContexts(design).get(host.id)).find(
      (x) => x.kind === 'worktop'
    )!;
    expect(s.holes.length).toBe(1);
    expect(surfaceContains(s, { x: 1, y: 0.4 })).toBe(false); // inside the cutout
    expect(surfaceContains(s, { x: 1, y: 0.4 })).toBe(false);
    // just outside the cutout, still on the slab
    expect(surfaceContains(s, { x: 1 + host.w / 2 - 0.02, y: 0.4 })).toBe(true);
  });

  it('an attached appliance offers no surfaces of its own', () => {
    const design = oneRoomDesign();
    const host = place(design, 'base-cabinet');
    const sink = place(design, 'appl-sink');
    sink.attach = { kind: 'counter', hostId: host.id, u: 0, v: 0 };
    expect(surfacesOf(design).some((s) => s.hostId === sink.id)).toBe(false);
  });
});

/* ---------------- shelves and niches ---------------- */

describe('shelf and niche surfaces', () => {
  it('an open bookcase offers its niche floor and every shelf, all visible', () => {
    const design = oneRoomDesign();
    const bc = place(design, 'bookcase');
    const ss = surfacesOfItem(design, bc);
    expect(ss.filter((s) => s.kind === 'shelf').length).toBeGreaterThan(0);
    expect(ss.filter((s) => s.kind === 'niche').length).toBe(1);
    expect(ss.every((s) => s.visible)).toBe(true);
  });

  it('a shelf top is its panel bottom plus the board thickness', () => {
    const design = oneRoomDesign();
    const bc = place(design, 'bookcase');
    const shelf = panelsOf(design, bc).find((p) => p.role === 'shelf')!;
    const s = byLocalId(surfacesOfItem(design, bc), shelf.id)!;
    expect(s.top).toBeCloseTo(bc.elevation + shelf.y + CARCASS_T, 9);
  });

  it('a shelf behind a door is found but reported not visible', () => {
    const design = oneRoomDesign();
    const cab = place(design, 'base-cabinet'); // a door fill
    const shelves = surfacesOfItem(design, cab).filter((s) => s.kind === 'shelf');
    expect(shelves.length).toBeGreaterThan(0);
    expect(shelves.every((s) => !s.visible)).toBe(true);
  });

  it("an appliance housing's niche floor is NOT a surface", () => {
    const design = oneRoomDesign();
    const tower = place(design, 'oven-tower');
    const panels = panelsOf(design, tower);
    const nicheBottoms = panels.filter((p) => p.id.endsWith('.niche-bottom'));
    expect(nicheBottoms.length).toBeGreaterThan(0); // the housing emits one

    const ss = surfacesOfItem(design, tower);
    for (const p of nicheBottoms) expect(byLocalId(ss, p.id)).toBeUndefined();
  });

  it('a rod is never a surface', () => {
    const design = oneRoomDesign();
    const wr = place(design, 'wardrobe');
    const rails = panelsOf(design, wr).filter((p) => p.shape.kind === 'cyl');
    const ss = surfacesOfItem(design, wr);
    for (const r of rails) expect(byLocalId(ss, r.id)).toBeUndefined();
  });

  it('a wardrobe still offers its shelves — role-derived, no part-type branch', () => {
    const design = oneRoomDesign();
    const wr = place(design, 'walk-in-shelving');
    expect(surfacesOfItem(design, wr).some((s) => s.kind === 'shelf')).toBe(true);
  });
});

/* ---------------- rotation and frames ---------------- */

describe('coordinate frames', () => {
  it('a rotated host puts its worktop in world space', () => {
    const design = oneRoomDesign();
    // 1.2 m wide so the two axes are tellable apart after a quarter turn
    const flat = place(design, 'base-cabinet', { x: 2, y: 1, w: 1.2, rotation: 0 });
    const turned = place(design, 'base-cabinet', { x: 2, y: 2.4, w: 1.2, rotation: Math.PI / 2 });
    const span = (it: Item): { x: number; y: number } => {
      const s = byLocalId(surfacesOfItem(design, it), 'worktop')!;
      const xs = s.outline.map((p) => p.x);
      const ys = s.outline.map((p) => p.y);
      return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
    };
    const a = span(flat);
    const b = span(turned);
    // a quarter turn swaps the two spans
    expect(b.x).toBeCloseTo(a.y, 9);
    expect(b.y).toBeCloseTo(a.x, 9);
    expect(b.y).toBeGreaterThan(flat.w);

    // and each slab is still centred on its own item
    const s = byLocalId(surfacesOfItem(design, turned), 'worktop')!;
    const xs = s.outline.map((p) => p.x);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(2, 1);
  });

  it('a chamfered cabinet yaws its shelves by MINUS rotY (panels.ts Place)', () => {
    const design = oneRoomDesign();
    const corner = place(design, 'corner-base', { x: 1, y: 1, rotation: 0 });
    const shelf = panelsOf(design, corner).find((p) => p.role === 'shelf' && p.rotY !== 0);
    if (!shelf || shelf.shape.kind !== 'box') return; // preset carries no yawed shelf
    const s = byLocalId(surfacesOfItem(design, corner), shelf.id)!;
    // the long axis of the rect must land along rot(+x, -rotY)
    const c = s.outline;
    const edge = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
    const want = { x: Math.cos(-shelf.rotY), y: Math.sin(-shelf.rotY) };
    const len = Math.hypot(edge.x, edge.y);
    const dot = Math.abs((edge.x * want.x + edge.y * want.y) / len);
    expect(dot).toBeGreaterThan(0.99); // parallel or antiparallel, never the mirror
  });

  it('every outline comes back counter-clockwise', () => {
    const design = oneRoomDesign();
    place(design, 'base-cabinet', { x: 1, y: 0.4, rotation: 0.7 });
    place(design, 'bookcase', { x: 3, y: 1 });
    const area = (poly: { x: number; y: number }[]): number => {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % poly.length];
        a += p.x * q.y - q.x * p.y;
      }
      return a / 2;
    };
    for (const s of surfacesOf(design)) expect(area(s.outline)).toBeLessThan(0);
  });
});

/* ---------------- bespoke tops and floors ---------------- */

describe('bespoke tops and floors', () => {
  it('a table top spans the item and sits at its height', () => {
    const design = oneRoomDesign();
    const t = place(design, 'table', { x: 2, y: 1.5 });
    const ss = surfacesOfItem(design, t);
    expect(kinds(ss)).toEqual(['table']);
    expect(ss[0].top).toBeCloseTo(t.elevation + t.h, 9);
    expect(surfaceContains(ss[0], { x: 2, y: 1.5 })).toBe(true);
  });

  it('a chair seat is deliberately not a surface', () => {
    const design = oneRoomDesign();
    const c = place(design, 'chair', { x: 2, y: 2 });
    expect(surfacesOfItem(design, c)).toEqual([]);
  });

  it('every room contributes a floor at 0', () => {
    const design = oneRoomDesign();
    const floors = surfacesOf(design).filter((s) => s.kind === 'floor');
    expect(floors.length).toBe(1);
    expect(floors[0].top).toBe(0);
    expect(floors[0].roomId).toBe(design.rooms[0].id);
  });
});

/* ---------------- lookups ---------------- */

describe('lookups', () => {
  it('surfaceAt picks the highest surface under the ceiling', () => {
    const design = oneRoomDesign();
    const base = place(design, 'base-cabinet', { x: 1, y: 0.4 });
    place(design, 'wall-cabinet', { x: 1, y: 0.4 });
    const ss = surfacesOf(design);
    const p = { x: 1, y: 0.4 };

    const under = surfaceAt(ss, p, DROP_CEIL)!;
    expect(under.hostId).toBe(base.id);
    expect(under.top).toBeCloseTo(base.elevation + base.h, 9);

    // raise the ceiling and a wall unit's shelf wins
    const high = surfaceAt(ss, p, 3)!;
    expect(high.top).toBeGreaterThan(under.top);
  });

  it('restingElevation falls back to the floor off any surface', () => {
    const design = oneRoomDesign();
    place(design, 'base-cabinet', { x: 1, y: 0.4 });
    const ss = surfacesOf(design);
    expect(restingElevation(ss, { x: 1, y: 0.4 }, DROP_CEIL)).toBeGreaterThan(0.8);
    expect(restingElevation(ss, { x: 3.5, y: 2.5 }, DROP_CEIL)).toBe(0);
  });

  it('clearanceAbove reports the gap to the thing overhead', () => {
    const design = oneRoomDesign();
    const base = place(design, 'base-cabinet', { x: 1, y: 0.4 });
    const wall = place(design, 'wall-cabinet', { x: 1, y: 0.4 });
    const ss = surfacesOf(design);
    const top = ss.find((s) => s.hostId === base.id && s.kind === 'worktop')!;
    const gap = clearanceAbove(ss, top);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(wall.elevation + wall.h - top.top + 1e-6);
  });

  it('an unobstructed surface has infinite clearance', () => {
    const design = oneRoomDesign();
    const t = place(design, 'table', { x: 2, y: 1.5 });
    const ss = surfacesOf(design);
    expect(
      clearanceAbove(
        ss,
        ss.find((s) => s.hostId === t.id)!
      )
    ).toBe(Infinity);
  });

  it('ids are unique and stable across calls', () => {
    const design = oneRoomDesign();
    place(design, 'base-cabinet', { x: 1, y: 0.4 });
    place(design, 'bookcase', { x: 3, y: 1 });
    const a = surfacesOf(design);
    const b = surfacesOf(design);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(new Set(a.map((s) => s.id)).size).toBe(a.length);
  });
});

/* ---------------- the WORKTOP_T sanity anchor ---------------- */

it('the uniform top rule matches the worktop thickness constant', () => {
  const design = oneRoomDesign();
  const cab = place(design, 'base-cabinet');
  const wt = panelsOf(design, cab).find((p) => p.role === 'worktop')!;
  expect(wt.shape.kind === 'box' ? wt.shape.h : 0).toBeCloseTo(WORKTOP_T, 9);
  expect(byLocalId(surfacesOfItem(design, cab), 'worktop')!.top).toBeCloseTo(
    cab.elevation + wt.y + WORKTOP_T,
    9
  );
});
