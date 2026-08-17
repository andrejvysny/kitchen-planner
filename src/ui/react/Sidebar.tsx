import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { catalogOpen } from '../shellState';
import { workspace } from '../workspaceState';
import { CatalogPanel } from './CatalogPanel';
import { useChannel } from './hooks/useStore';
import { OutlinePanel } from './OutlinePanel';
import { OutputDocsPanel } from './OutputDocsPanel';
import { VariablesPanel } from './VariablesPanel';
import { WorkshopPartsPanel } from './WorkshopPartsPanel';

const TABS = ['library', 'components', 'variables'] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = {
  library: 'Library',
  components: 'Components',
  variables: 'Variables',
};

/**
 * The left sidebar: three tab buttons over three panels, ported node-for-node
 * from index.html.
 *
 * Which tab is open is component state now (ui.ts's wireTabs/selectTab are
 * gone), and the panels carry BOTH signals the old pair wrote — `.active` on
 * the open one, `hidden` on the others — because style.css hides on `[hidden]`
 * while test/interact.mjs asserts the class.
 *
 * All three panels are React's now: the Variables panel landed in T3, the
 * catalog and the components outline in T4. Nothing in the sidebar is written
 * by src/ui/ui.ts any more.
 *
 * `.open` is the off-canvas drawer state on narrow screens, driven by the
 * topbar's ☰ (src/ui/react/Topbar.tsx) through the shell singleton.
 *
 * The tab strip + three panels are plan/furnish's sidebar only (WS-SPEC
 * §4.5): workshop swaps in <WorkshopPartsPanel/> and output swaps in
 * <OutputDocsPanel/> instead, and the tab resets to 'library' on every
 * workspace change so returning to plan/furnish never leaves a stale tab
 * selected. The `<aside id="catalog">` wrapper and its drawer `.open` state
 * stay for every workspace — it is the layout column, not tab chrome.
 */
export function Sidebar(): ReactElement {
  useChannel('shell');
  const wsVersion = useChannel('workspace');
  const [tab, setTab] = useState<Tab>('library');
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => setTab('library'), [wsVersion]);

  const ws = workspace();

  /** Roving focus across the tablist: move the selection AND the caret with it. */
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next]);
    // the button nodes are keyed, so identity survives the re-render this
    // schedules — focusing the existing one right now is safe
    btns.current[next]?.focus();
  };

  const panel = (t: Tab): string => (tab === t ? 'tab-panel active' : 'tab-panel');

  if (ws === 'workshop') {
    return (
      <aside id="catalog" className={catalogOpen() ? 'open' : undefined}>
        <WorkshopPartsPanel />
      </aside>
    );
  }
  if (ws === 'output') {
    return (
      <aside id="catalog" className={catalogOpen() ? 'open' : undefined}>
        <OutputDocsPanel />
      </aside>
    );
  }

  return (
    <aside id="catalog" className={catalogOpen() ? 'open' : undefined}>
      <div id="sidebar-tabs" role="tablist" aria-label="Left sidebar">
        {TABS.map((t, i) => (
          <button
            key={t}
            id={`tab-btn-${t}`}
            role="tab"
            data-tab={t}
            className={tab === t ? 'active' : undefined}
            aria-selected={tab === t}
            aria-controls={`tab-${t}`}
            ref={(el) => {
              btns.current[i] = el;
            }}
            onClick={() => setTab(t)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {LABELS[t]}
          </button>
        ))}
      </div>
      <div
        id="tab-library"
        className={panel('library')}
        role="tabpanel"
        aria-labelledby="tab-btn-library"
        hidden={tab !== 'library'}
      >
        <div id="catalog-inner">
          <CatalogPanel />
        </div>
      </div>
      <div
        id="tab-components"
        className={panel('components')}
        role="tabpanel"
        aria-labelledby="tab-btn-components"
        hidden={tab !== 'components'}
      >
        <div id="outline">
          <OutlinePanel />
        </div>
      </div>
      <div
        id="tab-variables"
        className={panel('variables')}
        role="tabpanel"
        aria-labelledby="tab-btn-variables"
        hidden={tab !== 'variables'}
      >
        <VariablesPanel />
      </div>
    </aside>
  );
}
