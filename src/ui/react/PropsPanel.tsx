import { memo, type ReactElement } from 'react';
import { store } from '../../app/bootstrap';
import { useChannel } from './hooks/useStore';
import { PropsBody } from './props/PropsBody';

/**
 * The right-hand properties panel.
 *
 * This component only decides WHEN the body is a new panel: the key below is
 * the identity of what is selected, so a different object remounts
 * <PropsBody/> from scratch while an edit to the SAME object re-renders it in
 * place. That single line is what replaces ui.ts's `innerHTML = ''` and every
 * "don't rebuild while the caret is in there" guard that came with it.
 *
 * TWO WRITERS, ONE NODE EACH (migration scaffolding, gone in T5c): the
 * selection kinds React has not taken yet are still drawn by src/ui/ui.ts.
 * React therefore owns `#props-inner`'s CHILDREN and ui.ts owns the children of
 * `#props-legacy` — a div React renders once and never gives children of its
 * own, so the reconciler has no child fibers there and never touches what
 * ui.ts appends. Sharing `#props-inner` itself would be a crash waiting to
 * happen: `innerHTML = ''` would delete nodes React still believes it owns.
 * Every pinned selector (`#props-inner .prop-row`, `#props-inner button`,
 * `.props-title`, the `.prop-section` index) is a descendant match, so the
 * extra div is invisible to e2e/dom-contract.spec.ts and test/interact.mjs.
 */
export function PropsPanel(): ReactElement {
  useChannel('selection');
  useChannel('activeRoom');

  const sel = store.selection;
  const key = sel.kind === 'none' ? `room:${store.activeRoomId}` : `${sel.kind}:${sel.id}`;

  return (
    <aside id="props">
      <div id="props-inner">
        <PropsBody key={key} />
        <LegacyPropsHost />
      </div>
    </aside>
  );
}

/**
 * T5c EXPIRY: the container src/ui/ui.ts renders the item / wall / opening /
 * corner panels into. Empty and memoized — React never re-renders it, and it
 * declares no children, so the nodes ui.ts appends are invisible to the
 * reconciler.
 */
const LegacyPropsHost = memo(function LegacyPropsHost(): ReactElement {
  return <div id="props-legacy"></div>;
});
