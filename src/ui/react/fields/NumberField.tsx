import { useRef, type KeyboardEvent, type ReactElement } from 'react';
import { useStore } from '../services';
import { useLiveValue, useSyncedValue } from './useLiveValue';
import { mixedValue, useMixedValue } from './useMixedValue';
import { useNativeChange } from './useNativeChange';

/**
 * What every numeric field takes. `items` + `read` instead of a bare value:
 * one field stands for the whole selection, which is one item today and any
 * number of them once multi-select lands — see useMixedValue.ts.
 */
export interface FieldProps<T> {
  label: string;
  /** The items this field edits. */
  items: readonly T[];
  /** One item's value, in MODEL units (metres / radians). */
  read: (it: T) => number;
  /** The edited value, back in MODEL units, already clamped to min/max. */
  onCommit: (v: number) => void;
  /** `data-cls` hook the E2E suites select on (pos-x, rot, corner-y, …). */
  cls?: string;
  /**
   * Bounds in MODEL units — metres, radians — NOT in whatever the box shows.
   * A `type=text` box has no browser-side range to lean on and the display
   * unit is a preference, so the field clamps here and the numbers stay true
   * whichever unit the user reads them in.
   */
  min?: number;
  max?: number;
  /** One ArrowUp/Down press, in the unit the box SHOWS. Shift multiplies by ten. */
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
  /** Suffix in `span.unit`, and the value of the `data-unit` hook. */
  unit: string;
  /** model → the string in the box. */
  format: (v: number) => string;
  /** what the user typed → model units, or null when it means nothing. */
  parse: (s: string) => number | null;
}

/**
 * The shared body of NumberField / LengthField / AngleField — src/ui/ui.ts's
 * numberRow, grown up: `.prop-row` > label + box + `span.unit`.
 *
 * The box is `type=text` with `inputMode=decimal`, not `type=number`, and that
 * is the whole point of the unit switch: the value is an EXPRESSION in the
 * user's unit ('600-18*2', '1.2m', '45cm'), parsed by src/model/units.ts, and
 * a number spinner cannot hold one. What the browser used to do for free is
 * re-implemented here and only here — clamping (min/max are model units now),
 * ArrowUp/Down stepping, and rejecting nonsense — so every field in the app
 * behaves the same way.
 *
 * `data-unit` marks a box as one of these fields; test/interact.mjs selects on
 * it, and it carries the unit actually being shown.
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
  format,
  parse,
}: NumericRowProps<T>): ReactElement {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const { value, mixed } = useMixedValue(items, read);
  const shown = value === null ? '' : format(value);

  /** The model's own value, read fresh — the design is mutated in place. */
  const current = (): string => {
    const now = mixedValue(items, read);
    return now.value === null ? '' : format(now.value);
  };

  useLiveValue(input, live ? current : null);
  useSyncedValue(input, shown);

  const commit = (m: number): number => {
    let v = m;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onCommit(v);
    store.commit();
    return v;
  };

  useNativeChange(input, (el) => {
    const m = parse(el.value);
    // nonsense in, nothing out: put the model's own value back rather than
    // leave the box holding a string that means nothing
    if (m === null) {
      el.value = current();
      return;
    }
    commit(m);
  });

  /**
   * ArrowUp/Down, in DISPLAY units — what a `type=number` spinner did before.
   * The box is written back by hand: it still holds the caret, and
   * useSyncedValue refuses to write into a focused field on purpose.
   */
  const nudge = (dir: number, big: boolean): void => {
    const now = mixedValue(items, read);
    if (now.value === null) return;
    const from = Number(format(now.value));
    if (!Number.isFinite(from)) return;
    const m = parse(String(from + dir * (step ?? 1) * (big ? 10 : 1)));
    if (m === null) return;
    const applied = commit(m);
    if (input.current) input.current.value = format(applied);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); // a text box would move the caret instead
    nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
  };

  const box = (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      defaultValue={shown}
      placeholder={mixed ? '—' : undefined}
      data-unit={unit}
      data-cls={cls}
      onKeyDown={onKeyDown}
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
  return (
    <NumericRow
      {...props}
      format={(v) => String(v)}
      parse={(s) => {
        const n = Number(s.trim());
        return s.trim() !== '' && Number.isFinite(n) ? n : null;
      }}
    />
  );
}
