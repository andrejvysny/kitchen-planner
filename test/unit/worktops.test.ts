import { describe, expect, it } from 'vitest';
import { applianceHosting, attachValid, defOfDesign, partOfDesign } from '../../src/model/attach';
import { partPanels, type Panel, type PartDims } from '../../src/model/panels';
import { emptyDesign } from '../../src/model/store';
import type { CabinetPartDef, Design, Item, Point } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { hostContexts, itemRuns, worktopRuns } from '../../src/model/worktops';

/* ---------------- fixtures ---------------- */

/** Place an item of `defId` at its natural size in the first room. */
function place(design: Design, defId: string, over: Partial<Item> = {}): Item {
  const def = defOfDesign(design, defId);
  if (!def) throw new Error(`no def ${defId}`);
  const it: Item = {
    id: uid('i'),
    defId,
    x: 0.4,
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

const dimsOf = (it: Item): PartDims => ({ w: it.w, d: it.d, h: it.h, elevation: it.elevation });

/** Every panel of an item, through the shared host-context composer. */
function panelsOf(design: Design, it: Item, ctxs = hostContexts(design)): Panel[] {
  const part = partOfDesign(design, it.defId);
  if (!part) throw new Error(`no part ${it.defId}`);
  return partPanels(part, dimsOf(it), ctxs.get(it.id));
}

const tops = (panels: Panel[]): Panel[] => panels.filter((p) => p.role === 'worktop');

function outlineOf(p: Panel): Point[] {
  if (p.shape.kind !== 'prism') throw new Error('expected a prism worktop');
  return p.shape.outline;
}

const spanX = (poly: Point[]): number =>
  Math.max(...poly.map((q) => q.x)) - Math.min(...poly.map((q) => q.x));
const spanY = (poly: Point[]): number =>
  Math.max(...poly.map((q) => q.y)) - Math.min(...poly.map((q) => q.y));

/** A run of `n` 60 cm base cabinets starting at `x`, `gap` metres apart. */
function runOf(design: Design, n: number, gap = 0, over: Partial<Item> = {}): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    out.push(place(design, 'base-cabinet', { x: 0.4 + i * (0.6 + gap), y: 0.4, ...over }));
  }
  return out;
}

/** L-footprint cabinet, worktop-bearing — terminates a run. */
function cornerPart(): CabinetPartDef {
  return {
    id: uid('part'),
    name: 'Corner unit',
    type: 'cabinet',
    w: 0.9,
    d: 0.6,
    h: 0.9,
    elevation: 0,
    color: '#8a9683',
    accentColor: '#c9a87c',
    footprint: { kind: 'cornerL', notch: 'left', nw: 0.3, nd: 0.3, face2: 'panel' },
    plinth: true,
    worktop: true,
    face: { kind: 'leaf', fill: 'door' },
  };
}

/* ---------------- runs ---------------- */

describe('worktopRuns', () => {
  it('two flush units merge: the leader spans both, the follower emits nothing', () => {
    const design = emptyDesign();
    const [a, b] = runOf(design, 2);
    const plans = worktopRuns(design);
    expect(plans.get(a.id)).toMatchObject({ role: 'leader' });
    expect(plans.get(b.id)).toEqual({ role: 'follower' });

    const ctxs = hostContexts(design);
    const lead = tops(panelsOf(design, a, ctxs));
    expect(lead).toHaveLength(1);
    expect(tops(panelsOf(design, b, ctxs))).toHaveLength(0);

    // one board 1.2 m long + the side overhangs, depth unchanged
    const poly = outlineOf(lead[0]);
    expect(spanX(poly)).toBeCloseTo(1.2 + 0.02, 9);
    expect(spanY(poly)).toBeCloseTo(0.6 + 0.015 + 0.005, 9);
    // leader-local: its own left edge stays where a lone slab had it
    expect(Math.min(...poly.map((q) => q.x))).toBeCloseTo(-0.3 - 0.01, 9);
    expect(lead[0].y).toBeCloseTo(a.h - 0.035, 9);
    expect(lead[0].slot).toBe('counter');
  });

  it('the merged area equals one long slab, not two short ones', () => {
    const design = emptyDesign();
    const items = runOf(design, 2);
    const ctxs = hostContexts(design);
    const merged = items.flatMap((it) => tops(panelsOf(design, it, ctxs)));
    expect(merged).toHaveLength(1);
    const poly = outlineOf(merged[0]);
    expect(spanX(poly) * spanY(poly)).toBeCloseTo(1.22 * 0.62, 9);
  });

  it('a 5 mm joint still merges; 6 mm is two separate worktops', () => {
    const flush = emptyDesign();
    runOf(flush, 2, 0.005);
    expect(worktopRuns(flush).size).toBe(2);

    const apart = emptyDesign();
    const items = runOf(apart, 2, 0.006);
    expect(worktopRuns(apart).size).toBe(0);
    const ctxs = hostContexts(apart);
    for (const it of items) expect(tops(panelsOf(apart, it, ctxs))).toHaveLength(1);
  });

  it('three flush units become one slab carried by the first', () => {
    const design = emptyDesign();
    const items = runOf(design, 3);
    const plans = worktopRuns(design);
    expect([...plans.values()].map((p) => p.role)).toEqual(['leader', 'follower', 'follower']);
    const poly = outlineOf(tops(panelsOf(design, items[0]))[0]);
    expect(spanX(poly)).toBeCloseTo(1.8 + 0.02, 9);
  });

  it('stacked duplicates are a modelling error, never a run', () => {
    const design = emptyDesign();
    place(design, 'base-cabinet', { x: 1, y: 0.4 });
    place(design, 'base-cabinet', { x: 1, y: 0.4 });
    expect(worktopRuns(design).size).toBe(0);
  });

  it('room, rotation, worktop plane, depth and overhang all split a run', () => {
    const cases: { name: string; over: Partial<Item> }[] = [
      { name: 'rotation', over: { rotation: 0.2 } },
      { name: 'plane', over: { h: 0.92 } },
      { name: 'elevation', over: { elevation: 0.02 } },
      { name: 'depth', over: { d: 0.65 } },
    ];
    for (const c of cases) {
      const design = emptyDesign();
      place(design, 'base-cabinet', { x: 0.4, y: 0.4 });
      place(design, 'base-cabinet', { x: 1.0, y: 0.4, ...c.over });
      expect(worktopRuns(design).size, c.name).toBe(0);
    }
    // a different overhang is a different board
    const ov = emptyDesign();
    const forked: CabinetPartDef = {
      ...(partOfDesign(ov, 'base-cabinet') as CabinetPartDef),
      id: uid('part'),
      worktopOverhang: { front: 0.05, back: 0.005, sides: 0.01 },
    };
    ov.customParts.push(forked);
    place(ov, 'base-cabinet', { x: 0.4, y: 0.4 });
    place(ov, forked.id, { x: 1.0, y: 0.4 });
    expect(worktopRuns(ov).size).toBe(0);
    // …and so is a different room, even at the very same spot
    const rooms = emptyDesign();
    rooms.rooms.push({ ...rooms.rooms[0], id: uid('room'), name: 'Utility' });
    place(rooms, 'base-cabinet', { x: 0.4, y: 0.4, roomId: rooms.rooms[0].id });
    place(rooms, 'base-cabinet', { x: 1.0, y: 0.4, roomId: rooms.rooms[1].id });
    expect(worktopRuns(rooms).size).toBe(0);
  });

  it('a units-apart run merges along its own axis, rotated', () => {
    const design = emptyDesign();
    const r = Math.PI / 2;
    // rotated 90°: the run axis is +y, cabinets stack along it
    const a = place(design, 'base-cabinet', { x: 2.4, y: 1.0, rotation: r });
    place(design, 'base-cabinet', { x: 2.4, y: 1.6, rotation: r });
    const plans = worktopRuns(design);
    expect(plans.get(a.id)?.role).toBe('leader');
    const poly = outlineOf(tops(panelsOf(design, a))[0]);
    expect(spanX(poly)).toBeCloseTo(1.22, 9);
  });

  it('an island run merges independently of the wall run', () => {
    const design = emptyDesign();
    const wall = runOf(design, 2); // along +x at y = 0.4
    const r = Math.PI / 2;
    const isle = [
      place(design, 'base-cabinet', { x: 2.0, y: 2.0, rotation: r }),
      place(design, 'base-cabinet', { x: 2.0, y: 2.6, rotation: r }),
    ];
    const plans = worktopRuns(design);
    expect(plans.size).toBe(4);
    expect(plans.get(wall[0].id)?.role).toBe('leader');
    expect(plans.get(isle[0].id)?.role).toBe('leader');
    expect(plans.get(wall[1].id)?.role).toBe('follower');
    expect(plans.get(isle[1].id)?.role).toBe('follower');
    // the two slabs stay 1.2 m each — no cross-run bleed
    const ctxs = hostContexts(design);
    for (const lead of [wall[0], isle[0]]) {
      expect(spanX(outlineOf(tops(panelsOf(design, lead, ctxs))[0]))).toBeCloseTo(1.22, 9);
    }
  });

  it('an L-footprint neighbour is excluded and keeps its own slab', () => {
    const design = emptyDesign();
    const corner = cornerPart();
    design.customParts.push(corner);
    const c = place(design, corner.id, { x: 0.45, y: 0.4 });
    const a = place(design, 'base-cabinet', { x: 1.2, y: 0.4 });
    const b = place(design, 'base-cabinet', { x: 1.8, y: 0.4 });
    const plans = worktopRuns(design);
    expect(plans.has(c.id)).toBe(false);
    expect(plans.get(a.id)?.role).toBe('leader');
    expect(plans.get(b.id)?.role).toBe('follower');
    const ctxs = hostContexts(design);
    // the corner unit still cuts its own footprint-shaped top
    const own = tops(panelsOf(design, c, ctxs));
    expect(own).toHaveLength(1);
    expect(outlineOf(own[0]).length).toBeGreaterThan(4);
  });

  it('non-candidates never join: no worktop, attached, or a bought product', () => {
    const design = emptyDesign();
    const a = place(design, 'base-cabinet', { x: 0.4, y: 0.4 });
    place(design, 'pantry', { x: 1.0, y: 0.4, h: 0.9 }); // worktop: false
    place(design, 'appl-sink', {
      x: 0.4,
      y: 0.4,
      attach: { kind: 'counter', hostId: a.id, u: 0, v: 0 },
    });
    place(design, 'chair', { x: 1.0, y: 0.4 }); // no part at all
    expect(worktopRuns(design).size).toBe(0);
    expect(itemRuns(design).map((r) => r.length)).toEqual([1]);
  });

  it('itemRuns exposes every run in order, singles included', () => {
    const design = emptyDesign();
    const [a, b] = runOf(design, 2);
    const lone = place(design, 'base-cabinet', { x: 3.0, y: 0.4 });
    const runs = itemRuns(design);
    expect(runs.map((r) => r.map((i) => i.id))).toEqual([[a.id, b.id], [lone.id]]);
  });
});

/* ---------------- the single-unit path must not move ---------------- */

describe('single units stay byte-identical', () => {
  it('a lone cabinet gets no plan and the very same panel list', () => {
    const design = emptyDesign();
    const it = place(design, 'base-cabinet');
    expect(worktopRuns(design).size).toBe(0);
    const part = partOfDesign(design, it.defId)!;
    const before = partPanels(part, dimsOf(it));
    const after = partPanels(part, dimsOf(it), hostContexts(design).get(it.id));
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.find((p) => p.role === 'worktop')?.shape.kind).toBe('box');
  });

  it('a lone host with a cutout matches the plain appliance-hosting context', () => {
    const design = emptyDesign();
    const host = place(design, 'base-cabinet', { w: 0.8 });
    place(design, 'appl-sink', {
      attach: { kind: 'counter', hostId: host.id, u: 0.02, v: 0 },
    });
    const part = partOfDesign(design, host.defId)!;
    const before = partPanels(part, dimsOf(host), applianceHosting(design).get(host.id));
    const after = partPanels(part, dimsOf(host), hostContexts(design).get(host.id));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

/* ---------------- cutouts across a run ---------------- */

describe('cutouts inside a merged run', () => {
  it("a follower's sink lands in the leader's slab at the same world point", () => {
    const design = emptyDesign();
    const r = 0.7; // an angle that is neither axis nor diagonal
    const lead = place(design, 'base-cabinet', { x: 1.2, y: 1.4, w: 0.8, rotation: r });
    const step = { x: 0.8 * Math.cos(r), y: 0.8 * Math.sin(r) };
    const host = place(design, 'base-cabinet', {
      x: lead.x + step.x,
      y: lead.y + step.y,
      w: 0.8,
      rotation: r,
    });
    const anchor = { u: 0.05, v: -0.02 };
    place(design, 'appl-sink', {
      x: host.x,
      y: host.y,
      attach: { kind: 'counter', hostId: host.id, ...anchor },
    });

    const plan = worktopRuns(design).get(lead.id);
    if (plan?.role !== 'leader') throw new Error('expected the first unit to lead');
    expect(plan.holes).toHaveLength(1);
    const hole = plan.holes[0];
    const centre = {
      x: (hole[0].x + hole[2].x) / 2,
      y: (hole[0].y + hole[2].y) / 2,
    };
    // leader-local → world, against the anchor's own host-local → world
    const toWorld = (o: Item, p: Point): Point => ({
      x: o.x + p.x * Math.cos(r) - p.y * Math.sin(r),
      y: o.y + p.x * Math.sin(r) + p.y * Math.cos(r),
    });
    const fromLeader = toWorld(lead, centre);
    const fromHost = toWorld(host, { x: anchor.u, y: anchor.v });
    expect(fromLeader.x - fromHost.x).toBeCloseTo(0, 9);
    expect(fromLeader.y - fromHost.y).toBeCloseTo(0, 9);
    // and the hole is a real hole in the merged board, sized like the cutout
    const top = tops(panelsOf(design, lead))[0];
    if (top.shape.kind !== 'prism') throw new Error('expected a prism');
    expect(top.shape.holes).toHaveLength(1);
    expect(spanX(top.shape.holes![0])).toBeCloseTo(0.5, 9);
    expect(spanY(top.shape.holes![0])).toBeCloseTo(0.4, 9);
    // the host itself cuts nothing any more — its board is gone
    expect(tops(panelsOf(design, host))).toHaveLength(0);
  });

  it('merging leaves the appliance attached to its own host (known limit)', () => {
    const design = emptyDesign();
    place(design, 'base-cabinet', { x: 0.4, y: 0.4, w: 0.8 });
    const host = place(design, 'base-cabinet', { x: 1.2, y: 0.4, w: 0.8 });
    const sink = place(design, 'appl-sink', {
      x: 1.2,
      y: 0.4,
      attach: { kind: 'counter', hostId: host.id, u: 0.02, v: 0 },
    });
    // the rim check still runs against the HOST unit, not the merged slab:
    // a sink may not straddle a joint even though the board is continuous
    expect(attachValid(design, sink)).toBe(true);
    if (sink.attach?.kind !== 'counter') throw new Error('expected a counter attach');
    sink.attach.u = 0.3;
    expect(attachValid(design, sink)).toBe(false);
  });
});

/* ---------------- the composer ---------------- */

describe('hostContexts', () => {
  it('carries appliance hosting and worktop plans in one map', () => {
    const design = emptyDesign();
    const a = place(design, 'base-cabinet', { x: 0.4, y: 0.4, w: 0.8 });
    const b = place(design, 'base-cabinet', { x: 1.2, y: 0.4, w: 0.8 });
    place(design, 'appl-sink', {
      attach: { kind: 'counter', hostId: b.id, u: 0.02, v: 0 },
    });
    const ctxs = hostContexts(design);
    // the follower keeps its cutout entry AND gains its role
    expect(ctxs.get(b.id)?.cutouts).toHaveLength(1);
    expect(ctxs.get(b.id)?.worktop).toEqual({ role: 'follower' });
    // the leader had no appliance of its own: a fresh entry was minted
    expect(ctxs.get(a.id)?.cutouts).toEqual([]);
    expect(ctxs.get(a.id)?.occupiedZones.size).toBe(0);
    expect(ctxs.get(a.id)?.worktop?.role).toBe('leader');
  });
});
