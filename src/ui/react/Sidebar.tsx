import type { ReactElement } from 'react';
import { catalogOpen } from '../shellState';
import { useChannel } from './hooks/useStore';

/**
 * The left sidebar: three tab buttons over three panels, ported node-for-node
 * from index.html.
 *
 * The panels are deliberately EMPTY shells — src/ui/ui.ts renders the catalog
 * into #catalog-inner, the outline into #outline and the variables editor into
 * #variables-panel, and flips the `hidden` attribute as tabs change. Those
 * runtime children survive the drawer re-render below because React only writes
 * props that CHANGED between renders, and it manages no children here at all.
 *
 * `.open` is the off-canvas drawer state on narrow screens, driven by the
 * topbar's ☰ (src/ui/react/Topbar.tsx) through the shell singleton.
 */
export function Sidebar(): ReactElement {
  useChannel('shell');
  return (
    <aside id="catalog" className={catalogOpen() ? 'open' : undefined}>
      <div id="sidebar-tabs" role="tablist" aria-label="Left sidebar">
        <button
          id="tab-btn-library"
          role="tab"
          data-tab="library"
          className="active"
          aria-selected="true"
          aria-controls="tab-library"
        >
          Library
        </button>
        <button
          id="tab-btn-components"
          role="tab"
          data-tab="components"
          aria-selected="false"
          aria-controls="tab-components"
        >
          Components
        </button>
        <button
          id="tab-btn-variables"
          role="tab"
          data-tab="variables"
          aria-selected="false"
          aria-controls="tab-variables"
        >
          Variables
        </button>
      </div>
      <div
        id="tab-library"
        className="tab-panel active"
        role="tabpanel"
        aria-labelledby="tab-btn-library"
      >
        <div id="catalog-inner"></div>
      </div>
      <div
        id="tab-components"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-btn-components"
        hidden
      >
        <div id="outline"></div>
      </div>
      <div
        id="tab-variables"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="tab-btn-variables"
        hidden
      >
        <div id="variables-panel"></div>
      </div>
    </aside>
  );
}
