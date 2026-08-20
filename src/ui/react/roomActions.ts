import type { Store } from '../../model/store';
import { confirmDialog } from '../dialogService';

/**
 * "Delete room" asked once, for both surfaces that offer it — the context menu
 * and the room inspector — so the question and the cascade description cannot
 * drift apart (same reason exportActions.ts exists for the two export routes).
 *
 * The body describes what `Store.deleteRoom` actually does: items inside the
 * room (plus anything attached to them) go, and an opening on one of its walls
 * survives only when that wall is a partition it can be re-homed onto.
 */
export async function confirmDeleteRoom(store: Store, roomId: string, name: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete room?',
    body: `"${name}" and the items in it are deleted. Openings on a shared wall move to the room next door, the rest go too.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  // the room can be gone by the time the answer lands (undo, a second surface)
  if (!ok || !store.roomById(roomId)) return;
  store.deleteRoom(roomId);
  store.commit();
}
