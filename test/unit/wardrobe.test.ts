import { describe, expect, it } from 'vitest';
import { CARCASS_T, MIN_ELEM_SPACE, RAIL_DIA, resolveInterior } from '../../src/model/interior';
import type { Panel, PartDims } from '../../src/model/panels';
import { sanitizePart } from '../../src/model/parts';
import type {
  CabinetPartDef,
  WardrobeColumn,
  WardrobePartDef,
  WardrobeSection,
} from '../../src/model/types';
import { bboxOf } from './fixtures';
import {
  AUTO_PAIR_W,
  COL_MIN_W,
  HANG_DROP,
  HAT_SHELF_UP,
  MAX_COLUMNS,
  MAX_SECTIONS,
  newWardrobePart,
  SEC_MIN_H,
  SLIDING_OVERLAP,
  sanitizeWardrobeFields,
  sectionInterior,
  wardrobeLayout,
  wardrobePanels,
  wardrobePlanSymbol,
  wardrobeSectionCavity,
} from '../../src/model/wardrobe';

/* ---------------- fixtures ---------------- */

let seq = 0;
const shelves = (count = 2, h: number | 'fill' = 'fill'): WardrobeSection => ({
  kind: 'shelves',
  h,
  count,
});
const col = (
  w: WardrobeColumn['w'],
  sections: WardrobeSection[] = [shelves()],
  door: WardrobeColumn['door'] = 'auto'
): WardrobeColumn => ({ id: `c${++seq}`, w, sections, door });

const wardrobe = (over: Partial<WardrobePartDef> = {}): WardrobePartDef => ({
  ...newWardrobePart(),
  ...over,
});

const dimsOf = (p: WardrobePartDef, over: Partial<PartDims> = {}): PartDims => ({
  w: p.w,
  d: p.d,
  h: p.h,
  elevation: p.elevation,
  ...over,
});

const widths = (p: WardrobePartDef): (number | 'fill')[] => p.columns.map((c) => c.w);

/* ---------------- 1-8: sanitizer ---------------- */

describe('sanitizeWardrobeFields — fill uniqueness', () => {
  it('makes the LAST column fill when none is', () => {
    const p = wardrobe({ columns: [col(0.5), col(0.6)] });
    sanitizeWardrobeFields(p);
    expect(widths(p)).toEqual([0.5, 'fill']);
  });

  it('keeps the FIRST fill column and fixes the rest', () => {
    const p = wardrobe({ columns: [col('fill'), col('fill'), col('fill')] });
    sanitizeWardrobeFields(p);
    expect(widths(p)).toEqual(['fill', COL_MIN_W, COL_MIN_W]);
  });

  it('applies the same repair to a column section stack', () => {
    const p = wardrobe({
      columns: [
        col('fill', [shelves(2, 0.4), shelves(2, 0.5)]),
        col(0.6, [shelves(2, 'fill'), shelves(2, 'fill'), shelves(2, 'fill')]),
      ],
    });
    sanitizeWardrobeFields(p);
    expect(p.columns[0].sections.map((s) => s.h)).toEqual([0.4, 'fill']);
    expect(p.columns[1].sections.map((s) => s.h)).toEqual(['fill', SEC_MIN_H, SEC_MIN_H]);
  });

  it('never reorders columns or sections', () => {
    const p = wardrobe({
      columns: [col(0.5, [shelves(1, 0.3), shelves(4, 'fill')]), col('fill'), col(0.4)],
    });
    const order = p.columns.map((c) => c.id);
    const counts = p.columns[0].sections.map((s) => s.count);
    sanitizeWardrobeFields(p);
    expect(p.columns.map((c) => c.id)).toEqual(order);
    expect(p.columns[0].sections.map((s) => s.count)).toEqual(counts);
  });
});

describe('sanitizeWardrobeFields — widths', () => {
  it('scales the fixed columns down when they leave the fill one nothing', () => {
    const p = wardrobe({ w: 2, columns: [col(1.2), col(1.0), col('fill')] });
    sanitizeWardrobeFields(p);
    const fixed = p.columns.filter((c) => c.w !== 'fill').map((c) => c.w as number);
    expect(fixed[0] / fixed[1]).toBeCloseTo(1.2, 9); // proportions preserved
    expect(fixed[0] + fixed[1]).toBeCloseTo(2 - COL_MIN_W, 9);
    // and the layout still gives the fill column its minimum
    const lay = wardrobeLayout(p, dimsOf(p));
    const fill = lay.columns.find((c) => c.fill)!;
    expect(fill.x1 - fill.x0).toBeGreaterThanOrEqual(COL_MIN_W - 1e-12);
  });

  it('leaves a run that already fits alone', () => {
    const p = wardrobe({ w: 3, columns: [col(0.8), col('fill'), col(0.6)] });
    sanitizeWardrobeFields(p);
    expect(widths(p)).toEqual([0.8, 'fill', 0.6]);
  });
});

describe('sanitizeWardrobeFields — ids', () => {
  it('rewrites duplicate and missing column ids', () => {
    const p = wardrobe({
      columns: [
        { id: 'a', w: 0.5, sections: [shelves()], door: 'auto' },
        { id: 'a', w: 0.5, sections: [shelves()], door: 'auto' },
        { id: '', w: 'fill', sections: [shelves()], door: 'auto' },
      ],
    });
    sanitizeWardrobeFields(p);
    const ids = p.columns.map((c) => c.id);
    expect(ids[0]).toBe('a'); // the first holder keeps it
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
});

describe('sanitizeWardrobeFields — clamps', () => {
  it('clamps counts, lists and envelope numbers', () => {
    const p = wardrobe({
      w: 6,
      columns: Array.from({ length: 12 }, (_, i) => col(i === 0 ? 'fill' : 0.3)),
      plinthH: 5,
      filler: { left: 1, right: -1 },
      cornice: 9,
      topRow: { h: 0.1, doors: true },
    });
    p.columns[0].sections = Array.from({ length: 9 }, () => shelves(99, 0.2));
    sanitizeWardrobeFields(p);
    expect(p.columns).toHaveLength(MAX_COLUMNS);
    expect(p.columns[0].sections).toHaveLength(MAX_SECTIONS);
    expect(p.columns[0].sections.every((s) => s.count === 6)).toBe(true);
    expect(p.plinthH).toBe(0.2);
    expect(p.filler).toEqual({ left: 0.1, right: 0 });
    expect(p.cornice).toBe(0.3);
    expect(p.topRow).toEqual({ h: 0.25, doors: true });
  });

  it('caps a drawer stack behind a door at 4 but an exposed one at 8', () => {
    const p = wardrobe({
      columns: [
        col('fill', [{ kind: 'drawers', h: 'fill', count: 9 }]),
        col(0.5, [{ kind: 'drawers', h: 'fill', count: 9, exposed: true }]),
      ],
    });
    sanitizeWardrobeFields(p);
    expect(p.columns[0].sections[0].count).toBe(4);
    expect(p.columns[1].sections[0].count).toBe(8);
  });

  it('drops a zero/absent cornice, an all-false light and a malformed top row', () => {
    const p = wardrobe({
      cornice: 0,
      light: { cove: false, shelves: false },
      topRow: undefined,
    });
    sanitizeWardrobeFields(p);
    expect('cornice' in p).toBe(false);
    expect('light' in p).toBe(false);
    expect('topRow' in p).toBe(false);
  });

  it('forces a wall side to carry no filler', () => {
    const p = wardrobe({
      sides: { left: 'wall', right: 'panel' },
      filler: { left: 0.08, right: 0.05 },
    });
    sanitizeWardrobeFields(p);
    expect(p.filler).toEqual({ left: 0, right: 0.05 });
  });
});

describe('sanitizeWardrobeFields — per-kind flags', () => {
  it('deletes exposed on a hanging section and under a sliding front', () => {
    const hinged = wardrobe({
      columns: [col('fill', [{ kind: 'hanging', h: 'fill', exposed: true }])],
    });
    sanitizeWardrobeFields(hinged);
    expect('exposed' in hinged.columns[0].sections[0]).toBe(false);

    const sliding = wardrobe({
      front: { kind: 'sliding', panels: 2 },
      columns: [col('fill', [{ kind: 'drawers', h: 'fill', count: 3, exposed: true }])],
    });
    sanitizeWardrobeFields(sliding);
    expect('exposed' in sliding.columns[0].sections[0]).toBe(false);
  });

  it('deletes an interior on a non-custom section and keeps a sanitized one on custom', () => {
    const p = wardrobe({
      columns: [
        col('fill', [
          {
            kind: 'shelves',
            h: 'fill',
            count: 2,
            interior: { mode: 'auto', shelves: 2, innerDrawers: 0 },
          },
        ]),
        col(0.5, [
          {
            kind: 'custom',
            h: 'fill',
            interior: { mode: 'custom', elements: [{ kind: 'shelf', y: 0.5 }] },
          },
        ]),
      ],
    });
    sanitizeWardrobeFields(p);
    expect('interior' in p.columns[0].sections[0]).toBe(false);
    expect(p.columns[1].sections[0].interior).toEqual({
      mode: 'custom',
      elements: [{ kind: 'shelf', y: 0.5 }],
    });
  });

  it('deletes pullDown outside a hanging section and a mirror outside a hinged front', () => {
    const p = wardrobe({
      front: { kind: 'sliding', panels: 3 },
      mirror: true,
      columns: [
        col('fill', [{ kind: 'shelves', h: 'fill', count: 2, pullDown: true }]),
        col(0.5, [{ kind: 'hanging', h: 'fill', pullDown: true }]),
      ],
    });
    sanitizeWardrobeFields(p);
    expect('pullDown' in p.columns[0].sections[0]).toBe(false);
    expect(p.columns[1].sections[0].pullDown).toBe(true);
    expect('mirror' in p).toBe(false);
  });

  it('normalizes the front union', () => {
    const bad = wardrobe({ front: { kind: 'wat' } as unknown as WardrobePartDef['front'] });
    sanitizeWardrobeFields(bad);
    expect(bad.front).toEqual({ kind: 'hinged' });

    const slide = wardrobe({
      front: { kind: 'sliding', panels: 7, mirror: true } as unknown as WardrobePartDef['front'],
    });
    sanitizeWardrobeFields(slide);
    expect(slide.front).toEqual({ kind: 'sliding', panels: 2, mirror: true });
  });
});

describe('sanitizePart — per-type dimension limits', () => {
  it('gives a wardrobe its own taller/shallower envelope', () => {
    const tall = sanitizePart(wardrobe({ h: 3.6 })) as WardrobePartDef;
    expect(tall.h).toBe(3.6);
    const over = sanitizePart(wardrobe({ h: 9, d: 1.4, w: 0.1 })) as WardrobePartDef;
    expect(over.h).toBe(4.0);
    expect(over.d).toBe(1.0);
    expect(over.w).toBe(0.3);
  });

  it('leaves the cabinet clamps exactly where they were', () => {
    const cab: CabinetPartDef = {
      ...(sanitizePart({
        id: 'p1',
        name: 'c',
        type: 'cabinet',
        w: 0.8,
        d: 0.45,
        h: 3.0,
        elevation: 0,
        color: '#fff',
        accentColor: '#fff',
        footprint: { kind: 'rect' },
        plinth: true,
        worktop: true,
        face: { kind: 'leaf', fill: 'door' },
      }) as CabinetPartDef),
    };
    expect(cab.h).toBe(2.6);
  });

  it('round-trips the default wardrobe unchanged', () => {
    const p = newWardrobePart();
    const before = structuredClone(p);
    expect(sanitizePart(p)).toEqual(before);
  });
});

/* ---------------- 9-14: layout ---------------- */

describe('wardrobeLayout — horizontal', () => {
  const p = wardrobe({
    w: 2.4,
    filler: { left: 0.05, right: 0 },
    columns: [col(0.5), col('fill'), col(0.7)],
  });

  it('covers the part width exactly', () => {
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const sum = lay.columns.reduce((s, c) => s + (c.x1 - c.x0), 0);
    const total = 0.05 + CARCASS_T + sum + (lay.columns.length - 1) * CARCASS_T + CARCASS_T + 0;
    expect(total).toBeCloseTo(2.4, 9);
    expect(lay.columns[0].x0).toBeCloseTo(lay.inner.x0, 12);
    expect(lay.columns[2].x1).toBeCloseTo(lay.inner.x1, 12);
    for (let i = 1; i < lay.columns.length; i++) {
      expect(lay.columns[i].x0 - lay.columns[i - 1].x1).toBeCloseTo(CARCASS_T, 12);
    }
  });

  it('laps the front over the full end panel and half an internal divider', () => {
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    expect(lay.columns[0].fx0).toBeCloseTo(lay.columns[0].x0 - CARCASS_T, 12);
    expect(lay.columns[0].fx1).toBeCloseTo(lay.columns[0].x1 + CARCASS_T / 2, 12);
    expect(lay.columns[2].fx1).toBeCloseTo(lay.columns[2].x1 + CARCASS_T, 12);
  });

  it('spans the whole width when both sides are walls', () => {
    const walls = wardrobe({
      w: 2.2,
      sides: { left: 'wall', right: 'wall' },
      filler: { left: 0.1, right: 0.1 },
    });
    sanitizeWardrobeFields(walls);
    const lay = wardrobeLayout(walls, dimsOf(walls));
    expect(lay.inner.x0).toBeCloseTo(-1.1, 12);
    expect(lay.inner.x1).toBeCloseTo(1.1, 12);
    expect(lay.columns[0].fx0).toBeCloseTo(-1.1, 12);
  });

  it('gives extra width to the fill column alone', () => {
    const q = wardrobe({ w: 2.4, columns: [col(0.5), col('fill'), col(0.7)] });
    sanitizeWardrobeFields(q);
    const a = wardrobeLayout(q, dimsOf(q));
    const b = wardrobeLayout(q, dimsOf(q, { w: 2.9 }));
    const wOf = (lay: ReturnType<typeof wardrobeLayout>): number[] =>
      lay.columns.map((c) => c.x1 - c.x0);
    expect(wOf(b)[0]).toBeCloseTo(wOf(a)[0], 12);
    expect(wOf(b)[2]).toBeCloseTo(wOf(a)[2], 12);
    expect(wOf(b)[1] - wOf(a)[1]).toBeCloseTo(0.5, 12);
  });
});

describe('wardrobeLayout — vertical', () => {
  it('tiles a section stack across the column with one divider between each pair', () => {
    const p = wardrobe({
      h: 2.4,
      plinthH: 0.1,
      columns: [col('fill', [shelves(2, 0.6), shelves(2, 'fill'), shelves(2, 0.3)])],
    });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const secs = lay.columns[0].sections;
    const colBot = lay.body.y0 + CARCASS_T;
    const colTop = lay.body.y1; // no top row
    const sum = secs.reduce((s, x) => s + (x.y1 - x.y0), 0);
    expect(sum + (secs.length - 1) * CARCASS_T).toBeCloseTo(colTop - colBot, 9);
    expect(secs[0].y0).toBeCloseTo(colBot, 12);
    expect(secs[2].y1).toBeCloseTo(colTop, 12);
  });

  it('parks the top row above the column stack', () => {
    const p = wardrobe({ h: 2.6, topRow: { h: 0.4, doors: true } });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const secs = lay.columns[0].sections;
    const colTop = secs[secs.length - 1].y1;
    expect(lay.topRow).not.toBeNull();
    expect(lay.topRow!.y0).toBeCloseTo(colTop + CARCASS_T, 12);
    expect(colTop + CARCASS_T + 0.4).toBeCloseTo(lay.body.y1, 12);
    expect(lay.topRow!.y1).toBeCloseTo(lay.body.y1, 12);
    expect(lay.topRow!.doors).toBe(true);
  });
});

describe('wardrobeLayout — doors', () => {
  it('pairs an auto door wider than AUTO_PAIR_W and hinges singles on the outer edge', () => {
    const p = wardrobe({ w: 3, columns: [col(0.5), col('fill'), col(0.5)] });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    expect(lay.columns[1].fx1 - lay.columns[1].fx0).toBeGreaterThan(AUTO_PAIR_W);
    expect(lay.columns.map((c) => c.door)).toEqual(['left', 'pair', 'right']);
    expect(lay.columns[0].doors[0].side).toBe('left');
    expect(lay.columns[2].doors[0].side).toBe('right');
    expect(lay.columns[1].doors[0].pair).toBe(true);
    expect(lay.columns[0].doors[0].unit).toBe(`${lay.columns[0].id}.door0`);
  });

  it('hinges a middle single on the left', () => {
    const p = wardrobe({ w: 2.1, columns: [col(0.5), col(0.5), col('fill'), col(0.5)] });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    expect(lay.columns[2].door).toBe('left');
  });

  it('splits a run at an exposed section and labels the covered ones', () => {
    const p = wardrobe({
      columns: [
        col('fill', [
          shelves(2, 0.4),
          { kind: 'drawers', h: 0.5, count: 3, exposed: true },
          shelves(2, 'fill'),
        ]),
      ],
    });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const c = lay.columns[0];
    expect(c.doors).toHaveLength(2);
    expect(c.doors[0].unit).toBe(`${c.id}.door0`);
    expect(c.doors[1].unit).toBe(`${c.id}.door1`);
    expect(c.sections.map((s) => s.doorUnit)).toEqual([c.doors[0].unit, null, c.doors[1].unit]);
    expect(c.doors[0].y1).toBeCloseTo(c.sections[0].y1, 12);
    expect(c.doors[1].y0).toBeCloseTo(c.sections[2].y0, 12);
  });

  it('emits no runs under a doorless or sliding front', () => {
    const none = wardrobe({ front: { kind: 'none' }, columns: [col('fill')] });
    sanitizeWardrobeFields(none);
    expect(wardrobeLayout(none, dimsOf(none)).columns[0].doors).toEqual([]);

    const slide = wardrobe({ front: { kind: 'sliding', panels: 2 }, columns: [col('fill')] });
    sanitizeWardrobeFields(slide);
    const lay = wardrobeLayout(slide, dimsOf(slide));
    expect(lay.columns[0].door).toBe('none');
    expect(lay.columns[0].sections[0].doorUnit).toBeNull();
  });
});

describe('wardrobeLayout — sliding front', () => {
  it('overlaps its panels across the full width and alternates the tracks', () => {
    const p = wardrobe({ w: 2, front: { kind: 'sliding', panels: 3 } });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    expect(lay.front.kind).toBe('sliding');
    if (lay.front.kind !== 'sliding') throw new Error('unreachable');
    const { panels, panelW } = lay.front;
    expect(panels).toHaveLength(3);
    expect(panelW * 3 - 2 * SLIDING_OVERLAP).toBeCloseTo(2, 12);
    expect(panels[0].x0).toBeCloseTo(-1, 12);
    expect(panels[2].x1).toBeCloseTo(1, 12);
    expect(panels.map((x) => x.layer)).toEqual([0, 1, 0]);
    expect(panels.every((x) => x.travel > 0)).toBe(true);
    expect(panels.map((x) => x.dir)).toEqual([1, 1, -1]);
    expect(lay.front.zOuter).toBeCloseTo(lay.depth.zFrontFace, 12);
    expect(lay.front.zOuter - lay.front.zInner).toBeCloseTo(0.018 + 0.004, 12);
    expect(lay.depth.frontD).toBeCloseTo(0.1, 12);
  });
});

describe('wardrobeLayout — depth', () => {
  it('reduces to the cabinet body math on a hinged, backed carcass', () => {
    const p = wardrobe({ d: 0.6, back: true });
    sanitizeWardrobeFields(p);
    const { depth } = wardrobeLayout(p, dimsOf(p));
    expect(depth.bodyD).toBeCloseTo(0.6 - 0.018, 12); // cabinetPanels' `cd`
    expect(depth.zBody).toBeCloseTo(-0.018 / 2, 12); // its `zc`
    expect(depth.cavD).toBeCloseTo(0.6 - 0.018 - 0.012, 12);
    expect(depth.zBodyFront).toBeCloseTo(0.3 - 0.018, 12);
    expect(depth.zFrontFace).toBeCloseTo(0.3 - 0.018 / 2, 12);
  });

  it('gives the whole body depth back when there is no front and no back', () => {
    const p = wardrobe({ d: 0.5, back: false, front: { kind: 'none' } });
    sanitizeWardrobeFields(p);
    const { depth } = wardrobeLayout(p, dimsOf(p));
    expect(depth.frontD).toBe(0);
    expect(depth.bodyD).toBeCloseTo(0.5, 12);
    expect(depth.cavD).toBeCloseTo(0.5, 12);
  });
});

describe('wardrobeLayout — degenerate input', () => {
  it('stays finite on a tiny part packed with columns', () => {
    const p = wardrobe({
      w: 0.3,
      h: 0.4,
      d: 0.3,
      columns: Array.from({ length: 8 }, (_, i) => col(i === 0 ? 'fill' : 0.3)),
    });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const nums: number[] = [
      lay.body.y0,
      lay.body.y1,
      lay.body.sideH,
      lay.body.divH,
      lay.inner.x0,
      lay.inner.x1,
      lay.inner.w,
      lay.depth.cavD,
      lay.depth.zCav,
      ...lay.columns.flatMap((c) => [
        c.x0,
        c.x1,
        c.fx0,
        c.fx1,
        ...c.sections.flatMap((s) => [s.y0, s.y1]),
      ]),
    ];
    expect(nums.every((v) => Number.isFinite(v))).toBe(true);
    expect(lay.columns).toHaveLength(8);
  });

  it('survives a part with no columns at all', () => {
    const p = wardrobe({ columns: [] });
    const lay = wardrobeLayout(p, dimsOf(p));
    expect(lay.columns).toEqual([]);
    expect(Number.isFinite(lay.inner.w)).toBe(true);
  });
});

/* ---------------- section cavity + interior ---------------- */

describe('wardrobeSectionCavity', () => {
  it('reports the column cavity with a zero-based local bottom', () => {
    const p = wardrobe({
      columns: [col('fill', [shelves(2, 0.6), shelves(2, 'fill')])],
    });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const cav = wardrobeSectionCavity(p, dimsOf(p), 0, 1)!;
    const c = lay.columns[0];
    expect(cav.x0).toBeCloseTo(c.x0, 12);
    expect(cav.w).toBeCloseTo(c.x1 - c.x0, 12);
    expect(cav.y0).toBe(0);
    expect(cav.h).toBeCloseTo(c.sections[1].y1 - c.sections[1].y0, 12);
  });

  it('is null out of range', () => {
    const p = newWardrobePart();
    expect(wardrobeSectionCavity(p, dimsOf(p), 9, 0)).toBeNull();
    expect(wardrobeSectionCavity(p, dimsOf(p), 0, 9)).toBeNull();
  });
});

describe('sectionInterior', () => {
  it('drops a hanging rail HANG_DROP below the cavity top', () => {
    const inter = sectionInterior({ kind: 'hanging', h: 'fill' }, 2.0)!;
    const els = resolveInterior(inter, 2.0);
    expect(els.filter((e) => e.kind === 'rail')).toHaveLength(1);
    expect(els.find((e) => e.kind === 'rail')!.y).toBeCloseTo(2.0 - HANG_DROP - HAT_SHELF_UP, 12);
  });

  it('adds the hat shelf above the rail when it clears the cavity top', () => {
    // Rail drops HANG_DROP + HAT_SHELF_UP, shelf sits HAT_SHELF_UP above it,
    // so the shelf keeps HANG_DROP (> MIN_ELEM_SPACE/2) of clear air.
    expect(HANG_DROP).toBeGreaterThan(MIN_ELEM_SPACE / 2);
    for (const cavH of [0.5, 1.2, 2.0, 2.4]) {
      const inter = sectionInterior({ kind: 'hanging', h: 'fill' }, cavH)!;
      if (inter.mode !== 'custom') throw new Error('unreachable');
      const shelf = inter.elements.filter((e) => e.kind === 'shelf');
      expect(shelf).toHaveLength(1);
      expect((shelf[0] as { y: number }).y).toBeCloseTo(
        Math.max(MIN_ELEM_SPACE, cavH - HANG_DROP - HAT_SHELF_UP) + HAT_SHELF_UP,
        12
      );
      // and the resolved form keeps both elements
      expect(resolveInterior(inter, cavH)).toHaveLength(2);
    }
    // a section too short for the shelf keeps just the rail
    const short = sectionInterior({ kind: 'hanging', h: 'fill' }, 0.14)!;
    if (short.mode !== 'custom') throw new Error('unreachable');
    expect(short.elements.filter((e) => e.kind === 'shelf')).toHaveLength(0);
  });

  it('puts two rails in a double-hang column and one in a short one', () => {
    const tall = resolveInterior(sectionInterior({ kind: 'hangingDouble', h: 'fill' }, 2.2), 2.2);
    expect(tall.filter((e) => e.kind === 'rail')).toHaveLength(2);
    // at 1.05 m the two rails land on the same height and resolveInterior's
    // overlap rule keeps only the lower one
    const short = resolveInterior(
      sectionInterior({ kind: 'hangingDouble', h: 'fill' }, 1.05),
      1.05
    );
    expect(short.filter((e) => e.kind === 'rail')).toHaveLength(1);
  });

  it('passes a shelf count straight through as an auto interior', () => {
    expect(sectionInterior({ kind: 'shelves', h: 'fill', count: 5 }, 1.2)).toEqual({
      mode: 'auto',
      shelves: 5,
      innerDrawers: 0,
    });
  });

  it('stacks internal drawer boxes on a pitch that survives resolveInterior', () => {
    const sec: WardrobeSection = { kind: 'drawers', h: 0.8, count: 4 };
    const inter = sectionInterior(sec, 0.8)!;
    if (inter.mode !== 'custom') throw new Error('unreachable');
    expect(inter.elements).toHaveLength(4);
    expect(inter.elements.every((e) => e.kind === 'drawerBox')).toBe(true);
    const pitch = 0.78 / 4;
    const boxH = Math.min(0.25, pitch - MIN_ELEM_SPACE / 2 - 0.001);
    expect(inter.elements[0]).toEqual({ kind: 'drawerBox', y: 0.01, h: boxH });
    const last = inter.elements[3] as { y: number; h: number };
    expect(last.y).toBeCloseTo(0.01 + 3 * pitch, 12);
    // the clear-air gap holds, so EVERY box survives the resolve —
    // resolveInterior's overlap rule would otherwise drop every second one
    expect(resolveInterior(inter, 0.8)).toHaveLength(4);
    expect(last.y + last.h).toBeLessThan(0.8);
  });

  it('leaves the generator to build the fills it draws itself', () => {
    expect(
      sectionInterior({ kind: 'drawers', h: 'fill', count: 3, exposed: true }, 1)
    ).toBeUndefined();
    expect(sectionInterior({ kind: 'open', h: 'fill' }, 1)).toBeUndefined();
    expect(sectionInterior({ kind: 'seat', h: 'fill' }, 1)).toBeUndefined();
    expect(sectionInterior({ kind: 'shoes', h: 'fill', count: 4 }, 1)).toBeUndefined();
  });

  it('returns a custom section its own interior verbatim', () => {
    const interior = { mode: 'custom' as const, elements: [{ kind: 'shelf' as const, y: 0.4 }] };
    expect(sectionInterior({ kind: 'custom', h: 'fill', interior }, 1)).toBe(interior);
    expect(sectionInterior({ kind: 'custom', h: 'fill' }, 1)).toBeUndefined();
  });
});

/* ---------------- 15-23: panels ---------------- */

/** every wardrobe feature at once: 4 columns × 4 sections, a 3-panel sliding
 * mirrored front, a top-box row with doors, both lights, fillers and a cornice */
const stress = (): WardrobePartDef => {
  const p = wardrobe({
    w: 3.2,
    d: 0.65,
    h: 2.7,
    front: { kind: 'sliding', panels: 3, mirror: true },
    filler: { left: 0.06, right: 0.04 },
    plinthH: 0.12,
    cornice: 0.08,
    topRow: { h: 0.4, doors: true },
    light: { cove: true, shelves: true },
    columns: [
      col(0.6, [
        { kind: 'shoes', h: 0.5, count: 3 },
        { kind: 'shelves', h: 0.4, count: 2 },
        { kind: 'hanging', h: 'fill', pullDown: true },
        { kind: 'open', h: 0.3 },
      ]),
      col('fill', [
        { kind: 'drawers', h: 0.6, count: 3 },
        { kind: 'hangingDouble', h: 'fill' },
        { kind: 'seat', h: 0.7 },
        {
          kind: 'custom',
          h: 0.35,
          interior: { mode: 'custom', elements: [{ kind: 'shelf', y: 0.15 }] },
        },
      ]),
      col(0.8, [
        { kind: 'shelves', h: 0.4, count: 2 },
        { kind: 'drawers', h: 0.5, count: 2 },
        { kind: 'hanging', h: 'fill' },
        { kind: 'shelves', h: 0.3, count: 1 },
      ]),
      col(0.7, [
        { kind: 'open', h: 0.4 },
        { kind: 'shoes', h: 0.4, count: 4 },
        { kind: 'custom', h: 'fill' },
        { kind: 'shelves', h: 0.3, count: 2 },
      ]),
    ],
  });
  sanitizeWardrobeFields(p);
  return p;
};

const ids = (panels: Panel[]): string[] => panels.map((p) => p.id);
const role = (panels: Panel[], r: Panel['role']): Panel[] => panels.filter((p) => p.role === r);

describe('wardrobePanels — bounding box', () => {
  it('fills the default wardrobe exactly and never pokes outside it', () => {
    const p = newWardrobePart();
    const bb = bboxOf(wardrobePanels(p, dimsOf(p)));
    expect(bb.maxX).toBeCloseTo(p.w / 2, 6);
    expect(bb.maxY).toBeCloseTo(p.h, 6);
    expect(bb.maxZ).toBeCloseTo(p.d / 2, 6);
  });

  it('holds on a part using every feature at once', () => {
    const p = stress();
    const bb = bboxOf(wardrobePanels(p, dimsOf(p)));
    expect(bb.maxX).toBeCloseTo(p.w / 2, 6);
    expect(bb.maxY).toBeCloseTo(p.h, 6);
    expect(bb.maxZ).toBeCloseTo(p.d / 2, 6);
  });

  it('follows the INSTANCE dimensions, not the part definition', () => {
    const p = newWardrobePart();
    const dims = dimsOf(p, { w: 2.8, d: 0.5, h: 2.1 });
    const bb = bboxOf(wardrobePanels(p, dims));
    expect(bb.maxX).toBeCloseTo(1.4, 6);
    expect(bb.maxY).toBeCloseTo(2.1, 6);
    expect(bb.maxZ).toBeCloseTo(0.25, 6);
  });
});

describe('wardrobePanels — panel ids', () => {
  it('are unique across the default and the stress part', () => {
    for (const p of [newWardrobePart(), stress()]) {
      const list = ids(wardrobePanels(p, dimsOf(p)));
      expect(list.length).toBeGreaterThan(20);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('names the default wardrobe’s carcass boards the way the table says', () => {
    const p = newWardrobePart();
    const list = ids(wardrobePanels(p, dimsOf(p)));
    for (const id of [
      'end.left',
      'end.right',
      'carcass.bottom',
      'carcass.top',
      'carcass.back',
      'plinth',
      'div.1',
    ]) {
      expect(list).toContain(id);
    }
    // the second column's two sections are separated by one board
    expect(list).toContain(`${p.columns[1].id}.div1`);
  });
});

describe('wardrobePanels — carcass options', () => {
  it('drops the end panels on a wall side', () => {
    const p = wardrobe({ sides: { left: 'wall', right: 'wall' } });
    sanitizeWardrobeFields(p);
    const list = ids(wardrobePanels(p, dimsOf(p)));
    expect(list).not.toContain('end.left');
    expect(list).not.toContain('end.right');
    expect(list).toContain('carcass.bottom');
  });

  it('drops the back board and the top board when the part declares neither', () => {
    const p = wardrobe({ back: false, top: 'ceiling' });
    sanitizeWardrobeFields(p);
    const list = ids(wardrobePanels(p, dimsOf(p)));
    expect(list).not.toContain('carcass.back');
    expect(list).not.toContain('carcass.top');
  });

  it('emits the plinth, cornice and top-row shelf only when they exist', () => {
    const bare = wardrobe({ plinthH: 0 });
    sanitizeWardrobeFields(bare);
    const bareIds = ids(wardrobePanels(bare, dimsOf(bare)));
    expect(bareIds).not.toContain('plinth');
    // a zero filler is float residue off the layout, never a board
    expect(bareIds).not.toContain('filler.left');
    expect(bareIds).not.toContain('filler.right');
    expect(bareIds).not.toContain('cornice');
    expect(bareIds).not.toContain('toprow.shelf');

    const full = stress();
    const fullIds = ids(wardrobePanels(full, dimsOf(full)));
    expect(fullIds).toContain('plinth');
    expect(fullIds).toContain('cornice');
    expect(fullIds).toContain('toprow.shelf');
  });
});

describe('wardrobePanels — hinged fronts', () => {
  it('gives the default wardrobe one leaf per pair and one unit per leaf', () => {
    const p = newWardrobePart();
    const panels = wardrobePanels(p, dimsOf(p));
    const lay = wardrobeLayout(p, dimsOf(p));
    const runs = lay.columns.flatMap((c) => c.doors);
    expect(runs).toHaveLength(2);
    const leaves = panels.filter((x) => x.motion?.kind === 'hinge');
    // both columns pair, so each run is two leaves on opposite hinges
    expect(leaves).toHaveLength(4);
    expect(new Set(leaves.map((x) => x.motion!.unit)).size).toBe(4);
    expect(leaves.map((x) => x.motion!.side)).toEqual(['left', 'right', 'left', 'right']);
    for (const run of runs) {
      expect(ids(panels)).toContain(`${run.unit}.0`);
      expect(ids(panels)).toContain(`${run.unit}.1`);
    }
  });

  it('hinges a single leaf on the side the run carries', () => {
    const p = wardrobe({ w: 1.0, columns: [col('fill', [shelves(2, 'fill')], 'right')] });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    const leaves = panels.filter((x) => x.motion?.kind === 'hinge');
    expect(leaves).toHaveLength(1);
    expect(leaves[0].motion!.side).toBe('right');
    expect(leaves[0].groove).toBe('top');
    expect(leaves[0].slot).toBe('front');
  });

  it('paints the leaves with the mirror slot when the part asks for one', () => {
    const p = wardrobe({ mirror: true });
    sanitizeWardrobeFields(p);
    const leaves = wardrobePanels(p, dimsOf(p)).filter((x) => x.motion?.kind === 'hinge');
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((x) => x.slot === 'mirror')).toBe(true);
  });

  it('emits one top-row door per column, hinged outward at the far end', () => {
    const p = stress();
    const doors = wardrobePanels(p, dimsOf(p)).filter((x) => x.id.endsWith('.door'));
    expect(doors).toHaveLength(4);
    expect(doors.map((x) => x.motion!.side)).toEqual(['left', 'left', 'left', 'right']);
    expect(doors.every((x) => x.groove === 'bottom')).toBe(true);
  });
});

describe('wardrobePanels — drawers', () => {
  it('turns an exposed bank into real fronts plus four box boards each', () => {
    const p = wardrobe({
      columns: [col('fill', [{ kind: 'drawers', h: 'fill', count: 3, exposed: true }])],
    });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    const fronts = role(panels, 'front');
    expect(fronts).toHaveLength(3); // every section exposed → no door run at all
    expect(fronts.every((x) => x.motion?.kind === 'slide' && x.motion.axis === undefined)).toBe(
      true
    );
    expect(fronts.every((x) => (x.motion!.travel ?? 0) > 0)).toBe(true);
    expect(role(panels, 'drawerBox')).toHaveLength(12);
  });

  it('keeps a bank behind the door internal: no extra front, boxes carry their own', () => {
    const p = wardrobe({
      columns: [col('fill', [{ kind: 'drawers', h: 'fill', count: 3 }])],
    });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    // the only 'front' panels are the door leaves
    expect(role(panels, 'front').every((x) => x.motion?.kind === 'hinge')).toBe(true);
    // 3 × (4 box boards + 1 internal front board)
    expect(role(panels, 'drawerBox')).toHaveLength(15);
    expect(ids(panels).filter((id) => id.endsWith('.ib0.front'))).toHaveLength(1);
  });
});

describe('wardrobePanels — interior fills', () => {
  it('hangs one rail whose top sits at the resolved element height', () => {
    const p = wardrobe({ columns: [col('fill', [{ kind: 'hanging', h: 'fill' }])] });
    sanitizeWardrobeFields(p);
    const dims = dimsOf(p);
    const lay = wardrobeLayout(p, dims);
    const sec = lay.columns[0].sections[0];
    const secH = sec.y1 - sec.y0;
    const el = resolveInterior(sectionInterior({ kind: 'hanging', h: secH }, secH), secH).find(
      (x) => x.kind === 'rail'
    )!;

    const rails = role(wardrobePanels(p, dims), 'rail');
    expect(rails).toHaveLength(1);
    expect(rails[0].shape).toEqual({
      kind: 'cyl',
      dia: RAIL_DIA,
      h: lay.columns[0].x1 - lay.columns[0].x0,
      axis: 'x',
    });
    // `y` is the UNDERSIDE of the tube; the element's y is its axis
    expect(rails[0].y + RAIL_DIA / 2).toBeCloseTo(sec.y0 + el.y, 12);
  });

  it('marks the topmost rail of a pull-down column as bought hardware', () => {
    const p = wardrobe({
      columns: [col('fill', [{ kind: 'hangingDouble', h: 'fill', pullDown: true }])],
    });
    sanitizeWardrobeFields(p);
    const rails = role(wardrobePanels(p, dimsOf(p)), 'rail');
    expect(rails).toHaveLength(2);
    expect(rails.filter((x) => x.bought === 'Pull-down rail')).toHaveLength(1);
    // the plain lower rail is a cut item, the lift is not
    expect(rails.find((x) => x.bought)!.y).toBeGreaterThan(rails.find((x) => !x.bought)!.y);
  });

  it('builds a seat niche out of a bench, a cushion and a hook rail', () => {
    const p = wardrobe({ columns: [col('fill', [{ kind: 'seat', h: 'fill' }])] });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    const sid = `${p.columns[0].id}-0`;
    const bench = panels.find((x) => x.id === `${sid}.bench`)!;
    const cushion = panels.find((x) => x.id === `${sid}.cushion`)!;
    expect(bench.role).toBe('shelf');
    expect(cushion.role).toBe('board');
    expect(cushion.tint).toBe(1.1);
    expect(cushion.y).toBeCloseTo(bench.y + CARCASS_T, 12);
    expect(panels.some((x) => x.id === `${sid}.hookrail`)).toBe(true);
  });

  it('skips the hook rail when the niche is too short to hold one', () => {
    const p = wardrobe({
      columns: [col('fill', [{ kind: 'seat', h: 0.5 }, shelves(2, 'fill')])],
    });
    sanitizeWardrobeFields(p);
    const sid = `${p.columns[0].id}-0`;
    const list = ids(wardrobePanels(p, dimsOf(p)));
    expect(list).toContain(`${sid}.bench`);
    expect(list).not.toContain(`${sid}.hookrail`);
  });

  it('stacks shoe shelves on an even pitch, shallower and pushed to the back', () => {
    const p = wardrobe({ columns: [col('fill', [{ kind: 'shoes', h: 'fill', count: 4 }])] });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const panels = wardrobePanels(p, dimsOf(p));
    const shoe = panels.filter((x) => x.id.includes('.shoe'));
    expect(shoe).toHaveLength(4);
    const depths = shoe.map((x) => (x.shape.kind === 'box' ? x.shape.d : 0));
    expect(depths.every((v) => Math.abs(v - lay.depth.cavD * 0.8) < 1e-12)).toBe(true);
    expect(shoe[0].z).toBeLessThan(lay.depth.zCav);
    const pitch = shoe[1].y - shoe[0].y;
    expect(shoe[3].y - shoe[2].y).toBeCloseTo(pitch, 12);
  });
});

describe('wardrobePanels — sliding front', () => {
  it('emits one panel per lane plus the two tracks', () => {
    const p = wardrobe({ w: 2.4, front: { kind: 'sliding', panels: 3, mirror: true } });
    sanitizeWardrobeFields(p);
    const dims = dimsOf(p);
    const lay = wardrobeLayout(p, dims);
    if (lay.front.kind !== 'sliding') throw new Error('unreachable');
    const panels = wardrobePanels(p, dims);

    const sliders = panels.filter((x) => x.role === 'front' && x.motion?.axis === 'x');
    expect(sliders).toHaveLength(3);
    expect(ids(sliders)).toEqual(['slide0', 'slide1', 'slide2']);
    expect(sliders.every((x) => x.slot === 'mirror')).toBe(true);
    expect(sliders.every((x) => x.groove === undefined)).toBe(true);
    expect(sliders.every((x) => (x.motion!.travel ?? 0) > 0)).toBe(true);
    expect(sliders.map((x) => x.motion!.dir)).toEqual([1, 1, -1]);
    // lane 0 rides the inner plane, lane 1 the outer one — they alternate
    expect(sliders.map((x) => x.z)).toEqual([lay.front.zInner, lay.front.zOuter, lay.front.zInner]);

    const tracks = role(panels, 'frame');
    expect(ids(tracks)).toEqual(['track.bottom', 'track.top']);
    expect(tracks.every((x) => x.bought === 'Sliding door track set')).toBe(true);
    expect(tracks[0].y).toBe(0);
    expect(tracks[1].y).toBeCloseTo(lay.front.y1, 12);
  });

  it('draws no hinged leaf at all behind a sliding front', () => {
    const p = wardrobe({ front: { kind: 'sliding', panels: 2 } });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    expect(panels.filter((x) => x.motion?.kind === 'hinge')).toHaveLength(0);
  });
});

describe('wardrobePanels — lighting', () => {
  it('puts one cove strip under the top board, billed as a bought fitting', () => {
    const p = wardrobe({ light: { cove: true, shelves: false } });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const lights = role(wardrobePanels(p, dimsOf(p)), 'light');
    expect(lights).toHaveLength(1);
    expect(lights[0].id).toBe('light.cove');
    expect(lights[0].bought).toBe('LED strip');
    expect(lights[0].y + (lights[0].shape.kind === 'box' ? lights[0].shape.h : 0)).toBeLessThan(
      lay.body.y1
    );
  });

  it('puts one strip under every INTERIOR shelf when shelf lights are on', () => {
    const p = wardrobe({ light: { cove: false, shelves: true } });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    const shelves = role(panels, 'shelf');
    const lights = role(panels, 'light');
    // the hanging column's hat shelf + three shelves in the second column
    expect(shelves).toHaveLength(4);
    expect(lights).toHaveLength(4);
    expect(ids(lights).sort()).toEqual(
      ids(shelves)
        .map((id) => `${id}.led`)
        .sort()
    );
    expect(lights.every((x) => x.bought === 'LED strip')).toBe(true);
  });
});

describe('wardrobePanels — degenerate input', () => {
  it('stays finite and emits no inside-out board on a tiny packed part', () => {
    const p = wardrobe({
      w: 0.3,
      h: 0.4,
      d: 0.3,
      columns: Array.from({ length: 8 }, (_, i) => col(i === 0 ? 'fill' : 0.3)),
    });
    sanitizeWardrobeFields(p);
    const panels = wardrobePanels(p, dimsOf(p));
    expect(panels.length).toBeGreaterThan(0);
    for (const x of panels) {
      expect(Number.isFinite(x.x) && Number.isFinite(x.y) && Number.isFinite(x.z)).toBe(true);
      if (x.shape.kind === 'box') {
        expect(Math.min(x.shape.w, x.shape.h, x.shape.d)).toBeGreaterThan(0);
      } else if (x.shape.kind === 'cyl') {
        expect(Math.min(x.shape.dia, x.shape.h)).toBeGreaterThan(0);
      }
    }
    expect(new Set(ids(panels)).size).toBe(panels.length);
  });

  it('emits nothing but trim for a part with no columns', () => {
    const p = wardrobe({ columns: [] });
    expect(() => wardrobePanels(p, dimsOf(p))).not.toThrow();
  });
});

/* ---------------- plan symbol ---------------- */

describe('wardrobePlanSymbol', () => {
  it('ticks every internal column boundary at the layout’s own divider centre', () => {
    const p = wardrobe({ w: 2.4, columns: [col(0.5), col('fill'), col(0.7)] });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    const sym = wardrobePlanSymbol(p, p.w, p.d);
    expect(sym.ticks).toHaveLength(lay.columns.length - 1);
    expect(sym.ticks[0]).toBeCloseTo(lay.columns[0].x1 + CARCASS_T / 2, 12);
    expect(sym.ticks[1]).toBeCloseTo(lay.columns[1].x1 + CARCASS_T / 2, 12);
  });

  it('splits a pair into two abutting leaves hinged on opposite edges', () => {
    const p = newWardrobePart(); // both columns pair
    const lay = wardrobeLayout(p, dimsOf(p));
    const sym = wardrobePlanSymbol(p, p.w, p.d);
    expect(sym.open).toBe(false);
    expect(sym.slides).toEqual([]);
    expect(sym.doors).toHaveLength(4);
    expect(sym.doors.map((x) => x.hinge)).toEqual(['left', 'right', 'left', 'right']);
    expect(sym.doors[0].x0).toBeCloseTo(lay.columns[0].fx0, 12);
    expect(sym.doors[0].x1).toBeCloseTo(sym.doors[1].x0, 12);
    expect(sym.doors[1].x1).toBeCloseTo(lay.columns[0].fx1, 12);
  });

  it('reports a single door once, on the side the layout resolved', () => {
    const p = wardrobe({ w: 1.0, columns: [col('fill', [shelves(2, 'fill')], 'right')] });
    sanitizeWardrobeFields(p);
    const sym = wardrobePlanSymbol(p, p.w, p.d);
    expect(sym.doors).toHaveLength(1);
    expect(sym.doors[0].hinge).toBe('right');
  });

  it('reports one span per sliding panel and no door arcs', () => {
    const p = wardrobe({ w: 2.4, front: { kind: 'sliding', panels: 3 } });
    sanitizeWardrobeFields(p);
    const lay = wardrobeLayout(p, dimsOf(p));
    if (lay.front.kind !== 'sliding') throw new Error('unreachable');
    const sym = wardrobePlanSymbol(p, p.w, p.d);
    expect(sym.doors).toEqual([]);
    expect(sym.open).toBe(false);
    expect(sym.slides).toHaveLength(3);
    expect(sym.slides.map((x) => x.layer)).toEqual([0, 1, 0]);
    expect(sym.slides[0].x0).toBeCloseTo(lay.front.panels[0].x0, 12);
    expect(sym.slides[2].x1).toBeCloseTo(1.2, 12);
  });

  it('reads a doorless run as open, with nothing to draw over it', () => {
    const p = wardrobe({ front: { kind: 'none' } });
    sanitizeWardrobeFields(p);
    const sym = wardrobePlanSymbol(p, p.w, p.d);
    expect(sym.open).toBe(true);
    expect(sym.doors).toEqual([]);
    expect(sym.slides).toEqual([]);
  });

  it('scales with the placed item, not the part definition', () => {
    const p = newWardrobePart();
    const wide = wardrobePlanSymbol(p, 3.0, p.d);
    expect(wide.doors[wide.doors.length - 1].x1).toBeCloseTo(1.5, 12);
    expect(wide.doors[0].x0).toBeCloseTo(-1.5, 12);
  });
});
