import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_PARAMS, partPanels, type PanelParams, type PartDims } from '../../src/model/panels';
import { newCabinetPart, samplePart } from '../../src/model/parts';
import { normalizeZones } from '../../src/model/zones';
import type { CabinetPartDef, Zone } from '../../src/model/types';
import { demoDesign } from '../../src/model/store';
import { validateDesignFit, validateItemPanels } from '../../src/model/manufacture/validate';

const M = DEFAULT_PANEL_PARAMS;
const dimsOf = (p: CabinetPartDef): PartDims => ({ w: p.w, d: p.d, h: p.h, elevation: p.elevation });

const cab = (extra: Partial<CabinetPartDef>): CabinetPartDef => ({
  ...newCabinetPart(),
  w: 0.8,
  d: 0.56,
  h: 0.8,
  elevation: 0,
  plinth: false,
  worktop: false,
  footprint: { kind: 'rect' },
  face: { kind: 'leaf', fill: 'door' },
  ...extra,
});

/** Validate a single part's emitted panels with the given params. */
function check(part: CabinetPartDef, m: PanelParams = M, dims: PartDims = dimsOf(part)) {
  return validateItemPanels('x', dims, partPanels(part, dims, m), m);
}

const deepTree: Zone = normalizeZones({
  kind: 'split',
  dir: 'v',
  weights: [1, 1],
  children: [
    { kind: 'leaf', fill: 'drawers', drawers: 3 },
    {
      kind: 'split',
      dir: 'h',
      weights: [1, 1],
      children: [
        { kind: 'leaf', fill: 'open', shelves: 2 },
        {
          kind: 'split',
          dir: 'v',
          weights: [1, 1],
          children: [
            { kind: 'leaf', fill: 'panel' },
            { kind: 'split', dir: 'h', weights: [1, 1], children: [
              { kind: 'leaf', fill: 'door' },
              { kind: 'leaf', fill: 'glass' },
            ] },
          ],
        },
      ],
    },
  ],
});

describe('fit validator — zero violations for well-formed parts', () => {
  it('the demo kitchen assembles cleanly', () => {
    expect(validateDesignFit(demoDesign())).toEqual([]);
  });

  it('deep 4-level zone tree', () => {
    expect(check(cab({ face: deepTree, w: 1.0, h: 1.4, d: 0.58 }))).toEqual([]);
  });

  it('chamfer + cornerL polygon footprints', () => {
    const chamfer = cab({ w: 0.9, d: 0.9, footprint: { kind: 'chamfer', corner: 'right', cx: 0.5, cz: 0.5, face: 'angled' } });
    const cornerL = cab({ w: 0.9, d: 0.9, footprint: { kind: 'cornerL', notch: 'left', nw: 0.4, nd: 0.3, face2: 'door' } });
    expect(check(chamfer)).toEqual([]);
    expect(check(cornerL)).toEqual([]);
  });

  it('5-drawer unit', () => {
    expect(check(cab({ face: { kind: 'leaf', fill: 'drawers', drawers: 5 }, h: 1.2 }))).toEqual([]);
  });

  it('wall cabinet (elevated, no plinth, groove flips)', () => {
    expect(check(cab({ face: { kind: 'leaf', fill: 'doorPair' }, elevation: 1.45, h: 0.7, d: 0.35 }))).toEqual([]);
  });

  it('tiny 300mm cabinet', () => {
    expect(check(cab({ w: 0.3, h: 0.72 }))).toEqual([]);
  });

  it('screwed-back settings variant', () => {
    const m: PanelParams = { ...M, backMode: 'screwed' };
    expect(check(cab({ face: { kind: 'leaf', fill: 'drawers', drawers: 3 } }), m)).toEqual([]);
  });

  it('16mm carcass variant', () => {
    const m: PanelParams = { ...M, carcassT: 0.016 };
    expect(check(cab({ face: deepTree, w: 1.0, h: 1.4, d: 0.58 }), m)).toEqual([]);
  });

  it('sample sideboard with an open niche shelf + worktop', () => {
    const p = samplePart() as CabinetPartDef;
    expect(check(p)).toEqual([]);
  });
});

describe('fit validator — catches a broken panel list', () => {
  it('widening a shelf past the carcass interior is flagged', () => {
    const part = samplePart() as CabinetPartDef;
    const dims = dimsOf(part);
    const panels = partPanels(part, dims, M);
    const shelf = panels.find((p) => p.role === 'shelf');
    expect(shelf).toBeTruthy();
    if (shelf && shelf.shape.kind === 'box') shelf.shape.w += 0.05; // +50mm — escapes the sides

    const viol = validateItemPanels(part.id, dims, panels, M);
    expect(viol.length).toBeGreaterThan(0);
    expect(viol.some((v) => v.rule === 'interior' || v.rule === 'overlap')).toBe(true);
  });

  it('a stolen carcass side is flagged by the structural count', () => {
    const part = cab({ face: { kind: 'leaf', fill: 'door' } });
    const dims = dimsOf(part);
    const panels = partPanels(part, dims, M).filter((p) => p.id !== 'side-r');
    const viol = validateItemPanels(part.id, dims, panels, M);
    expect(viol.some((v) => v.rule === 'structure')).toBe(true);
  });

  it('a drawer front widened past its reveal is flagged', () => {
    const part = cab({ face: { kind: 'leaf', fill: 'drawers', drawers: 3 } });
    const dims = dimsOf(part);
    const panels = partPanels(part, dims, M);
    for (const p of panels) if (p.role === 'front' && p.shape.kind === 'box') p.shape.w += 0.02;
    const viol = validateItemPanels(part.id, dims, panels, M);
    expect(viol.some((v) => v.rule === 'reveal' || v.rule === 'overlap')).toBe(true);
  });
});

describe('fit validator — the old (Phase-1) geometry provably fails', () => {
  const openOverDoor = cab({
    face: {
      kind: 'split',
      dir: 'h',
      weights: [1, 1],
      children: [
        { kind: 'leaf', fill: 'door' },
        { kind: 'leaf', fill: 'open', shelves: 1 },
      ],
    },
    w: 0.6,
    d: 0.6,
    h: 0.72,
  });

  it('OLD BUG 1: a niche shelf spanning to the outer rear (through the back + liner)', () => {
    const dims = dimsOf(openOverDoor);
    // the fixed geometry passes cleanly first
    expect(check(openOverDoor)).toEqual([]);
    // reconstruct the Phase-1 shelf: depth Dc − shelfSetback, centred on zc
    const panels = partPanels(openOverDoor, dims, M);
    const Dc = dims.d - M.frontT;
    for (const p of panels) {
      if (p.role === 'shelf' && p.shape.kind === 'box') {
        p.shape.d = Dc - M.shelfSetback;
        p.z = -M.frontT / 2 - M.shelfSetback / 2;
      }
    }
    const viol = validateItemPanels(openOverDoor.id, dims, panels, M);
    expect(viol.some((v) => v.rule === 'shelf-liner')).toBe(true);
    expect(viol.some((v) => v.rule === 'overlap')).toBe(true);
  });

  it('OLD BUG 2: a 136mm drawer box in a 121mm leaf runs into the divider above', () => {
    // samplePart is drawers(1) over a doorPair over an open niche — a 121mm drawer leaf
    const part = samplePart() as CabinetPartDef;
    const dims = dimsOf(part);
    expect(check(part)).toEqual([]);
    const panels = partPanels(part, dims, M);
    // restore the Phase-1 fixed 90mm box back (box top jumps from ~112mm to ~140mm)
    for (const p of panels) if (p.role === 'drawerBack' && p.shape.kind === 'box') p.shape.h = M.drawer.boxHeight;
    const viol = validateItemPanels(part.id, dims, panels, M);
    expect(viol.some((v) => v.rule === 'overlap' || v.rule === 'drawer-band')).toBe(true);
  });

  it('OLD BUG 3: a drawer tray reaching behind the structural back', () => {
    const part = cab({ face: { kind: 'leaf', fill: 'drawers', drawers: 3 }, w: 0.8, d: 0.6, h: 0.72 });
    const dims = dimsOf(part);
    expect(check(part)).toEqual([]);
    const panels = partPanels(part, dims, M);
    const Dc = dims.d - M.frontT;
    for (const p of panels) {
      if (p.role === 'drawerBottom' && p.shape.kind === 'box') {
        p.shape.d = Dc - M.drawer.depthDeduction; // Phase-1 depth
        p.z = -M.frontT / 2; // centred on the full interior → reaches past the back
      }
    }
    const viol = validateItemPanels(part.id, dims, panels, M);
    expect(viol.some((v) => v.rule === 'overlap' || v.rule === 'drawer-band')).toBe(true);
  });
});
