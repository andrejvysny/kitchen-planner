import type { ReactElement } from 'react';
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
 * `#props-inner` is React's alone now: the `#props-legacy` handover div T5a
 * introduced — the one src/ui/ui.ts drew the remaining selection panels into —
 * is gone with the last of them.
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
      </div>
    </aside>
  );
}
