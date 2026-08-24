import type { ReactElement } from 'react';
import { useAppServices, useStore } from '../services';
import { COUNTER_COLORS, FRONT_COLORS, LIGHT_COLORS } from '../../../model/catalog';
import { ITEM_MATERIALS, COUNTER_MATERIALS, overridesColor } from '../../../model/materials';
import { hasPreset } from '../../../model/presets';
import type { Item } from '../../../model/types';
import { isVarRef, refId, resolveColor } from '../../../model/variables';
import { openInWorkshop } from '../../workspaceState';
import { AngleField } from '../fields/AngleField';
import { LengthField } from '../fields/LengthField';
import { MaterialRow } from '../fields/MaterialRow';
import { RotToggle } from '../fields/RotToggle';
import { SliderRow } from '../fields/SliderRow';
import { StepperRow } from '../fields/StepperRow';
import { SwatchRow } from '../fields/SwatchRow';
import { ToggleRow } from '../fields/ToggleRow';
import { VarChips } from '../fields/VarChips';
import { ChecksSection } from './ChecksSection';

/**
 * 1 cm — dimensions are otherwise freeform (KITCHENP-7), this only stops
 * degenerate geometry. Handed to the fields as their `min`, which is where the
 * clamp lives now that the boxes take expressions rather than spinner values.
 */
const MIN_DIM = 0.01;

/**
 * The panel for a placed object — src/ui/ui.ts's renderItemProps, section for
 * section. Which sections appear is entirely a function of what the object IS:
 * an attached appliance has no position of its own, an opening or a marker no
 * colour, a cabinet an Accent and a Worktop slot, a fixture a Light.
 *
 * Dimensions carry no catalog limits on purpose; the only floor is MIN_DIM.
 * Position and rotation are `live` fields — they follow a drag through the
 * 'transient' channel without this component re-rendering at all (see
 * useLiveValue.ts).
 */
/**
 * The panel for the SELECTED OBJECTS. `items` is the whole selection in
 * selection order, so the last entry is the primary — the one the title, the
 * position boxes and the Workshop routes speak for.
 *
 * What applies to MANY is what a run of cabinets is selected for: dimensions,
 * off-floor height, the colour/material slots, the worktop finish and (when
 * every member is the same part) its configuration. What cannot be shared
 * honestly stays single: an exact X/Y, a mounted appliance's host, a fixture's
 * bulb, and anything that routes into the Workshop for one part.
 */
export function ItemProps({ items }: { items: Item[] }): ReactElement {
  const { store, editor } = useAppServices();
  const item = items[items.length - 1];
  const many = items.length > 1;
  const def = store.defOf(item.defId);
  const part = store.partOf(item.defId);
  // presets are parts too, but read as built-ins to the user
  const isOwnPart = !!store.customPartById(item.defId);
  // one patch per member, computed from that member — a colour swap has to read
  // each item's own material to know whether it must drop it
  const applyEach = (patch: (it: Item) => Partial<Item>): void => {
    for (const it of items) store.updateItem(it.id, patch(it));
  };
  const sameDef = items.every((it) => it.defId === item.defId);

  return (
    <>
      <h2 className="props-title">{many ? `${items.length} items selected` : def.label}</h2>
      <p className="props-sub">
        {many
          ? sameDef
            ? `${def.label} ×${items.length}`
            : 'Mixed selection — shared fields apply to all'
          : isOwnPart
            ? 'Custom part'
            : 'Catalog item'}
      </p>

      {many ? null : (
        <ChecksSection
          list={store.warnings().filter((w) => w.itemIds.includes(item.id))}
          exceptId={item.id}
        />
      )}

      {!many && item.attach ? <MountingSection item={item} /> : null}

      <div className="prop-section">
        <div className="prop-section-title">Dimensions</div>
        <LengthField
          label="Width"
          items={items}
          read={(it) => it.w}
          onCommit={(m) => applyEach(() => ({ w: m }))}
          min={MIN_DIM}
        />
        <LengthField
          label="Depth"
          items={items}
          read={(it) => it.d}
          onCommit={(m) => applyEach(() => ({ d: m }))}
          min={MIN_DIM}
        />
        <LengthField
          label="Height"
          items={items}
          read={(it) => it.h}
          onCommit={(m) => applyEach(() => ({ h: m }))}
          min={MIN_DIM}
        />
        {items.every((it) => it.attach) ? null : (
          // off-floor placement is likewise freeform for every item (floor at 0, no ceiling cap)
          <LengthField
            label="Off floor"
            items={items}
            read={(it) => it.elevation}
            onCommit={(m) => applyEach(() => ({ elevation: m }))}
            min={0}
          />
        )}
      </div>

      {many || item.attach ? null : <PositionSection item={item} />}

      {def.params?.length && sameDef ? (
        <div className="prop-section">
          <div className="prop-section-title">Configuration</div>
          {def.params.map((p) => (
            <StepperRow
              key={p.key}
              label={p.label}
              value={item.params?.[p.key] ?? p.def}
              min={p.min}
              max={p.max}
              onChange={(v) => {
                for (const it of items) store.setItemParam(it.id, p.key, v);
              }}
            />
          ))}
        </div>
      ) : null}

      {def.opening || def.marker ? null : (
        <>
          <ColourSection items={items} />
          {part ? <AccentSection items={items} accentDefault={part.accentColor} /> : null}
          {/* worktops live on cabinet parts now — nothing else carries one */}
          {part && part.type === 'cabinet' && part.worktop ? (
            <WorktopSection items={items} />
          ) : null}
        </>
      )}

      {!many && item.light ? <LightSection item={item} light={item.light} /> : null}

      <div className="prop-section">
        <div className="prop-section-title">Actions</div>
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => {
              const copies = items
                .map((it) => store.duplicateItem(it.id))
                .filter((c): c is Item => !!c)
                .map((c) => ({ kind: 'item', id: c.id }) as const);
              if (copies.length) editor.selectRefs(copies);
              store.commit();
            }}
          >
            {many ? `Duplicate ${items.length}` : 'Duplicate'}
          </button>
          <button
            className="btn danger"
            onClick={() => {
              for (const it of items) store.deleteItem(it.id);
              store.commit();
            }}
          >
            {many ? `Delete ${items.length}` : 'Delete'}
          </button>
        </div>
        {many ? null : isOwnPart ? (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                if (store.customPartById(item.defId)) openInWorkshop(item.defId, item.id);
              }}
            >
              Edit in Workshop…
            </button>
          </div>
        ) : hasPreset(item.defId) ? (
          <div className="btn-row">
            <button
              className="btn"
              title="Makes an editable copy of this built-in part for this design"
              onClick={() => {
                // fork the preset into "My parts" so just this instance becomes editable
                const fork = store.forkPartForItem(item.id);
                if (!fork) return;
                store.commit();
                openInWorkshop(fork.id, item.id);
              }}
            >
              Customize in Workshop…
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** A mounted appliance's pose is derived from its host — say so, and offer Detach. */
function MountingSection({ item }: { item: Item }): ReactElement {
  const store = useStore();
  const attach = item.attach!;
  const host = store.itemById(attach.hostId);
  const hostLabel = host ? store.defOf(host.defId).label : '?';

  return (
    <div className="prop-section">
      <div className="prop-section-title">Mounting</div>
      <p className="props-sub">
        Mounted {attach.kind === 'zone' ? 'in a niche of' : 'on'} <b>{hostLabel}</b> — moves with it
      </p>
      <div className="btn-row">
        <button
          className="btn"
          onClick={() => {
            store.setAttachment(item.id, undefined);
            store.commit();
          }}
        >
          Detach
        </button>
      </div>
    </div>
  );
}

/** X / Y / rotation. All three follow a plan drag without a re-render. */
function PositionSection({ item }: { item: Item }): ReactElement {
  const store = useStore();
  const one = [item];
  // a quarter turn from wherever the item currently is — never from the box
  const rotate = (rad: number): void => {
    store.updateItem(item.id, { rotation: rad }, { structural: false });
    store.commit();
  };

  return (
    <div className="prop-section">
      <div className="prop-section-title">Position</div>
      <LengthField
        label="X"
        items={one}
        read={(it) => it.x}
        onCommit={(m) => store.updateItem(item.id, { x: m })}
        cls="pos-x"
        live
      />
      <LengthField
        label="Y"
        items={one}
        read={(it) => it.y}
        onCommit={(m) => store.updateItem(item.id, { y: m })}
        cls="pos-y"
        live
      />
      <AngleField
        label="Rotate"
        items={one}
        read={(it) => it.rotation}
        onCommit={(rad) => store.updateItem(item.id, { rotation: rad }, { structural: false })}
        cls="rot"
        step={15}
        live
        stepper={{
          down: ['⟲', 'Rotate left'],
          up: ['⟳', 'Rotate right'],
          onDown: () => rotate(item.rotation - Math.PI / 2),
          onUp: () => rotate(item.rotation + Math.PI / 2),
        }}
      />
    </div>
  );
}

/**
 * The front slot: a variable binding, a literal colour, and a texture on top.
 *
 * Reads the PRIMARY (the last member) and writes every member: with a run
 * selected, "make these sage" is the whole point, and the swatch row has one
 * current colour to show either way.
 */
function ColourSection({ items }: { items: Item[] }): ReactElement {
  const store = useStore();
  const item = items[items.length - 1];
  const bound = isVarRef(item.color);
  const boundVar = bound ? store.variableById(refId(item.color)) : undefined;
  const each = (patch: (it: Item) => Partial<Item>): void => {
    for (const it of items) store.updateItem(it.id, patch(it));
  };

  return (
    <div className="prop-section">
      <div className="prop-section-title">Colour &amp; material</div>
      {/* bind chips first — picking a literal swatch below detaches back to a hex */}
      <VarChips current={item.color} onBind={(ref) => each(() => ({ color: ref }))} />
      <SwatchRow
        colors={FRONT_COLORS}
        current={resolveColor(store.design, item.color)}
        boundTo={boundVar?.name}
        onPick={(c) =>
          // picking a plain colour drops a colour-hiding texture so the colour
          // shows — decided per member, since they may not share a material
          each((it) =>
            overridesColor(it.material)
              ? { color: c, material: undefined, materialRot: undefined }
              : { color: c }
          )
        }
      />
      {bound ? (
        <p className="props-sub" style={{ marginTop: 8 }}>
          Texture follows the bound variable
        </p>
      ) : (
        <>
          <MaterialRow
            mats={ITEM_MATERIALS}
            current={item.material}
            onPick={(id) => each(() => ({ material: id }))}
            groupHeaders
          />
          <RotToggle
            matId={item.material}
            value={item.materialRot === true}
            onChange={(v) => each(() => ({ materialRot: v || undefined }))}
          />
        </>
      )}
    </div>
  );
}

/** Custom parts expose an accent (wood-tone) slot — bindable per instance. */
function AccentSection({
  items,
  accentDefault,
}: {
  items: Item[];
  accentDefault: string;
}): ReactElement {
  const store = useStore();
  const item = items[items.length - 1];
  const raw = item.accentColor ?? '';
  const boundVar = isVarRef(raw) ? store.variableById(refId(raw)) : undefined;
  return (
    <div className="prop-section">
      <div className="prop-section-title">Accent</div>
      <VarChips
        current={raw}
        onBind={(ref) => {
          for (const it of items) store.updateItem(it.id, { accentColor: ref });
        }}
      />
      <SwatchRow
        colors={COUNTER_COLORS}
        current={resolveColor(store.design, item.accentColor ?? accentDefault)}
        boundTo={boundVar?.name}
        onPick={(c) => {
          for (const it of items) store.updateItem(it.id, { accentColor: c });
        }}
      />
    </div>
  );
}

/** Per-item worktop finish; the first chip falls back to the room's setting. */
function WorktopSection({ items }: { items: Item[] }): ReactElement {
  const store = useStore();
  const item = items[items.length - 1];
  return (
    <div className="prop-section">
      <div className="prop-section-title">Worktop</div>
      <MaterialRow
        mats={COUNTER_MATERIALS}
        current={item.counterMaterial}
        onPick={(id) => {
          for (const it of items) store.updateItem(it.id, { counterMaterial: id });
        }}
        plainTitle="Room default"
        groupHeaders
      />
      <RotToggle
        matId={item.counterMaterial}
        value={item.counterMaterialRot === true}
        onChange={(v) => {
          for (const it of items) store.updateItem(it.id, { counterMaterialRot: v || undefined });
        }}
      />
      <p className="props-sub" style={{ marginTop: 8 }}>
        First chip follows the room&apos;s worktop setting
      </p>
    </div>
  );
}

/** A fixture's own bulb: on/off, intensity, warmth, and an explicit colour. */
function LightSection({
  item,
  light,
}: {
  item: Item;
  light: NonNullable<Item['light']>;
}): ReactElement {
  const store = useStore();
  return (
    <div className="prop-section">
      <div className="prop-section-title">Light</div>
      <ToggleRow
        label="On"
        value={light.on}
        onChange={(v) => store.updateItemLight(item.id, { on: v })}
      />
      <SliderRow
        label="Brightness"
        value={light.intensity}
        onInput={(v) => store.updateItemLight(item.id, { intensity: v })}
      />
      <SliderRow
        label="Warmth"
        value={light.warmth}
        onInput={(v) => store.updateItemLight(item.id, { warmth: v })}
      />
      {/* explicit colour wins over warmth when set */}
      <SwatchRow
        colors={LIGHT_COLORS}
        current={light.color ?? '#fff4e0'}
        onPick={(c) => store.updateItemLight(item.id, { color: c })}
      />
    </div>
  );
}
