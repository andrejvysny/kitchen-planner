import { useRef, type ReactElement } from 'react';
import { store } from '../../app/bootstrap';
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
 * The Variables tab: create / edit / delete the design's finish tokens, and
 * pick the one new items are born bound to.
 *
 * Ported from src/ui/ui.ts renderVariablesSection node for node — same section,
 * same `.var-item` cards, same labels and hint text. What changes is only HOW
 * it stays current: ui.ts rebuilt the panel's DOM on every 'history' and needed
 * an isEditingVariableName guard so a rebuild would not yank the name field out
 * from under the caret. Here React reconciles instead, the name input is
 * uncontrolled, and useSyncedValue refuses to write into a focused field — so
 * the guard has nothing left to protect and is gone.
 *
 * Every mutation below is a store call followed by `store.commit()`, exactly as
 * the helper had it: variables are design data, so each edit is one undo step.
 */
export function VariablesPanel(): ReactElement {
  useChannel('history');
  const design = store.design;

  return (
    <div id="variables-panel">
      <div className="prop-section">
        <div className="prop-section-title">Variables</div>
        <p className="props-sub">
          Named colours &amp; textures — bind cabinets, walls, floor or worktops to one so a single
          edit re-themes them all.
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
            ＋ Add variable
          </button>
        </div>
        {design.variables.length > 0 ? <DefaultVarRow /> : null}
      </div>
    </div>
  );
}

/** One variable: name, colour, material, texture rotation, bulk-apply, delete. */
function VarCard({ v }: { v: DesignVar }): ReactElement {
  const name = useRef<HTMLInputElement>(null);

  useSyncedValue(name, v.name);
  useNativeChange(name, (el) => {
    store.updateVariable(v.id, { name: el.value.trim() || 'Variable' });
    store.commit();
  });

  const applyToFronts = (): void => {
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
      />
      <RotToggle
        matId={v.material}
        value={v.materialRot === true}
        onChange={(r) => store.updateVariable(v.id, { materialRot: r || undefined })}
      />
      <div className="btn-row">
        <button className="btn" onClick={applyToFronts}>
          Apply to all fronts
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
      <label>New items use</label>
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
