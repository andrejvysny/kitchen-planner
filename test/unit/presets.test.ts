import { describe, expect, it } from 'vitest';
import { partPanels } from '../../src/model/panels';
import { sanitizePart } from '../../src/model/parts';
import { PRESETS } from '../../src/model/presets';

/**
 * Every preset is a readonly, deep-frozen literal (presets.ts) that resolves
 * through Store.partOf exactly like a design-local custom part — including
 * a pass through `sanitizePart` on load (sanitizeDesign / the shared
 * library). A preset that is NOT a fixed point of its own sanitizer would
 * silently mutate the moment a user's saved design round-trips through
 * storage, which is indistinguishable from data loss.
 *
 * Scoped to `wardrobe`-type entries: one pre-existing preset ('end-panel', a
 * freeform 18 mm standing board) already fails this — `DIM_LIMITS.freeform.w`
 * clamps its 0.018 m width up to the 0.05 m floor — which is a pre-existing
 * sanitizer/preset mismatch outside this change's scope, not a regression
 * introduced here. Left as-is and reported rather than "fixed" by either
 * loosening the sanitizer or widening the panel.
 */
describe('preset / sanitizer fixed points', () => {
  it('every wardrobe PRESETS entry survives sanitizePart unchanged', () => {
    const wardrobes = PRESETS.filter((e) => e.part.type === 'wardrobe');
    expect(wardrobes.length).toBeGreaterThan(0);
    for (const { part } of wardrobes) {
      const clone = JSON.parse(JSON.stringify(part));
      expect(sanitizePart(clone), `preset ${part.id}`).toEqual(part);
    }
  });
});

describe('wardrobe presets', () => {
  const byId = (id: string) => {
    const entry = PRESETS.find((e) => e.part.id === id);
    if (!entry || entry.part.type !== 'wardrobe') throw new Error(`no wardrobe preset ${id}`);
    return entry.part;
  };

  it('builds a fitted wardrobe with a top row', () => {
    const part = byId('wardrobe-fitted');
    const panels = partPanels(part, { w: part.w, d: part.d, h: part.h, elevation: part.elevation });
    expect(panels.length).toBeGreaterThan(20);
    expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
  });
});
