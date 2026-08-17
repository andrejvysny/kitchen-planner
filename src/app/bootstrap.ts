import '../style.css';
import { navInput, setNavInput } from '../model/navPref';
import { setMacOverride } from '../view3d/wheelInput';
import { renderCounts } from '../ui/react/debugCounters';
import { createServices, type AppServices } from './services';

/**
 * App bootstrap: builds the one AppServices graph and installs the debug
 * handle. Importing this module IS the construction — src/app/main.tsx imports
 * it before it mounts React, and <App/> puts `services` on a context so no
 * component has to know this module exists.
 *
 * Nothing here touches the DOM: React owns every element, the three views are
 * built DETACHED and get their canvases from ref effects in
 * src/ui/react/Workspace.tsx, and the two things this module used to write by
 * hand — the recovery banner and the elevation wall label — are a component and
 * a shellState field now.
 */

// Test-only hook (KITCHENP-13 E2E coverage on any platform): a page-init
// script sets window.__kpForceMac before this module runs, so Plan2D/View3D
// read the forced value when they cache isMac at construction below. Must run
// BEFORE createServices(). Production never sets the flag.
const forceMac = (window as unknown as { __kpForceMac?: boolean }).__kpForceMac;
if (forceMac !== undefined) setMacOverride(forceMac);

export const services: AppServices = createServices();

// small debug/testing handle — the E2E suites drive the app through it
// (e2e/kp.d.ts), so its SHAPE is a contract: keep the flat aliases.
(window as unknown as Record<string, unknown>).__kp = {
  store: services.store,
  plan: services.plan,
  view: services.view3d,
  elev: services.elevation,
  navInput,
  setNavInput,
  editor: services.editor,
  bridge: services.bridge,
  // React commit counters — a test seam, like Plan2D's debug().drawCount
  debug: { renderCounts },
};
