import { useRef, type ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { useLiveValue, useSyncedValue } from './useLiveValue';
import { mixedValue, useMixedValue } from './useMixedValue';
import { useNativeChange } from './useNativeChange';

/**
 * What every numeric field takes. `items` + `read` instead of a bare value:
 * one field stands for the whole selection, which is one item today and any
 * number of them once T4 lands multi-select — see useMixedValue.ts.
 */
export interface FieldProps<T> {
  label: string;
  /** The items this field edits. */
  items: readonly T[];
  /** One item's value, in MODEL units (metres / radians). */
  read: (it: T) => number;
  /** The edited value, back in MODEL units. The field commits right after. */
  onCommit: (v: number) => void;
  /** `data-cls` hook the E2E suites select on (pos-x, rot, corner-y, …). */
  cls?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Follow the value mid-drag (the 'transient' channel). */
  live?: boolean;
  /** Flank the box with two buttons, inside a `.stepper` — the rotate row. */
  stepper?: StepperButtons;
}

/**
 * The two buttons of a stepper field. They act on the MODEL, not on the number
 * in the box (item rotation steps by a quarter turn from wherever it is), so
 * each side is a glyph, a tooltip and a handler that commits for itself.
 */
export interface StepperButtons {
  down: readonly [glyph: string, title: string];
  up: readonly [glyph: string, title: string];
  onDown: () => void;
  onUp: () => void;
}

interface NumericRowProps<T> extends FieldProps<T> {
  unit: string;
  /** model → the number in the box. */
  toDisplay: (v: number) => number;
  /** the number in the box → model. */
  fromDisplay: (v: number) => number;
}

/**
 * The shared body of NumberField / LengthField / AngleField — src/ui/ui.ts's
 * numberRow: `.prop-row` > label + `input[type=number]` + `span.unit`, with
 * min/max/data-cls emitted only when given and `step` defaulting to 1.
 *
 * The input stays UNCONTROLLED (useSyncedValue mirrors the model into it after
 * each render, useLiveValue during a drag) and commits on native change only —
 * a controlled React input would re-render the panel on every keystroke and
 * fight the caret.
 */
export function NumericRow<T>({
  label,
  items,
  read,
  onCommit,
  unit,
  cls,
  min,
  max,
  step,
  live,
  stepper,
  toDisplay,
  fromDisplay,
}: NumericRowProps<T>): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const { value, mixed } = useMixedValue(items, read);
  const shown = value === null ? '' : String(toDisplay(value));

  useLiveValue(
    input,
    live
      ? () => {
          const now = mixedValue(items, read);
          return now.value === null ? '' : String(toDisplay(now.value));
        }
      : null
  );
  useSyncedValue(input, shown);

  useNativeChange(input, (el) => {
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    onCommit(fromDisplay(v));
    store.commit();
  });

  const box = (
    <input
      type="number"
      defaultValue={shown}
      placeholder={mixed ? '—' : undefined}
      min={min}
      max={max}
      step={step ?? 1}
      data-cls={cls}
      ref={input}
    />
  );

  return (
    <div className="prop-row">
      <label>{label}</label>
      {stepper ? (
        <div className="stepper">
          <button title={stepper.down[1]} onClick={stepper.onDown}>
            {stepper.down[0]}
          </button>
          {box}
          <button title={stepper.up[1]} onClick={stepper.onUp}>
            {stepper.up[0]}
          </button>
        </div>
      ) : (
        box
      )}
      <span className="unit">{unit}</span>
    </div>
  );
}

/** A plain number in model units — counts, percentages, anything unitless. */
export function NumberField<T>(props: FieldProps<T> & { unit: string }): ReactElement {
  return <NumericRow {...props} toDisplay={(v) => v} fromDisplay={(v) => v} />;
}
