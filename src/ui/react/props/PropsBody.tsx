import { useEffect, type ReactElement } from 'react';
import { useEditor, useStore } from '../services';
import { countRender } from '../debugCounters';
import { useChannel } from '../hooks/useStore';
import { CornerProps } from './CornerProps';
import { ItemProps } from './ItemProps';
import { OpeningProps } from './OpeningProps';
import { NoRoomProps, RoomProps } from './RoomProps';
import { WallProps } from './WallProps';

/**
 * The properties panel's body: one panel per selection kind.
 *
 * <PropsPanel/> mounts this under a KEY derived from the selection, so picking
 * a different object REMOUNTS the whole body — the React equivalent of ui.ts's
 * `root.innerHTML = ''`, and the reason every field below can stay
 * uncontrolled. A change WITHIN one selection (an undo, a slider, a rename) is
 * an ordinary re-render instead, so nodes, focus and caret survive it.
 *
 * The channels are the three ui.ts's renderProps was subscribed to plus
 * 'workspace' (the room panel's section list is workspace-scoped —
 * roomSections.ts — so a tab switch must re-render it; it used to render the
 * PREVIOUS workspace's sections until an unrelated event arrived). NOTHING
 * gesture-rate: a mid-drag 'change' is transient-only and must never reach
 * this component (see useLiveValue.ts — the fields that show a dragged value
 * subscribe to 'transient' themselves and write into their own node).
 *
 * Every committed render is counted (src/ui/react/debugCounters.ts), so
 * e2e/transient-perf.spec.ts can assert "not once during a drag" outright
 * instead of inferring it from what the boxes happen to show.
 */
export function PropsBody(): ReactElement {
  const store = useStore();
  const editor = useEditor();
  useChannel('selection');
  useChannel('history');
  useChannel('activeRoom');
  useChannel('workspace');

  // no dependency array: one tick per COMMITTED render, which is what the
  // transient rule is stated in
  useEffect(() => countRender('propsBody'));

  const sel = editor.selection;
  // An id that resolves nowhere falls through to the room panel, exactly as
  // ui.ts's renderProps did — a stale selection shows the room, not an error.
  if (sel.kind === 'item') {
    const item = store.itemById(sel.id);
    if (item) return <ItemProps item={item} />;
  } else if (sel.kind === 'wall') {
    if (store.wallById(sel.id)) return <WallProps wallId={sel.id} />;
  } else if (sel.kind === 'opening') {
    if (store.openingById(sel.id)) return <OpeningProps id={sel.id} />;
  } else if (sel.kind === 'corner') {
    if (store.cornerById(sel.id)) return <CornerProps id={sel.id} />;
  }

  if (store.design.rooms.length === 0) return <NoRoomProps />;
  return <RoomProps />;
}
