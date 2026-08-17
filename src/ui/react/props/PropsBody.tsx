import type { ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { useChannel } from '../hooks/useStore';
import { RoomProps } from './RoomProps';

/**
 * The properties panel's body: one panel per selection kind.
 *
 * <PropsPanel/> mounts this under a KEY derived from the selection, so picking
 * a different object REMOUNTS the whole body — the React equivalent of ui.ts's
 * `root.innerHTML = ''`, and the reason every field below can stay
 * uncontrolled. A change WITHIN one selection (an undo, a slider, a rename) is
 * an ordinary re-render instead, so nodes, focus and caret survive it.
 *
 * The three channels are exactly the ones ui.ts's renderProps was subscribed
 * to, and no others: a mid-drag 'change' is transient-only and must never reach
 * this component (see useLiveValue.ts — the fields that show a dragged value
 * subscribe to 'transient' themselves and write into their own node).
 *
 * MIGRATION: kinds React does not own yet render null here and are drawn into
 * `#props-legacy` by src/ui/ui.ts instead — see <LegacyPropsHost/> in
 * src/ui/react/PropsPanel.tsx for why the two writers never share a node.
 */
export function PropsBody(): ReactElement | null {
  useChannel('selection');
  useChannel('history');
  useChannel('activeRoom');

  const sel = store.selection;
  // An id that resolves nowhere falls through to the room panel, exactly as
  // ui.ts's renderProps did — a stale selection shows the room, not an error.
  if (sel.kind === 'item' && store.itemById(sel.id)) return null;
  if (sel.kind === 'wall' && store.wallById(sel.id)) return null;
  if (sel.kind === 'opening' && store.openingById(sel.id)) return null;
  if (sel.kind === 'corner' && store.cornerById(sel.id)) return null;

  return <RoomProps />;
}
