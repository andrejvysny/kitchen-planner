import { describe, expect, it } from 'vitest';
import { rotateAbout, selectionCentre, withoutCarried } from '../../../src/editor/selectionOps';

const at = (
  id: string,
  x: number,
  y: number,
  rotation = 0
): { id: string; x: number; y: number; rotation: number } => ({
  id,
  x,
  y,
  rotation,
});

/**
 * src/editor/selectionOps.ts — what a multi-selection DOES, as pure geometry.
 * A selection moves rigidly: the arrangement the user built is the thing they
 * selected several items to preserve.
 */
describe('selectionCentre', () => {
  it('is the middle of the bounding box of the item centres', () => {
    expect(selectionCentre([at('a', 0, 0), at('b', 4, 2)])).toEqual({ x: 2, y: 1 });
    // an outlier stretches the box; it is not an average
    expect(selectionCentre([at('a', 0, 0), at('b', 0, 0), at('c', 10, 0)])).toEqual({
      x: 5,
      y: 0,
    });
  });

  it('a lone item turns about its own centre — no special case needed', () => {
    expect(selectionCentre([at('a', 3, 7)])).toEqual({ x: 3, y: 7 });
  });

  it('an empty selection has no centre', () => {
    expect(selectionCentre([])).toBe(null);
  });
});

describe('rotateAbout', () => {
  it('carries positions round and turns each item by the same step', () => {
    const out = rotateAbout([at('a', 1, 0), at('b', -1, 0)], { x: 0, y: 0 }, Math.PI / 2);
    expect(out[0].x).toBeCloseTo(0);
    expect(out[0].y).toBeCloseTo(1);
    expect(out[1].x).toBeCloseTo(0);
    expect(out[1].y).toBeCloseTo(-1);
    expect(out[0].rotation).toBeCloseTo(Math.PI / 2);
  });

  it('keeps the set rigid: distances between members are unchanged', () => {
    const before = [at('a', 0, 0), at('b', 3, 4)];
    const after = rotateAbout(before, { x: 1, y: 1 }, 0.7);
    const d = (p: { x: number; y: number }, q: { x: number; y: number }): number =>
      Math.hypot(p.x - q.x, p.y - q.y);
    expect(d(after[0], after[1])).toBeCloseTo(d(before[0], before[1]));
  });

  it('four quarter turns land back where it started', () => {
    let pose = [at('a', 2, 0, 0.3)];
    const c = { x: 0, y: 0 };
    for (let i = 0; i < 4; i++) pose = rotateAbout(pose, c, Math.PI / 2);
    expect(pose[0].x).toBeCloseTo(2);
    expect(pose[0].y).toBeCloseTo(0);
    expect(pose[0].rotation).toBeCloseTo(0.3 + Math.PI * 2);
  });

  it('turning about the centre of the set does not move the set', () => {
    const items = [at('a', 0, 0), at('b', 2, 0)];
    const c = selectionCentre(items)!;
    const out = rotateAbout(items, c, Math.PI);
    expect(selectionCentre(out)!.x).toBeCloseTo(c.x);
    expect(selectionCentre(out)!.y).toBeCloseTo(c.y);
  });
});

describe('withoutCarried', () => {
  it('drops an appliance whose host is moving too', () => {
    const items = [
      { id: 'host', attach: undefined },
      { id: 'sink', attach: { hostId: 'host' } },
      { id: 'chair', attach: undefined },
    ];
    expect(withoutCarried(items).map((i) => i.id)).toEqual(['host', 'chair']);
  });

  it('keeps an appliance whose host is NOT part of the move', () => {
    const items = [{ id: 'sink', attach: { hostId: 'elsewhere' } }];
    expect(withoutCarried(items).map((i) => i.id)).toEqual(['sink']);
  });
});
