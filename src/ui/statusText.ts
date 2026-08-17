import type { Store } from '../model/store';

/**
 * The status bar's right-hand summary — item count, floor area, and the room
 * and issue counts when there is something to say about them.
 *
 * Pure and DOM-free so it can be unit-tested in plain node: the string is a
 * contract (test/interact.mjs reads #status-info back verbatim), and it used to
 * live inline in src/ui/ui.ts updateInfo where nothing could reach it.
 */
export function statusInfoText(store: Store): string {
  const rooms = store.design.rooms.length;
  // info-severity findings are hints, not issues — they stay out of the count
  const issues = store.warnings().filter((w) => w.severity !== 'info').length;
  return (
    `${store.design.items.length} items · ${store.totalFloorArea().toFixed(1)} m²` +
    (rooms > 1 ? ` · ${rooms} rooms` : '') +
    (issues > 0 ? ` · ${issues} issue${issues === 1 ? '' : 's'}` : '')
  );
}
