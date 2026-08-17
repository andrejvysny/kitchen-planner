import { useEffect, useRef, useState, type ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { useNativeChange } from './useNativeChange';
import { useSyncedValue } from './useLiveValue';

export interface SliderRowProps {
  label: string;
  value: number;
  /** Fired live, per input event — for a slider that IS the point. */
  onInput: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Renders the readout span when given; ui.ts's sliderRow omitted it otherwise. */
  fmt?: (v: number) => string;
}

/**
 * A range slider — src/ui/ui.ts's sliderRow, and THE ONE SANCTIONED EXCEPTION
 * to the commit rule in useNativeChange.ts.
 *
 * A slider drags: the model has to follow the thumb, so the live `input` event
 * (React spells it `onChange` for a range) drives `onInput`, which callers wire
 * to a NON-structural, uncommitted store mutation. The undo step is still taken
 * once, from the native `change` at the end of the drag — same split ui.ts had.
 */
export function SliderRow({
  label,
  value,
  onInput,
  min = 0,
  max = 1,
  step = 0.01,
  fmt,
}: SliderRowProps): ReactElement {
  const range = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(value);

  useSyncedValue(range, String(value));
  useEffect(() => {
    if (document.activeElement !== range.current) setShown(value);
  }, [value]);

  useNativeChange(range, () => store.commit());

  return (
    <div className="prop-row">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={value}
        ref={range}
        // eslint-disable-next-line no-restricted-syntax -- the sanctioned live-input case; see the doc comment
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          setShown(v);
          onInput(v);
        }}
      />
      {fmt ? <span className="unit slider-val">{fmt(shown)}</span> : null}
    </div>
  );
}
