import { describe, expect, it } from 'vitest';
import {
  COUNTER_COLORS,
  FLOOR_COLORS,
  FRONT_COLORS,
  LIGHT_COLORS,
  WALL_COLORS,
} from '../../src/model/catalog';
import {
  COUNTER_MATERIALS,
  FLOOR_MATERIALS,
  ITEM_MATERIALS,
  MATERIALS,
  WALL_MATERIALS,
} from '../../src/model/materials';
import {
  GROUP_LABELS,
  materialInfo,
  titleFor,
  type MaterialGroup,
} from '../../src/model/materialInfo';

/**
 * Every palette array the app actually renders into a swatch/material row
 * (SwatchRow's `colors` / MaterialRow's `mats`), walked programmatically —
 * no hardcoded copy of the arrays themselves, so a new palette entry that
 * ships without a name fails here instead of shipping silently unnamed.
 */
const COLOR_PALETTES: Record<string, readonly string[]> = {
  FRONT_COLORS,
  FLOOR_COLORS,
  WALL_COLORS,
  COUNTER_COLORS,
  LIGHT_COLORS,
};

const MATERIAL_PALETTES: Record<string, readonly { id: string }[]> = {
  ITEM_MATERIALS,
  FLOOR_MATERIALS,
  WALL_MATERIALS,
  COUNTER_MATERIALS,
};

describe('materialInfo', () => {
  it('names every entry of every colour palette shipped in the app', () => {
    for (const [paletteName, colors] of Object.entries(COLOR_PALETTES)) {
      expect(colors.length, `${paletteName} is empty`).toBeGreaterThan(0);
      for (const hex of colors) {
        const info = materialInfo(hex);
        expect(info.name, `${paletteName} entry ${hex} has no name`).not.toBe(hex);
      }
    }
  });

  it('names every entry of every material palette shipped in the app', () => {
    for (const [paletteName, mats] of Object.entries(MATERIAL_PALETTES)) {
      expect(mats.length, `${paletteName} is empty`).toBeGreaterThan(0);
      for (const m of mats) {
        const info = materialInfo(m.id);
        expect(info.name, `${paletteName} entry ${m.id} has no name`).not.toBe(m.id);
      }
    }
  });

  it('names and captions the whole registry (all 19 built-in materials)', () => {
    expect(MATERIALS.length).toBe(19);
    for (const def of MATERIALS) {
      const info = materialInfo(def.id);
      expect(info.name).toBe(def.label);
      expect(info.caption, `${def.id} has no caption`).toBeTruthy();
      expect(info.group, `${def.id} has no group`).toBeTruthy();
    }
  });

  it('falls back to the raw value for an unknown id/hex', () => {
    expect(materialInfo('chrome-unicorn')).toEqual({ name: 'chrome-unicorn' });
    expect(materialInfo('#123abc')).toEqual({ name: '#123abc' });
  });

  it('hex lookup is case-insensitive', () => {
    expect(materialInfo('#8A9683').name).toBe(materialInfo('#8a9683').name);
  });

  it('titleFor appends the caption only when one exists', () => {
    const withCaption = materialInfo('oak');
    expect(titleFor(withCaption)).toBe(`${withCaption.name} — ${withCaption.caption}`);
    const noCaption = materialInfo('#8a9683');
    expect(titleFor(noCaption)).toBe(noCaption.name);
  });

  it('every material group used has a display label', () => {
    const groups = new Set(MATERIALS.map((m) => materialInfo(m.id).group).filter(Boolean));
    for (const g of groups) expect(GROUP_LABELS[g as MaterialGroup]).toBeTruthy();
  });
});
