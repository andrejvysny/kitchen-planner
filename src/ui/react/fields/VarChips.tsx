import type { ReactElement } from 'react';
import { useStore } from '../services';
import { isVarRef, refId, toVarRef } from '../../../model/variables';

export interface VarChipsProps {
  /** The slot's raw value — a `var:<id>` ref lights its chip. */
  current: string;
  onBind: (ref: string) => void;
}

/**
 * Design-variable binding chips, rendered ABOVE a colour swatch row: picking a
 * chip binds the slot to that variable (`var:<id>`), picking a literal swatch
 * afterwards detaches it. Nothing renders when the design has no variables.
 *
 * src/ui/ui.ts's varChips, node for node. The list is read straight off the
 * store like the helper did, so a caller only passes the slot it edits.
 */
export function VarChips({ current, onBind }: VarChipsProps): ReactElement | null {
  const store = useStore();
  const vars = store.design.variables;
  if (!vars.length) return null;

  return (
    <div className="swatches var-chips">
      {vars.map((v) => {
        const active = isVarRef(current) && refId(current) === v.id;
        return (
          <button
            key={v.id}
            className={active ? 'var-chip active' : 'var-chip'}
            title={`Bind to variable "${v.name}"`}
            onClick={() => {
              onBind(toVarRef(v.id));
              store.commit();
            }}
          >
            <span className="dot" style={{ background: v.color }}></span>
            {v.name}
          </button>
        );
      })}
    </div>
  );
}
