/**
 * The ONE wire between the editor's selection and the store's lifetime.
 *
 * The selection moved off the Store in M18, so a delete can no longer clear it
 * inline. Instead: after every SETTLED change, whatever is held is re-checked
 * against the design, and a wholesale design swap ('reset' — an undo/redo
 * restore, a file load, New) drops it outright, which is exactly what the store
 * used to do at those three call sites.
 *
 * Transient ticks are skipped deliberately. A drag cannot delete anything, and
 * `entityExists` resolves a wall through `allWalls()` — far too much work to
 * repeat at pointer rate.
 *
 * `Store` arrives as a TYPE-only import (the same inversion commands/types.ts
 * uses), so src/editor still pulls no store runtime.
 */

import type { Store } from '../model/store';
import type { EditorState } from './editorState';

/** Returns a disposer that drops both subscriptions. */
export function syncSelection(store: Store, editor: EditorState): () => void {
  const offChange = store.on('change', (info) => {
    if (!info.transient) editor.pruneSelection((ref) => store.entityExists(ref));
  });
  const offReset = store.on('reset', () => editor.select({ kind: 'none' }));
  return () => {
    offChange();
    offReset();
  };
}
