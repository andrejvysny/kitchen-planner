/**
 * Which no-selection room-panel sections each workspace shows, in order.
 * Mirrors `CatalogSection.workspace` (src/model/catalog.ts) — same "tag a
 * section with the workspace(s) it belongs to, filter at render time" shape,
 * applied to the right panel instead of the left one. A section id listed
 * under both workspaces (`checks`) is shared/reused, not duplicated.
 *
 * Plan owns floor-plan STRUCTURE (rooms, size, shape, reference photo);
 * Furnish owns FINISH (materials, lighting) — see CLAUDE.md's workspace
 * scoping note. `RoomProps.tsx` maps each id to its section component.
 */
export type RoomSectionId =
  | 'identity'
  | 'roomList'
  | 'referencePhoto'
  | 'checks'
  | 'size'
  | 'shape'
  | 'ceiling'
  | 'deleteRoom'
  | 'tip'
  | 'walls'
  | 'floor'
  | 'worktops'
  | 'lighting'
  | 'staging';

export const WORKSPACE_ROOM_SECTIONS: Record<'plan' | 'furnish', readonly RoomSectionId[]> = {
  plan: [
    'identity',
    'roomList',
    'referencePhoto',
    'checks',
    'size',
    'shape',
    'ceiling',
    'deleteRoom',
    'tip',
  ],
  // staging goes LAST: appending keeps test/interact.mjs's "the room panel's
  // first numeric field" ordinal intact
  furnish: ['checks', 'walls', 'floor', 'worktops', 'lighting', 'staging'],
};
