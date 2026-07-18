import './style.css';
import { demoDesign, Store } from './model/store';
import { buildPack, validateDesignFit } from './model/manufacture';
import { Plan2D } from './plan2d/plan2d';
import { ElevationView } from './plan2d/elevation';
import { UI } from './ui/ui';
import { View3D } from './view3d/view3d';

const store = new Store(Store.loadAutosaved() ?? demoDesign());

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

// small debug/testing handle. The Manufacturing export dialog (topbar →
// Manufacture) is the user-facing surface for the pure pipeline in
// src/model/manufacture; `mfg` exposes its two pure entry points for E2E, and
// `demoDesign` lets tests reset to a known-good, fitting kitchen. jsPDF stays a
// lazy chunk — only the dialog's PDF button pulls it in (buildPdfBlob).
(window as unknown as Record<string, unknown>).__kp = {
  store,
  plan,
  view,
  elev,
  demoDesign,
  mfg: {
    buildPack: () => buildPack(store.design),
    validate: () => validateDesignFit(store.design),
  },
};
