import { Fragment, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { useAppServices, useStore } from '../services';
import { workspace } from '../../workspaceState';
import { COUNTER_COLORS, FLOOR_COLORS, WALL_COLORS } from '../../../model/catalog';
import {
  COUNTER_MATERIALS,
  FLOOR_MATERIALS,
  overridesColor,
  WALL_MATERIALS,
} from '../../../model/materials';
import type { Room, RoomStyle, WallVisMode } from '../../../model/types';
import { resolveColor } from '../../../model/variables';
import { ChoiceRow } from '../fields/ChoiceRow';
import { LengthField } from '../fields/LengthField';
import { MaterialRow } from '../fields/MaterialRow';
import { RotToggle } from '../fields/RotToggle';
import { SwatchRow } from '../fields/SwatchRow';
import { useSyncedValue } from '../fields/useLiveValue';
import { useNativeChange } from '../fields/useNativeChange';
import { VarChips } from '../fields/VarChips';
import { WORKSPACE_ROOM_SECTIONS, type RoomSectionId } from './roomSections';
import { ChecksSection } from './ChecksSection';
import { LightingProps } from './LightingProps';
import { UnderlaySection } from './UnderlaySection';

/** The three global wall-visibility buttons, as [mode, label] pairs. */
const VIS_ALL: readonly (readonly [WallVisMode, string])[] = [
  ['auto', 'Auto all'],
  ['show', 'Show all'],
  ['hide', 'Hide all'],
];

const VIS_CHOICES: readonly (readonly [string, string])[] = [
  ['auto', 'Auto'],
  ['show', 'Show'],
  ['hide', 'Hide'],
];

/**
 * The no-selection panel: which sections show is a per-workspace registry
 * (roomSections.ts) — Plan gets floor-plan structure, Furnish gets
 * materials + lighting, `checks` is shared by both. ui.ts's renderRoomProps
 * used to render all of this as one fixed list; here each block is a small
 * component in `SECTIONS` below, looked up by id instead of hardcoded order.
 *
 * ui.ts had to guard its rebuilds with an `isEditingRoomName` check, because a
 * fresh 'activeRoom' event would blow the name field away mid-edit. Here the
 * panel is remounted only when the SELECTION changes (PropsBody carries the
 * key) and re-rendered otherwise, so the name input keeps its node and its
 * caret — the guard has nothing left to protect and is gone.
 */
export function RoomProps(): ReactElement | null {
  const store = useStore();
  const room = store.activeRoom();
  const style = store.activeStyle();
  const rect = store.rectangleSize();

  // PropsBody only renders this component once a room exists (see
  // NoRoomProps for the 0-room panel), but activeRoom() stays nullable at
  // the type level for the design's genuinely-roomless window.
  if (!room) return null;

  const ids = WORKSPACE_ROOM_SECTIONS[workspace() === 'furnish' ? 'furnish' : 'plan'];
  const SECTIONS: Record<RoomSectionId, () => ReactElement> = {
    identity: () => <IdentitySection room={room} />,
    roomList: () => <RoomListSection room={room} />,
    referencePhoto: () => <UnderlaySection />,
    checks: () => <ChecksSection list={store.warnings()} cap={12} />,
    size: () => <SizeSection room={room} style={style} rect={rect} />,
    shape: () => <ShapeSection room={room} />,
    ceiling: () => <CeilingSection />,
    deleteRoom: () => <DeleteRoomSection room={room} />,
    tip: () => <TipSection />,
    walls: () => <WallsSection style={style} />,
    floor: () => <FloorSection style={style} />,
    worktops: () => <WorktopsSection style={style} />,
    lighting: () => <LightingProps />,
  };

  return (
    <>
      {ids.map((id) => (
        <Fragment key={id}>{SECTIONS[id]()}</Fragment>
      ))}
    </>
  );
}

/** Placeholder for the props panel while the design has no rooms yet. */
export function NoRoomProps(): ReactElement {
  if (workspace() === 'furnish') {
    return <p className="props-sub">Add a room in Plan first — there is nothing to furnish yet.</p>;
  }
  // Plan's canvas already carries the full "Start with a room" card
  // (<PlanStarterCard/>); nothing more to say here.
  return <p className="props-sub">Add a room to get started.</p>;
}

function IdentitySection({ room }: { room: Room }): ReactElement {
  const store = useStore();
  return (
    <>
      <RoomName room={room} />
      <p className="props-sub">{`${store.floorArea().toFixed(1)} m² · ${room.corners.length} corners`}</p>
    </>
  );
}

function RoomListSection({ room }: { room: Room }): ReactElement {
  const store = useStore();
  const plan = useAppServices().plan;
  const rooms = store.design.rooms;
  return (
    <div className="prop-section">
      <div className="prop-section-title">Rooms</div>
      {rooms.map((r) => (
        <RoomRow key={r.id} room={r} active={r.id === room.id} />
      ))}
      <div className="btn-row">
        <button className="btn" onClick={() => plan.setRoomTool(true)}>
          ＋ Add room
        </button>
        <button className="btn" onClick={() => plan.setDrawRoom(true)}>
          ✎ Draw room
        </button>
      </div>
    </div>
  );
}

function SizeSection({
  style,
  rect,
}: {
  room: Room;
  style: RoomStyle;
  rect: { w: number; d: number } | null;
}): ReactElement {
  const store = useStore();
  return (
    <div className="prop-section">
      <div className="prop-section-title">Size</div>
      {rect ? (
        <>
          <LengthField
            label="Width"
            items={[rect]}
            read={(r) => r.w}
            onCommit={(m) => store.setRectangleSize(m, rect.d)}
            min={1}
            max={20}
          />
          <LengthField
            label="Depth"
            items={[rect]}
            read={(r) => r.d}
            onCommit={(m) => store.setRectangleSize(rect.w, m)}
            min={1}
            max={20}
          />
        </>
      ) : (
        <p className="props-sub">Select a wall to edit its length, or drag corners in the plan.</p>
      )}
      <LengthField
        label="Ceiling"
        items={[style]}
        read={(s) => s.wallHeight}
        onCommit={(m) => store.setRoomStyle({ wallHeight: m })}
        min={2}
        max={4}
      />
    </div>
  );
}

function CeilingSection(): ReactElement {
  const store = useStore();
  return (
    <div className="prop-section">
      <div className="prop-section-title">Ceiling</div>
      <ChoiceRow
        options={VIS_CHOICES}
        current={store.ceilingVisibility()}
        onPick={(v) => store.setCeilingVisibility(v as WallVisMode)}
      />
      <p className="props-sub" style={{ marginTop: 8 }}>
        Auto shows the ceiling only when the camera is below it
      </p>
    </div>
  );
}

function DeleteRoomSection({ room }: { room: Room }): ReactElement {
  const store = useStore();
  const rooms = store.design.rooms;
  return (
    <div className="prop-section">
      <div className="prop-section-title">Actions</div>
      <div className="btn-row">
        <button
          className="btn danger"
          disabled={rooms.length === 1}
          title={rooms.length === 1 ? 'A design always has at least one room' : undefined}
          onClick={() => {
            if (!confirm(`Delete "${room.name}" and everything in it?`)) return;
            store.deleteRoom(room.id);
            store.commit();
          }}
        >
          Delete room
        </button>
      </div>
    </div>
  );
}

function TipSection(): ReactElement {
  return (
    <div className="props-empty-tip">
      <b>How to design your space</b>
      <br />1 · Sketch rooms — size, corners, and <b>＋ Add room</b> for more
      <br />2 · Place doors, windows &amp; utilities on the walls
      <br />3 · Furnish along the walls — cabinets and furniture snap into place
      <br />4 · Place lights, then set the mood in <b>Lighting</b> (sun direction &amp; height,
      brightness)
      <br />
      Create your own parametric furniture with <b>＋ New part</b>
    </div>
  );
}

/**
 * The title IS the room name — renaming is the most common room-level edit.
 * `renameRoom` rejects blanks, so the field is written back from the model
 * after the change even when it still holds the caret (useSyncedValue skips a
 * focused field on purpose, and Enter does not blur).
 */
function RoomName({ room }: { room: Room }): ReactElement {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);

  useSyncedValue(input, room.name);
  useNativeChange(input, (el) => {
    store.renameRoom(room.id, el.value);
    store.commit();
    el.value = store.roomById(room.id)?.name ?? room.name;
  });

  return (
    <input
      className="room-name"
      type="text"
      spellCheck={false}
      title="Rename this room"
      defaultValue={room.name}
      ref={input}
    />
  );
}

/** A row in the room switcher: picking one activates it and drops the selection. */
function RoomRow({ room, active }: { room: Room; active: boolean }): ReactElement {
  const store = useStore();
  const pick = (): void => {
    store.setActiveRoom(room.id);
    store.select({ kind: 'none' });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  };

  return (
    <div
      className={active ? 'ol-row room-row active' : 'ol-row room-row'}
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={onKeyDown}
    >
      <span className="room-row-name">{room.name}</span>
      <span className="room-row-area">{`${store.floorArea(room.id).toFixed(1)} m²`}</span>
    </div>
  );
}

/** A preset rewrites the whole corner ring, which would orphan a partition. */
function ShapeSection({ room }: { room: Room }): ReactElement {
  const store = useStore();
  const shared = store.wallsOf(room.id).some((w) => w.shared);
  const title = shared
    ? 'This room shares a wall with another — reshaping it would break the partition'
    : undefined;

  const apply = (preset: 'rect' | 'lshape'): void => {
    store.setShapePreset(preset);
    store.commit();
  };

  return (
    <div className="prop-section">
      <div className="prop-section-title">Room shape</div>
      <div className="btn-row">
        <button className="btn" disabled={shared} title={title} onClick={() => apply('rect')}>
          Rectangle
        </button>
        <button className="btn" disabled={shared} title={title} onClick={() => apply('lshape')}>
          L-shape
        </button>
      </div>
      <p className="props-sub" style={{ marginTop: 8 }}>
        Drag ■ corners to reshape · drag ◆ to bend a wall
      </p>
    </div>
  );
}

function WallsSection({ style }: { style: RoomStyle }): ReactElement {
  const store = useStore();
  return (
    // #section-walls is the context menu's "Wall colour…" destination: wall
    // finishes are a room-level style here, so that entry scrolls to this
    // section rather than opening anything of its own.
    <div className="prop-section" id="section-walls">
      <div className="prop-section-title">Walls</div>
      <VarChips
        current={style.wallColor}
        onBind={(ref) => store.setRoomStyle({ wallColor: ref })}
      />
      <SwatchRow
        colors={WALL_COLORS}
        current={resolveColor(store.design, style.wallColor)}
        onPick={(c) =>
          // picking a plain colour drops a colour-hiding texture so the colour shows
          store.setRoomStyle(
            overridesColor(style.wallMaterial)
              ? { wallColor: c, wallMaterial: undefined, wallMaterialRot: undefined }
              : { wallColor: c }
          )
        }
      />
      <MaterialRow
        mats={WALL_MATERIALS}
        current={style.wallMaterial}
        onPick={(id) => store.setRoomStyle({ wallMaterial: id })}
      />
      <RotToggle
        matId={style.wallMaterial}
        value={style.wallMaterialRot === true}
        onChange={(v) => store.setRoomStyle({ wallMaterialRot: v || undefined })}
      />
      <div className="btn-row">
        {VIS_ALL.map(([mode, label]) => (
          <button
            key={mode}
            className="btn"
            data-m={mode}
            onClick={() => {
              store.setAllWallVisibility(mode);
              store.commit();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="props-sub" style={{ marginTop: 8 }}>
        Or select a single wall to override it
      </p>
    </div>
  );
}

function FloorSection({ style }: { style: RoomStyle }): ReactElement {
  const store = useStore();
  return (
    <div className="prop-section">
      <div className="prop-section-title">Floor</div>
      <VarChips
        current={style.floorColor}
        onBind={(ref) => store.setRoomStyle({ floorColor: ref })}
      />
      <SwatchRow
        colors={FLOOR_COLORS}
        current={resolveColor(store.design, style.floorColor)}
        onPick={(c) =>
          store.setRoomStyle(
            overridesColor(style.floorMaterial)
              ? { floorColor: c, floorMaterial: undefined, floorMaterialRot: undefined }
              : { floorColor: c }
          )
        }
      />
      <MaterialRow
        mats={FLOOR_MATERIALS}
        current={style.floorMaterial}
        onPick={(id) => store.setRoomStyle({ floorMaterial: id })}
      />
      <RotToggle
        matId={style.floorMaterial}
        value={style.floorMaterialRot === true}
        onChange={(v) => store.setRoomStyle({ floorMaterialRot: v || undefined })}
      />
    </div>
  );
}

function WorktopsSection({ style }: { style: RoomStyle }): ReactElement {
  const store = useStore();
  return (
    <div className="prop-section">
      <div className="prop-section-title">Worktops</div>
      <VarChips
        current={style.counterColor}
        onBind={(ref) => store.setRoomStyle({ counterColor: ref })}
      />
      <SwatchRow
        colors={COUNTER_COLORS}
        current={resolveColor(store.design, style.counterColor)}
        onPick={(c) =>
          store.setRoomStyle(
            overridesColor(style.counterMaterial)
              ? { counterColor: c, counterMaterial: undefined, counterMaterialRot: undefined }
              : { counterColor: c }
          )
        }
      />
      <MaterialRow
        mats={COUNTER_MATERIALS}
        current={style.counterMaterial}
        onPick={(id) => store.setRoomStyle({ counterMaterial: id })}
      />
      <RotToggle
        matId={style.counterMaterial}
        value={style.counterMaterialRot === true}
        onChange={(v) => store.setRoomStyle({ counterMaterialRot: v || undefined })}
      />
    </div>
  );
}
