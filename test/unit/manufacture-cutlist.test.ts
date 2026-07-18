import { describe, expect, it } from 'vitest';
import { catalogDef, defaultParams, type CatalogDef } from '../../src/model/catalog';
import type { CustomPartDef, Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { emptyDesign } from '../../src/model/store';
import { newCabinetPart } from '../../src/model/parts';
import { buildCutList } from '../../src/model/manufacture/cutlist';
import { cutListCsv } from '../../src/model/manufacture/csv';
import type { CutPart } from '../../src/model/manufacture/types';

function item(defId: string, patch: Partial<Item> = {}): Item {
  const def: CatalogDef = catalogDef(defId);
  return {
    id: uid('i'),
    defId,
    x: 1,
    y: 1,
    rotation: 0,
    w: def.w,
    d: def.d,
    h: def.h,
    elevation: def.elevation,
    color: def.color,
    params: defaultParams(def),
    ...patch,
  };
}

function mkDesign(items: Item[], customParts: CustomPartDef[] = []): Design {
  return { ...emptyDesign(), items, customParts, variables: [] };
}

const find = (parts: CutPart[], pred: (p: CutPart) => boolean): CutPart => {
  const p = parts.find(pred);
  if (!p) throw new Error('cut part not found');
  return p;
};

describe('cut list', () => {
  it('every dimension and edge value is an integer millimetre', () => {
    const { parts } = buildCutList(mkDesign([item('base-drawers'), item('base-sink'), item('oven-tower')]));
    for (const p of parts) {
      for (const v of [p.lengthMm, p.widthMm, p.thicknessMm, p.qty, p.edge.L1, p.edge.L2, p.edge.W1, p.edge.W2]) {
        expect(Number.isInteger(v), `${p.refId} ${v}`).toBe(true);
      }
      expect(p.lengthMm).toBeGreaterThanOrEqual(1);
      expect(p.widthMm).toBeGreaterThanOrEqual(1);
      expect(p.thicknessMm).toBeGreaterThanOrEqual(1);
    }
  });

  it('thickness is the minimum dimension; carcass side is 18mm', () => {
    const { parts } = buildCutList(mkDesign([item('base-cabinet', { color: '#8a9683' })]));
    const side = find(parts, (p) => p.role === 'side');
    expect(side.thicknessMm).toBe(18);
  });

  it('grain runs along the vertical dimension even when depth exceeds height', () => {
    // a short, deep wall cabinet: bodyH 400 < carcass depth 582
    const { parts } = buildCutList(mkDesign([item('wall-cabinet', { w: 0.6, d: 0.6, h: 0.4 })]));
    const side = find(parts, (p) => p.role === 'side');
    expect(side.lengthMm).toBe(400); // grain = vertical height, not the larger depth
    expect(side.widthMm).toBe(582);
    expect(side.grain).toBe(true);
  });

  it('dedup collapses two identical base cabinets into one row with doubled qty', () => {
    const one = buildCutList(mkDesign([item('base-cabinet', { color: '#8a9683' })]));
    const two = buildCutList(
      mkDesign([item('base-cabinet', { color: '#8a9683' }), item('base-cabinet', { color: '#8a9683' })])
    );
    const sideOne = find(one.parts, (p) => p.role === 'side');
    const sideTwo = find(two.parts, (p) => p.role === 'side');
    expect(sideOne.qty).toBe(2); // left + right of one cabinet
    expect(sideTwo.qty).toBe(4); // both cabinets merged
    expect(sideTwo.cabinet).toBe('Base cabinet ×4');
    // one cabinet's rows all stay singular in structure
    expect(one.parts.filter((p) => p.role === 'top')[0].qty).toBe(1);
  });

  it('edge banding follows the role', () => {
    const { parts } = buildCutList(mkDesign([item('base-cabinet')]));
    const front = find(parts, (p) => p.role === 'front');
    expect(front.edge).toEqual({ L1: 2, L2: 2, W1: 2, W2: 2 }); // all four = edgeFrontT
    const side = find(parts, (p) => p.role === 'side');
    expect(side.edge).toEqual({ L1: 1, L2: 0, W1: 0, W2: 0 }); // front carcass edge only
    const back = find(parts, (p) => p.role === 'back');
    expect(back.edge).toEqual({ L1: 0, L2: 0, W1: 0, W2: 0 });
    const worktop = find(parts, (p) => p.role === 'worktop');
    expect(worktop.edge).toEqual({ L1: 2, L2: 0, W1: 2, W2: 2 }); // front + both ends
  });

  it('counter items emit a worktop row; sink/hob carry cutout notes', () => {
    const { parts } = buildCutList(mkDesign([item('base-sink'), item('base-hob')]));
    const worktops = parts.filter((p) => p.role === 'worktop');
    expect(worktops.length).toBeGreaterThanOrEqual(2);
    expect(worktops.some((p) => /sink cutout/.test(p.notes))).toBe(true);
    expect(worktops.some((p) => /hob cutout/.test(p.notes))).toBe(true);
    const sinkWt = find(parts, (p) => p.role === 'worktop' && /sink/.test(p.notes));
    expect(sinkWt.lengthMm).toBe(800); // item.w
    expect(sinkWt.widthMm).toBe(620); // item.d + 20mm
    expect(sinkWt.thicknessMm).toBe(35); // worktopT (NB: 40mm 3-D slab)
  });

  it('CSV golden row + RFC-4180 quoting of commas', () => {
    const { parts } = buildCutList(mkDesign([item('base-cabinet', { color: '#8a9683', params: { doors: 1 } })]));
    const csv = cutListCsv(parts);
    expect(csv.startsWith('id,cabinet,name,length_mm,width_mm,thickness_mm,qty,material,grain,edge_L1,edge_L2,edge_W1,edge_W2,notes\r\n')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    // exact door-front row (bodyH 760 → front 756 × 592 × 18, front grain vertical)
    expect(csv).toContain('zr.front0,Base cabinet ×1,Base cabinet — front 1,756,592,18,1,Front 18mm #8a9683,L,2,2,2,2,\r\n');

    // a label containing a comma must be quoted in both cabinet and name columns
    const part: CustomPartDef = { ...newCabinetPart(), name: 'Big, wide unit', worktop: false, plinth: false };
    const it: Item = {
      id: uid('i'),
      defId: part.id,
      x: 1,
      y: 1,
      rotation: 0,
      w: part.w,
      d: part.d,
      h: part.h,
      elevation: part.elevation,
      color: part.color,
    };
    const csv2 = cutListCsv(buildCutList(mkDesign([it], [part])).parts);
    expect(csv2).toContain('"Big, wide unit ×');
    expect(csv2).toContain('"Big, wide unit — ');
  });

  it('unmanufacturable items are skipped, appliances collected', () => {
    const { skipped, appliances } = buildCutList(mkDesign([item('pendant'), item('chair'), item('fridge')]));
    expect(skipped).toContain('Pendant lamp');
    expect(skipped).toContain('Chair');
    expect(appliances.some((a) => a.kind === 'fridge')).toBe(true);
  });
});
