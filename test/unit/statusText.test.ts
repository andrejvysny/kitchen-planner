import { describe, expect, it } from 'vitest';
import { demoDesign, emptyDesign, Store } from '../../src/model/store';
import { statusInfoText } from '../../src/ui/statusText';

// src/ui/statusText.ts — the #status-info string, lifted out of ui.ts
// updateInfo in step B2 so it can be asserted without a browser. The exact
// wording is a contract: test/interact.mjs reads the element back and looks for
// the "issue" suffix, and the React status bar renders nothing else.

describe('statusInfoText', () => {
  it('counts items and floor area, and stays quiet about a single room', () => {
    const store = new Store(emptyDesign());
    expect(statusInfoText(store)).toBe('0 items · 12.0 m²');
  });

  it('adds the room count once a design has more than one room', () => {
    const store = new Store(emptyDesign());
    store.addRoom({ w: 3, d: 2 });
    expect(statusInfoText(store)).toBe('0 items · 18.0 m² · 2 rooms');
  });

  it('counts the demo design and ignores info-severity hints', () => {
    const store = new Store(demoDesign());
    const text = statusInfoText(store);
    // the demo ships one deliberate work-triangle HINT (info severity) — a
    // hint is not an issue, so it must not reach the count
    expect(store.warnings().some((w) => w.severity === 'info')).toBe(true);
    expect(text).toMatch(/^\d+ items · \d+\.\d m² · \d+ rooms$/);
    expect(text).not.toContain('issue');
  });

  it('appends the issue count, singular then plural', () => {
    const store = new Store(demoDesign());
    const cabinets = store.design.items.filter((i) => i.defId === 'wall-cabinet');
    // stack one cabinet on another: one 'overlap' error naming both items
    store.updateItem(cabinets[1].id, { x: cabinets[0].x, y: cabinets[0].y });
    expect(store.warnings().filter((w) => w.severity !== 'info')).toHaveLength(1);
    expect(statusInfoText(store)).toContain(' · 1 issue');
    expect(statusInfoText(store)).not.toContain('issues');

    const fridge = store.design.items.find((i) => i.defId === 'fridge')!;
    store.updateItem(fridge.id, { x: fridge.x + 0.5 });
    expect(store.warnings().filter((w) => w.severity !== 'info').length).toBeGreaterThan(1);
    expect(statusInfoText(store)).toMatch(/ · \d+ issues$/);
  });
});
