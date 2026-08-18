import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useAppServices, useEditor, useStore } from './services';
import { navInput, setNavInput } from '../../model/navPref';
import { emptyDesign, sanitizeDesign } from '../../model/store';
import { isMac, NAV_INPUTS, type NavInput } from '../../view3d/wheelInput';
import { catalogOpen, setCatalogOpen, setHint } from '../shellState';
import { applyCalibration, importUnderlay } from '../underlayImport';
import { workspace, type WorkspaceId } from '../workspaceState';
import {
  download,
  exportBomSheet,
  exportBuyCsv,
  exportCutCsv,
  exportGlb,
  exportPlanSheet,
  exportSnapshotPng,
} from './exportActions';
import { useChannel } from './hooks/useStore';

/**
 * The top bar. B1 ported the markup from index.html node-for-node; B2/B3 moved
 * the BEHAVIOR off src/ui/ui.ts's old wireTopbar/wireExportMenu into the
 * components below — same ids, classes, attribute values and order
 * (e2e/dom-contract.spec.ts pins them), same public calls on the store and the
 * views.
 *
 * Every piece of state is held by the smallest component that needs it, so
 * <Topbar/> itself stays stateless and never re-renders. That matters: the DOM
 * ui.ts still writes to must never be reconciled out from under it.
 *
 * WS-SPEC §2.3 slimmed it to the document level — workspaces, history, files.
 * What steers the DRAWING went onto the canvases (src/ui/react/CanvasOverlays.tsx:
 * the 2D/Split/3D toggle and the day-night / open-fronts pair), what is a device
 * preference went behind the gear (<SettingsMenu/>), and the two one-shot 3D
 * exports became <ExportMenu/> entries beside the ones that were already there.
 */
export function Topbar(): ReactElement {
  return (
    <header id="topbar">
      <div className="brand">
        <span className="brand-mark">▦</span>
        <span className="brand-name">Interior Planner</span>
      </div>
      <CatalogButton />
      <WorkspaceTabs />
      <HistoryButtons />
      <div className="topbar-spacer"></div>
      <FileGroup />
      <SettingsMenu />
    </header>
  );
}

/* ================= catalog drawer ================= */

/**
 * Narrow screens only (the button is display:none above 900px): the catalog is
 * an off-canvas drawer, and this is its handle. The open flag lives in
 * shellState so <Sidebar/> can put `.open` on #catalog — the two components are
 * on opposite sides of the tree, which is exactly what a shell singleton is
 * for.
 */
function CatalogButton(): ReactElement {
  const editor = useEditor();
  useChannel('shell');
  useChannel('editor');
  const btn = useRef<HTMLButtonElement>(null);
  const open = catalogOpen();

  // click-away close, as wireTopbar had it: pointerdown (not click) so it lands
  // before a catalog tile's own click, and never on a press that hit the drawer
  // or this button — those own the toggle. Cleanup keeps a StrictMode double
  // mount from stacking listeners.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      const cat = document.getElementById('catalog')!;
      if (!cat.contains(t) && !btn.current!.contains(t)) setCatalogOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // arming a tile closes the drawer: it covers the plan you are about to click
  const armed = editor.isTool('place');
  useEffect(() => {
    if (armed) setCatalogOpen(false);
  }, [armed]);

  return (
    <button
      id="btn-catalog"
      title="Show / hide the catalog"
      ref={btn}
      onClick={() => setCatalogOpen(!catalogOpen())}
    >
      ☰
    </button>
  );
}

/* ================= workspace tabs ================= */

const WS: { id: WorkspaceId; label: string; title: string }[] = [
  { id: 'plan', label: 'Plan', title: 'Rooms, walls, doors and windows (1)' },
  { id: 'furnish', label: 'Furnish', title: 'Place furniture, appliances and lighting (2)' },
  { id: 'workshop', label: 'Workshop', title: 'Design and customize your own parts (3)' },
  { id: 'output', label: 'Output', title: 'Drawings, cut lists and exports (4)' },
];

/**
 * The four task workspaces — the app's PRIMARY navigation, which is why it
 * sits first in the bar and reads heavier than the view toggle beside it.
 *
 * Every path that changes workspace goes through `switchWorkspace`, the app's
 * one guarded switch (src/app/services.ts): these buttons, the `workspace.*`
 * commands behind keys 1-4, and the panes to come. The component holds NO
 * state of its own — `workspace()` is the truth and the 'workspace' channel is
 * the re-render ticket — so <Topbar/> above stays stateless.
 *
 * A `<nav>` rather than a tablist: there are no tabpanels to point
 * `aria-controls` at yet, and a landmark marks its current destination with
 * `aria-current`. Arrows move the CARET only, like a link list — selection is
 * the button's own click, so Tab-then-Enter never switches by accident.
 */
function WorkspaceTabs(): ReactElement {
  const { switchWorkspace } = useAppServices();
  useChannel('workspace');
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const current = workspace();

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : WS.length - 1)) % WS.length;
    btns.current[next]?.focus();
  };

  return (
    <nav id="ws-tabs" className="ws-tabs" aria-label="Workspace">
      {WS.map((w, i) => (
        <button
          key={w.id}
          id={`ws-tab-${w.id}`}
          data-ws={w.id}
          className={current === w.id ? 'active' : undefined}
          aria-current={current === w.id ? 'true' : undefined}
          title={w.title}
          ref={(el) => {
            btns.current[i] = el;
          }}
          onClick={() => switchWorkspace(w.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {w.label}
        </button>
      ))}
    </nav>
  );
}

/* ================= reference photo ================= */

/**
 * The tracing-photo picker. Hidden markup in the topbar, clicked from the
 * props panel's Reference-photo section (src/ui/react/props/UnderlaySection.tsx)
 * — it lives here because that section unmounts with the room panel and the
 * calibration callback below has to outlive it.
 *
 * Plan2D reports a finished calibration through `onCalibrateDone`, not through
 * the editor state, because answering it needs a blocking prompt no view
 * should own. Both halves are in src/ui/underlayImport.ts.
 */
function UnderlayInput(): ReactElement {
  const { store, plan } = useAppServices();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    plan.onCalibrateDone = (d) => applyCalibration(store, d);
    return () => {
      plan.onCalibrateDone = null;
    };
  }, [plan, store]);

  const onPick = async (): Promise<void> => {
    const el = input.current!;
    const f = el.files?.[0];
    el.value = ''; // same file twice in a row must still fire a change
    if (f) await importUnderlay(store, f);
  };

  return (
    <input
      type="file"
      id="underlay-input"
      accept="image/*"
      hidden
      ref={input}
      onChange={() => void onPick()}
    />
  );
}

/* ================= undo / redo ================= */

/** Enablement tracks the undo stacks, which only ever move on 'history'. */
function HistoryButtons(): ReactElement {
  const store = useStore();
  useChannel('history');
  return (
    <div className="topbar-group">
      <button
        id="btn-undo"
        title="Undo (Ctrl+Z)"
        disabled={!store.canUndo()}
        onClick={() => store.undo()}
      >
        ↩
      </button>
      <button
        id="btn-redo"
        title="Redo (Ctrl+Y)"
        disabled={!store.canRedo()}
        onClick={() => store.redo()}
      >
        ↪
      </button>
    </div>
  );
}

/* ================= dropdown plumbing ================= */

/**
 * Click-away close, shared by the two topbar dropdowns. Pointerdown, not click:
 * it must fire before a menu item's own click — and must NOT close when the
 * press lands on the button (that would fight its toggle) or inside the menu
 * (the item still needs its click). Cleanup keeps a StrictMode double mount
 * from stacking listeners.
 */
function useMenuDismiss(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  btn: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!menu.current!.contains(t) && !btn.current!.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, setOpen, btn, menu]);
}

/* ================= settings ================= */

const NAV_LABELS: Record<NavInput, string> = {
  auto: 'Nav: Auto',
  mouse: 'Nav: Mouse',
  trackpad: 'Nav: Trackpad',
};

const NAV_HINTS: Record<NavInput, string> = {
  auto: 'Detect mouse vs trackpad automatically — click if the wheel pans when it should zoom',
  mouse: 'Wheel always zooms',
  trackpad: 'Two-finger swipe pans, +Shift orbits, pinch zooms',
};

/**
 * Device preferences, behind a gear at the far right (WS-SPEC §2.3): things
 * that are neither the document nor the drawing, and that a user sets once.
 * Same open/close plumbing as <ExportMenu/> below.
 */
function SettingsMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, setOpen, btn, menu);

  return (
    <div className="topbar-menu-wrap">
      <button
        id="btn-settings"
        title="Settings"
        ref={btn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ⚙
      </button>
      <div id="settings-menu" className={open ? 'topbar-menu open' : 'topbar-menu'} ref={menu}>
        <NavInputRow />
        {/* WS-SPEC: units picker lands here later */}
      </div>
    </div>
  );
}

/**
 * Wheel-reading preference (KITCHENP-13). Mouse-vs-trackpad cannot be decided
 * from the DOM in every case — a high-resolution wheel is indistinguishable
 * from a two-finger swipe — so "Auto" is a good guess and this is the manual
 * override. macOS-only: elsewhere the wheel always zooms, so it would be a
 * no-op control and the row stays hidden.
 *
 * The preference is a module singleton in navPref.ts with no change event, so
 * the label re-reads it after a click, exactly as ui.ts's refresh() did. The
 * row stays a CYCLER rather than becoming three menu entries: the settings menu
 * is where it moved to, not a redesign of what it does.
 */
function NavInputRow(): ReactElement {
  const [, bump] = useState(0);
  const mac = isMac(navigator.platform, navigator.userAgent);
  const pref = navInput();

  const cycle = (): void => {
    setNavInput(NAV_INPUTS[(NAV_INPUTS.indexOf(navInput()) + 1) % NAV_INPUTS.length]);
    bump((n) => n + 1);
  };

  return (
    <div id="navinput-group" hidden={!mac}>
      <button id="btn-navinput" title={NAV_HINTS[pref]} onClick={cycle}>
        {NAV_LABELS[pref]}
      </button>
    </div>
  );
}

/* ================= file operations ================= */

function FileGroup(): ReactElement {
  const { store, plan } = useAppServices();
  const fileInput = useRef<HTMLInputElement>(null);

  const onNew = (): void => {
    if (!confirm('Start a new design? Your current design will be replaced (Undo can restore it).'))
      return;
    plan.setArmed(null);
    store.replaceDesign(emptyDesign());
    plan.zoomFit();
  };

  const onSave = (): void => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    download(URL.createObjectURL(blob), 'interior-design.json');
  };

  const onFile = async (): Promise<void> => {
    const input = fileInput.current!;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const raw: unknown = JSON.parse(await f.text());
      const d = sanitizeDesign(raw);
      if (!d) throw new Error('bad file');
      // the reference photo rides ALONGSIDE the design (it is never part of
      // it, so sanitizeDesign drops the field) — reinstall it afterwards, and
      // never let a photo-less file resurrect the previous one
      const src = (raw as { underlaySrc?: unknown }).underlaySrc;
      const hasSrc = typeof src === 'string' && !!src;
      if (!hasSrc) delete d.underlay;
      store.replaceDesign(d);
      if (hasSrc && d.underlay && !store.setUnderlay(src as string)) {
        setHint(
          'Design loaded, but the reference photo could not be stored — storage is full or blocked'
        );
      }
      plan.zoomFit();
    } catch {
      setHint('Could not read that file — is it an interior-design.json?');
    }
  };

  return (
    <div className="topbar-group">
      <button id="btn-new" title="Start a new empty design" onClick={onNew}>
        New
      </button>
      <button id="btn-save" title="Download design as JSON" onClick={onSave}>
        Save
      </button>
      <button
        id="btn-load"
        title="Load design from JSON"
        onClick={() => fileInput.current!.click()}
      >
        Load
      </button>
      <ExportMenu />
      <input
        type="file"
        id="file-input"
        accept=".json,application/json"
        hidden
        ref={fileInput}
        onChange={() => void onFile()}
      />
      <UnderlayInput />
    </div>
  );
}

/* ================= export menu ================= */

/**
 * Everything that produces a file: the two CSVs, the two printable sheets, and
 * — since WS-SPEC §2.3 took them out of the bar — the 3D snapshot and the GLB.
 *
 * The handlers themselves live in src/ui/react/exportActions.ts, because the
 * Output workspace's pane (WP 1.8) runs the same ones; this component owns only
 * what a MENU owns, which is when to close and whether the long-running entry is
 * busy. GLB is the one entry that can take seconds, so it says so in place
 * rather than leaving a dead-looking menu behind.
 */
function ExportMenu(): ReactElement {
  const { store, view3d } = useAppServices();
  const [open, setOpen] = useState(false);
  const [glbBusy, setGlbBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, setOpen, btn, menu);

  /** Every entry closes the menu; only the GLB one keeps running after it does. */
  const run = (fn: () => void) => (): void => {
    setOpen(false);
    fn();
  };

  const onGlb = async (): Promise<void> => {
    setOpen(false);
    setGlbBusy(true);
    try {
      await exportGlb(view3d);
    } finally {
      setGlbBusy(false);
    }
  };

  return (
    <div className="topbar-menu-wrap">
      <button
        id="btn-export"
        title="Cut list, shopping list, printable sheets and 3D exports"
        ref={btn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        Export ▾
      </button>
      <div id="export-menu" className={open ? 'topbar-menu open' : 'topbar-menu'} ref={menu}>
        <button data-export="cut" onClick={run(() => exportCutCsv(store))}>
          Cut list (CSV)
        </button>
        <button data-export="buy" onClick={run(() => exportBuyCsv(store))}>
          Shopping list (CSV)
        </button>
        <button data-export="sheet" onClick={run(() => exportBomSheet(store))}>
          Printable sheet…
        </button>
        <button data-export="plan" onClick={run(() => exportPlanSheet(store))}>
          Plan sheet…
        </button>
        <button
          id="btn-png"
          data-export="png"
          title="Export the 3D view as a PNG image"
          onClick={run(() => exportSnapshotPng(view3d))}
        >
          Snapshot (PNG)
        </button>
        <button
          id="btn-glb"
          data-export="glb"
          title="Export the modelled interior as .glb for Blender"
          disabled={glbBusy}
          onClick={() => void onGlb()}
        >
          {glbBusy ? 'Exporting…' : 'Blender (GLB)…'}
        </button>
      </div>
    </div>
  );
}
