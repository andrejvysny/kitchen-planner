import { describe, expect, it } from 'vitest';
import { cabinetPanels, partPanels, type Panel, type PartDims } from '../../src/model/panels';
import { newBoardPart, newCabinetPart, newFreeformPart, samplePart } from '../../src/model/parts';
import { deskBoards } from '../../src/model/partsMigrate';
import type { CabinetPartDef } from '../../src/model/types';

const dimsOf = (p: { w: number; d: number; h: number; elevation: number }): PartDims => ({
  w: p.w,
  d: p.d,
  h: p.h,
  elevation: p.elevation,
});

function bboxOf(panels: Panel[]): { maxX: number; maxY: number; maxZ: number } {
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  for (const p of panels) {
    if (p.shape.kind === 'prism') {
      for (const q of p.shape.outline) {
        maxX = Math.max(maxX, Math.abs(q.x));
        maxZ = Math.max(maxZ, Math.abs(q.y));
      }
      maxY = Math.max(maxY, p.y + p.shape.h);
    } else {
      const c = Math.abs(Math.cos(p.rotY));
      const s = Math.abs(Math.sin(p.rotY));
      const w = p.shape.kind === 'cyl' ? p.shape.dia : p.shape.w;
      const d = p.shape.kind === 'cyl' ? p.shape.dia : p.shape.d;
      maxX = Math.max(maxX, Math.abs(p.x) + (w * c + d * s) / 2);
      maxZ = Math.max(maxZ, Math.abs(p.z) + (w * s + d * c) / 2);
      maxY = Math.max(maxY, p.y + p.shape.h);
    }
  }
  return { maxX, maxY, maxZ };
}

const boxDims = (p: Panel): [number, number, number] => {
  if (p.shape.kind !== 'box') throw new Error(`${p.id} is not a box`);
  return [p.shape.w, p.shape.h, p.shape.d];
};

describe('partPanels (manufacturing IR)', () => {
  it('sample sideboard: roles, counts and cut-list dimensions line up', () => {
    const part = samplePart(); // 1 drawer + door pair + open shelf, worktop, no plinth
    const panels = partPanels(part, dimsOf(part));
    const roles = (r: string) => panels.filter((p) => p.role === r);
    const byId = (id: string) => panels.find((p) => p.id === id);
    expect(roles('worktop')).toHaveLength(1);
    expect(roles('plinth')).toHaveLength(0);
    // 1 drawer front + 2 pair doors
    expect(roles('front')).toHaveLength(3);
    // discrete carcass boards: two sides, a bottom, a top and a structural back
    expect(roles('side')).toHaveLength(2);
    expect(roles('bottom')).toHaveLength(1);
    expect(roles('top')).toHaveLength(1);
    expect(byId('back')?.role).toBe('back');
    // the root h-split (drawers / doorPair / open) yields two horizontal dividers
    expect(roles('divider')).toHaveLength(2);
    // the open leaf is an accent-wood niche: a liner + one shelf
    expect(roles('shelf')).toHaveLength(1);
    // every front is a real board with the standard thickness
    for (const f of roles('front')) {
      expect(f.shape.kind).toBe('box');
      if (f.shape.kind === 'box') expect(f.shape.d).toBeCloseTo(0.018);
    }
    // stable ids — a cut list can reference them across exports
    expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
    const bb = bboxOf(panels);
    expect(bb.maxY).toBeLessThanOrEqual(part.h + 1e-6);
    expect(bb.maxX).toBeLessThanOrEqual(part.w / 2 + 0.02);
  });

  it('door base cabinet decomposes into EU-frameless boards with real dimensions', () => {
    const part: CabinetPartDef = {
      ...newCabinetPart(),
      w: 0.6,
      d: 0.56,
      h: 0.72,
      elevation: 0,
      plinth: false,
      worktop: false,
      footprint: { kind: 'rect' },
      face: { kind: 'leaf', fill: 'door' },
    };
    const panels = cabinetPanels(part, dimsOf(part));
    const byId = (id: string) => panels.find((p) => p.id === id)!;
    // sides: T × bodyH × Dc  (18 × 720 × 542)
    expect(boxDims(byId('side-l'))).toEqual([0.018, 0.72, 0.542]);
    expect(byId('side-l').x).toBeCloseTo(-(0.6 / 2 - 0.009));
    expect(boxDims(byId('side-r'))).toEqual([0.018, 0.72, 0.542]);
    // bottom / top: Wi × T × Dc  (564 × 18 × 542)
    expect(boxDims(byId('bottom'))).toEqual([0.564, 0.018, 0.542]);
    expect(boxDims(byId('top'))).toEqual([0.564, 0.018, 0.542]);
    expect(byId('top').y).toBeCloseTo(0.702); // y0 + bodyH − T
    // grooved back: (Wi+2gd) × (Hi+2gd) × backT  (580 × 700 × 3) captured into the carcass
    const back = byId('back');
    expect(boxDims(back).map((v) => +v.toFixed(3))).toEqual([0.58, 0.7, 0.003]);
    expect(back.z).toBeCloseTo(-0.56 / 2 + 0.012 + 0.0015);
    expect(back.y).toBeCloseTo(0.01); // T − grooveDepth
    // door front: (w−2·reveal) × (bodyH−reveal) × frontT  (592 × 716 × 18)
    const front = panels.find((p) => p.role === 'front')!;
    expect(boxDims(front).map((v) => +v.toFixed(3))).toEqual([0.592, 0.716, 0.018]);
    expect(front.groove).toBe('top');
    // carcass sits inside the nominal w × h × d envelope
    const bb = bboxOf(panels);
    expect(bb.maxX).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(bb.maxZ).toBeLessThanOrEqual(0.28 + 1e-9);
    expect(bb.maxY).toBeLessThanOrEqual(0.72 + 1e-9);
  });

  it('instances scale: doubling the width doubles front widths, not thicknesses', () => {
    const part = newCabinetPart();
    const one = cabinetPanels(part, dimsOf(part));
    const two = cabinetPanels(part, { ...dimsOf(part), w: part.w * 2 });
    const f1 = one.find((p) => p.role === 'front')!;
    const f2 = two.find((p) => p.role === 'front')!;
    if (f1.shape.kind === 'box' && f2.shape.kind === 'box') {
      expect(f2.shape.w).toBeCloseTo(f1.shape.w + part.w);
      expect(f2.shape.d).toBeCloseTo(f1.shape.d);
    }
  });

  it('diagonal corner cabinet: fronts sit rotated on the chamfer plane', () => {
    const part: CabinetPartDef = {
      ...newCabinetPart(),
      w: 0.9,
      d: 0.9,
      footprint: { kind: 'chamfer', corner: 'right', cx: 0.5, cz: 0.5, face: 'angled' },
    };
    const panels = cabinetPanels(part, dimsOf(part));
    // polygon carcass = top + bottom prisms + per-edge side boards
    const prisms = panels.filter((p) => (p.role === 'top' || p.role === 'bottom') && p.shape.kind === 'prism');
    expect(prisms).toHaveLength(2);
    const sides = panels.filter((p) => p.role === 'side');
    expect(sides.length).toBeGreaterThanOrEqual(3); // back + two straight sides
    const fronts = panels.filter((p) => p.role === 'front' && p.rotY !== 0);
    expect(fronts.length).toBeGreaterThan(0);
    // outward normal of the right chamfer points front-right (45°)
    expect(fronts[0].rotY).toBeCloseTo(Math.PI / 4, 1);
    // the panel that closes the straight front is a plain panel
    expect(panels.some((p) => p.role === 'panel')).toBe(true);
  });

  it('board part: single prism carrying outline + holes verbatim', () => {
    const part = newBoardPart();
    part.holes = [{ x: 0.2, y: 0, w: 0.4, d: 0.3 }];
    const panels = partPanels(part, dimsOf(part));
    expect(panels).toHaveLength(1);
    const p = panels[0];
    expect(p.role).toBe('board');
    if (p.shape.kind === 'prism') {
      expect(p.shape.outline).toHaveLength(4);
      expect(p.shape.holes).toHaveLength(1);
      expect(p.shape.h).toBeCloseTo(part.h);
    } else {
      throw new Error('expected prism');
    }
  });

  it('freeform: one panel per board, slots/tints/grooves preserved', () => {
    const part = newFreeformPart();
    part.boards = deskBoards({ drawers: 2, panelLegs: 0 }, { w: 1.4, d: 0.7, h: 0.75 });
    Object.assign(part, { w: 1.4, d: 0.7, h: 0.75 });
    const panels = partPanels(part, dimsOf(part));
    expect(panels).toHaveLength(part.boards.length);
    const legs = panels.filter((p) => p.shape.kind === 'cyl');
    expect(legs).toHaveLength(4);
    expect(legs[0].tint).toBeCloseTo(0.8);
    const drawers = panels.filter((p) => p.groove === 'top' && p.boardId?.startsWith('dr-'));
    expect(drawers).toHaveLength(2);
    const top = panels.find((p) => p.boardId === 'top')!;
    expect(top.slot).toBe('accent');
    expect(top.finish).toBe('wood');
  });

  it('a flat cut list is derivable: every panel has finite dimensions', () => {
    const parts = [samplePart(), newBoardPart(), newCabinetPart()];
    for (const part of parts) {
      for (const p of partPanels(part, dimsOf(part))) {
        const dims =
          p.shape.kind === 'box'
            ? [p.shape.w, p.shape.h, p.shape.d]
            : p.shape.kind === 'cyl'
              ? [p.shape.dia, p.shape.h]
              : [p.shape.h, ...p.shape.outline.flatMap((q) => [q.x, q.y])];
        expect(dims.every((v) => Number.isFinite(v))).toBe(true);
        expect(p.shape.kind === 'prism' || (dims[0] > 0 && dims[1] > 0)).toBe(true);
      }
    }
  });
});
