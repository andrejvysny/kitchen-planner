import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { catalogOpen } from '../shellState';
import { useChannel } from './hooks/useStore';
import { VariablesPanel } from './VariablesPanel';

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
 * The Library and Components panels are still EMPTY shells: src/ui/ui.ts
 * renders the catalog into #catalog-inner and the outline into #outline. Those
 * runtime children survive a re-render here because React only writes props
 * that CHANGED and manages no children of its own inside them. The Variables
 * panel is React's as of T3.
 *
 * `.open` is the off-canvas drawer state on narrow screens, driven by the
 * topbar's ☰ (src/ui/react/Topbar.tsx) through the shell singleton.
 */
export function Sidebar(): ReactElement {
  useChannel('shell');
  const [tab, setTab] = useState<Tab>('library');
  const btns = useRef<(HTMLButtonElement | null)[]>([]);

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
        <div id="catalog-inner"></div>
      </div>
      <div
        id="tab-components"
        className={panel('components')}
        role="tabpanel"
        aria-labelledby="tab-btn-components"
        hidden={tab !== 'components'}
      >
        <div id="outline"></div>
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
