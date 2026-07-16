import { describe, expect, it } from 'vitest';
import { cabinetPanels, partPanels, type Panel, type PartDims } from '../../src/model/panels';
import { newBoardPart, newCabinetPart, newFreeformPart, samplePart } from '../../src/model/parts';
import type { CabinetPartDef } from '../../src/model/types';
import { deskBoards } from './fixtures';

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

describe('partPanels (manufacturing IR)', () => {
  it('sample sideboard: roles, counts and cut-list dimensions line up', () => {
    const part = samplePart(); // 1 drawer + door pair + open shelf, worktop, no plinth
    const panels = partPanels(part, dimsOf(part));
    const roles = (r: string) => panels.filter((p) => p.role === r);
    expect(roles('worktop')).toHaveLength(1);
    expect(roles('plinth')).toHaveLength(0);
    // 1 drawer front + 2 pair doors
    expect(roles('front')).toHaveLength(3);
    expect(roles('niche').length).toBeGreaterThanOrEqual(5);
    // one shelf in the open niche + the default auto shelf behind the door pair
    expect(roles('shelf')).toHaveLength(2);
    // hollow shell: left/right/bottom/top/back — real boards, not a solid block
    expect(roles('carcass').map((p) => p.id).sort()).toEqual([
      'carcass.back',
      'carcass.bottom',
      'carcass.left',
      'carcass.right',
      'carcass.top',
    ]);
    // 3 stacked zones → 2 divider boards
    expect(roles('divider')).toHaveLength(2);
    // the drawer front pulls a real box: 2 sides + back + bottom
    expect(roles('drawerBox')).toHaveLength(4);
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
    expect(panels.find((p) => p.role === 'carcass')?.shape.kind).toBe('prism');
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
    part.boards = deskBoards(2, { w: 1.4, d: 0.7, h: 0.75 });
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

  it('worktop panels carry the counter slot', () => {
    const part = samplePart(); // worktop: true
    const top = partPanels(part, dimsOf(part)).find((p) => p.role === 'worktop')!;
    expect(top.slot).toBe('counter');
  });

  it('worktopOverhang extends the slab per edge; default stays snug', () => {
    const part = newCabinetPart(); // rect, worktop: true
    const dflt = cabinetPanels(part, dimsOf(part)).find((p) => p.role === 'worktop')!;
    if (dflt.shape.kind !== 'box') throw new Error('expected box');
    expect(dflt.shape.w).toBeCloseTo(part.w + 0.02);
    expect(dflt.shape.d).toBeCloseTo(part.d + 0.02);
    expect(dflt.z).toBeCloseTo(0.005);

    part.worktopOverhang = { front: 0.15, back: 0.03, sides: 0.03 };
    const island = cabinetPanels(part, dimsOf(part)).find((p) => p.role === 'worktop')!;
    if (island.shape.kind !== 'box') throw new Error('expected box');
    expect(island.shape.w).toBeCloseTo(part.w + 0.06);
    expect(island.shape.d).toBeCloseTo(part.d + 0.18);
    expect(island.z).toBeCloseTo(0.06); // front-heavy overhang shifts the slab forward
  });

  it('finishedBack emits a real back board flush with the carcass', () => {
    const part = newCabinetPart();
    part.finishedBack = true;
    const panels = cabinetPanels(part, dimsOf(part));
    const back = panels.find((p) => p.id === 'back')!;
    expect(back.role).toBe('panel');
    if (back.shape.kind !== 'box') throw new Error('expected box');
    expect(back.shape.w).toBeCloseTo(part.w);
    expect(back.shape.d).toBeCloseTo(0.018);
    expect(back.z).toBeCloseTo(-part.d / 2 + 0.009);
    delete part.finishedBack;
    expect(cabinetPanels(part, dimsOf(part)).some((p) => p.id === 'back')).toBe(false);
  });

  it('motion: doors hinge on the leaf side, pairs on outer edges, drawers slide', () => {
    const single = newCabinetPart();
    single.face = { kind: 'leaf', fill: 'door', hinge: 'right' };
    const door = cabinetPanels(single, dimsOf(single)).find((p) => p.role === 'front')!;
    expect(door.motion).toEqual({ unit: door.id, kind: 'hinge', side: 'right' });

    const dflt = newCabinetPart();
    dflt.face = { kind: 'leaf', fill: 'door' };
    const d0 = cabinetPanels(dflt, dimsOf(dflt)).find((p) => p.role === 'front')!;
    expect(d0.motion?.side).toBe('left'); // default hinge

    const pair = newCabinetPart();
    pair.face = { kind: 'leaf', fill: 'doorPair' };
    const fronts = cabinetPanels(pair, dimsOf(pair)).filter((p) => p.role === 'front');
    expect(fronts.map((p) => p.motion?.side)).toEqual(['left', 'right']);

    const dr = newCabinetPart(); // 2 drawers by default
    const panels = cabinetPanels(dr, dimsOf(dr));
    const dFront = panels.find((p) => p.role === 'front')!;
    expect(dFront.motion?.kind).toBe('slide');
    // travel derives from the cavity depth the generator computed
    expect(dFront.motion?.travel).toBeGreaterThan(0.3);
    expect(dFront.motion?.travel).toBeLessThan(dr.d);
    // the box boards ride the same unit as their front
    const boxes = panels.filter((p) => p.role === 'drawerBox' && p.motion?.unit === dFront.id);
    expect(boxes.length).toBe(4);
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
