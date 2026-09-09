import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  isDecor,
  isDecorative,
  isStaging,
  snapsToWall,
  type CatalogDef,
  type DecorForm,
} from '../../src/model/catalog';
import { buildBom } from '../../src/model/export';
import { makeRoom } from '../../src/model/rooms';
import { emptyDesign } from '../../src/model/store';
import type { Design, Item } from '../../src/model/types';
import { uid } from '../../src/model/types';
import { DECOR_FORMS } from '../../src/view3d/decorMeshes';
import { hasItemBuilder } from '../../src/view3d/itemMeshes';

const DECOR: CatalogDef[] = CATALOG.flatMap((s) => s.items).filter(isDecor);

/**
 * Every `DecorForm`, spelled out rather than derived from DECOR_FORMS' own
 * keys — deriving it from the thing under test would make the exhaustiveness
 * check vacuous. TypeScript enforces the other direction at compile time.
 */
const ALL_FORMS: Record<DecorForm, true> = {
  vessel: true,
  bowl: true,
  stack: true,
  plant: true,
  rack: true,
  cloth: true,
  frame: true,
  basket: true,
};

describe('the decor def contract', () => {
  it('ships a decor family at all', () => {
    expect(DECOR.length).toBeGreaterThanOrEqual(12);
  });

  it.each(DECOR.map((d) => [d.id, d] as const))('%s declares the full contract', (_id, d) => {
    expect(d.kind).toBe('decor');
    // free placement is what keeps throughWallChecks at 'warn', not 'error'
    expect(d.placement).toBe('free');
    expect(snapsToWall(d)).toBe(false);
    expect(isDecorative(d)).toBe(true);
    expect(isStaging(d)).toBe(true);
    expect(d.decor).toBeDefined();
    expect(ALL_FORMS[d.decor!.form]).toBe(true);
  });

  it.each(DECOR.map((d) => [d.id, d] as const))(
    '%s carries no appliance spec (placeArmed would refuse it off a host)',
    (_id, d) => {
      expect(d.appliance).toBeUndefined();
    }
  );

  it('every decor param is an integer range containing its default', () => {
    for (const d of DECOR) {
      for (const p of d.params ?? []) {
        expect(Number.isInteger(p.min), `${d.id}.${p.key} min`).toBe(true);
        expect(Number.isInteger(p.max), `${d.id}.${p.key} max`).toBe(true);
        expect(p.min).toBeLessThanOrEqual(p.def);
        expect(p.def).toBeLessThanOrEqual(p.max);
        // widthPer drives item.w, which would fight drop-to-surface margins
        expect(p.widthPer, `${d.id}.${p.key} widthPer`).toBeUndefined();
      }
    }
  });

  it('decor ids are unique and none collides with an existing def', () => {
    const all = CATALOG.flatMap((s) => s.items).map((d) => d.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the form registry', () => {
  it('the decor kind has a real builder', () => {
    expect(hasItemBuilder('decor')).toBe(true);
  });

  it('every DecorForm has a builder — a new form fails here, not silently', () => {
    for (const form of Object.keys(ALL_FORMS) as DecorForm[]) {
      expect(typeof DECOR_FORMS[form], form).toBe('function');
    }
    expect(Object.keys(DECOR_FORMS).sort()).toEqual(Object.keys(ALL_FORMS).sort());
  });

  it('every declared form is actually used by at least one def', () => {
    const used = new Set(DECOR.map((d) => d.decor!.form));
    for (const form of Object.keys(ALL_FORMS) as DecorForm[]) {
      expect(used.has(form), `no catalog entry uses the ${form} form`).toBe(true);
    }
  });
});

describe('decor reaches no export list', () => {
  function designWith(defIds: string[]): Design {
    const design = emptyDesign();
    design.rooms = [makeRoom({ name: 'Room 1', x: 0, y: 0, w: 4, d: 3 })];
    for (const defId of defIds) {
      const def = CATALOG.flatMap((s) => s.items).find((d) => d.id === defId)!;
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
      };
      design.items.push(it);
    }
    return design;
  }

  it('a room full of set dressing bills nothing', () => {
    const bom = buildBom(designWith(DECOR.map((d) => d.id)));
    expect(bom.buy).toEqual([]);
    expect(bom.cut).toEqual([]);
    expect(bom.totals.products).toBe(0);
    expect(bom.totals.panels).toBe(0);
  });

  it('decor does not displace the products that ARE bought', () => {
    // ids are minted per fixture, so compare the stable columns
    const strip = (rows: { label: string; qty: number; category: string; wMm: number }[]) =>
      rows.map((r) => ({ label: r.label, qty: r.qty, category: r.category, wMm: r.wMm }));
    const bare = buildBom(designWith(['fridge', 'table']));
    const staged = buildBom(designWith(['fridge', 'table', ...DECOR.map((d) => d.id)]));
    expect(strip(staged.buy)).toEqual(strip(bare.buy));
    expect(staged.totals.products).toBe(bare.totals.products);
  });
});
