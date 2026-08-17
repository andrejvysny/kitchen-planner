// Import order is the contract: bootstrap constructs Store/Plan2D/ElevationView/
// View3D as a side effect of being imported, so every singleton <App/> reaches
// for exists before the first render. Keep this import first.
import './bootstrap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/react/App';

/**
 * React entry point. <App/> renders the whole application shell — index.html is
 * down to the root div below — and src/ui/ui.ts keeps filling the containers it
 * always did. StrictMode is on from day one: every view honours the
 * attach/detach/attach double mount it forces (see e2e/lifecycle.spec.ts).
 */
createRoot(document.getElementById('react-root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
