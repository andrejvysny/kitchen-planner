import type { ReactElement } from 'react';
import { useStore } from '../services';
import { MAX_WALL_W, MIN_WALL_W } from '../../../model/store';
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
 * Thickness is PER WALL (`Room.wallWidths`, resolved in `allWalls`), stored on
 * the wall's OWN room rather than the active one: a partition selected from
 * the other side still edits the room that owns it, and both sides answer with
 * the one width they share. Clearing the override falls back to the room-wide
 * `style.wallThickness`, which the Furnish panel's Walls section still edits.
 */
export function WallProps({ wallId }: { wallId: string }): ReactElement | null {
  const store = useStore();
  const wall = store.wallById(wallId);
  if (!wall) return null;

  // a free-standing chain belongs to no room, so the room-scoped sections
  // (visibility override, add-a-corner on the ring) have nothing to act on
  const chain = store.freeWallOf(wallId);
  if (chain) return <FreeWallProps wallId={wallId} chainId={chain.id} />;

  const wallRoom = store.roomOfWall(wallId) ?? store.activeRoom();
  if (!wallRoom) return null;
  const overridden = store.hasWallWidthOverride(wallId);
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
          cls="wall-len"
          min={0.3}
          max={30}
        />
        <LengthField
          label="Thickness"
          items={[wall]}
          read={(w) => w.thickness}
          onCommit={(m) => store.setWallWidth(wallId, m)}
          cls="wall-thickness"
          min={MIN_WALL_W}
          max={MAX_WALL_W}
        />
        {overridden ? (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                store.setWallWidth(wallId, null);
                store.commit();
              }}
            >
              Reset to room default
            </button>
          </div>
        ) : null}
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

/**
 * One segment of a free-standing chain — a divider, a peninsula, a stub.
 *
 * Deliberately thinner than the room-wall panel: a chain has no room, so
 * per-room wall VISIBILITY has nothing to override, and its length is set by
 * moving its corners rather than by propagating through perpendicular
 * neighbours the way `setWallLength` does on a closed ring. What it does have
 * that a room wall does not is deletion: the chain is its own object.
 */
function FreeWallProps({ wallId, chainId }: { wallId: string; chainId: string }): ReactElement | null {
  const store = useStore();
  const wall = store.wallById(wallId);
  const chain = store.design.walls?.find((c) => c.id === chainId);
  if (!wall || !chain) return null;
  const overridden = store.hasWallWidthOverride(wallId);
  const segments = chain.corners.length - 1;

  return (
    <>
      <h2 className="props-title">Wall</h2>
      <p className="props-sub">
        {`Free-standing · ${segments} segment${segments === 1 ? '' : 's'} · belongs to no room`}
      </p>

      <div className="prop-section">
        <div className="prop-section-title">Size</div>
        <LengthField
          label="Length"
          items={[wall]}
          read={(w) => w.len}
          onCommit={() => undefined}
          cls="wall-len"
          min={0.1}
          max={30}
        />
        <p className="props-sub">Drag its ends in the plan to change this segment</p>
        <LengthField
          label="Thickness"
          items={[wall]}
          read={(w) => w.thickness}
          onCommit={(m) => store.setWallWidth(wallId, m)}
          cls="wall-thickness"
          min={MIN_WALL_W}
          max={MAX_WALL_W}
        />
        {overridden ? (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                store.setWallWidth(wallId, null);
                store.commit();
              }}
            >
              Reset to chain default
            </button>
          </div>
        ) : null}
      </div>

      <div className="prop-section">
        <div className="prop-section-title">Actions</div>
        <div className="btn-row">
          <button
            className="btn danger"
            onClick={() => {
              store.deleteFreeWall(chainId);
              store.commit();
            }}
          >
            Delete wall
          </button>
        </div>
      </div>
    </>
  );
}
