import type { Store } from '../src/model/store';
import type { Plan2D } from '../src/plan2d/plan2d';
import type { ElevationView } from '../src/plan2d/elevation';
import type { View3D } from '../src/view3d/view3d';

/**
 * The debug/testing handle installed by src/main.ts. Specs drive the app
 * through it rather than through the DOM wherever the DOM would only be an
 * indirection — asserting store state is what makes these checks meaningful.
 *
 * Typed against the real classes, so a rename in src/ breaks the specs at
 * TYPECHECK time instead of at 2 a.m. in CI.
 */
declare global {
  interface Window {
    __kp: {
      store: Store;
      plan: Plan2D;
      view: View3D;
      elev: ElevationView;
      navInput: unknown;
      setNavInput: (v: unknown) => void;
    };
    /** page-init flag forcing the mac-gated wheel handling on every platform */
    __kpForceMac?: boolean;
  }
}

export {};
