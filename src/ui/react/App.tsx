import { useEffect, type ReactElement } from 'react';
import { mountLegacyUI } from '../../app/bootstrap';
import { StatusBar } from './StatusBar';
import { Topbar } from './Topbar';
import { Workspace } from './Workspace';

/**
 * App — the application shell. Step B1 of the strangler migration moved every
 * line of index.html's body in here VERBATIM: same ids, classes, attribute
 * values, nesting and order, split into components purely for readability. The
 * rendered DOM is node-for-node what the static markup produced, which is what
 * keeps e2e/dom-contract.spec.ts, e2e/layout.spec.ts and test/interact.mjs
 * honest regression gates for the move itself.
 *
 * src/ui/ui.ts still owns everything INSIDE those containers (catalog, outline,
 * variables, props panel) — B2 took the topbar and status bar into the
 * components, B3 the tool buttons, the 2D/elev toggle, the wall nav and the
 * catalog drawer. This component holds no state and never re-renders, so React
 * never reconciles over the DOM ui.ts writes.
 *
 * The effect below is the handover: it runs after the Workspace's canvas
 * effects (children first), so every view is attached before ui.ts queries the
 * document. Later B steps dissolve ui.ts into components and this goes away.
 */
export function App(): ReactElement {
  useEffect(() => {
    mountLegacyUI();
  }, []);

  return (
    <div id="app">
      <Topbar />
      <Workspace />
      <StatusBar />
    </div>
  );
}
