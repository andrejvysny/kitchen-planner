import type { ReactElement } from 'react';
import { store, studio } from '../../../app/bootstrap';
import { COUNTER_COLORS, FRONT_COLORS, LIGHT_COLORS } from '../../../model/catalog';
import { ITEM_MATERIALS, COUNTER_MATERIALS, overridesColor } from '../../../model/materials';
import { hasPreset } from '../../../model/presets';
import type { Item } from '../../../model/types';
import { isVarRef, resolveColor } from '../../../model/variables';
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
export function ItemProps({ item }: { item: Item }): ReactElement {
  const def = store.defOf(item.defId);
  const part = store.partOf(item.defId);
  // presets are parts too, but read as built-ins to the user
  const isOwnPart = !!store.customPartById(item.defId);
  const one = [item];

  return (
    <>
      <h2 className="props-title">{def.label}</h2>
      <p className="props-sub">{isOwnPart ? 'Custom part' : 'Catalog item'}</p>

      <ChecksSection
        list={store.warnings().filter((w) => w.itemIds.includes(item.id))}
        exceptId={item.id}
      />

      {item.attach ? <MountingSection item={item} /> : null}

      <div className="prop-section">
        <div className="prop-section-title">Dimensions</div>
        <LengthField
          label="Width"
          items={one}
          read={(it) => it.w}
          onCommit={(m) => store.updateItem(item.id, { w: m })}
          min={MIN_DIM}
        />
        <LengthField
          label="Depth"
          items={one}
          read={(it) => it.d}
          onCommit={(m) => store.updateItem(item.id, { d: m })}
          min={MIN_DIM}
        />
        <LengthField
          label="Height"
          items={one}
          read={(it) => it.h}
          onCommit={(m) => store.updateItem(item.id, { h: m })}
          min={MIN_DIM}
        />
        {item.attach ? null : (
          // off-floor placement is likewise freeform for every item (floor at 0, no ceiling cap)
          <LengthField
            label="Off floor"
            items={one}
            read={(it) => it.elevation}
            onCommit={(m) => store.updateItem(item.id, { elevation: m })}
            min={0}
          />
        )}
      </div>

      {item.attach ? null : <PositionSection item={item} />}

      {def.params?.length ? (
        <div className="prop-section">
          <div className="prop-section-title">Configuration</div>
          {def.params.map((p) => (
            <StepperRow
              key={p.key}
              label={p.label}
              value={item.params?.[p.key] ?? p.def}
              min={p.min}
              max={p.max}
              onChange={(v) => store.setItemParam(item.id, p.key, v)}
            />
          ))}
        </div>
      ) : null}

      {def.opening || def.marker ? null : (
        <>
          <ColourSection item={item} />
          {part ? <AccentSection item={item} accentDefault={part.accentColor} /> : null}
          {/* worktops live on cabinet parts now — nothing else carries one */}
          {part && part.type === 'cabinet' && part.worktop ? <WorktopSection item={item} /> : null}
        </>
      )}

      {item.light ? <LightSection item={item} light={item.light} /> : null}

      <div className="prop-section">
        <div className="prop-section-title">Actions</div>
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => {
              const copy = store.duplicateItem(item.id);
              if (copy) store.select({ kind: 'item', id: copy.id });
              store.commit();
            }}
          >
            Duplicate
          </button>
          <button
            className="btn danger"
            onClick={() => {
              store.deleteItem(item.id);
              store.commit();
            }}
          >
            Delete
          </button>
        </div>
        {isOwnPart ? (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                const own = store.customPartById(item.defId);
                if (own) studio.open(own);
              }}
            >
              Edit part template…
            </button>
          </div>
        ) : hasPreset(item.defId) ? (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => {
                // fork the preset into "My parts" so just this instance becomes editable
                const fork = store.forkPartForItem(item.id);
                if (!fork) return;
                store.commit();
                studio.open(fork);
              }}
            >
              Customize part…
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** A mounted appliance's pose is derived from its host — say so, and offer Detach. */
function MountingSection({ item }: { item: Item }): ReactElement {
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

/** The front slot: a variable binding, a literal colour, and a texture on top. */
function ColourSection({ item }: { item: Item }): ReactElement {
  const bound = isVarRef(item.color);

  return (
    <div className="prop-section">
      <div className="prop-section-title">Colour &amp; material</div>
      {/* bind chips first — picking a literal swatch below detaches back to a hex */}
      <VarChips current={item.color} onBind={(ref) => store.updateItem(item.id, { color: ref })} />
      <SwatchRow
        colors={FRONT_COLORS}
        current={resolveColor(store.design, item.color)}
        onPick={(c) =>
          // picking a plain colour drops a colour-hiding texture so the colour shows
          store.updateItem(
            item.id,
            overridesColor(item.material)
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
            onPick={(id) => store.updateItem(item.id, { material: id })}
          />
          <RotToggle
            matId={item.material}
            value={item.materialRot === true}
            onChange={(v) => store.updateItem(item.id, { materialRot: v || undefined })}
          />
        </>
      )}
    </div>
  );
}

/** Custom parts expose an accent (wood-tone) slot — bindable per instance. */
function AccentSection({
  item,
  accentDefault,
}: {
  item: Item;
  accentDefault: string;
}): ReactElement {
  return (
    <div className="prop-section">
      <div className="prop-section-title">Accent</div>
      <VarChips
        current={item.accentColor ?? ''}
        onBind={(ref) => store.updateItem(item.id, { accentColor: ref })}
      />
      <SwatchRow
        colors={COUNTER_COLORS}
        current={resolveColor(store.design, item.accentColor ?? accentDefault)}
        onPick={(c) => store.updateItem(item.id, { accentColor: c })}
      />
    </div>
  );
}

/** Per-item worktop finish; the first chip falls back to the room's setting. */
function WorktopSection({ item }: { item: Item }): ReactElement {
  return (
    <div className="prop-section">
      <div className="prop-section-title">Worktop</div>
      <MaterialRow
        mats={COUNTER_MATERIALS}
        current={item.counterMaterial}
        onPick={(id) => store.updateItem(item.id, { counterMaterial: id })}
        plainTitle="Room default"
      />
      <RotToggle
        matId={item.counterMaterial}
        value={item.counterMaterialRot === true}
        onChange={(v) => store.updateItem(item.id, { counterMaterialRot: v || undefined })}
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
