import { describe, expect, it } from 'vitest';
import { demoDesign } from '../../src/model/store';
import { partPanels } from '../../src/model/panels';
import type { CabinetPartDef, Design } from '../../src/model/types';
import { collectDesign } from '../../src/model/manufacture/collect';
import { itemDrilling } from '../../src/model/manufacture/drilling';
import { DEFAULT_MANUFACTURE, panelParamsFrom } from '../../src/model/manufacture/settings';
import { buildSheets } from '../../src/model/manufacture/drawings';
import { buildCutList } from '../../src/model/manufacture/cutlist';
import { buildHardware } from '../../src/model/manufacture/hardware';
import type { DrawingSheet, DrawPrim } from '../../src/model/manufacture/types';
import { wallElevation } from '../../src/model/elevation';

const M = DEFAULT_MANUFACTURE;
const pp = panelParamsFrom(M);

function sheetsFor(design: Design): DrawingSheet[] {
  const { parts, appliances } = buildCutList(design);
  const hardware = buildHardware(design);
  return buildSheets(design, { parts, hardware, appliances });
}

/** Independent re-derivation of the unique-cabinet signatures from collectDesign. */
function expectedCabinetCount(design: Design): number {
  const sigs = new Set<string>();
  for (const c of collectDesign(design).items) {
    if (!c.part || c.part.type !== 'cabinet') continue;
    const d = c.dims;
    const key = [d.w, d.d, d.h, d.elevation].map((v) => Math.round(v * 1000)).join(',');
    sigs.add(`${JSON.stringify(c.part)}|${key}`);
  }
  return sigs.size;
}

const dims = (p: DrawPrim[]): Extract<DrawPrim, { t: 'dim' }>[] =>
  p.filter((d): d is Extract<DrawPrim, { t: 'dim' }> => d.t === 'dim');
const horizontal = (d: Extract<DrawPrim, { t: 'dim' }>): boolean => Math.abs(d.a.y - d.b.y) < 1e-6;

describe('drawing sheets — demoDesign', () => {
  const design = demoDesign();
  const sheets = sheetsFor(design);
  const byKind = (k: DrawingSheet['kind']): DrawingSheet[] => sheets.filter((s) => s.kind === k);

  it('produces cover + floorplan + ≥1 elevation + N unique cabinet sheets + the three tables', () => {
    expect(byKind('cover')).toHaveLength(1);
    expect(byKind('floorplan')).toHaveLength(1);
    expect(byKind('elevation').length).toBeGreaterThanOrEqual(1);

    const n = expectedCabinetCount(design);
    expect(n).toBeGreaterThan(0);
    expect(byKind('cabinet')).toHaveLength(n);
    // cabinet sheets are numbered 1..N and carry a W×D×H title
    byKind('cabinet').forEach((s, i) => {
      expect(s.id).toBe(`cab-${i + 1}`);
      expect(s.title).toMatch(/^\d+\. .+ \d+×\d+×\d+$/);
    });

    const tables = byKind('table');
    expect(tables.some((s) => s.id.startsWith('tbl-cutlist'))).toBe(true);
    expect(tables.some((s) => s.id.startsWith('tbl-hardware'))).toBe(true);
    expect(tables.some((s) => s.id.startsWith('tbl-appliances'))).toBe(true);
    for (const t of tables) expect(t.table).toBeTruthy();
  });

  it('cover carries the counts + settings summary table', () => {
    const cover = byKind('cover')[0];
    expect(cover.table).toBeTruthy();
    const flat = cover.table!.rows.map((r) => r.join(' '));
    expect(flat.some((r) => /Cabinets/.test(r))).toBe(true);
    expect(flat.some((r) => /Carcass/.test(r))).toBe(true);
    expect(flat.some((r) => /Joinery/.test(r))).toBe(true);
  });

  it('floorplan room polygon bounds equal the room dims in mm', () => {
    const fp = byKind('floorplan')[0];
    const room = fp.prims.find(
      (p): p is Extract<DrawPrim, { t: 'poly' }> => p.t === 'poly' && p.layer === 'wall' && p.closed
    )!;
    const xs = room.pts.map((q) => q.x);
    const ys = room.pts.map((q) => q.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // demo room is 4.2 × 3.4 m
    expect(Math.round(w)).toBe(4200);
    expect(Math.round(h)).toBe(3400);
  });

  it("every elevation's bottom running chain sums to the wall length (±1 mm)", () => {
    const elevs = byKind('elevation');
    expect(elevs.length).toBeGreaterThan(0);
    for (const s of elevs) {
      const wallId = s.id.replace(/^elev-/, '');
      const wall = wallElevation(design, wallId)!;
      const sum = dims(s.prims).filter(horizontal).reduce((acc, d) => acc + Number(d.text), 0);
      expect(Math.abs(sum - wall.len * 1000)).toBeLessThanOrEqual(1);
    }
  });

  it('a cabinet FRONT view has hinge-cup circles matching itemDrilling', () => {
    // pick the first unique floor cabinet that is actually drilled with hinge cups
    let checked = 0;
    const seen = new Set<string>();
    for (const c of collectDesign(design).items) {
      if (!c.part || c.part.type !== 'cabinet') continue;
      const d = c.dims;
      const sig = `${JSON.stringify(c.part)}|${[d.w, d.d, d.h, d.elevation].map((v) => Math.round(v * 1000)).join(',')}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const idx = seen.size;
      const panels = partPanels(c.part, d, pp);
      const drills = itemDrilling(c.part as CabinetPartDef, d, panels, M);
      let cups = 0;
      for (const ops of drills.values()) for (const op of ops.drills) if (op.kind === 'hingeCup') cups++;
      if (cups === 0) continue;
      const sheet = sheets.find((s) => s.id === `cab-${idx}`)!;
      const circles = sheet.prims.filter((p) => p.t === 'circle' && p.layer === 'drill').length;
      expect(circles, sheet.title).toBe(cups);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('every dimension text is a positive integer millimetre', () => {
    for (const s of sheets) {
      for (const d of dims(s.prims)) {
        const n = Number(d.text);
        expect(Number.isInteger(n), `${s.id} "${d.text}"`).toBe(true);
        expect(n).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic — two builds of the same design deep-equal', () => {
    expect(sheetsFor(design)).toEqual(sheetsFor(design));
  });
});

describe('drawing sheet helpers', () => {
  it('dimChainPrims defaults its text to the rounded a–b distance', async () => {
    const { dimChainPrims, fitLabel } = await import('../../src/model/manufacture/drawings');
    const [d] = dimChainPrims({ x: 0, y: 0 }, { x: 600, y: 0 }, -100) as Extract<DrawPrim, { t: 'dim' }>[];
    expect(d.t).toBe('dim');
    expect(d.text).toBe('600');
    expect(d.off).toBe(-100);
    expect(fitLabel('Appliance tower', 8)).toBe('Applian…');
    expect(fitLabel('short', 8)).toBe('short');
  });
});
