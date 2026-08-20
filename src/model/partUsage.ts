import type { Design } from './types';

/**
 * How many placed items resolve to a part def, and which ones — the Part
 * Studio's scope line (WS-SPEC WP 3.2). Live-apply (WP 3.1) means an edit to
 * a def reaches every item that shares it at once, so the studio says up
 * front how many that is before the user touches anything.
 *
 * Pure, no Store import — a plain array walk over `design.items`, mirroring
 * `discardPristineShadow`/`forkPartForItem`'s own `defId ===` filters in
 * store.ts rather than adding a new resolution rule.
 */

/** Placed item ids whose `defId` is exactly `defId`, in `design.items` order. */
export function instanceIdsOf(design: Design, defId: string): string[] {
  return design.items.filter((i) => i.defId === defId).map((i) => i.id);
}

/** How many placed items resolve to `defId`. */
export function instancesOf(design: Design, defId: string): number {
  return instanceIdsOf(design, defId).length;
}
