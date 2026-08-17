import type { ReactElement } from 'react';
import { useStore } from '../services';

export interface StepperRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}

/**
 * −/value/+ stepper — src/ui/ui.ts's parametric-option row: `.prop-row` >
 * label + `.stepper` > button + span + button. For small integer counts
 * (shelves, seats) where a number box would be more typing than the edit is
 * worth.
 *
 * The ±1 is clamped here, exactly as the helper's `apply()` clamped it, so a
 * caller never has to re-state a param's own limits.
 */
export function StepperRow({ label, value, min, max, onChange }: StepperRowProps): ReactElement {
  const store = useStore();

  const step = (d: number): void => {
    onChange(Math.min(max, Math.max(min, value + d)));
    store.commit();
  };

  return (
    <div className="prop-row">
      <label>{label}</label>
      <div className="stepper">
        <button onClick={() => step(-1)}>−</button>
        <span>{value}</span>
        <button onClick={() => step(1)}>+</button>
      </div>
    </div>
  );
}
