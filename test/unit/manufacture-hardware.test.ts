import { describe, expect, it } from 'vitest';
import { demoDesign } from '../../src/model/store';
import { partPanels } from '../../src/model/panels';
import { walkZones } from '../../src/model/zones';
import { collectDesign } from '../../src/model/manufacture/collect';
import { DEFAULT_MANUFACTURE, panelParamsFrom, type ManufactureSettings } from '../../src/model/manufacture/settings';
import { hingeCountForHeight, itemDrilling } from '../../src/model/manufacture/drilling';
import { buildHardware } from '../../src/model/manufacture/hardware';
import type { Design } from '../../src/model/types';

const M = DEFAULT_MANUFACTURE;
const pp = panelParamsFrom(M);

/** Independent re-derivation of the coherence counters straight from the model. */
function derive(design: Design): { hinges: number; drawers: number; confirmat: number; legs: number; hangers: number } {
  let hinges = 0, drawers = 0, confirmat = 0, legs = 0, hangers = 0;
  for (const c of collectDesign(design).items) {
    const part = c.part;
    if (!part || part.type !== 'cabinet') continue;
    const wallMounted = c.dims.elevation > 0.3;
    const topT = part.worktop ? pp.worktopT : 0;
    const y0 = !wallMounted && part.plinth ? pp.plinthH : 0;
    const bodyH = c.dims.h - y0 - topT;
    for (const r of walkZones(part.face, c.dims.w, bodyH)) {
      const H = (r.h - pp.reveal) * 1000;
      if (r.leaf.fill === 'door') hinges += hingeCountForHeight(H);
      else if (r.leaf.fill === 'doorPair') hinges += 2 * hingeCountForHeight(H);
      else if (r.leaf.fill === 'drawers') drawers += Math.max(1, r.leaf.drawers ?? 1);
    }
    if (!wallMounted && part.plinth) legs += 4 + (c.dims.w > 0.9 ? 2 : 0);
    if (wallMounted) hangers += 2;
    for (const o of itemDrilling(part, c.dims, partPanels(part, c.dims, pp), M).values())
      for (const d of o.drills) if (d.kind === 'confirmat') confirmat++;
  }
  return { hinges, drawers, confirmat, legs, hangers };
}

describe('hardware schedule — demoDesign', () => {
  const design = demoDesign();
  const hw = buildHardware(design);
  const qty = (re: RegExp): number => hw.find((h) => re.test(h.spec))?.qty ?? 0;
  const d = derive(design);

  it('matches the independently-derived counts', () => {
    // The demo kitchen's manufacturable cabinets are: base-drawers(3 drawers),
    // base-sink(door), base-hob(2 drawers), base-cabinet(door), oven-tower
    // (2 doors + 2 appliance bays), island(3 drawers) — all plinthed floor units
    // — plus the elevated wall-cabinet (a door pair, no plinth, wall-hung).
    expect(d.drawers).toBe(8); // 3 + 2 + 3
    expect(qty(/concealed hinge/)).toBe(d.hinges); // one hinge line, height-tiered totals
    expect(qty(/confirmat/)).toBe(d.confirmat); // connector qty == real drilled through-holes
    expect(qty(/adjustable/)).toBe(d.legs); // 4 per unit (+2 when wider than 900 mm)
    expect(qty(/hanger/)).toBe(d.hangers); // 2 per wall-mounted cabinet
  });

  it('produces the hand-checked totals', () => {
    // Derived above and cross-checked against the model:
    expect(qty(/concealed hinge/)).toBe(12);
    // 90 from the floor units + 8 for the wall cabinet (4 top/bottom↔side
    // joints × 2 screws at 332 mm depth) now that wall units drill too
    expect(qty(/confirmat/)).toBe(98);
    expect(qty(/adjustable/)).toBe(26); // 5 units × 4 + island (>900 mm) × 6
    expect(qty(/hanger/)).toBe(2); // the single wall cabinet
    // 8 drawers → 8 soft-close runner sets, deduped to one NL-550 line
    const runner = hw.find((h) => h.category === 'runner')!;
    expect(runner.qty).toBe(8);
    expect(runner.unit).toBe('set');
    expect(runner.spec).toBe(`${M.drawer.system}, NL 550 mm, soft-close`);
  });

  it('is deduped (one row per spec) and stably ordered', () => {
    const specs = hw.map((h) => h.spec);
    expect(new Set(specs).size).toBe(specs.length); // no duplicate specs
    const order = hw.map((h) => h.category);
    const rank = { hinge: 0, runner: 1, leg: 2, shelfPin: 3, connector: 4, handle: 6, misc: 6 } as const;
    for (let i = 1; i < order.length; i++) expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
    // hinges first, wall hangers last
    expect(hw[0].category).toBe('hinge');
    expect(/hanger/.test(hw[hw.length - 1].spec)).toBe(true);
  });

  it('shelf pins appear for a design with an open-niche cabinet', () => {
    // The demo now ships adjustable shelves behind door fronts: base-cabinet
    // (1 door × 1 shelf → 4 pins) + wall-cabinet (1 door-pair × 1 shelf → 4 pins)
    // = 8 demo pins (oven-tower bays stay shelfless). Adding a 2-shelf open unit
    // (4 pins × 2 = 8) brings the total to 16.
    const base = demoDesign();
    const withOpen: Design = {
      ...base,
      customParts: [
        ...base.customParts,
        {
          id: 'p-open', name: 'Open unit', type: 'cabinet', w: 0.6, d: 0.56, h: 0.72,
          elevation: 0, color: '#8a9683', accentColor: '#c9a87c', footprint: { kind: 'rect' },
          plinth: true, worktop: false, face: { kind: 'leaf', fill: 'open', shelves: 2 },
        },
      ],
      items: [
        ...base.items,
        { id: 'i-open', defId: 'p-open', x: 0.5, y: 0.5, rotation: 0, w: 0.6, d: 0.56, h: 0.72, elevation: 0, color: '#8a9683' },
      ],
    };
    const pins = buildHardware(withOpen).find((h) => h.category === 'shelfPin');
    expect(pins?.qty).toBe(16); // 8 demo (door shelves) + 8 (open unit: 4 × 2 shelves)
    expect(pins?.spec).toBe('5 mm sleeve pin');
  });

  it('cam-lock joinery yields cam sets instead of confirmat screws', () => {
    const cam: Design = { ...demoDesign(), manufacture: { ...M, joinery: 'camlock' } as ManufactureSettings };
    const hwCam = buildHardware(cam);
    expect(hwCam.some((h) => /confirmat/.test(h.spec))).toBe(false);
    const set = hwCam.find((h) => /cam/.test(h.spec))!;
    expect(set.qty).toBe(98); // camBore count == the confirmat count it replaces
    expect(set.unit).toBe('set');
  });
});
