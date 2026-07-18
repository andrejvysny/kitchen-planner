import { describe, expect, it } from 'vitest';
import { emptyDesign } from '../../src/model/store';
import { catalogDef, defaultParams } from '../../src/model/catalog';
import { newCabinetPart } from '../../src/model/parts';
import type { CabinetPartDef, Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { buildCutList } from '../../src/model/manufacture/cutlist';
import { cutPartsDxf } from '../../src/model/manufacture/dxf';
import type { CutPart } from '../../src/model/manufacture/types';

function catalogItem(defId: string, patch: Partial<Item> = {}): Item {
  const def = catalogDef(defId);
  return {
    id: uid('i'), defId, x: 1, y: 1, rotation: 0,
    w: def.w, d: def.d, h: def.h, elevation: def.elevation, color: def.color,
    params: defaultParams(def), ...patch,
  };
}

// A drilled base cabinet (box parts) + a chamfer cabinet (prism top/bottom).
const chamfer: CabinetPartDef = {
  ...newCabinetPart(), id: 'p-chamfer', name: 'Corner unit',
  w: 0.9, d: 0.9, h: 0.72, elevation: 0, plinth: false, worktop: false,
  footprint: { kind: 'chamfer', corner: 'right', cx: 0.5, cz: 0.5, face: 'angled' },
  face: { kind: 'leaf', fill: 'door' },
};

function design(): Design {
  return {
    ...emptyDesign(),
    customParts: [chamfer],
    variables: [],
    items: [
      catalogItem('base-cabinet', { color: '#8a9683' }),
      { id: uid('i'), defId: 'p-chamfer', x: 2, y: 2, rotation: 0, w: 0.9, d: 0.9, h: 0.72, elevation: 0, color: '#8a9683' },
    ],
  };
}

const count = (s: string, kw: string): number => (s.match(new RegExp(`\\n${kw}\\n`, 'g')) ?? []).length;

describe('cut parts → DXF R12', () => {
  const parts: CutPart[] = buildCutList(design()).parts;
  const dxf = cutPartsDxf(parts);

  it('has the R12 section skeleton and units', () => {
    for (const kw of ['SECTION', 'HEADER', 'TABLES', 'ENTITIES', 'ENDSEC', 'EOF']) {
      expect(dxf.includes(`\n${kw}\n`) || dxf.endsWith(`\n${kw}\n`), kw).toBe(true);
    }
    expect(dxf).toContain('$ACADVER');
    expect(dxf).toContain('AC1009');
    expect(dxf).toContain('$INSUNITS');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('declares CUT/ETCH/GROOVE plus a layer per drill dia/depth (through-holes distinct)', () => {
    for (const layer of ['CUT', 'ETCH', 'GROOVE']) expect(dxf).toContain(`\n${layer}\n`);
    // every drill layer the parts reference is declared in the LAYER table
    const referenced = new Set<string>();
    for (const p of parts) for (const op of p.drills) {
      referenced.add(op.kind === 'confirmat' ? 'DRILL_D5_THRU' : `DRILL_D${op.dia}_T${op.depth}`);
    }
    expect(referenced.has('DRILL_D5_THRU')).toBe(true); // confirmat through-holes
    expect(referenced.has('DRILL_D35_T13')).toBe(true); // hinge cups
    expect(referenced.has('DRILL_D5_T12')).toBe(true); // shelf/system-32 holes
    for (const layer of referenced) expect(dxf, layer).toContain(`\n${layer}\n`);
  });

  it('one CIRCLE per drill, closed POLYLINEs cover every part + groove, one TEXT label per part', () => {
    let expCircles = 0;
    let expVerts = 0;
    for (const p of parts) {
      expCircles += p.drills.length;
      expVerts += (p.outline && p.outline.length >= 3 ? p.outline.length : 4) + p.grooves.length * 4;
    }
    expect(count(dxf, 'CIRCLE')).toBe(expCircles);
    expect(count(dxf, 'POLYLINE')).toBeGreaterThanOrEqual(parts.length);
    expect(count(dxf, 'POLYLINE')).toBe(parts.length + parts.reduce((s, p) => s + p.grooves.length, 0));
    expect(count(dxf, 'VERTEX')).toBe(expVerts);
    expect(count(dxf, 'TEXT')).toBe(parts.length);
  });

  it('a prism part (chamfer top) renders its real polygon outline, not a rectangle', () => {
    const prism = parts.find((p) => p.outline && p.outline.length > 4);
    expect(prism, 'chamfer top/bottom prism').toBeTruthy();
    // its vertex count feeds the aggregate VERTEX total asserted above; here we
    // confirm it is a genuine polygon (a plain box part would be 4).
    expect(prism!.outline!.length).toBeGreaterThan(4);
    // a label naming the part id and its L×W×T is emitted on ETCH
    expect(dxf).toContain(`${prism!.refId} ${prism!.lengthMm}×${prism!.widthMm}×${prism!.thicknessMm}`);
  });

  it('labels mark quantity when a row is deduped', () => {
    // the base cabinet has two distinct sides + shared parts; force a duplicate
    const twin = design();
    twin.items.push(catalogItem('base-cabinet', { color: '#8a9683' }));
    const dxf2 = cutPartsDxf(buildCutList(twin).parts);
    expect(/×2\n/.test(dxf2) || /×3\n/.test(dxf2) || /×4\n/.test(dxf2)).toBe(true);
  });
});
