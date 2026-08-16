import './style.css';
import { navInput, setNavInput } from './model/navPref';
import { demoDesign, Store } from './model/store';
import { Plan2D } from './plan2d/plan2d';
import { ElevationView } from './plan2d/elevation';
import { UI } from './ui/ui';
import { View3D } from './view3d/view3d';
import { setMacOverride } from './view3d/wheelInput';

// Test-only hook (KITCHENP-13 E2E coverage on any platform): a page-init
// script sets window.__kpForceMac before this module runs, so Plan2D/View3D
// read the forced value when they cache isMac at construction below.
// Production never sets the flag, so setMacOverride is never called then.
const forceMac = (window as unknown as { __kpForceMac?: boolean }).__kpForceMac;
if (forceMac !== undefined) setMacOverride(forceMac);

const loadedDesign = Store.loadAutosaved();
const store = new Store(loadedDesign ?? demoDesign());

// loadAutosaved only stashes a recovery backup when the saved text existed
// but failed to parse/sanitize — a brand-new install has neither, so no banner
if (!loadedDesign && Store.recoveryPayload()) showRecoveryBanner();

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

const hintEl = document.getElementById('status-hint')!;
const plan = new Plan2D(
  document.getElementById('canvas2d') as HTMLCanvasElement,
  store,
  (hint) => (hintEl.textContent = hint)
);

const elev = new ElevationView(
  document.getElementById('canvas-elev') as HTMLCanvasElement,
  store,
  () => (document.getElementById('wall-label')!.textContent = elev.wallLabel())
);

const view = new View3D(document.getElementById('canvas3d') as HTMLCanvasElement, store, {
  getArmed: () => plan.armedDef,
  clearArmed: () => plan.setArmed(null),
});

new UI(store, plan, view, elev);

// small debug/testing handle
(window as unknown as Record<string, unknown>).__kp = {
  store,
  plan,
  view,
  elev,
  navInput,
  setNavInput,
};
