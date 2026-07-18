import { describe, expect, it } from 'vitest';
import { emptyDesign } from '../../src/model/store';
import { catalogDef, defaultParams } from '../../src/model/catalog';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { buildPack, buildPdfBlob } from '../../src/model/manufacture/index';

function item(defId: string, patch: Partial<Item> = {}): Item {
  const def = catalogDef(defId);
  return {
    id: uid('i'), defId, x: 1, y: 1, rotation: 0,
    w: def.w, d: def.d, h: def.h, elevation: def.elevation, color: def.color,
    params: defaultParams(def), ...patch,
  };
}

/** A small kitchen: two floor cabinets against the top wall + a fridge appliance. */
function smallDesign(): Design {
  return {
    ...emptyDesign(),
    customParts: [],
    variables: [],
    items: [
      item('base-cabinet', { x: 0.6, y: 0.35, color: '#8a9683' }),
      item('base-drawers', { x: 1.3, y: 0.35, color: '#8a9683' }),
      item('fridge', { x: 3.4, y: 0.4 }),
    ],
  };
}

// jsPDF needs Blob/atob/ArrayBuffer — all present on Node 22. If a future runtime
// lacks them the guard skips rather than failing spuriously.
const CAN_RUN = typeof Blob !== 'undefined' && typeof globalThis.atob === 'function';

describe.runIf(CAN_RUN)('pdf pack assembly', () => {
  it('emits a real multi-page PDF whose page count matches the sheet count', async () => {
    const pack = buildPack(smallDesign());
    expect(pack.sheets.length).toBeGreaterThan(3);

    const blob = await buildPdfBlob(pack);
    expect(blob).toBeInstanceOf(Blob);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(5000);

    // magic header '%PDF'
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');

    // one '/Type /Page' object per page (excluding the '/Pages' tree node); with
    // table chunking each table sheet fits a single page, so pages == sheets.
    const raw = new TextDecoder('latin1').decode(bytes);
    const pageObjs = (raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
    expect(pageObjs).toBe(pack.sheets.length);
  });

  it('index re-exports the CSV / DXF / validator entry points', async () => {
    const mod = await import('../../src/model/manufacture/index');
    expect(typeof mod.buildPack).toBe('function');
    expect(typeof mod.buildPdfBlob).toBe('function');
    expect(typeof mod.cutListCsv).toBe('function');
    expect(typeof mod.cutPartsDxf).toBe('function');
    expect(typeof mod.validateDesignFit).toBe('function');
  });
});
