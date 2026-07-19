import { describe, expect, it } from 'vitest';
import { partPanels, type PartDims } from '../../src/model/panels';
import { newCabinetPart } from '../../src/model/parts';
import { emptyDesign } from '../../src/model/store';
import type { CabinetPartDef, Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { DEFAULT_MANUFACTURE, panelParamsFrom, type ManufactureSettings } from '../../src/model/manufacture/settings';
import { enumerateJoints, itemDrilling } from '../../src/model/manufacture/drilling';
import { validateItemDrilling } from '../../src/model/manufacture/validate';
import { buildHardware } from '../../src/model/manufacture/hardware';

// A 600×560×720 base cabinet: a door (bottom) over an open-with-shelf niche (top).
// bodyH = 720 − 100 (plinth) = 620 mm; Dc = 560 − 18 (front) = 542 mm.
const cabinet = (extra: Partial<CabinetPartDef> = {}): CabinetPartDef => ({
  ...newCabinetPart(),
  id: 'part-test',
  w: 0.6, d: 0.56, h: 0.72,
  elevation: 0,
  plinth: true,
  worktop: false,
  footprint: { kind: 'rect' },
  face: {
    kind: 'split', dir: 'h', weights: [1, 1],
    children: [
      { kind: 'leaf', fill: 'door' },
      { kind: 'leaf', fill: 'open', shelves: 1 },
    ],
  },
  ...extra,
});

const dimsOf = (p: CabinetPartDef): PartDims => ({ w: p.w, d: p.d, h: p.h, elevation: p.elevation });
const M = DEFAULT_MANUFACTURE;

function drill(part: CabinetPartDef, m: ManufactureSettings = M) {
  const dims = dimsOf(part);
  const panels = partPanels(part, dims, panelParamsFrom(m));
  return { dims, panels, ops: itemDrilling(part, dims, panels, m) };
}

function designWith(part: CabinetPartDef): Design {
  const item: Item = {
    id: uid('i'), defId: part.id, x: 1, y: 1, rotation: 0,
    w: part.w, d: part.d, h: part.h, elevation: part.elevation, color: part.color,
  };
  return { ...emptyDesign(), items: [item], customParts: [part], variables: [] };
}

describe('drilling — System 32 shelf-pin boring', () => {
  it('both sides bored over the open band only, pitch 32, v at front/back setback', () => {
    const { ops } = drill(cabinet());
    const widthMm = 542; // Dc
    for (const id of ['side-l', 'side-r']) {
      const pins = (ops.get(id)?.drills ?? []).filter((d) => d.kind === 'shelfPin');
      expect(pins.length, id).toBeGreaterThan(0);
      // exactly two v-columns: frontSetback and width − frontSetback
      const vs = [...new Set(pins.map((p) => p.v))].sort((a, b) => a - b);
      expect(vs).toEqual([37, widthMm - 37]);
      // every hole is above the divider (side-u 310) → within the open band only
      expect(Math.min(...pins.map((p) => p.u))).toBeGreaterThan(310);
      // pitch exactly 32 within a column
      const col = pins.filter((p) => p.v === 37).map((p) => p.u).sort((a, b) => a - b);
      for (let i = 1; i < col.length; i++) expect(col[i] - col[i - 1]).toBe(32);
      // dia 5 / depth 12 from the interior face
      expect(pins.every((p) => p.dia === 5 && p.depth === 12 && p.face === 'A')).toBe(true);
    }
  });

  it('a plain door cabinet bores no shelf pins', () => {
    const { ops } = drill(cabinet({ face: { kind: 'leaf', fill: 'door' } }));
    const pins = [...ops.values()].flatMap((o) => o.drills).filter((d) => d.kind === 'shelfPin');
    expect(pins).toHaveLength(0);
  });

  it('a door leaf WITH shelves bores pin rows on both sides AND keeps its hinge plates', () => {
    // full-height door + 2 adjustable shelves: side members get BOTH the System-32
    // shelf-pin columns and the hinge mounting plates (they share the v=37 column).
    const part = cabinet({ face: { kind: 'leaf', fill: 'door', shelves: 2 } });
    const { dims, panels, ops } = drill(part);
    const widthMm = 542; // Dc
    for (const id of ['side-l', 'side-r']) {
      const pins = (ops.get(id)?.drills ?? []).filter((d) => d.kind === 'shelfPin');
      expect(pins.length, `${id} pins`).toBeGreaterThan(0);
      const vs = [...new Set(pins.map((p) => p.v))].sort((a, b) => a - b);
      expect(vs).toEqual([37, widthMm - 37]);
    }
    // the default-left hinge still bores its mounting plates on side-l (side-r none)
    const plates = (ops.get('side-l')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5);
    expect(plates.length).toBe(4); // 2 hinges × a vertical pair
    expect((ops.get('side-r')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5)).toHaveLength(0);

    // NO exact-duplicate holes on any panel — a plate/pin coincidence is deduped
    for (const [pid, o] of ops) {
      const seen = new Set<string>();
      for (const d of o.drills) {
        const key = `${d.face}:${d.u}:${d.v}:${d.dia}`;
        expect(seen.has(key), `${pid} duplicate hole ${key}`).toBe(false);
        seen.add(key);
      }
    }
    // and the whole battery passes the drilling validator (grid + bounds)
    expect(validateItemDrilling(part.id, part, dims, panels, M)).toEqual([]);
  });
});

describe('drilling — hinge cups + pilots + mounting plates', () => {
  it('door front: 2 cups (H=306 ≤ 900) at 21.5 mm inset, 100 mm from each end, with pilots', () => {
    const { ops } = drill(cabinet());
    const front = ops.get('z0.front0')!.drills;
    const cups = front.filter((d) => d.kind === 'hingeCup');
    expect(cups).toHaveLength(2);
    expect(cups.map((c) => c.u).sort((a, b) => a - b)).toEqual([100, 206]); // 100 & H−100
    expect(cups.every((c) => c.v === 21.5 && c.dia === 35 && c.depth === 13 && c.face === 'A')).toBe(true);
    // each cup flanked by two 3 mm pilots at ±22.5 mm
    const pilots = front.filter((d) => d.kind === 'hingePlate' && d.dia === 3);
    expect(pilots).toHaveLength(4);
    expect(pilots.map((p) => p.u).sort((a, b) => a - b)).toEqual([77.5, 122.5, 183.5, 228.5]);
    expect(pilots.every((p) => p.v === 31.5 && p.depth === 5)).toBe(true);
  });

  it('mounting plates only on the hinge-side member (default left), 32 mm pairs at cup heights', () => {
    const { ops } = drill(cabinet());
    const left = (ops.get('side-l')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5);
    const right = (ops.get('side-r')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5);
    expect(right).toHaveLength(0); // hinge is on the left
    expect(left).toHaveLength(4); // 2 hinges × a vertical pair
    // pairs 32 mm apart, centred at the door's cup heights mapped to the side
    // (door bottom item-y 102 mm → side-u = 2 + cupU): cups 100,206 → 102,208
    const us = left.map((p) => p.u).sort((a, b) => a - b);
    expect(us).toEqual([86, 118, 192, 224]);
    expect(us[1] - us[0]).toBe(32);
    expect(us[3] - us[2]).toBe(32);
    expect(left.every((p) => p.v === 37 && p.dia === 5 && p.depth === 12)).toBe(true);
  });

  it('a right-hinged door moves the plates to side-r', () => {
    const { ops } = drill(cabinet({ face: {
      kind: 'split', dir: 'h', weights: [1, 1],
      children: [{ kind: 'leaf', fill: 'door', hinge: 'right' }, { kind: 'leaf', fill: 'open', shelves: 1 }],
    } }));
    expect((ops.get('side-l')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5)).toHaveLength(0);
    expect((ops.get('side-r')?.drills ?? []).filter((d) => d.kind === 'hingePlate' && d.dia === 5)).toHaveLength(4);
  });

  it('a tall door gets more hinges (H thresholds)', () => {
    // single-zone door, bodyH 1900 → H 1896 → 4 hinges (≤ 2000)
    const { ops } = drill(cabinet({ h: 2.0, face: { kind: 'leaf', fill: 'door' } }));
    const cups = (ops.get('zr.front0')?.drills ?? []).filter((d) => d.kind === 'hingeCup');
    expect(cups).toHaveLength(4);
  });
});

describe('drilling — carcass joinery', () => {
  it('confirmat: 6 joints × 3 (Dc 542 ≥ 400) = 18, matching the hardware schedule', () => {
    const part = cabinet();
    const { ops } = drill(part);
    const joints = enumerateJoints(part, dimsOf(part), partPanels(part, dimsOf(part), panelParamsFrom(M)), M);
    expect(joints).toHaveLength(6); // top+bottom×2 sides + div-h×2 sides
    const confirmat = [...ops.values()].flatMap((o) => o.drills).filter((d) => d.kind === 'confirmat');
    expect(confirmat).toHaveLength(18);
    expect(confirmat.every((d) => d.dia === 5 && d.depth === 18)).toBe(true); // through the 18 mm side
    // v-positions spread across the depth with 50 mm front/back margins (3 rows)
    expect([...new Set(confirmat.map((d) => d.v))].sort((a, b) => a - b)).toEqual([50, 271, 492]);
    const hw = buildHardware(designWith(part));
    const screws = hw.find((h) => /confirmat/.test(h.spec));
    expect(screws?.qty).toBe(18); // total == hardware screw qty
  });

  it('a shallow cabinet uses 2 confirmats per joint (Dc < 400)', () => {
    const part = cabinet({ d: 0.4, face: { kind: 'leaf', fill: 'door' } }); // Dc = 382
    const { ops } = drill(part);
    // 4 joints (top+bottom to both sides), 2 each = 8
    const confirmat = [...ops.values()].flatMap((o) => o.drills).filter((d) => d.kind === 'confirmat');
    expect(confirmat).toHaveLength(8);
  });

  it('cam-lock: cam bores replace confirmats (same per-joint count) + 2 dowels/joint', () => {
    const part = cabinet();
    const m: ManufactureSettings = { ...M, joinery: 'camlock' };
    const { ops } = drill(part, m);
    const drills = [...ops.values()].flatMap((o) => o.drills);
    expect(drills.filter((d) => d.kind === 'confirmat')).toHaveLength(0);
    expect(drills.filter((d) => d.kind === 'camBore')).toHaveLength(18); // 6 joints × 3
    expect(drills.filter((d) => d.kind === 'dowel')).toHaveLength(12); // 6 joints × 2
    expect(drills.filter((d) => d.kind === 'camBore').every((d) => d.dia === 15 && d.depth === 13)).toBe(true);
    expect(drills.filter((d) => d.kind === 'dowel').every((d) => d.dia === 8 && d.face === 'edge')).toBe(true);
  });
});

describe('drilling — back groove', () => {
  it('groove on sides, top, bottom and dividers at the rear back band', () => {
    const { ops } = drill(cabinet());
    for (const id of ['side-l', 'side-r', 'top', 'bottom', 'div-h0-0']) {
      const g = ops.get(id)?.grooves ?? [];
      expect(g, id).toHaveLength(1);
      expect(g[0]).toMatchObject({ axis: 'u', at: 527, width: 3, depth: 8, from: 0 }); // Dc−backInset−backT = 527
    }
    // fronts / shelves / liner carry no groove
    expect(ops.get('z0.front0')?.grooves ?? []).toHaveLength(0);
  });

  it('screwed back mode emits no groove and still validates', () => {
    const part = cabinet();
    const m: ManufactureSettings = { ...M, backMode: 'screwed' };
    const { dims, panels, ops } = drill(part, m);
    expect([...ops.values()].flatMap((o) => o.grooves)).toHaveLength(0);
    expect(validateItemDrilling('x', part, dims, panels, m)).toEqual([]);
  });
});

describe('drilling — validator: every op is in bounds and on grid', () => {
  it('confirmat, camlock and screwed variants all pass the fit validator', () => {
    for (const m of [
      M,
      { ...M, joinery: 'camlock' } as ManufactureSettings,
      { ...M, backMode: 'screwed' } as ManufactureSettings,
    ]) {
      for (const part of [
        cabinet(),
        cabinet({ face: { kind: 'leaf', fill: 'drawers', drawers: 3 } }),
        cabinet({ w: 1.0, face: { kind: 'leaf', fill: 'doorPair' } }),
        cabinet({ w: 0.3, face: { kind: 'leaf', fill: 'door' } }),
      ]) {
        const { dims, panels } = drill(part, m);
        expect(validateItemDrilling(part.id, part, dims, panels, m), `${m.joinery}/${m.backMode}`).toEqual([]);
      }
    }
  });
});
