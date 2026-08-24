import { describe, expect, it } from 'vitest';
import { partPanels } from '../../src/model/panels';
import { PRESETS, presetPart } from '../../src/model/presets';
import type { CabinetPartDef } from '../../src/model/types';

/**
 * The kitchen units a real layout cannot do without, added in M18's quick-win
 * batch. These assert the SHAPE of what they generate, not pixels: a niche an
 * oven fits, a false front over a sink, and an L footprint that actually
 * reaches the panel generator.
 */
const part = (id: string): CabinetPartDef => {
  const p = presetPart(id);
  expect(p, `${id} is a preset`).toBeTruthy();
  expect(p!.type).toBe('cabinet');
  return p as CabinetPartDef;
};

describe('kitchen presets', () => {
  it('every new preset lands in a section the catalog actually renders', () => {
    const sections = new Set(PRESETS.map((e) => e.section));
    for (const id of ['sink-base', 'corner-base', 'oven-tower', 'end-panel']) {
      const entry = PRESETS.find((e) => e.part.id === id);
      expect(entry, id).toBeTruthy();
      expect(sections.has(entry!.section)).toBe(true);
    }
  });

  it('the oven housing offers a niche an oven fits into', () => {
    const p = part('oven-tower');
    const panels = partPanels(p, { w: p.w, d: p.d, h: p.h, elevation: p.elevation });
    const niche = panels.filter((q) => q.role === 'niche' && q.shape.kind === 'box');
    expect(niche.length).toBeGreaterThan(0);
    // catalog.ts asks a zone-mounted oven for at least 0.5 x 0.55; the niche's
    // BACK is the panel that spans the whole opening
    const back = niche
      .map((q) => q.shape as { kind: 'box'; w: number; h: number; d: number })
      .reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b));
    expect(back.w).toBeGreaterThanOrEqual(0.5);
    expect(back.h).toBeGreaterThanOrEqual(0.55);
  });

  it('the sink base is a door pair under a false front, and carries a worktop', () => {
    const p = part('sink-base');
    expect(p.worktop).toBe(true);
    const panels = partPanels(p, { w: p.w, d: p.d, h: p.h, elevation: p.elevation });
    const fronts = panels.filter((q) => q.role === 'front' || q.role === 'panel');
    // two doors + one false front
    expect(fronts.length).toBeGreaterThanOrEqual(3);
    // and NO drawer box behind the false front — that is what makes it a sink base
    expect(panels.some((q) => q.role === 'drawerBox')).toBe(false);
  });

  it('the blind corner base really is a polygon footprint', () => {
    const p = part('corner-base');
    expect(p.footprint.kind).toBe('cornerL');
    const panels = partPanels(p, { w: p.w, d: p.d, h: p.h, elevation: p.elevation });
    // polygon footprints keep a solid prism carcass (CLAUDE.md), so the shell
    // arrives as prisms rather than the five boards a rect emits
    expect(panels.some((q) => q.shape.kind === 'prism')).toBe(true);
    // the door on the remaining face and the panel closing the notch return
    expect(panels.some((q) => q.role === 'front')).toBe(true);
    expect(panels.some((q) => q.role === 'panel')).toBe(true);
  });

  it('the end panel is one standing board', () => {
    const entry = PRESETS.find((e) => e.part.id === 'end-panel')!;
    expect(entry.part.type).toBe('freeform');
    const panels = partPanels(entry.part, {
      w: entry.part.w,
      d: entry.part.d,
      h: entry.part.h,
      elevation: entry.part.elevation,
    });
    expect(panels).toHaveLength(1);
    const box = panels[0].shape as { kind: 'box'; w: number; h: number; d: number };
    expect(box.h).toBeGreaterThan(box.w); // it stands on its edge
  });
});
