import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { catalogDef } from '../../model/catalog';
import { hasPreset } from '../../model/presets';
import { contextMenu, type ContextHit, type MenuEntry } from '../contextMenuModel';
import { openInWorkshop, workspace } from '../workspaceState';
import { useMenuDismiss } from './hooks/useMenuDismiss';
import { useAppServices } from './services';

/**
 * The right-click menu over the two canvases (WS-SPEC §5.1, WP 2.1).
 *
 * Three parts, deliberately separated:
 *  - WHAT is under the pointer — `Plan2D.hitAt()` in the plan, `View3D.pickItem()`
 *    in 3D. Both are thin façades over the hit testers the click paths already
 *    run, so the menu can never disagree with what a left-click would select.
 *  - WHICH entries that earns — src/ui/contextMenuModel.ts, pure and unit-tested.
 *  - WHAT each entry does — the dispatch below, and every branch of it is an
 *    EXISTING mutation or an existing command. Nothing here is a new operation:
 *    a context menu that could do things no other route can is a second
 *    implementation waiting to drift.
 *
 * The item entries go through `commands.execute()` rather than the store, so the
 * menu and the keyboard share one path (and one `canExecute` guard, and one
 * undo step). That is why they select first: the commands act on the selection.
 *
 * Mounted as a CHILD of <Workspace/> for the reason that component's header
 * gives — it must stay stateless and never reconcile, so anything holding state
 * arrives as a child, exactly like <WorkshopPane/> and the canvas overlays.
 */

interface OpenMenu {
  /** viewport coordinates of the press; clamped to the window on layout */
  x: number;
  y: number;
  hit: ContextHit;
  entries: readonly MenuEntry[];
}

/** Gap kept between the menu and the window edge when it has to be nudged in. */
const EDGE = 6;

export function ContextMenu(): ReactElement | null {
  const { store, plan, view3d, commands } = useAppServices();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setMenu(null), []);
  useMenuDismiss(menu !== null, close, box);

  /**
   * One `contextmenu` listener per canvas. preventDefault ALWAYS — the browser
   * menu over a drawing surface is never the right answer, even where this one
   * has nothing to offer (Plan2D already suppresses it for the same reason).
   */
  useEffect(() => {
    const plan2d = document.getElementById('canvas2d');
    const canvas3d = document.getElementById('canvas3d');
    if (!plan2d || !canvas3d) return;

    const open = (hit: ContextHit, e: MouseEvent): void => {
      const entries = contextMenu(hit, workspace(), {
        multiRoom: store.design.rooms.length > 1,
        activeRoomId: store.activeRoomId,
      });
      // no entries = no popup. An empty menu is worse than no menu.
      if (!entries.length) {
        setMenu(null);
        return;
      }
      // Right-click selects what it acts on, as every editor does — it is what
      // makes "Set wall length…" coherent (the panel it focuses is the panel
      // for the thing just clicked). Rooms are the exception: activating one is
      // an ENTRY here, so auto-activating would delete its own menu item.
      if (hit.kind === 'item') store.select({ kind: 'item', id: hit.itemId });
      else if (hit.kind === 'wall') store.select({ kind: 'wall', id: hit.wallId });
      setMenu({ x: e.clientX, y: e.clientY, hit, entries });
    };

    const onPlan = (e: MouseEvent): void => {
      e.preventDefault();
      open(plan.hitAt(e.clientX, e.clientY), e);
    };
    const on3d = (e: MouseEvent): void => {
      e.preventDefault();
      // 3D picks items and nothing else: walls and rooms are edited in the plan
      const item = view3d.pickItem(e);
      if (!item) {
        setMenu(null);
        return;
      }
      open({ kind: 'item', itemId: item.id }, e);
    };

    plan2d.addEventListener('contextmenu', onPlan);
    canvas3d.addEventListener('contextmenu', on3d);
    return () => {
      plan2d.removeEventListener('contextmenu', onPlan);
      canvas3d.removeEventListener('contextmenu', on3d);
    };
  }, [store, plan, view3d]);

  /** Keep the popup inside the window, and give it the keyboard. */
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !menu) return;
    el.style.left = `${Math.max(EDGE, Math.min(menu.x, window.innerWidth - el.offsetWidth - EDGE))}px`;
    el.style.top = `${Math.max(EDGE, Math.min(menu.y, window.innerHeight - el.offsetHeight - EDGE))}px`;
    el.focus();
  }, [menu]);

  const run = (entryId: string): void => {
    if (menu) dispatch(entryId, menu.hit);
    close();
  };

  /**
   * Escape closes, arrows rove. Both stop propagation: the global key map lives
   * on `window` (src/editor/keyboard/), and an Escape that closed this menu must
   * not also cancel the live tool.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...box.current!.querySelectorAll('button')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const down = e.key === 'ArrowDown';
    const next =
      at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  };

  /* ---------------- dispatch: every branch is an existing mutation ---------------- */

  const dispatch = (id: string, hit: ContextHit): void => {
    switch (id) {
      /* ---- wall ---- */
      case 'add-corner': {
        if (hit.kind !== 'wall') return;
        // the same three lines Plan2D's dblclick runs — one behaviour, two routes
        const corner = store.splitWall(hit.wallId, hit.t);
        if (!corner) return;
        store.select({ kind: 'corner', id: corner.id });
        store.commit();
        return;
      }
      case 'add-door':
      case 'add-window':
        // plain arming: the opening lands where the NEXT click puts it, because
        // that click is also what picks the side and the offset
        plan.setArmed(catalogDef(id === 'add-door' ? 'door' : 'window'));
        return;
      case 'wall-length':
        if (hit.kind !== 'wall') return;
        store.select({ kind: 'wall', id: hit.wallId });
        focusField('#props-inner input[data-cls="wall-len"]');
        return;
      case 'wall-colour': {
        if (hit.kind !== 'wall') return;
        // wall finishes are a ROOM style in this model (one palette per room),
        // so the honest destination is that room's Walls section
        const room = store.roomOfWall(hit.wallId);
        if (room) store.setActiveRoom(room.id);
        store.select({ kind: 'none' });
        scrollToSection('section-walls');
        return;
      }

      /* ---- room ---- */
      case 'activate-room':
        if (hit.kind !== 'room') return;
        // ephemeral view state: no notify, no commit, never an undo step
        store.setActiveRoom(hit.roomId);
        store.select({ kind: 'none' });
        return;
      case 'rename-room':
        if (hit.kind !== 'room') return;
        store.setActiveRoom(hit.roomId);
        store.select({ kind: 'none' });
        focusField('#props-inner .room-name');
        return;
      case 'shape-rect':
      case 'shape-l':
        if (hit.kind !== 'room') return;
        store.setShapePreset(id === 'shape-rect' ? 'rect' : 'lshape', hit.roomId);
        store.commit();
        return;
      case 'delete-room': {
        if (hit.kind !== 'room') return;
        const room = store.roomById(hit.roomId);
        if (!room) return;
        if (!confirm(`Delete "${room.name}" and everything in it?`)) return;
        store.deleteRoom(hit.roomId);
        store.commit();
        return;
      }

      /* ---- item ---- */
      case 'edit-workshop': {
        if (hit.kind !== 'item') return;
        const item = store.itemById(hit.itemId);
        if (!item) return;
        // mirrors src/ui/react/props/ItemProps.tsx: a design-local part opens as
        // itself, a preset forks first so only THIS instance becomes editable
        if (store.customPartById(item.defId)) {
          openInWorkshop(item.defId, item.id);
          return;
        }
        if (!hasPreset(item.defId)) return;
        const fork = store.forkPartForItem(item.id);
        if (!fork) return;
        store.commit();
        openInWorkshop(fork.id, item.id);
        return;
      }
      case 'duplicate':
      case 'rotate90':
      case 'delete': {
        if (hit.kind !== 'item') return;
        store.select({ kind: 'item', id: hit.itemId });
        commands.execute(
          id === 'duplicate'
            ? 'selection.duplicate'
            : id === 'rotate90'
              ? 'transform.rotate90'
              : 'selection.delete'
        );
        return;
      }

      /* ---- empty floor ---- */
      case 'add-room':
        plan.setRoomTool(true);
        return;
      case 'draw-room':
        plan.setDrawRoom(true);
        return;
    }
  };

  if (!menu) return null;

  return (
    <div
      id="context-menu"
      className="context-menu"
      role="menu"
      aria-label="Context menu"
      tabIndex={-1}
      ref={box}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          data-cmd={entry.id}
          className={entry.danger ? 'danger' : undefined}
          onClick={() => run(entry.id)}
        >
          <span className="ctx-label">{entry.label}</span>
          {entry.hint ? <span className="ctx-hint">{entry.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Put the caret in the field the entry promised to open. The properties panel
 * re-renders off the store event that just fired, so the node may not exist
 * yet — retry for a few frames rather than guess at React's commit timing.
 */
function focusField(selector: string, tries = 10): void {
  const el = document.querySelector<HTMLInputElement>(selector);
  if (el) {
    el.focus();
    el.select();
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusField(selector, tries - 1));
}

/** Same idea for a section that has no field to focus, only a place to be. */
function scrollToSection(id: string, tries = 10): void {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => scrollToSection(id, tries - 1));
}
