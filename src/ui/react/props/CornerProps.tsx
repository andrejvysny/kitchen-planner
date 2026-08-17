import type { ReactElement } from 'react';
import { useStore } from '../services';
import { LengthField } from '../fields/LengthField';

/**
 * A selected corner — src/ui/ui.ts's renderCornerProps.
 *
 * Both fields are `live`: dragging the corner in the plan fires transient
 * changes at pointer rate, and the boxes follow without this panel
 * re-rendering. Each edit re-reads the OTHER axis off the model rather than
 * trusting a value captured at render time, because a drag may have moved it
 * since.
 */
export function CornerProps({ id }: { id: string }): ReactElement | null {
  const store = useStore();
  const corner = store.cornerById(id);
  if (!corner) return null;

  const one = [corner];
  const move = (x: number, y: number): void => store.moveCorner(id, x, y, false);

  return (
    <>
      <h2 className="props-title">Corner</h2>
      <p className="props-sub">Drag it in the plan, or set exact coordinates</p>

      <div className="prop-section">
        <div className="prop-section-title">Position</div>
        <LengthField
          label="X"
          items={one}
          read={(c) => c.x}
          onCommit={(m) => {
            const now = store.cornerById(id);
            if (now) move(m, now.y);
          }}
          cls="corner-x"
          live
        />
        <LengthField
          label="Y"
          items={one}
          read={(c) => c.y}
          onCommit={(m) => {
            const now = store.cornerById(id);
            if (now) move(now.x, m);
          }}
          cls="corner-y"
          live
        />
      </div>

      <div className="prop-section">
        <div className="prop-section-title">Actions</div>
        <div className="btn-row">
          <button
            className="btn danger"
            disabled={(store.roomOfCorner(id)?.corners.length ?? 0) <= 3}
            title={
              (store.roomOfCorner(id)?.corners.length ?? 0) <= 3
                ? 'A room needs at least 3 corners'
                : undefined
            }
            onClick={() => {
              store.deleteCorner(id);
              store.commit();
            }}
          >
            Remove corner
          </button>
        </div>
      </div>
    </>
  );
}
