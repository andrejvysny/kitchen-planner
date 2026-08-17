import type { ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import type { WallVisMode } from '../../../model/types';
import { ChoiceRow } from '../fields/ChoiceRow';
import { LengthField } from '../fields/LengthField';

const VIS_CHOICES: readonly (readonly [string, string])[] = [
  ['auto', 'Auto'],
  ['show', 'Show'],
  ['hide', 'Hide'],
];

/**
 * A selected wall — src/ui/ui.ts's renderWallProps.
 *
 * Walls are DERIVED (src/model/rooms.ts `allWalls` recomputes them from the
 * corner rings), so nothing here holds one across a render: every read goes
 * back through `wallById`, and the length edit propagates through the
 * perpendicular neighbours inside `setWallLength` — see the CLAUDE.md gotcha,
 * this panel must not try to "help".
 *
 * Thickness is a property of the wall's OWN room, not the active one: a
 * partition selected from the other side still edits the room that owns it.
 */
export function WallProps({ wallId }: { wallId: string }): ReactElement | null {
  const wall = store.wallById(wallId);
  if (!wall) return null;

  const wallRoom = store.roomOfWall(wallId) ?? store.activeRoom();
  // a partition belongs to two rooms — say which, so its edits are no surprise
  const twin = wall.shared ? store.roomById(wall.shared.roomId) : undefined;

  return (
    <>
      <h2 className="props-title">Wall</h2>
      <p className="props-sub">Interior length along this wall</p>
      {twin ? (
        <p className="props-sub room-shared">
          Shared with <b>{twin.name}</b>
        </p>
      ) : null}

      <div className="prop-section">
        <div className="prop-section-title">Size</div>
        <LengthField
          label="Length"
          items={[wall]}
          read={(w) => w.len}
          onCommit={(m) => store.setWallLength(wallId, m)}
          min={0.3}
          max={30}
        />
        <LengthField
          label="Thickness"
          items={[wallRoom.style]}
          read={(s) => s.wallThickness}
          onCommit={(m) => store.setRoomStyle({ wallThickness: m }, wallRoom.id)}
          min={0.05}
          max={0.4}
        />
      </div>

      <div className="prop-section">
        <div className="prop-section-title">Visibility</div>
        <ChoiceRow
          options={VIS_CHOICES}
          current={store.wallVisibility(wallId)}
          onPick={(v) => store.setWallVisibility(wallId, v as WallVisMode)}
        />
        <p className="props-sub" style={{ marginTop: 8 }}>
          Auto hides this wall when the camera looks past it
        </p>
      </div>

      <div className="prop-section">
        <div className="prop-section-title">Shape</div>
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => {
              const now = store.wallById(wallId);
              if (!now) return;
              const nc = store.splitWall(wallId, now.len / 2);
              if (nc) {
                store.select({ kind: 'corner', id: nc.id });
                store.commit();
              }
            }}
          >
            Add corner in the middle
          </button>
        </div>
      </div>
    </>
  );
}
