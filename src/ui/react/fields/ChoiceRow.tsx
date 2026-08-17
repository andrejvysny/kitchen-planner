import type { ReactElement } from 'react';
import { store } from '../../../app/bootstrap';

export interface ChoiceRowProps {
  /** [value, label] pairs, in display order. */
  options: readonly (readonly [string, string])[];
  current: string;
  onPick: (v: string) => void;
}

/**
 * Segmented choice — src/ui/ui.ts's choiceRow: `.btn-row` > n × `button.btn`,
 * the active one carrying `.active`.
 *
 * The helper patched its own `.active` class after a click "so no re-render is
 * needed"; that workaround exists because the panel it lived in was rebuilt by
 * hand. Here `current` is a prop read live off the design, and the commit below
 * bumps the 'history' channel the owning panel subscribes to — so the class
 * follows the model instead of guessing at it.
 */
export function ChoiceRow({ options, current, onPick }: ChoiceRowProps): ReactElement {
  return (
    <div className="btn-row">
      {options.map(([value, label]) => (
        <button
          key={value}
          className={value === current ? 'btn active' : 'btn'}
          onClick={() => {
            onPick(value);
            store.commit();
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
