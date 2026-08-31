import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  OPEN_ANGLE,
  setFrontPoses,
  snapFrontPoses,
  stepFrontPoses,
  withClosedPoses,
} from '../../src/view3d/partMeshes';

/**
 * The open/close animation must be driven by WALL-CLOCK time, never by frame
 * count: CI renders through SwiftShader at a fraction of a display's refresh
 * rate, and a 120 Hz monitor must not open a door twice as fast as a 60 Hz one.
 */

/** a hinged pivot group shaped exactly like the ones partMeshes builds */
function hingeUnit(unit = 'z0.front0'): THREE.Group {
  const g = new THREE.Group();
  g.userData = {
    motionUnit: unit,
    kind: 'hinge',
    side: 'left',
    travel: 0,
    baseX: 0,
    baseZ: 0,
    baseRotY: 0,
    openT: 0,
    targetT: 0,
  };
  return g;
}

function slideUnit(unit = 'z0.drawer0'): THREE.Group {
  const g = new THREE.Group();
  g.userData = {
    motionUnit: unit,
    kind: 'slide',
    travel: 0.5,
    baseX: 0,
    baseZ: 0,
    baseRotY: 0,
    openT: 0,
    targetT: 0,
  };
  return g;
}

/** a sliding-DOOR pivot group (axis 'x'): travels sideways along the face */
function slideXUnit(opts: { baseRotY?: number; dir?: 1 | -1 } = {}): THREE.Group {
  const g = new THREE.Group();
  g.userData = {
    motionUnit: 'z0.slidingDoor0',
    kind: 'slide',
    travel: 0.4,
    axis: 'x',
    dir: opts.dir ?? 1,
    baseX: 0,
    baseZ: 0,
    baseRotY: opts.baseRotY ?? 0,
    openT: 0,
    targetT: 0,
  };
  return g;
}

const openAll = () => true;
const t = (u: THREE.Group): number => (u.userData as { openT: number }).openT;

describe('front-pose animation', () => {
  it('is frame-rate independent: many small steps == one big step', () => {
    const slow = [hingeUnit()];
    const fast = [hingeUnit()];
    setFrontPoses(slow, openAll);
    setFrontPoses(fast, openAll);

    // 12 frames at 60 fps vs a single 200 ms frame — same elapsed time
    for (let i = 0; i < 12; i++) stepFrontPoses(slow, 1 / 60);
    stepFrontPoses(fast, 12 / 60);

    expect(t(slow[0])).toBeCloseTo(t(fast[0]), 3);
  });

  it('reaches the open pose in the same TIME regardless of frame budget', () => {
    // 0.75 s of animation, delivered as 45 fast frames or 3 slow ones
    const smooth = [hingeUnit()];
    const janky = [hingeUnit()];
    setFrontPoses(smooth, openAll);
    setFrontPoses(janky, openAll);

    for (let i = 0; i < 45; i++) stepFrontPoses(smooth, 0.75 / 45);
    for (let i = 0; i < 3; i++) stepFrontPoses(janky, 0.25);

    expect(t(smooth[0])).toBeGreaterThan(0.99);
    expect(t(janky[0])).toBeGreaterThan(0.99);
    expect(smooth[0].rotation.y).toBeCloseTo(-OPEN_ANGLE, 2);
    expect(janky[0].rotation.y).toBeCloseTo(-OPEN_ANGLE, 2);
  });

  it('clamps a huge delta so a stalled loop cannot teleport the pose', () => {
    const units = [hingeUnit()];
    setFrontPoses(units, openAll);
    stepFrontPoses(units, 60); // one minute of stall in a single frame
    // POSE_DT_MAX caps it at 0.25 s -> 1 - e^-3, decidedly not a jump to 1
    expect(t(units[0])).toBeGreaterThan(0.9);
    expect(t(units[0])).toBeLessThan(1);
  });

  it('a zero or non-finite delta advances nothing', () => {
    const units = [hingeUnit()];
    setFrontPoses(units, openAll);
    expect(stepFrontPoses(units, 0)).toBe(true); // still moving, just not yet
    expect(t(units[0])).toBe(0);
    stepFrontPoses(units, Number.NaN);
    expect(t(units[0])).toBe(0);
  });

  it('snaps and stops once the remaining travel is imperceptible', () => {
    const units = [hingeUnit()];
    setFrontPoses(units, openAll);
    for (let i = 0; i < 10; i++) stepFrontPoses(units, 0.25);
    expect(t(units[0])).toBe(1);
    expect(stepFrontPoses(units, 1 / 60)).toBe(false); // settled: no more work
  });

  it('drives slide units along the face normal, also time-based', () => {
    const slow = [slideUnit()];
    const fast = [slideUnit()];
    setFrontPoses(slow, openAll);
    setFrontPoses(fast, openAll);
    for (let i = 0; i < 10; i++) stepFrontPoses(slow, 1 / 60);
    stepFrontPoses(fast, 10 / 60);
    expect(slow[0].position.z).toBeCloseTo(fast[0].position.z, 3);
    expect(slow[0].position.z).toBeGreaterThan(0);
  });

  it('drives an axis "x" slide sideways along the face, rotated with the unit and flippable by dir', () => {
    // baseRotY = 0: face-local +x is world +x
    const straight = [slideXUnit()];
    setFrontPoses(straight, openAll);
    snapFrontPoses(straight);
    expect(straight[0].position.x).toBeCloseTo(0.4, 6);
    expect(straight[0].position.z).toBeCloseTo(0, 6);

    // baseRotY = pi/2: same face-local +x maps to world -z (the rotation
    // mapping motionUnit already uses for pivots: (+cos ry, -sin ry))
    const rotated = [slideXUnit({ baseRotY: Math.PI / 2 })];
    setFrontPoses(rotated, openAll);
    snapFrontPoses(rotated);
    expect(rotated[0].position.x).toBeCloseTo(0, 6);
    expect(rotated[0].position.z).toBeCloseTo(-0.4, 6);

    // dir -1 flips the travel direction
    const reversed = [slideXUnit({ dir: -1 })];
    setFrontPoses(reversed, openAll);
    snapFrontPoses(reversed);
    expect(reversed[0].position.x).toBeCloseTo(-0.4, 6);
    expect(reversed[0].position.z).toBeCloseTo(0, 6);

    // withClosedPoses closes to the base position, then restores the live one
    const seenX = withClosedPoses(straight, () => straight[0].position.x);
    expect(seenX).toBeCloseTo(0, 6);
    expect(straight[0].position.x).toBeCloseTo(0.4, 6);
  });

  it('snapFrontPoses jumps straight to the target', () => {
    const units = [hingeUnit()];
    setFrontPoses(units, openAll);
    snapFrontPoses(units);
    expect(t(units[0])).toBe(1);
    expect(units[0].rotation.y).toBeCloseTo(-OPEN_ANGLE, 6);
  });

  it('withClosedPoses restores the live pose afterwards (GLB export path)', () => {
    const units = [hingeUnit()];
    setFrontPoses(units, openAll);
    snapFrontPoses(units);
    const seen = withClosedPoses(units, () => units[0].rotation.y);
    expect(seen).toBeCloseTo(0, 6); // closed while the export ran
    expect(units[0].rotation.y).toBeCloseTo(-OPEN_ANGLE, 6); // and restored
  });
});
