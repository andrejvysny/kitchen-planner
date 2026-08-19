/**
 * The snap engine's vocabulary. Pure types — no DOM, no three, no React, and
 * deliberately no import of src/plan2d either: the caller converts its screen
 * reach into `pointReachPx`/`lineReachPx` before calling, so `hitRadius`'s
 * coarse-pointer widening stays a view concern.
 *
 * The central idea is the split between a POINT candidate and a LINE candidate.
 * A point fully determines where the cursor lands (a corner, a midpoint, a
 * crossing). A line only removes one degree of freedom, which is why two of
 * them can be intersected — "lined up with that corner vertically AND square to
 * the wall I just drew" is a real CAD gesture and it is exactly the
 * intersection of an `align` line and a `perpendicular` line.
 */

import type { Point } from '../types';

export type SnapKind =
  /** a wall-centreline segment end, a free-chain end, or a chain vertex */
  | 'endpoint'
  /** the midpoint of a centreline segment */
  | 'midpoint'
  /** two centrelines (or their extensions) crossing */
  | 'intersection'
  /** the nearest point ON a centreline */
  | 'onSegment'
  /** the pending segment held square to a nearby wall */
  | 'perpendicular'
  /** the pending segment held parallel to a nearby wall */
  | 'parallel'
  /** the colinear continuation of a wall or of the previous segment */
  | 'extension'
  /** horizontal / vertical through a reference point */
  | 'align'
  /** the quantised angle lock */
  | 'angle'
  | 'grid'
  /** nothing was in reach (or snapping is suppressed) — the raw cursor */
  | 'free';

/** A candidate that fully determines the point. */
export interface SnapPoint {
  p: Point;
  kind: SnapKind;
  score: number;
  /** what it came from, for the guide the result draws */
  ref?: Point;
  /** second reference, for an `intersection` */
  ref2?: Point;
}

/** A candidate that constrains ONE degree of freedom — an INFINITE line. */
export interface SnapLine {
  origin: Point;
  /** unit direction */
  dir: Point;
  kind: SnapKind;
  score: number;
  /** where the guide should start; defaults to `origin` */
  ref?: Point;
}

export interface SnapGuide {
  a: Point;
  b: Point;
  kind: SnapKind;
  label?: string;
}

export interface SnapResult {
  p: Point;
  /** the winning candidate's kind — this is what selects the cursor glyph */
  kind: SnapKind;
  /** every constraint that contributed: one point, or one or two lines */
  kinds: SnapKind[];
  /** already ranked and capped; only constraints that ACTUALLY applied */
  guides: SnapGuide[];
}

/** One centreline (or raw wall) the engine may snap to. */
export interface SnapSegment {
  a: Point;
  b: Point;
  wallId?: string;
  roomId?: string;
}

/** A point worth landing exactly on, tagged with why it is interesting. */
export interface SnapRef {
  p: Point;
  kind: 'endpoint' | 'midpoint';
}

/**
 * Everything the engine reads. `segments` and `points` are design-derived and
 * should be built ONCE per gesture (`contextFromDesign`); `chain` and `anchor`
 * change every pointermove and are cheap to spread in.
 */
export interface SnapContext {
  segments: SnapSegment[];
  points: SnapRef[];
  /** the chain being drawn, in the same space as `segments`; [] outside a draw */
  chain: Point[];
  /**
   * The vertex the pending segment starts at — normally the last of `chain`.
   * Never a point-snap target itself (that would be a zero-length wall) but it
   * IS an alignment reference and the origin of every angle/perpendicular line.
   */
  anchor: Point | null;
}

export interface SnapConfig {
  /** px per metre — turns the px reaches below into world distances */
  zoom: number;
  pointReachPx: number;
  lineReachPx: number;
  /**
   * Ceiling on the world reach, whatever the zoom. Without it, zooming OUT
   * turns every snap into a magnet spanning metres — the mirror image of the
   * bug that made reach screen-relative in the first place.
   */
  maxWorldReach: number;
  /** metres; null = no grid fallback */
  gridStep: number | null;
  /** radians; null = no angle lock */
  angleStep: number | null;
  /** Alt held: return the cursor untouched, grid included */
  suppressed: boolean;
  /** undefined = every kind */
  enabled?: ReadonlySet<SnapKind>;
  maxGuides: number;
}

export const DEFAULT_SNAP_CONFIG: Omit<SnapConfig, 'zoom'> = {
  pointReachPx: 12,
  lineReachPx: 8,
  maxWorldReach: 0.25,
  gridStep: 0.05,
  angleStep: Math.PI / 12,
  suppressed: false,
  maxGuides: 3,
};

/**
 * How much each kind is worth before distance is subtracted. A stronger kind
 * wins from further away, which is what makes "a corner beats the angle lock"
 * true without being an absolute rule the user cannot escape.
 */
export const TYPE_WEIGHT: Record<SnapKind, number> = {
  endpoint: 100,
  intersection: 90,
  midpoint: 80,
  perpendicular: 70,
  parallel: 65,
  extension: 62,
  align: 60,
  onSegment: 50,
  angle: 40,
  grid: 10,
  free: 0,
};
