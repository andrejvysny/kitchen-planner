import './style.css';
import { demoDesign, Store } from './model/store';
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

// small debug/testing handle. `exportPack`/`exportPdf` lazily pull in the pure
// manufacturing pipeline (and, transitively, jsPDF) so both stay off the main
// bundle in their own chunks; Phase 5 builds the real export dialog on top of
// this same public API (src/model/manufacture/index.ts).
(window as unknown as Record<string, unknown>).__kp = {
  store,
  plan,
  view,
  elev,
  exportPack: () => import('./model/manufacture').then((m) => m.buildPack(store.design)),
  exportPdf: () => import('./model/manufacture').then((m) => m.buildPdfBlob(m.buildPack(store.design))),
};
