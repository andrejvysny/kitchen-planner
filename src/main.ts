import './style.css';
import { demoDesign, Store } from './model/store';
import { Plan2D } from './plan2d/plan2d';
import { UI } from './ui/ui';
import { View3D } from './view3d/view3d';

const store = new Store(Store.loadAutosaved() ?? demoDesign());

const hintEl = document.getElementById('status-hint')!;
const plan = new Plan2D(
  document.getElementById('canvas2d') as HTMLCanvasElement,
  store,
  (hint) => (hintEl.textContent = hint)
);

const view = new View3D(document.getElementById('canvas3d') as HTMLCanvasElement, store, {
  getArmed: () => plan.armedDef,
  clearArmed: () => plan.setArmed(null),
});

new UI(store, plan, view);

// small debug/testing handle
(window as unknown as Record<string, unknown>).__kp = { store, plan, view };
