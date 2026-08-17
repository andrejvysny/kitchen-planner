import { useEffect, type ReactElement } from 'react';
import { services } from '../../app/bootstrap';
import { RecoveryBanner } from './RecoveryBanner';
import { AppServicesProvider } from './services';
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
 * With src/ui/ui.ts gone, React owns every element in the application shell.
 * What is left of the old controller is the global key map, which is now a
 * binding table plus a command registry under src/editor — genuinely global,
 * belonging to no component, so <App/> only owns its LIFECYCLE. The effect runs
 * after the Workspace's canvas effects (children first), so every view is
 * attached before a key can reach a command; `attach`/`dispose` are both
 * idempotent, so StrictMode's double mount changes nothing.
 *
 * This is also the ONE component that imports the bootstrap: everything below
 * takes the app's services off the context instead. It holds no state and never
 * re-renders.
 */
export function App(): ReactElement {
  useEffect(() => {
    services.keyboard.attach(window);
    return () => services.keyboard.dispose();
  }, []);

  return (
    <AppServicesProvider services={services}>
      <div id="app">
        {services.needsRecoveryBanner && <RecoveryBanner />}
        <Topbar />
        <Workspace />
        <StatusBar />
      </div>
    </AppServicesProvider>
  );
}
