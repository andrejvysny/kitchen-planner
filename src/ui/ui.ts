import type { Store } from '../model/store';
import type { Plan2D } from '../plan2d/plan2d';
import type { EditorState } from '../editor/editorState';
import { studio } from '../app/bootstrap';

/**
 * What is left of the legacy UI controller: the global keyboard map.
 *
 * Everything else went to components — B2 the topbar and status bar, B3 the
 * tool buttons, the 2D/elev toggle, the wall nav and the catalog drawer, T3
 * the sidebar tabs and the Variables panel, T4 the catalog and the components
 * outline, and T5 the whole properties inspector. This class holds no DOM of
 * its own and subscribes to no store event; it owns one `keydown` listener on
 * `window`, which is the one thing that is genuinely global and belongs to no
 * component.
 *
 * With that it also gains the lifecycle the three views have had since Phase
 * A: `dispose()` aborts the listener, so constructing a second instance is a
 * legitimate thing to do and `mountLegacyUI()`'s module guard has stopped
 * being load-bearing. The last step of the migration turns this into an
 * App-level effect that constructs one and disposes it.
 */
export class UI {
  private store: Store;
  private plan: Plan2D;
  private editor: EditorState;
  private keys = new AbortController();

  constructor(store: Store, plan: Plan2D, editor: EditorState) {
    this.store = store;
    this.plan = plan;
    this.editor = editor;

    this.wireKeyboard();
  }

  /** Release the keyboard map. Idempotent — aborting a spent controller is a no-op. */
  dispose(): void {
    this.keys.abort();
  }

  /* ================= keyboard shortcuts ================= */

  private wireKeyboard(): void {
    window.addEventListener(
      'keydown',
      (e) => {
        const target = e.target as HTMLElement;
        const typing =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable;

        // one tool is live at a time, so the order below is really a priority
        // list for the studio-vs-tool-vs-selection question, not a cascade
        if (e.key === 'Escape') {
          const tool = this.editor.tool;
          if (studio.isOpen()) studio.handleEscape();
          else if (tool === 'place') this.plan.setArmed(null);
          else if (tool === 'calibrate') this.plan.setCalibrate(false);
          else if (tool === 'measure') this.plan.setMeasure(false);
          else if (tool === 'room') this.plan.setRoomTool(false);
          // two-stage: the ring in progress goes first, the tool only when empty
          else if (tool === 'drawRoom') this.plan.cancelDrawRoom();
          else this.store.select({ kind: 'none' });
          return;
        }
        if (typing || studio.isOpen()) return;

        // Enter closes the ring the draw-room tool is building
        if (e.key === 'Enter' && this.editor.isTool('drawRoom')) {
          e.preventDefault();
          this.plan.closeDrawRoom();
          return;
        }

        const sel = this.store.selection;
        const mod = e.ctrlKey || e.metaKey;

        if (mod && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.store.redo();
          else this.store.undo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          this.store.redo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'd' && sel.kind === 'item') {
          e.preventDefault();
          const copy = this.store.duplicateItem(sel.id);
          if (copy) this.store.select({ kind: 'item', id: copy.id });
          this.store.commit();
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel.kind !== 'none') {
          e.preventDefault();
          if (sel.kind === 'item') this.store.deleteItem(sel.id);
          else if (sel.kind === 'opening') this.store.deleteOpening(sel.id);
          else if (sel.kind === 'corner') this.store.deleteCorner(sel.id);
          this.store.commit();
          return;
        }
        if (e.key.toLowerCase() === 'r' && sel.kind === 'item') {
          e.preventDefault();
          const it = this.store.itemById(sel.id);
          if (it) {
            const step = e.shiftKey ? Math.PI / 12 : Math.PI / 2;
            this.store.updateItem(sel.id, { rotation: it.rotation + step }, { structural: false });
            this.store.commit();
          }
          return;
        }
        if (e.key.startsWith('Arrow') && sel.kind === 'item') {
          e.preventDefault();
          const it = this.store.itemById(sel.id);
          if (!it) return;
          const step = e.shiftKey ? 0.1 : 0.01;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          this.store.updateItem(sel.id, { x: it.x + dx, y: it.y + dy }, { structural: false });
          this.store.commit();
        }
      },
      { signal: this.keys.signal }
    );
  }
}
