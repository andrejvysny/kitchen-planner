/**
 * What a multi-selection DOES, as pure geometry — no store, no DOM, so the
 * rules can be pinned without a canvas and the plan view and the 3D view can
 * only ever apply the same ones.
 *
 * Both operations here answer the same question in two ways: a selection moves
 * RIGIDLY. Snapping or rotating each member on its own deforms the arrangement
 * the user built, which is exactly what they selected several things to avoid.
 */

import type { Point } from '../model/types';

/** The slice of an Item these operations need. */
export interface Posed {
  id: string;
  x: number;
  y: number;
  rotation: number;
}

/** A patch to apply through `store.updateItem`. */
export interface PosePatch {
  id: string;
  x: number;
  y: number;
  rotation: number;
}

/**
 * The centre a multi-rotate turns about: the middle of the bounding box of the
 * item CENTRES.
 *
 * Deliberately not the bounding box of the outlines — that box changes as the
 * set turns (a rotating rectangle's AABB grows and shrinks), so the centre
 * would drift across successive presses of R and the set would walk away from
 * where it started.
 */
export function selectionCentre(items: readonly Posed[]): Point | null {
  if (!items.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    maxX = Math.max(maxX, it.x);
    minY = Math.min(minY, it.y);
    maxY = Math.max(maxY, it.y);
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Turn every item by `step` radians about `centre`, carrying its position
 * round with it. One item turns about its own centre, which is what
 * `selectionCentre` returns for a set of one — so the single-selection
 * behaviour falls out rather than being a special case.
 */
export function rotateAbout(items: readonly Posed[], centre: Point, step: number): PosePatch[] {
  const c = Math.cos(step);
  const s = Math.sin(step);
  return items.map((it) => {
    const dx = it.x - centre.x;
    const dy = it.y - centre.y;
    return {
      id: it.id,
      x: centre.x + dx * c - dy * s,
      y: centre.y + dx * s + dy * c,
      rotation: it.rotation + step,
    };
  });
}

/**
 * Drop the members whose pose is not theirs to change: an appliance mounted on
 * a host that is moving too is carried by `syncAttachments`, so transforming it
 * here as well would apply the change twice.
 */
export function withoutCarried<T extends { id: string; attach?: { hostId: string } }>(
  items: readonly T[]
): T[] {
  const moving = new Set(items.map((it) => it.id));
  return items.filter((it) => !(it.attach && moving.has(it.attach.hostId)));
}
