// Import order is the contract: bootstrap constructs Store/Plan2D/View3D/UI as
// a side effect of being imported, so the legacy app is fully booted before the
// React root below mounts. Keep this import first.
import './bootstrap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/react/App';

/**
 * React entry point. The root is mounted but inert: <App/> renders null, so the
 * DOM stays exactly what index.html + src/ui/ui.ts produce. StrictMode is on
 * from day one — every view already honours the attach/detach/attach double
 * mount it forces (see e2e/lifecycle.spec.ts).
 */
const reactRoot = document.createElement('div');
reactRoot.id = 'react-root';
document.body.appendChild(reactRoot);

createRoot(reactRoot).render(
  <StrictMode>
    <App />
  </StrictMode>
);
