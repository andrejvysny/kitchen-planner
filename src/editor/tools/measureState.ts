import type { Point } from '../../model/types';

/**
 * Transient two-point distance measurement (overlay only — never touches the
 * model).
 *
 * It lives HERE rather than next to the code that draws it because `src/editor`
 * may not import `src/plan2d` (the direction rule in ../README.md) and
 * `MeasureTool` owns this state now. `renderPlan.ts` re-exports it, so every
 * existing `import type { Measure } from './renderPlan'` still resolves.
 */
export interface Measure {
  a: Point | null; // first point
  b: Point | null; // second point, set once the measurement is complete
  hover: Point | null; // snapped cursor while measuring / before the first click
  snapped: boolean; // whether `hover` locked onto a corner/edge (vs. a free point)
  measuring: boolean; // first point placed, waiting for the second
}

/** A measurement with nothing in it — the state on entry and after a reset. */
export function emptyMeasure(): Measure {
  return { a: null, b: null, hover: null, snapped: false, measuring: false };
}
