import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useAppServices, useEditor, useStore } from './services';
import { buildBom } from '../../model/export';
import { bomHtml, cutListCsv, shoppingListCsv } from '../../model/exportFormats';
import { navInput, setNavInput } from '../../model/navPref';
import { emptyDesign, sanitizeDesign } from '../../model/store';
import { openPrintSheet } from '../../print/sheet';
import { isMac, NAV_INPUTS, type NavInput } from '../../view3d/wheelInput';
import { catalogOpen, setCatalogOpen, setHint } from '../shellState';
import { applyCalibration, importUnderlay } from '../underlayImport';
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
 * Nothing in the top bar is legacy-wired any more: T5 took the last of it, the
 * reference-photo input, off ui.ts's wireUnderlay.
 */
export function Topbar(): ReactElement {
  return (
    <header id="topbar">
      <div className="brand">
        <span className="brand-mark">▦</span>
        <span className="brand-name">Interior Planner</span>
      </div>
      <CatalogButton />
      <ViewToggle />
      <HistoryButtons />
      <SceneToggles />
      <NavInputControl />
      <div className="topbar-spacer"></div>
      <FileGroup />
    </header>
  );
}

/* ================= helpers shared by the ported handlers ================= */

/** Moved verbatim from ui.ts: click a synthetic <a download>, then free the blob. */
function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // the click consumed the URL synchronously; hand the blob's memory back
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadText(text: string, name: string, type: string): void {
  const blob = new Blob([text], { type });
  download(URL.createObjectURL(blob), name);
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

/* ================= view toggle ================= */

type ViewMode = '2d' | 'split' | '3d';

/**
 * 2D / Split / 3D. React owns the buttons' own `.active` class; the panes stay
 * imperative because the 2D/elev sub-toggle (Workspace.tsx) writes
 * `.elev-mode` on the same class list — so this is the old setView, unchanged,
 * minus the part React now renders.
 */
function ViewToggle(): ReactElement {
  const { view3d } = useAppServices();
  const [mode, setMode] = useState<ViewMode>('split');

  const pick = (next: ViewMode): void => {
    document.getElementById('pane2d')!.classList.toggle('hidden', next === '3d');
    document.getElementById('pane3d')!.classList.toggle('hidden', next === '2d');
    view3d.setActive(next !== '2d'); // a hidden 3D pane renders nothing
    setMode(next);
  };

  const cls = (m: ViewMode): string | undefined => (mode === m ? 'active' : undefined);

  return (
    <div className="topbar-group" id="view-toggle">
      <button
        data-view="2d"
        className={cls('2d')}
        title="2D floor plan only"
        onClick={() => pick('2d')}
      >
        2D
      </button>
      <button
        data-view="split"
        className={cls('split')}
        title="2D + 3D side by side"
        onClick={() => pick('split')}
      >
        Split
      </button>
      <button data-view="3d" className={cls('3d')} title="3D view only" onClick={() => pick('3d')}>
        3D
      </button>
    </div>
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

/* ================= day/night + open fronts ================= */

/**
 * Two toggles, two sources: night is design data (committed, so it lands on
 * 'history'), the open-front pose is ephemeral view state on the 'pose'
 * channel — never in the Design, never in an undo step.
 */
function SceneToggles(): ReactElement {
  const store = useStore();
  useChannel('history');
  useChannel('pose');

  const night = store.design.scene.night;

  const toggleNight = (): void => {
    store.setNight(!store.design.scene.night);
    store.commit();
  };

  return (
    <div className="topbar-group">
      <button id="btn-daynight" title="Toggle day / night" onClick={toggleNight}>
        {night ? '☾ Night' : '☀ Day'}
      </button>
      <button
        id="btn-openfronts"
        className={store.openFronts.allOpen ? 'active' : undefined}
        title="Preview all doors and drawers open (3D only, never saved)"
        onClick={() => store.openFronts.setAll(!store.openFronts.allOpen)}
      >
        Open fronts
      </button>
    </div>
  );
}

/* ================= nav input ================= */

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
 * Wheel-reading preference (KITCHENP-13). Mouse-vs-trackpad cannot be decided
 * from the DOM in every case — a high-resolution wheel is indistinguishable
 * from a two-finger swipe — so "Auto" is a good guess and this is the manual
 * override. macOS-only: elsewhere the wheel always zooms, so it would be a
 * no-op control and the group stays hidden.
 *
 * The preference is a module singleton in navPref.ts with no change event, so
 * the label re-reads it after a click, exactly as ui.ts's refresh() did.
 */
function NavInputControl(): ReactElement {
  const [, bump] = useState(0);
  const mac = isMac(navigator.platform, navigator.userAgent);
  const pref = navInput();

  const cycle = (): void => {
    setNavInput(NAV_INPUTS[(NAV_INPUTS.indexOf(navInput()) + 1) % NAV_INPUTS.length]);
    bump((n) => n + 1);
  };

  return (
    <div className="topbar-group" id="navinput-group" hidden={!mac}>
      <button id="btn-navinput" title={NAV_HINTS[pref]} onClick={cycle}>
        {NAV_LABELS[pref]}
      </button>
    </div>
  );
}

/* ================= file operations ================= */

function FileGroup(): ReactElement {
  const { store, plan, view3d } = useAppServices();
  const fileInput = useRef<HTMLInputElement>(null);
  const [glbBusy, setGlbBusy] = useState(false);

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

  const onGlb = async (): Promise<void> => {
    setGlbBusy(true);
    try {
      const blob = await view3d.exportGLB();
      download(URL.createObjectURL(blob), 'interior.glb');
      setHint('interior.glb exported — in Blender: File → Import → glTF 2.0');
    } catch {
      setHint('GLB export failed — try again after a reload.');
    } finally {
      setGlbBusy(false);
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
      <button
        id="btn-png"
        title="Export 3D snapshot as PNG"
        onClick={() => download(view3d.snapshotPNG(), 'interior-3d.png')}
      >
        Snapshot
      </button>
      <button
        id="btn-glb"
        title="Export the modelled interior as .glb for Blender"
        disabled={glbBusy}
        onClick={() => void onGlb()}
      >
        Blender
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

/** Cut list / shopping list CSVs, the BOM sheet, the plan sheet. */
function ExportMenu(): ReactElement {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // click-away close. Pointerdown, not click: it must fire before a menu
  // item's own click — and must NOT close when the press lands on the button
  // (that would fight its toggle) or inside the menu (the item still needs its
  // click). Cleanup keeps a StrictMode double mount from stacking listeners.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!menu.current!.contains(t) && !btn.current!.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onCut = (): void => {
    const bom = buildBom(store.design);
    downloadText(cutListCsv(bom), 'interior-cutlist.csv', 'text/csv;charset=utf-8');
    setHint('interior-cutlist.csv exported');
    setOpen(false);
  };

  const onBuy = (): void => {
    const bom = buildBom(store.design);
    downloadText(shoppingListCsv(bom), 'interior-shopping-list.csv', 'text/csv;charset=utf-8');
    setHint('interior-shopping-list.csv exported');
    setOpen(false);
  };

  const onSheet = (): void => {
    const bom = buildBom(store.design);
    const url = URL.createObjectURL(new Blob([bomHtml(bom)], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) download(url, 'interior-bom.html');
    // the opened tab keeps reading the URL while it loads — outlive that, then free it
    else setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setHint(
      w
        ? 'Printable sheet opened in a new tab'
        : 'Pop-ups are blocked — interior-bom.html downloaded instead'
    );
    setOpen(false);
  };

  const onPlan = (): void => {
    const opened = openPrintSheet(store);
    setHint(
      opened
        ? 'Plan sheet opened in a new tab — print it at 100% on A4 landscape'
        : 'Pop-ups are blocked — interior-plan-sheet.html downloaded instead'
    );
    setOpen(false);
  };

  return (
    <div className="topbar-menu-wrap">
      <button
        id="btn-export"
        title="Cut list, shopping list and printable sheets"
        ref={btn}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        Export ▾
      </button>
      <div id="export-menu" className={open ? 'topbar-menu open' : 'topbar-menu'} ref={menu}>
        <button data-export="cut" onClick={onCut}>
          Cut list (CSV)
        </button>
        <button data-export="buy" onClick={onBuy}>
          Shopping list (CSV)
        </button>
        <button data-export="sheet" onClick={onSheet}>
          Printable sheet…
        </button>
        <button data-export="plan" onClick={onPlan}>
          Plan sheet…
        </button>
      </div>
    </div>
  );
}
