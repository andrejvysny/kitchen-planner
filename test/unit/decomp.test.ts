import { describe, expect, it } from 'vitest';
import {
  cabinetPanels,
  DEFAULT_PANEL_PARAMS,
  leafInterior,
  type Panel,
  type PanelParams,
  type PartDims,
} from '../../src/model/panels';
import { newCabinetPart } from '../../src/model/parts';
import { walkSplits, walkZones } from '../../src/model/zones';
import type { CabinetPartDef, Zone } from '../../src/model/types';

const T = DEFAULT_PANEL_PARAMS.carcassT;
const FRONT_T = DEFAULT_PANEL_PARAMS.frontT;

const dimsOf = (p: CabinetPartDef): PartDims => ({ w: p.w, d: p.d, h: p.h, elevation: p.elevation });

/** Outer axis-aligned bounds (rotation-aware) — the manufacturing envelope. */
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

interface AABB {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** AABB of an axis-aligned (rotY 0) box panel. */
function aabb(p: Panel): AABB {
  if (p.shape.kind !== 'box') throw new Error('box expected');
  const { w, h, d } = p.shape;
  return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y, y1: p.y + h, z0: p.z - d / 2, z1: p.z + d / 2 };
}

const overlap1 = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function overlapVol(a: AABB, b: AABB): number {
  return (
    overlap1(a.x0, a.x1, b.x0, b.x1) * overlap1(a.y0, a.y1, b.y0, b.y1) * overlap1(a.z0, a.z1, b.z0, b.z1)
  );
}

const STRUCTURAL = new Set(['side', 'top', 'bottom', 'divider', 'shelf', 'drawerBottom', 'drawerBack']);

const rectCab = (face: Zone, extra: Partial<CabinetPartDef> = {}): CabinetPartDef => ({
  ...newCabinetPart(),
  w: 0.8,
  d: 0.56,
  h: 0.8,
  elevation: 0,
  plinth: false,
  worktop: false,
  footprint: { kind: 'rect' },
  face,
  ...extra,
});

describe('carcass decomposition', () => {
  it('walkSplits mirrors walkZones cut positions', () => {
    expect(walkSplits({ kind: 'leaf', fill: 'door' }, 1, 1)).toEqual([]);

    const v: Zone = { kind: 'split', dir: 'v', weights: [1, 1], children: [
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'door' },
    ] };
    const [sv] = walkSplits(v, 1.0, 0.9);
    expect(sv.dir).toBe('v');
    expect(sv.boundaries).toHaveLength(1);
    expect(sv.boundaries[0]).toBeCloseTo(0.5);

    const h: Zone = { kind: 'split', dir: 'h', weights: [1, 1, 1], children: [
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'door' },
    ] };
    const [sh] = walkSplits(h, 1.0, 0.9);
    expect(sh.boundaries.map((b) => +b.toFixed(3))).toEqual([0.3, 0.6]);

    // nested: a v-split whose second column is an h-split
    const nested: Zone = { kind: 'split', dir: 'v', weights: [1, 1], children: [
      { kind: 'leaf', fill: 'drawers', drawers: 2 },
      { kind: 'split', dir: 'h', weights: [1, 1], children: [
        { kind: 'leaf', fill: 'open', shelves: 1 },
        { kind: 'leaf', fill: 'door' },
      ] },
    ] };
    const splits = walkSplits(nested, 0.8, 0.8);
    expect(splits).toHaveLength(2);
    const inner = splits.find((s) => s.dir === 'h')!;
    expect(inner.x).toBeCloseTo(0.4); // second column starts at the v cut
    expect(inner.w).toBeCloseTo(0.4);
    expect(inner.boundaries[0]).toBeCloseTo(0.4); // mid of the 0..0.8 column
  });

  it('divider positions match walkSplits boundaries', () => {
    const face: Zone = { kind: 'split', dir: 'v', weights: [1, 2, 1], children: [
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'door' },
    ] };
    const part = rectCab(face);
    const panels = cabinetPanels(part, dimsOf(part));
    const dividers = panels.filter((p) => p.role === 'divider');
    const splits = walkSplits(part.face, part.w, part.h);
    expect(dividers).toHaveLength(splits[0].boundaries.length);
    // vertical divider local x == boundary − w/2
    const xs = dividers.map((d) => +d.x.toFixed(4)).sort((a, b) => a - b);
    const want = splits[0].boundaries.map((b) => +(b - part.w / 2).toFixed(4)).sort((a, b) => a - b);
    expect(xs).toEqual(want);
  });

  it('rect structural boards never overlap (default grooved back)', () => {
    const face: Zone = { kind: 'split', dir: 'v', weights: [1, 1], children: [
      { kind: 'leaf', fill: 'drawers', drawers: 3 },
      { kind: 'leaf', fill: 'open', shelves: 2 },
    ] };
    const part = rectCab(face);
    const panels = cabinetPanels(part, dimsOf(part)).filter((p) => STRUCTURAL.has(p.role));
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const v = overlapVol(aabb(panels[i]), aabb(panels[j]));
        expect(v, `${panels[i].id} ∩ ${panels[j].id}`).toBeLessThan(1e-9);
      }
    }
  });

  it('shelves and drawer boards fit strictly inside their leaf interior (rule E)', () => {
    const face: Zone = { kind: 'split', dir: 'v', weights: [1, 1], children: [
      { kind: 'leaf', fill: 'drawers', drawers: 3 },
      { kind: 'leaf', fill: 'open', shelves: 2 },
    ] };
    const part = rectCab(face);
    const panels = cabinetPanels(part, dimsOf(part));
    const rects = walkZones(part.face, part.w, part.h);
    const zid = (path: number[]) => `z${path.join('-') || 'r'}`;
    for (const r of rects) {
      const iv = leafInterior(r, part.w, part.h, T);
      const ix0 = iv.x0 - part.w / 2;
      const ix1 = iv.x1 - part.w / 2;
      for (const p of panels) {
        if (!p.id.startsWith(`${zid(r.path)}.`)) continue;
        if (p.role !== 'shelf' && p.role !== 'drawerBottom' && p.role !== 'drawerBack') continue;
        const a = aabb(p);
        expect(a.x0, `${p.id} left`).toBeGreaterThanOrEqual(ix0 - 1e-9);
        expect(a.x1, `${p.id} right`).toBeLessThanOrEqual(ix1 + 1e-9);
        // depth stays inside the carcass (rear −d/2 … front d/2 − frontT)
        expect(a.z0, `${p.id} rear`).toBeGreaterThanOrEqual(-part.d / 2 - 1e-9);
        expect(a.z1, `${p.id} front`).toBeLessThanOrEqual(part.d / 2 - FRONT_T + 1e-9);
      }
    }
  });

  it('grooved back captures each carcass edge by exactly grooveDepth', () => {
    const part = rectCab({ kind: 'leaf', fill: 'door' });
    const panels = cabinetPanels(part, dimsOf(part));
    const back = aabb(panels.find((p) => p.id === 'back')!);
    const gd = DEFAULT_PANEL_PARAMS.grooveDepth;
    const side = aabb(panels.find((p) => p.id === 'side-l')!);
    const bottom = aabb(panels.find((p) => p.id === 'bottom')!);
    const top = aabb(panels.find((p) => p.id === 'top')!);
    // the back seats grooveDepth into the side (x) and into the bottom/top (y)
    expect(overlap1(back.x0, back.x1, side.x0, side.x1)).toBeCloseTo(gd);
    expect(overlap1(back.y0, back.y1, bottom.y0, bottom.y1)).toBeCloseTo(gd);
    expect(overlap1(back.y0, back.y1, top.y0, top.y1)).toBeCloseTo(gd);
  });

  it('screwed back reduces carcass depth and never overlaps', () => {
    const m: PanelParams = { ...DEFAULT_PANEL_PARAMS, backMode: 'screwed' };
    const part = rectCab({ kind: 'leaf', fill: 'door' });
    const panels = cabinetPanels(part, dimsOf(part), m);
    const side = panels.find((p) => p.id === 'side-l')!;
    if (side.shape.kind === 'box') expect(side.shape.d).toBeCloseTo(part.d - m.frontT - m.backT);
    const back = panels.find((p) => p.id === 'back')!;
    if (back.shape.kind === 'box') {
      expect(back.shape.w).toBeCloseTo(part.w);
      expect(back.z).toBeCloseTo(-part.d / 2 + m.backT / 2);
    }
    // in screwed mode even the back is a clean, non-overlapping box
    const boards = panels.filter((p) => STRUCTURAL.has(p.role) || p.role === 'back');
    for (let i = 0; i < boards.length; i++) {
      for (let j = i + 1; j < boards.length; j++) {
        expect(overlapVol(aabb(boards[i]), aabb(boards[j])), `${boards[i].id} ∩ ${boards[j].id}`).toBeLessThan(1e-9);
      }
    }
  });

  it('open-niche shelves and drawer boxes clear the structural back (Phase-2 fix)', () => {
    // a niche shelf must sit in front of its liner, which is in front of the back
    const openCab = rectCab(
      { kind: 'split', dir: 'h', weights: [1, 1], children: [
        { kind: 'leaf', fill: 'door' },
        { kind: 'leaf', fill: 'open', shelves: 2 },
      ] },
      { w: 0.6, d: 0.6 }
    );
    const op = cabinetPanels(openCab, dimsOf(openCab));
    const backFront = aabb(op.find((p) => p.id === 'back')!).z1;
    const linerFront = aabb(op.find((p) => p.id.endsWith('.liner'))!).z1;
    const shelves = op.filter((p) => p.role === 'shelf');
    expect(shelves.length).toBe(2);
    for (const s of shelves) {
      expect(aabb(s).z0, `${s.id} rear clears the liner`).toBeGreaterThan(linerFront);
      expect(aabb(s).z0, `${s.id} rear clears the back`).toBeGreaterThan(backFront);
    }

    // a drawer box must not reach behind the structural back
    const drawerCab = rectCab({ kind: 'leaf', fill: 'drawers', drawers: 3 }, { w: 0.8, d: 0.6 });
    const dp = cabinetPanels(drawerCab, dimsOf(drawerCab));
    const dBackFront = aabb(dp.find((p) => p.id === 'back')!).z1;
    const boxes = dp.filter((p) => p.role === 'drawerBottom' || p.role === 'drawerBack');
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(aabb(b).z0, `${b.id} rear clears the back`).toBeGreaterThan(dBackFront);
    }
  });

  it('a door leaf with shelves emits interior shelf boards that fit and clear the back', () => {
    // adjustable shelves behind a closed door: carcass-look boards (no accent
    // niche liner), fitted inside the interior and clear of the structural back
    const cab = rectCab({ kind: 'leaf', fill: 'door', shelves: 2 }, { w: 0.6, d: 0.6 });
    const panels = cabinetPanels(cab, dimsOf(cab));
    const shelves = panels.filter((p) => p.role === 'shelf');
    expect(shelves).toHaveLength(2);
    // ids follow the same `${zid}.shelf${i}` scheme as open-niche shelves
    expect(shelves.map((s) => s.id).sort()).toEqual(['zr.shelf0', 'zr.shelf1']);
    // doors hide the interior → carcass look (slot front, matte, 0.92 tint), NOT accent
    expect(shelves.every((s) => s.slot === 'front' && s.finish === 'matte' && s.tint === 0.92)).toBe(true);
    // a door leaf gets NO accent niche liner
    expect(panels.some((p) => p.id.endsWith('.liner'))).toBe(false);

    const back = aabb(panels.find((p) => p.id === 'back')!);
    const sl = aabb(panels.find((p) => p.id === 'side-l')!);
    const sr = aabb(panels.find((p) => p.id === 'side-r')!);
    const bottom = aabb(panels.find((p) => p.id === 'bottom')!);
    const top = aabb(panels.find((p) => p.id === 'top')!);
    const frontZ = Math.max(sl.z1, sr.z1);
    for (const s of shelves) {
      const a = aabb(s);
      expect(a.x0, `${s.id} inside left`).toBeGreaterThanOrEqual(sl.x1 - 1e-9);
      expect(a.x1, `${s.id} inside right`).toBeLessThanOrEqual(sr.x0 + 1e-9);
      expect(a.y0, `${s.id} above bottom`).toBeGreaterThanOrEqual(bottom.y1 - 1e-9);
      expect(a.y1, `${s.id} below top`).toBeLessThanOrEqual(top.y0 + 1e-9);
      expect(a.z0, `${s.id} clears the back`).toBeGreaterThan(back.z1);
      expect(a.z1, `${s.id} clears the fronts`).toBeLessThanOrEqual(frontZ + 1e-9);
    }
    // no structural board overlaps the new shelves
    const boards = panels.filter((p) => STRUCTURAL.has(p.role));
    for (let i = 0; i < boards.length; i++) {
      for (let j = i + 1; j < boards.length; j++) {
        expect(overlapVol(aabb(boards[i]), aabb(boards[j])), `${boards[i].id} ∩ ${boards[j].id}`).toBeLessThan(1e-9);
      }
    }
  });

  it('a drawer box in a short leaf is height-clamped so it stays inside the opening', () => {
    // drawers-over-door: a 15%-tall drawer leaf must not spawn a full 90mm box
    const cab = rectCab(
      { kind: 'split', dir: 'h', weights: [0.15, 0.85], children: [
        { kind: 'leaf', fill: 'drawers', drawers: 1 },
        { kind: 'leaf', fill: 'door' },
      ] },
      { w: 0.6, d: 0.6, h: 0.9 }
    );
    const panels = cabinetPanels(cab, dimsOf(cab));
    const divider = aabb(panels.find((p) => p.role === 'divider')!);
    for (const b of panels.filter((p) => p.role === 'drawerBack' || p.role === 'drawerBottom')) {
      // clamped box does not protrude up through the divider above the leaf
      expect(aabb(b).y1, `${b.id} stays below the divider`).toBeLessThanOrEqual(divider.y1 + 1e-9);
      expect(overlapVol(aabb(b), divider), `${b.id} ∩ divider`).toBeLessThan(1e-9);
    }
  });

  it('outer bbox parity across footprints and sizes', () => {
    const faces: CabinetPartDef['footprint'][] = [
      { kind: 'rect' },
      { kind: 'chamfer', corner: 'right', cx: 0.3, cz: 0.3, face: 'angled' },
      { kind: 'chamfer', corner: 'left', cx: 0.25, cz: 0.2, face: 'front' },
      { kind: 'cornerL', notch: 'right', nw: 0.4, nd: 0.3, face2: 'door' },
    ];
    for (const footprint of faces) {
      for (const [w, d, h] of [[0.6, 0.56, 0.72], [0.9, 0.9, 0.9], [1.2, 0.6, 2.0]] as const) {
        const part = rectCab({ kind: 'leaf', fill: 'door' }, { footprint, w, d, h });
        const bb = bboxOf(cabinetPanels(part, dimsOf(part)));
        expect(bb.maxX, `${footprint.kind} ${w}x${d}x${h} x`).toBeLessThanOrEqual(w / 2 + 1e-6);
        expect(bb.maxZ, `${footprint.kind} ${w}x${d}x${h} z`).toBeLessThanOrEqual(d / 2 + 1e-6);
        expect(bb.maxY, `${footprint.kind} ${w}x${d}x${h} y`).toBeLessThanOrEqual(h + 1e-6);
      }
    }
  });
});
