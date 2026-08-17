import '../style.css';
import { navInput, setNavInput } from '../model/navPref';
import { demoDesign, Store } from '../model/store';
import { Plan2D } from '../plan2d/plan2d';
import { ElevationView } from '../plan2d/elevation';
import { UI } from '../ui/ui';
import { PartStudio } from '../ui/partstudio';
import { View3D } from '../view3d/view3d';
import { setMacOverride } from '../view3d/wheelInput';
import { EditorState } from '../editor/editorState';
import { StoreBridge } from '../ui/react/storeBridge';
import { setHint } from '../ui/shellState';

/**
 * App bootstrap: constructs the singletons, in the order the pre-React
 * src/main.ts did. Importing this module IS the construction — src/app/main.tsx
 * imports it before it mounts React.
 *
 * Nothing here touches the DOM any more: React owns the markup now, so the
 * store and the three views are built DETACHED and the shell hands each view
 * its canvas through `attach()` (a ref effect per canvas in
 * src/ui/react/Workspace.tsx). The legacy `UI` controller, which document-
 * queries its whole world in its constructor, waits for `mountLegacyUI()`.
 */

// Test-only hook (KITCHENP-13 E2E coverage on any platform): a page-init
// script sets window.__kpForceMac before this module runs, so Plan2D/View3D
// read the forced value when they cache isMac at construction below.
// Production never sets the flag, so setMacOverride is never called then.
const forceMac = (window as unknown as { __kpForceMac?: boolean }).__kpForceMac;
if (forceMac !== undefined) setMacOverride(forceMac);

const loadedDesign = Store.loadAutosaved();
export const store = new Store(loadedDesign ?? demoDesign());

// loadAutosaved only stashes a recovery backup when the saved text existed
// but failed to parse/sanitize — a brand-new install has neither, so no banner.
// The DECISION is taken here, before anything else can touch storage; the
// banner itself lives inside #app, which React renders, so showing it waits
// for mountLegacyUI().
const needsRecoveryBanner = !loadedDesign && Store.recoveryPayload() !== null;

/** One-shot banner offering the raw (unparseable) autosave text as a download. */
function showRecoveryBanner(): void {
  const bar = document.createElement('div');
  bar.className = 'recovery-banner';

  const msg = document.createElement('span');
  msg.textContent = "Couldn't load your saved design — a backup was kept.";
  bar.appendChild(msg);

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.textContent = 'Download backup';
  downloadBtn.addEventListener('click', () => {
    const payload = Store.recoveryPayload();
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interior-design-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    // download does NOT clear the backup — only Dismiss does
  });
  bar.appendChild(downloadBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    Store.clearRecovery();
    bar.remove();
  });
  bar.appendChild(dismissBtn);

  document.getElementById('app')!.prepend(bar);
}

/** Ephemeral tool state — the single source of truth; see src/editor/editorState.ts. */
export const editor = new EditorState();

// the hint goes to the shell singleton, which <StatusHint/> renders — no DOM
// lookup, so a hint raised by a DETACHED view (or before the first render)
// still lands. #wall-label is still legacy DOM, resolved on each call.
export const plan = new Plan2D(store, editor, (hint) => setHint(hint));

export const elev = new ElevationView(
  store,
  () => (document.getElementById('wall-label')!.textContent = elev.wallLabel())
);

export const view = new View3D(store, {
  getArmed: () => plan.armedDef,
  clearArmed: () => plan.setArmed(null),
});

/**
 * The Part Studio modal — one instance for the whole app, reached by the
 * catalog's ＋/✎ tiles, the props panel's "Edit part template…" and Escape.
 * Its constructor is DOM-free (only `open()` touches the document), so it
 * belongs here with the other singletons.
 *
 * Its close callback is a no-op: the only paths that change the parts library
 * (save / delete part) both `store.commit()`, so the 'history' channel already
 * wakes <CatalogPanel/>. Cancelling changes nothing, so there is nothing to
 * refresh — which is exactly what the old renderCatalogIfPartsChanged
 * signature check worked out for itself.
 */
export const studio = new PartStudio(store, () => {});

/** UI has no dispose() yet, so it may only ever be constructed once. */
let uiMounted = false;

/**
 * Wire the legacy UI controller over the DOM React has just rendered.
 *
 * `UI` document-queries every element it owns in its constructor and registers
 * listeners that it has no way to release, so this runs from an App-level
 * effect — after the canvas effects, hence after every view is attached — and
 * exactly once: React StrictMode calls that effect twice, and the guard makes
 * the second call a no-op. When UI is dissolved into components in a later B
 * step it gains a dispose() and the guard goes with it.
 */
export function mountLegacyUI(): void {
  if (uiMounted) return;
  uiMounted = true;
  if (needsRecoveryBanner) showRecoveryBanner();
  new UI(store, plan, editor);
}

/** Store/EditorState/shell → React adapter; inert until a component subscribes. */
export const bridge = new StoreBridge(store, editor);

// small debug/testing handle
(window as unknown as Record<string, unknown>).__kp = {
  store,
  plan,
  view,
  elev,
  navInput,
  setNavInput,
  editor,
  bridge,
};
