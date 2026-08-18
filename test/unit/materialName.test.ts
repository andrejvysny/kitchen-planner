import { describe, expect, it } from 'vitest';
import {
  MATERIAL_NAME_MAX,
  materialName,
  parseMaterialName,
  type MaterialDesc,
  type ProductSlug,
} from '../../src/model/materialName';
import { MATERIALS } from '../../src/model/materials';

// Record<ProductSlug, true> makes this list exhaustive at compile time: an
// added/removed/renamed slug in the union fails typecheck here, not just at
// runtime.
const PRODUCT_SLUG_SET: Record<ProductSlug, true> = {
  steel: true,
  'appliance-glass': true,
  'appliance-black': true,
  'appliance-ring': true,
  handle: true,
  bulb: true,
  'window-glass': true,
  'window-frame': true,
  'door-leaf': true,
  'door-knob': true,
  groove: true,
  ground: true,
};
const PRODUCT_SLUGS = Object.keys(PRODUCT_SLUG_SET) as ProductSlug[];

const SURFACES = ['wall', 'floor', 'ceiling'] as const;

function roundTrip(d: MaterialDesc): void {
  const name = materialName(d);
  expect(name.length).toBeLessThanOrEqual(MATERIAL_NAME_MAX);
  expect(parseMaterialName(name)).toEqual(d);
}

describe('materialName / parseMaterialName round trip', () => {
  it('library: every MATERIALS id x rot true/false', () => {
    for (const m of MATERIALS) {
      for (const rot of [true, false]) {
        roundTrip({ kind: 'library', matId: m.id, hex6: 'c9a87c', rot });
      }
    }
  });

  it('plain: both fallbacks', () => {
    for (const fallback of ['matte', 'wood'] as const) {
      roundTrip({ kind: 'plain', hex6: 'e6dfd0', fallback });
    }
  });

  it('shell: all 3 surfaces x {no matId, matId, matId+rot}', () => {
    for (const surface of SURFACES) {
      roundTrip({ kind: 'shell', surface, hex6: 'c9a87c', matId: undefined, rot: false });
      roundTrip({ kind: 'shell', surface, hex6: 'c9a87c', matId: 'floor-walnut', rot: false });
      roundTrip({ kind: 'shell', surface, hex6: 'c9a87c', matId: 'floor-walnut', rot: true });
    }
  });

  it('product: every ProductSlug', () => {
    for (const product of PRODUCT_SLUGS) {
      roundTrip({ kind: 'product', product });
    }
  });
});

describe('materialName length', () => {
  it('every generated name in the sweep stays within MATERIAL_NAME_MAX', () => {
    const names: string[] = [];
    for (const m of MATERIALS) {
      names.push(materialName({ kind: 'library', matId: m.id, hex6: 'aabbcc', rot: false }));
      names.push(materialName({ kind: 'library', matId: m.id, hex6: 'aabbcc', rot: true }));
    }
    for (const fallback of ['matte', 'wood'] as const) {
      names.push(materialName({ kind: 'plain', hex6: 'aabbcc', fallback }));
    }
    for (const surface of SURFACES) {
      names.push(materialName({ kind: 'shell', surface, hex6: 'aabbcc' }));
      // longest known matId — worst case for the shell format
      names.push(
        materialName({ kind: 'shell', surface, hex6: 'aabbcc', matId: 'tiles-terracotta' })
      );
      names.push(
        materialName({
          kind: 'shell',
          surface,
          hex6: 'aabbcc',
          matId: 'tiles-terracotta',
          rot: true,
        })
      );
    }
    for (const product of PRODUCT_SLUGS) {
      names.push(materialName({ kind: 'product', product }));
    }
    for (const n of names) expect(n.length).toBeLessThanOrEqual(MATERIAL_NAME_MAX);
  });
});

describe('parseMaterialName Blender duplicate-suffix tolerance', () => {
  it('strips a trailing .NNN suffix before parsing', () => {
    const base = materialName({ kind: 'library', matId: 'oak', hex6: 'c9a87c', rot: true });
    expect(parseMaterialName(`${base}.001`)).toEqual(parseMaterialName(base));
    expect(parseMaterialName(`${base}.123`)).toEqual(parseMaterialName(base));
  });

  it('does not strip a non-3-digit or non-numeric trailing dot group', () => {
    const base = materialName({ kind: 'plain', hex6: 'e6dfd0', fallback: 'matte' });
    expect(parseMaterialName(`${base}.1`)).toBeNull();
    expect(parseMaterialName(`${base}.abc`)).toBeNull();
  });
});

describe('materialName hex normalization', () => {
  it('strips a leading # and lowercases', () => {
    const name = materialName({ kind: 'plain', hex6: '#ABCDEF', fallback: 'matte' });
    expect(name).toBe('kp:c:abcdef:matte');
  });

  it('throws on malformed hex', () => {
    expect(() =>
      materialName({ kind: 'plain', hex6: 'not-a-color', fallback: 'matte' })
    ).toThrow();
    expect(() => materialName({ kind: 'library', matId: 'oak', hex6: 'zzzzzz', rot: false })).toThrow();
  });
});

describe('parseMaterialName rejections', () => {
  it('rejects foreign / malformed names', () => {
    const bad = [
      'Material',
      'Material.001',
      'kp:z:oak:aabbcc', // unknown kind letter
      'kp:m:oak:xyz123', // bad hex
      'kp:p:unknown-slug', // unknown product slug
      '',
      'kp:m:oak', // missing hex
      'kp:c:aabbcc:glossy', // unknown fallback
      'kp:s:attic:aabbcc', // unknown surface
      'kp:m::aabbcc', // empty matId
    ];
    for (const name of bad) expect(parseMaterialName(name)).toBeNull();
  });
});
