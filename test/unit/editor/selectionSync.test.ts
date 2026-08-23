import { describe, expect, it } from 'vitest';
import { EditorState } from '../../../src/editor/editorState';
import { syncSelection } from '../../../src/editor/selectionSync';
import { catalogDef } from '../../../src/model/catalog';
import { emptyDesign, Store } from '../../../src/model/store';

/**
 * src/editor/selectionSync.ts — the one wire between the editor's selection and
 * the store's lifetime. Before M18 each delete path cleared `store.selection`
 * inline; these are the same behaviours, now stated once.
 */
function setup(): { store: Store; editor: EditorState; off: () => void } {
  const store = new Store(emptyDesign());
  store.addRoom({ w: 4, d: 3 });
  store.commit();
  const editor = new EditorState();
  const off = syncSelection(store, editor);
  return { store, editor, off };
}

describe('syncSelection', () => {
  it('drops a deleted item from the selection', () => {
    const { store, editor } = setup();
    const it = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.commit();
    editor.select({ kind: 'item', id: it.id });

    store.deleteItem(it.id);
    expect(editor.selection).toEqual({ kind: 'none' });
  });

  it('keeps the rest of a multi-selection when one member dies', () => {
    const { store, editor } = setup();
    const def = store.defOf('base-cabinet');
    const a = store.addItem(def, 1, 1);
    const b = store.addItem(def, 2, 1);
    store.commit();
    editor.selectRefs([
      { kind: 'item', id: a.id },
      { kind: 'item', id: b.id },
    ]);

    store.deleteItem(b.id);
    expect(editor.selectedItemIds()).toEqual([a.id]);
    expect(editor.selection).toEqual({ kind: 'item', id: a.id });
  });

  it('drops a deleted opening and a wall that no longer resolves', () => {
    const { store, editor } = setup();
    const wallId = store.allWalls()[0].id;
    const o = store.addOpening(catalogDef('door'), wallId, 1);
    store.commit();

    editor.select({ kind: 'opening', id: o.id });
    store.deleteOpening(o.id);
    expect(editor.selection).toEqual({ kind: 'none' });

    editor.select({ kind: 'wall', id: 'no-such-wall' });
    store.notify({ structural: true });
    expect(editor.selection).toEqual({ kind: 'none' });
  });

  it('leaves a live selection alone', () => {
    const { store, editor } = setup();
    const it = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.commit();
    editor.select({ kind: 'item', id: it.id });

    store.updateItem(it.id, { w: 0.8 });
    store.commit();
    expect(editor.selection).toEqual({ kind: 'item', id: it.id });
  });

  it('a TRANSIENT tick never prunes — a drag cannot delete anything', () => {
    const { store, editor } = setup();
    let checked = 0;
    editor.select({ kind: 'item', id: 'gone' });
    // count the exists() probes by re-selecting through a spy-free route:
    // a transient notify must not reach entityExists at all
    const realExists = store.entityExists.bind(store);
    store.entityExists = (ref): boolean => {
      checked++;
      return realExists(ref);
    };

    store.notify({ structural: false, transient: true });
    expect(checked).toBe(0);
    expect(editor.selection).toEqual({ kind: 'item', id: 'gone' });

    store.notify({ structural: false });
    expect(checked).toBeGreaterThan(0);
    expect(editor.selection).toEqual({ kind: 'none' });
  });

  it('a design swap clears the selection outright, and undo counts as one', () => {
    const { store, editor } = setup();
    const it = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.commit();
    editor.select({ kind: 'item', id: it.id });

    store.undo();
    expect(editor.selection).toEqual({ kind: 'none' });
  });

  it('the disposer drops both subscriptions', () => {
    const { store, editor, off } = setup();
    const it = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.commit();
    editor.select({ kind: 'item', id: it.id });

    off();
    store.deleteItem(it.id);
    expect(editor.selection).toEqual({ kind: 'item', id: it.id });
  });
});
