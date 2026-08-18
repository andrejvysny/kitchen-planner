/**
 * The right-click menu, as DATA (WS-SPEC §5.1, WP 2.1).
 *
 * Framework-free and pure, the same way src/ui/outlineModel.ts is the grouping
 * truth for the outline panel: what a right-click OFFERS is a decision about
 * the model, and belongs where it can be unit-tested as a table rather than
 * asserted through a rendered DOM. src/ui/react/ContextMenu.tsx only draws
 * these entries and maps each `id` onto a mutation that already exists.
 *
 * Two rules the matrix below encodes, both worth stating out loud:
 *
 * 1. **Every entry teaches its gesture.** `hint` is the keyboard or mouse route
 *    to the same command, shown trailing and muted. A context menu that only
 *    hides shortcuts makes users slower; one that names them is a tutorial that
 *    costs nothing.
 * 2. **An entry that cannot work is not shown, ever disabled.** `store.deleteRoom`
 *    refuses the last room and `setActiveRoom` on the active room is a no-op, so
 *    those two entries are omitted rather than greyed out — a menu of dead rows
 *    is worse than a short menu.
 *
 * Submenu-free on purpose: one flat list, at most five rows.
 */

import type { WorkspaceId } from '../editor/commands/types';
import type { ContextHit } from '../plan2d/planHit';

export type { ContextHit };

export interface MenuEntry {
  /** Dispatch key — ContextMenu.tsx switches on it. Also the `data-cmd` hook. */
  id: string;
  label: string;
  /** The gesture that does the same thing: 'Ctrl+D', 'R', 'double-click'. */
  hint?: string;
  /** Destructive: red, and last in its menu. */
  danger?: boolean;
}

export interface MenuOpts {
  /** More than one room exists, so `deleteRoom` will not refuse. */
  multiRoom: boolean;
  activeRoomId: string;
}

/** Workspaces whose canvases are visible; the other two are covered by a pane. */
const CANVAS_WORKSPACES: readonly WorkspaceId[] = ['plan', 'furnish'];

/**
 * The entries for one hit, or [] when there is no menu to show. An empty list
 * means the caller shows NOTHING — never an empty popup.
 *
 * `ws` gates twice: nothing at all outside the two canvas workspaces (belt and
 * braces — a pane already covers the canvases there), and the room-creation
 * entries only in Plan, where the room tools live (WS-SPEC §4.4).
 */
export function contextMenu(hit: ContextHit, ws: WorkspaceId, opts: MenuOpts): MenuEntry[] {
  if (!CANVAS_WORKSPACES.includes(ws)) return [];

  switch (hit.kind) {
    case 'item':
      return [
        { id: 'edit-workshop', label: 'Edit in Workshop' },
        { id: 'duplicate', label: 'Duplicate', hint: 'Ctrl+D' },
        { id: 'rotate90', label: 'Rotate 90°', hint: 'R' },
        { id: 'delete', label: 'Delete', hint: 'Delete', danger: true },
      ];

    case 'wall':
      return [
        { id: 'add-corner', label: 'Add corner here', hint: 'double-click' },
        { id: 'add-door', label: 'Add door' },
        { id: 'add-window', label: 'Add window' },
        { id: 'wall-length', label: 'Set wall length…' },
        { id: 'wall-colour', label: 'Wall colour…' },
      ];

    case 'room': {
      const out: MenuEntry[] = [];
      if (hit.roomId !== opts.activeRoomId) {
        out.push({ id: 'activate-room', label: 'Make active room', hint: 'click' });
      }
      out.push(
        { id: 'rename-room', label: 'Rename room…' },
        { id: 'shape-rect', label: 'Shape: rectangle' },
        { id: 'shape-l', label: 'Shape: L' }
      );
      // the store refuses the last room, so the row would be a dead end
      if (opts.multiRoom) out.push({ id: 'delete-room', label: 'Delete room', danger: true });
      return out;
    }

    case 'empty':
      // outside every room there is nothing to act ON, only something to create
      return ws === 'plan'
        ? [
            { id: 'add-room', label: 'Add a room' },
            { id: 'draw-room', label: 'Draw a room' },
          ]
        : [];
  }
}
