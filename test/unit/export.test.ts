import { describe, expect, it } from 'vitest';
import { defOfDesign, partOfDesign } from '../../src/model/attach';
import { PLINTH_COLOR } from '../../src/model/catalog';
import {
  buildBom,
  buyRows,
  cutRows,
  hardwareRows,
  type Bom,
  type CutRow,
} from '../../src/model/export';
import {
  BUY_HEADER,
  bomHtml,
  CUT_HEADER,
  cutListCsv,
  shoppingListCsv,
} from '../../src/model/exportFormats';
import { partPanels } from '../../src/model/panels';
import { PRESETS } from '../../src/model/presets';
import { allWalls, makeRoom, openingsOfWall } from '../../src/model/rooms';
import { emptyDesign } from '../../src/model/store';
import type { CabinetPartDef, Design, FreeformPartDef, Item, Opening } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { deskBoards } from './fixtures';

/* ---------------- fixtures ---------------- */

/** Place an item of `defId` at the def's natural size, overridable. */
function place(design: Design, defId: string, over: Partial<Item> = {}): Item {
  const def = defOfDesign(design, defId);
  if (!def) throw new Error(`no def ${defId}`);
  const it: Item = {
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
    roomId: design.rooms[0].id,
    ...over,
  };
  design.items.push(it);
  return it;
}

/** A single-door cabinet whose body height is exactly `h` (no plinth/worktop). */
function doorPart(name: string, h: number): CabinetPartDef {
  return {
    id: uid('part'),
    name,
    type: 'cabinet',
    w: 0.6,
    d: 0.6,
    h,
    elevation: 0,
    color: '#8a9683',
    accentColor: '#c9a87c',
    footprint: { kind: 'rect' },
    plinth: false,
    worktop: false,
    face: { kind: 'leaf', fill: 'door' },
  };
}

function drawerPart(name: string, d: number, drawers: number): CabinetPartDef {
  return { ...doorPart(name, 0.9), name, d, face: { kind: 'leaf', fill: 'drawers', drawers } };
}

/** Design with a second room to the right of the first, sharing the partition. */
function twoRoomDesign(): Design {
  const design = emptyDesign();
  design.rooms = [
    makeRoom({ name: 'Kitchen', x: 0, y: 0, w: 4, d: 3 }),
    makeRoom({ name: 'Utility', x: 4, y: 0, w: 3, d: 3 }),
  ];
  return design;
}

const rowOf = (rows: CutRow[], panelId: string): CutRow => {
  const hit = rows.find((r) => r.panelId === panelId);
  if (!hit) throw new Error(`no row for ${panelId}: ${rows.map((r) => r.panelId).join(', ')}`);
  return hit;
};

/* ---------------- phase 1: cut rows ---------------- */

describe('cutRows', () => {
  it('emits one row per panel of a manufactured item', () => {
    const design = emptyDesign();
    const item = place(design, 'base-cabinet');
    const rows = cutRows(design);
    const panels = partPanels(partOfDesign(design, 'base-cabinet')!, {
      w: item.w,
      d: item.d,
      h: item.h,
      elevation: item.elevation,
    });
    expect(rows).toHaveLength(panels.length);
    expect(new Set(rows.map((r) => r.panelId))).toEqual(new Set(panels.map((p) => p.id)));
    expect(rows.every((r) => r.qty === 1 && r.part === 'Base cabinet')).toBe(true);
    expect(rows.every((r) => r.room === design.rooms[0].name)).toBe(true);
  });

  it('merges identical items in one room: qty adds up, itemIds keep traceability', () => {
    const design = emptyDesign();
    const a = place(design, 'base-cabinet');
    const b = place(design, 'base-cabinet', { x: 2 });
    const rows = cutRows(design);
    const single = cutRows({ ...design, items: [a] });
    expect(rows).toHaveLength(single.length);
    expect(rows.every((r) => r.qty === 2)).toBe(true);
    expect(rowOf(rows, 'carcass.left').itemIds).toEqual([a.id, b.id]);
  });

  it('never merges across rooms — each room cuts its own boards', () => {
    const design = twoRoomDesign();
    place(design, 'base-cabinet', { roomId: design.rooms[0].id });
    place(design, 'base-cabinet', { roomId: design.rooms[1].id, x: 5 });
    const rows = cutRows(design);
    const left = rows.filter((r) => r.panelId === 'carcass.left');
    expect(left).toHaveLength(2);
    expect(left.map((r) => r.qty)).toEqual([1, 1]);
    expect(left.map((r) => r.room).sort()).toEqual(['Kitchen', 'Utility']);
  });

  it('a resized instance splits off — dimensions are part of the key', () => {
    const design = emptyDesign();
    place(design, 'base-cabinet');
    place(design, 'base-cabinet', { w: 0.9 });
    const rows = cutRows(design).filter((r) => r.panelId === 'carcass.bottom');
    expect(rows).toHaveLength(2);
    // the bottom board is 564 × 582 at 600 wide (depth wins the length sort)
    expect(rows.map((r) => r.lengthMm).sort((x, y) => x - y)).toEqual([582, 864]);
  });

  it('same-named parts under different defIds merge; a renamed fork does not', () => {
    // forkPartForItem mints a fresh defId, so keying on defId would split two
    // physically identical cabinets — the part NAME is the dedup identity
    const design = emptyDesign();
    const one = doorPart('Sideboard', 0.9);
    const two = { ...doorPart('Sideboard', 0.9), id: uid('part') };
    const forked = { ...doorPart('Sideboard (custom)', 0.9), id: uid('part') };
    design.customParts.push(one, two, forked);
    place(design, one.id);
    place(design, two.id);
    const rows = cutRows(design);
    const merged = rows.filter((r) => r.panelId === 'carcass.left');
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(2);
    expect(merged[0].defId).toBe(one.id); // first instance wins
    place(design, forked.id);
    expect(cutRows(design).filter((r) => r.panelId === 'carcass.left')).toHaveLength(2);
  });

  it('every drawer front pulls a real box: 2 drawers → 8 drawerBox rows', () => {
    const design = emptyDesign();
    const part = drawerPart('Drawers', 0.6, 2);
    design.customParts.push(part);
    place(design, part.id);
    const rows = cutRows(design);
    expect(rows.filter((r) => r.role === 'drawerBox')).toHaveLength(8);
    expect(rows.filter((r) => r.role === 'front')).toHaveLength(2);
  });

  it('hinge side and slide travel travel into the notes', () => {
    const design = emptyDesign();
    const hinged = doorPart('Hinged', 0.9);
    const slid = drawerPart('Slid', 0.6, 1);
    design.customParts.push(hinged, slid);
    place(design, hinged.id);
    place(design, slid.id);
    const rows = cutRows(design).filter((r) => r.role === 'front');
    expect(rows.find((r) => r.part === 'Hinged')!.notes).toBe('Hinge left');
    // cavity depth 0.6 − FRONT_T − BACK_T = 0.57, travel = ×0.9
    expect(rows.find((r) => r.part === 'Slid')!.notes).toBe('Slide travel 513 mm');
  });

  it('worktops follow the room counter finish, per room', () => {
    const design = twoRoomDesign();
    design.rooms[0].style.counterColor = '#111111';
    design.rooms[1].style.counterColor = '#222222';
    place(design, 'base-cabinet', { roomId: design.rooms[0].id });
    place(design, 'base-cabinet', { roomId: design.rooms[1].id });
    const tops = cutRows(design).filter((r) => r.role === 'worktop');
    expect(tops).toHaveLength(2);
    expect(tops.map((r) => r.colorHex).sort()).toEqual(['#111111', '#222222']);
    expect(tops.every((r) => r.slot === 'counter')).toBe(true);
  });

  it('a per-item counter material wins over the room one, keeping its colour', () => {
    const design = emptyDesign();
    design.rooms[0].style.counterColor = '#c9a87c';
    design.rooms[0].style.counterMaterial = 'oak';
    place(design, 'base-cabinet', { counterMaterial: 'marble-light' });
    const top = cutRows(design).find((r) => r.role === 'worktop')!;
    expect(top.materialLabel).toBe('Marble');
    expect(top.colorHex).toBe('#c9a87c');
  });

  it('design variables resolve into the row; a dangling ref falls back', () => {
    const design = emptyDesign();
    design.variables = [{ id: 'v1', name: 'Sage', color: '#8a9683', material: 'oak' }];
    place(design, 'base-cabinet', { color: 'var:v1' });
    place(design, 'base-cabinet', { color: 'var:gone', x: 2 });
    const fronts = cutRows(design).filter((r) => r.role === 'front');
    const bound = fronts.find((r) => r.colorHex === '#8a9683')!;
    expect(bound.materialLabel).toBe('Oak');
    const dangling = fronts.find((r) => r.colorHex === '#e6dfd0')!; // VAR_FALLBACK
    expect(dangling.materialLabel).toBe('');
  });

  it('accent slots take the item override, else the part accent', () => {
    const design = emptyDesign();
    place(design, 'base-cabinet');
    place(design, 'base-cabinet', { accentColor: '#123456', x: 2 });
    const shelves = cutRows(design).filter((r) => r.role === 'shelf');
    expect(shelves).toHaveLength(2);
    expect(shelves.map((r) => r.colorHex).sort()).toEqual(['#123456', '#c9a87c']);
    expect(shelves.every((r) => r.slot === 'accent')).toBe(true);
  });

  it('plinth boards carry the shared plinth colour; glass carries the glass material', () => {
    const design = emptyDesign();
    const glassy: CabinetPartDef = {
      ...doorPart('Vitrine', 1.2),
      plinth: true,
      face: { kind: 'leaf', fill: 'glass' },
    };
    design.customParts.push(glassy);
    place(design, 'base-cabinet');
    place(design, glassy.id, { x: 2 });
    const rows = cutRows(design);
    expect(rowOf(rows, 'plinth').colorHex).toBe(PLINTH_COLOR);
    const glass = rows.find((r) => r.slot === 'glass')!;
    expect(glass.colorHex).toBe('#bcd2d8');
    expect(glass.materialLabel).toBe('Glass');
  });

  it('a sink cutout turns the worktop into a prism whose area drops by the hole', () => {
    const design = emptyDesign();
    const host = place(design, 'base-cabinet', { w: 0.8 });
    place(design, 'appl-sink', {
      attach: { kind: 'counter', hostId: host.id, u: 0, v: 0 },
    });
    const top = cutRows(design).find((r) => r.role === 'worktop')!;
    expect(top.shape).toBe('prism');
    expect(top.holes).toHaveLength(1);
    expect(top.outline).toHaveLength(4);
    // slab 0.82 × 0.62 minus the 0.5 × 0.4 cutout
    expect(top.areaM2).toBeCloseTo(0.82 * 0.62 - 0.5 * 0.4, 6);
    expect(top.notes).toBe('Cutout 500×400 mm');
    expect(top.thicknessMm).toBe(35);
  });

  it('bought products never reach the cut list', () => {
    const design = emptyDesign();
    place(design, 'chair');
    place(design, 'appl-oven');
    place(design, 'pendant');
    expect(cutRows(design)).toEqual([]);
  });

  it('freeform rods sort like rods and note their diameter', () => {
    const design = emptyDesign();
    const desk: FreeformPartDef = {
      id: uid('part'),
      name: 'Desk',
      type: 'freeform',
      w: 1.4,
      d: 0.7,
      h: 0.75,
      elevation: 0,
      color: '#8a9683',
      accentColor: '#c9a87c',
      boards: deskBoards(0, { w: 1.4, d: 0.7, h: 0.75 }),
    };
    design.customParts.push(desk);
    place(design, desk.id);
    const legs = cutRows(design).filter((r) => r.shape === 'cyl');
    expect(legs).toHaveLength(4);
    expect(legs[0].notes).toBe('Ø44 mm');
    expect(legs[0].lengthMm).toBe(715);
    expect(legs[0].widthMm).toBe(44);
    expect(legs[0].thicknessMm).toBe(44);
  });

  it('dimension invariants hold for every preset: L ≥ W ≥ T ≥ 1 mm', () => {
    const design = emptyDesign();
    for (const entry of PRESETS) place(design, entry.part.id);
    const rows = cutRows(design);
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) {
      expect(r.lengthMm).toBeGreaterThanOrEqual(r.widthMm);
      expect(r.widthMm).toBeGreaterThanOrEqual(r.thicknessMm);
      expect(r.thicknessMm).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(r.areaM2)).toBe(true);
      expect(r.areaM2).toBeGreaterThan(0);
    }
  });
});

/* ---------------- phase 2: shopping list, openings, hardware ---------------- */

describe('buyRows', () => {
  it('identical chairs collapse into one row', () => {
    const design = emptyDesign();
    const ids = [0, 1, 2, 3].map((i) => place(design, 'chair', { x: i }).id);
    const rows = buyRows(design);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'Furniture', label: 'Chair', qty: 4 });
    expect(rows[0].itemIds).toEqual(ids);
    expect(rows[0].wMm).toBe(450);
  });

  it('catalog params render as options and split otherwise-identical rows', () => {
    const design = emptyDesign();
    place(design, 'appl-hob', { params: { burners: 4 } });
    place(design, 'appl-hob', { params: { burners: 5 }, x: 2 });
    const rows = buyRows(design).filter((r) => r.defId === 'appl-hob');
    expect(rows.map((r) => r.options).sort()).toEqual(['Zones: 4', 'Zones: 5']);
    expect(rows.every((r) => r.category === 'Appliances')).toBe(true);
  });

  it('an attached appliance notes its host and the cutout it takes', () => {
    const design = emptyDesign();
    const host = place(design, 'base-cabinet', { w: 0.8 });
    place(design, 'appl-sink', { attach: { kind: 'counter', hostId: host.id, u: 0, v: 0 } });
    const tower = place(design, 'pantry');
    place(design, 'appl-oven', { attach: { kind: 'zone', hostId: tower.id, path: [0] } });
    const rows = buyRows(design);
    expect(rows.find((r) => r.defId === 'appl-sink')!.notes).toBe(
      'Mounted in Base cabinet · cutout 500×400 mm'
    );
    expect(rows.find((r) => r.defId === 'appl-oven')!.notes).toBe('Built into Tall cabinet niche');
  });

  it('openings become rows carrying the wall thickness and their options', () => {
    const design = emptyDesign();
    const wallId = design.rooms[0].corners[0].id;
    const mkOpening = (over: Partial<Opening>): Opening => ({
      id: uid('o'),
      wallId,
      type: 'door',
      offset: 1,
      width: 0.9,
      height: 2.05,
      sill: 0,
      ...over,
    });
    design.openings = [
      mkOpening({}),
      mkOpening({ offset: 2.5 }),
      mkOpening({ type: 'window', width: 1.2, height: 1.2, sill: 0.9, offset: 3.2 }),
    ];
    const rows = buyRows(design).filter((r) => r.category === 'Openings');
    expect(rows).toHaveLength(2);
    const door = rows.find((r) => r.label === 'Door')!;
    expect(door.qty).toBe(2);
    expect(door.options).toBe('Hinge: left; Swing: in');
    expect(door.dMm).toBe(100); // room wall thickness
    expect(door.hMm).toBe(2050);
    expect(rows.find((r) => r.label === 'Window')!.options).toBe('Sill: 900 mm');
  });

  it('a partition opening is bought once, not once per side', () => {
    const design = twoRoomDesign();
    const walls = allWalls(design.rooms);
    const partition = walls.find((w) => w.shared?.owner)!;
    design.openings = [
      {
        id: uid('o'),
        wallId: partition.id,
        type: 'door',
        offset: 1.5,
        width: 0.8,
        height: 2.0,
        sill: 0,
      },
    ];
    // both sides SEE the door (the twin view is mirrored), but it is stored once
    const twin = walls.find((w) => w.id === partition.shared!.wallId)!;
    expect(openingsOfWall(design, partition)).toHaveLength(1);
    expect(openingsOfWall(design, twin)).toHaveLength(1);
    const rows = buyRows(design).filter((r) => r.category === 'Openings');
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe(1);
    expect(rows[0].room).toBe('Kitchen');
  });
});

describe('hardwareRows', () => {
  it('hinge counts step 2 / 3 / 4 with the leaf height', () => {
    const design = emptyDesign();
    for (const h of [0.7, 1.2, 2.0]) {
      const part = doorPart(`Door ${h}`, h);
      design.customParts.push(part);
      place(design, part.id);
    }
    const rows = hardwareRows(design).filter((r) => r.label === 'Concealed hinge');
    expect(rows).toHaveLength(1); // one room, one hardware line
    expect(rows[0].qty).toBe(2 + 3 + 4);
    expect(rows[0].category).toBe('Hardware');
  });

  it('slide pairs bucket to stocked lengths, one pair per drawer', () => {
    const design = emptyDesign();
    const deep = drawerPart('Deep drawers', 0.6, 3);
    const shallow = drawerPart('Shallow drawers', 0.35, 2);
    design.customParts.push(deep, shallow);
    place(design, deep.id);
    place(design, shallow.id);
    const rows = hardwareRows(design).filter((r) => r.label === 'Drawer slide pair');
    const byOption = new Map(rows.map((r) => [r.options, r]));
    // cavity 570 mm → 550 bucket; cavity 320 mm → 300 bucket
    expect(byOption.get('550 mm')!.qty).toBe(3);
    expect(byOption.get('300 mm')!.qty).toBe(2);
    expect(byOption.get('300 mm')!.dMm).toBe(300);
  });
});

describe('buildBom', () => {
  it('manufactured and bought are mutually exclusive; totals sum the rows', () => {
    const design = emptyDesign();
    const cab = place(design, 'base-cabinet');
    const chair = place(design, 'chair', { x: 2 });
    const bom = buildBom(design, new Date('2026-01-02T03:04:05.000Z'));
    expect(bom.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(bom.rooms).toEqual([{ id: design.rooms[0].id, name: design.rooms[0].name }]);
    const cutIds = new Set(bom.cut.flatMap((r) => r.itemIds));
    const products = bom.buy.filter((r) => r.category !== 'Hardware');
    const buyIds = new Set(products.flatMap((r) => r.itemIds));
    expect(cutIds.has(cab.id)).toBe(true);
    expect(buyIds.has(cab.id)).toBe(false); // manufactured → never a product
    expect(buyIds.has(chair.id)).toBe(true);
    expect(cutIds.has(chair.id)).toBe(false);
    // its hinges ARE bought, and stay traceable back to the cabinet
    const hinges = bom.buy.find((r) => r.label === 'Concealed hinge')!;
    expect(hinges.itemIds).toEqual([cab.id]);
    expect(bom.totals.panels).toBe(bom.cut.reduce((s, r) => s + r.qty, 0));
    expect(bom.totals.products).toBe(bom.buy.reduce((s, r) => s + r.qty, 0));
    expect(bom.totals.boardAreaM2).toBeGreaterThan(0);
    // hardware rides in the same purchasable list
    expect(bom.buy.some((r) => r.category === 'Hardware')).toBe(true);
  });

  it('an empty design yields empty lists and zero totals', () => {
    const bom = buildBom(emptyDesign());
    expect(bom.cut).toEqual([]);
    expect(bom.buy).toEqual([]);
    expect(bom.totals).toEqual({ panels: 0, boardAreaM2: 0, products: 0 });
  });
});

/* ---------------- phase 3: serializers ---------------- */

/** Minimal RFC 4180 reader — the round-trip half of the CSV writer. */
function parseCsv(text: string): string[][] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (body[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i++;
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A design exercising every row shape: cabinet, cutout prism, product, opening. */
function richBom(): Bom {
  const design = emptyDesign();
  const host = place(design, 'base-cabinet', { w: 0.8 });
  place(design, 'appl-sink', { attach: { kind: 'counter', hostId: host.id, u: 0, v: 0 } });
  place(design, 'chair', { x: 2 });
  design.openings = [
    {
      id: uid('o'),
      wallId: design.rooms[0].corners[0].id,
      type: 'door',
      offset: 1,
      width: 0.9,
      height: 2.05,
      sill: 0,
    },
  ];
  return buildBom(design, new Date('2026-01-02T03:04:05.000Z'));
}

describe('CSV serializers', () => {
  it('lead with a UTF-8 BOM, use CRLF and the frozen header contract', () => {
    const bom = richBom();
    const cut = cutListCsv(bom);
    const buy = shoppingListCsv(bom);
    for (const text of [cut, buy]) {
      expect(text.startsWith('﻿')).toBe(true);
      expect(text.includes('\r\n')).toBe(true);
      expect(text.replace(/\r\n/g, '')).not.toMatch(/\n/); // no bare LF
    }
    expect(cut.slice(1).split('\r\n')[0]).toBe(CUT_HEADER.join(','));
    expect(buy.slice(1).split('\r\n')[0]).toBe(BUY_HEADER.join(','));
  });

  it('every line carries exactly as many fields as the header', () => {
    const bom = richBom();
    for (const [text, header] of [
      [cutListCsv(bom), CUT_HEADER],
      [shoppingListCsv(bom), BUY_HEADER],
    ] as const) {
      const rows = parseCsv(text);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) expect(r).toHaveLength(header.length);
    }
  });

  it('quotes only when needed and round-trips commas and quotes', () => {
    const design = emptyDesign();
    const part = doorPart('Oak, sideboard "XL"', 0.9);
    design.customParts.push(part);
    place(design, part.id);
    const text = cutListCsv(buildBom(design));
    expect(text).toContain('"Oak, sideboard ""XL"""');
    const rows = parseCsv(text);
    expect(rows[1][1]).toBe('Oak, sideboard "XL"');
    // plain values stay bare — no blanket quoting
    expect(rows[1][3]).toBe(rows[1][3].trim());
    expect(text).toContain(',carcass.left,carcass,');
  });

  it('polygon cells never contain a comma, so they never need quoting', () => {
    const text = cutListCsv(richBom());
    const rows = parseCsv(text);
    const outlineCol = CUT_HEADER.indexOf('Outline (mm)');
    const holesCol = CUT_HEADER.indexOf('Holes (mm)');
    const top = rows.slice(1).find((r) => r[outlineCol] !== '')!;
    expect(top[outlineCol]).toMatch(/^-?\d+ -?\d+(;-?\d+ -?\d+)+$/);
    expect(top[holesCol]).toMatch(/^-?\d+ -?\d+(;-?\d+ -?\d+)+$/);
    for (const r of rows.slice(1)) {
      expect(r[outlineCol]).not.toContain(',');
      expect(r[holesCol]).not.toContain(',');
      // unquoted in the raw text
      if (r[outlineCol]) expect(text).toContain(`,${r[outlineCol]},`);
    }
  });
});

describe('bomHtml', () => {
  it('is a self-contained A4 sheet with rooms, totals and the caveat', () => {
    const bom = richBom();
    const html = bomHtml(bom);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@page { size: A4; margin: 12mm; }');
    expect(html).toContain('.noprint { display: none }');
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('onclick="print()"');
    expect(html).toContain('<table>');
    expect(html).toContain('Cut list · Room 1');
    expect(html).toContain('Base cabinet');
    expect(html).toContain('Shopping list');
    expect(html).toContain('Hardware');
    expect(html).toContain(String(bom.totals.panels));
    expect(html).toContain('continuous runs are not merged');
    expect(html).toContain(bom.generatedAt);
    // no external assets: everything inline
    expect(html).not.toMatch(/<(link|img|iframe)\b/);
    expect(html).not.toContain('http');
  });

  it('escapes user text — a part named like a script tag stays inert', () => {
    const design = emptyDesign();
    const part = doorPart('<script>alert("x")</script>', 0.9);
    design.customParts.push(part);
    place(design, part.id);
    const html = bomHtml(buildBom(design));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('survives an empty design', () => {
    const bom = buildBom(emptyDesign());
    const html = bomHtml(bom);
    expect(html).toContain('Nothing to manufacture.');
    expect(html).toContain('Nothing to buy.');
    expect(html).toContain('No moving fronts.');
    expect(parseCsv(cutListCsv(bom))).toEqual([[...CUT_HEADER]]);
    expect(parseCsv(shoppingListCsv(bom))).toEqual([[...BUY_HEADER]]);
  });
});
