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

  return (
    <div className="prop-row">
      <label>{label}</label>
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
      <span className="unit">{unit}</span>
    </div>
  );
}

/** A plain number in model units — counts, percentages, anything unitless. */
export function NumberField<T>(props: FieldProps<T> & { unit: string }): ReactElement {
  return <NumericRow {...props} toDisplay={(v) => v} fromDisplay={(v) => v} />;
}
