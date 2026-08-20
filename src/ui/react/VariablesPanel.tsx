import { useRef, type ReactElement } from 'react';
import { useStore } from './services';
import { FRONT_COLORS } from '../../model/catalog';
import { ITEM_MATERIALS, overridesColor } from '../../model/materials';
import type { DesignVar } from '../../model/types';
import { setHint } from '../shellState';
import { MaterialRow } from './fields/MaterialRow';
import { RotToggle } from './fields/RotToggle';
import { SwatchRow } from './fields/SwatchRow';
import { useSyncedValue } from './fields/useLiveValue';
import { useNativeChange } from './fields/useNativeChange';
import { useChannel } from './hooks/useStore';

/**
 * The Materials tab (WS-SPEC Phase 4 — "Variables" everywhere a user reads
 * it): create / edit / delete the design's shared swatches, and pick the one
 * new parts are born bound to. The model type stays `DesignVar` and every
 * store method stays `*Variable*`/`applyVarToItems` — this is a copy-only
 * rename, not a data-shape change.
 *
 * Ported from src/ui/ui.ts renderVariablesSection node for node — same
 * section, same `.var-item` cards. What changes is only HOW it stays current:
 * ui.ts rebuilt the panel's DOM on every 'history' and needed an
 * isEditingVariableName guard so a rebuild would not yank the name field out
 * from under the caret. Here React reconciles instead, the name input is
 * uncontrolled, and useSyncedValue refuses to write into a focused field — so
 * the guard has nothing left to protect and is gone.
 *
 * Every mutation below is a store call followed by `store.commit()`, exactly as
 * the helper had it: variables are design data, so each edit is one undo step.
 */
export function VariablesPanel(): ReactElement {
  const store = useStore();
  useChannel('history');
  const design = store.design;

  return (
    <div id="variables-panel">
      <div className="prop-section">
        <div className="prop-section-title">Materials</div>
        <p className="props-sub">
          A material here is a shared swatch: bind any front, wall, floor or worktop to one and they
          all change together when you edit it — a single colour or texture edit re-themes
          everything bound to it.
        </p>
        {design.variables.map((v) => (
          <VarCard key={v.id} v={v} />
        ))}
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => {
              store.addVariable();
              store.commit();
            }}
          >
            ＋ Add material
          </button>
        </div>
        {design.variables.length > 0 ? <DefaultVarRow /> : null}
      </div>
    </div>
  );
}

/** One variable: name, colour, material, texture rotation, bulk-apply, delete. */
function VarCard({ v }: { v: DesignVar }): ReactElement {
  const store = useStore();
  const name = useRef<HTMLInputElement>(null);

  useSyncedValue(name, v.name);
  useNativeChange(name, (el) => {
    store.updateVariable(v.id, { name: el.value.trim() || 'Variable' });
    store.commit();
  });

  // Rebinds every item's front colour slot to THIS variable (store.ts
  // applyVarToItems: `it.color = toVarRef(v.id)`) — a live link, not a
  // one-time paint, so the button says "Bind" and the hint already did.
  const bindAllFronts = (): void => {
    const n = store.applyVarToItems(v.id, 'front');
    store.commit();
    setHint(`Bound ${n} item${n === 1 ? '' : 's'} to "${v.name}"`);
  };

  return (
    <div className="var-item">
      <input className="var-name" type="text" spellCheck={false} defaultValue={v.name} ref={name} />
      <SwatchRow
        colors={FRONT_COLORS}
        current={v.color}
        onPick={(c) =>
          // picking a plain colour drops a colour-hiding texture so the colour shows
          store.updateVariable(
            v.id,
            overridesColor(v.material)
              ? { color: c, material: undefined, materialRot: undefined }
              : { color: c }
          )
        }
      />
      <MaterialRow
        mats={ITEM_MATERIALS}
        current={v.material}
        onPick={(id) => store.updateVariable(v.id, { material: id })}
        groupHeaders
      />
      <RotToggle
        matId={v.material}
        value={v.materialRot === true}
        onChange={(r) => store.updateVariable(v.id, { materialRot: r || undefined })}
      />
      <div className="btn-row">
        <button className="btn" onClick={bindAllFronts}>
          Bind all fronts
        </button>
        <button
          className="btn danger"
          onClick={() => {
            store.deleteVariable(v.id);
            store.commit();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** Which variable a newly placed item's front binds to. Only shown once one exists. */
function DefaultVarRow(): ReactElement {
  const store = useStore();
  const select = useRef<HTMLSelectElement>(null);
  const design = store.design;
  const current = design.defaultFrontVar ?? '';

  useSyncedValue(select, current);
  useNativeChange(select, (el) => {
    store.setDefaultVar('front', el.value || undefined);
    store.commit();
  });

  return (
    <div className="prop-row">
      <label>Default for new parts</label>
      <select defaultValue={current} ref={select}>
        <option value="">None</option>
        {design.variables.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </div>
  );
}
