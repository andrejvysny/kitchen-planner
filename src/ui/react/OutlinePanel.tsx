import { type KeyboardEvent, type ReactElement, type MouseEvent as ReactMouseEvent } from 'react';
import { useEditor, useStore } from './services';
import { outlineGroups, type OutlineRoomRow, type OutlineRow } from '../outlineModel';
import { useChannel } from './hooks/useStore';

/**
 * The Components tab: every room, then every placed object and opening,
 * grouped by type. Ported from src/ui/ui.ts renderOutline node for node.
 *
 * All the grouping and ordering lives in src/ui/outlineModel.ts — this
 * component only formats and wires clicks. It rebuilds on the same three
 * signals the old renderOutline was subscribed to and no others: a mid-drag
 * 'change' never reaches it, so a room area still only moves on commit.
 */
export function OutlinePanel(): ReactElement {
  const store = useStore();
  const editor = useEditor();
  useChannel('selection');
  useChannel('history');
  useChannel('activeRoom');

  const { roomRows, groups, total } = outlineGroups(store, editor.selectionState());

  return (
    <>
      <div className="ol-head">
        Components<span className="ol-total">{total}</span>
      </div>
      {/* Rooms lead the outline: it is the primary room switcher, and it is
          there even in an empty design — before the "nothing placed" note. */}
      <div className="ol-group">
        <div className="ol-group-title">
          <span className="ol-label">Rooms</span>
          <span className="ol-count">{roomRows.length}</span>
        </div>
        {roomRows.map((r) => (
          <RoomRow key={r.id} row={r} />
        ))}
      </div>
      {total === 0 ? (
        <div className="ol-empty">Nothing placed yet</div>
      ) : (
        groups.map((g) => (
          <div className="ol-group" key={g.title}>
            <div className="ol-group-title">
              <span className="ol-label">{g.title}</span>
              <span className="ol-count">{g.rows.length}</span>
            </div>
            {g.rows.map((r) => (
              <ObjectRow key={r.id} row={r} />
            ))}
          </div>
        ))
      )}
    </>
  );
}

/** Enter and Space activate a row, the same as a click — they are `role="button"`. */
function activateOnKey(e: KeyboardEvent, fn: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
}

function RoomRow({ row }: { row: OutlineRoomRow }): ReactElement {
  const store = useStore();
  const editor = useEditor();
  // ui.ts activateRoom, inlined: switching rooms drops back to the room panel.
  // The props panel still owns its own copy until it becomes a component too.
  const pick = (): void => {
    store.setActiveRoom(row.id);
    editor.select({ kind: 'none' });
  };

  return (
    <div
      className={row.active ? 'ol-row room-row active' : 'ol-row room-row'}
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(e) => activateOnKey(e, pick)}
    >
      <span className="room-row-name">{row.name}</span>
      <span className="room-row-area">{`${row.area.toFixed(1)} m²`}</span>
    </div>
  );
}

function ObjectRow({ row }: { row: OutlineRow }): ReactElement {
  const editor = useEditor();
  const pick = (): void => editor.select(row.sel);
  // Shift adds or drops one, exactly as it does in the plan — the two lists
  // are the same selection, so they must grow it the same way
  const click = (e: ReactMouseEvent): void => {
    if (e.shiftKey && row.sel.kind !== 'none') editor.toggleRef(row.sel);
    else pick();
  };

  return (
    <div
      className={row.active ? 'ol-row active' : 'ol-row'}
      role="button"
      tabIndex={0}
      onClick={click}
      onKeyDown={(e) => activateOnKey(e, pick)}
    >
      {row.label}
    </div>
  );
}
