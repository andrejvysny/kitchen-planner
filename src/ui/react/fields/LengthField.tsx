import type { ReactElement } from 'react';
import { fromCm, toCm } from './convert';
import { NumericRow, type FieldProps } from './NumberField';

/**
 * A length. The model holds metres; this shows whole centimetres, which is
 * what src/ui/ui.ts's numberRow call sites did by hand at every one of them
 * (`Math.round(m * 100)` out, `v / 100` back).
 *
 * T4 swaps this body for src/model/units.ts — a `type=text` box taking mm/cm/m
 * and arithmetic ('600-18*2'), formatted per the unit prefs. That is a visible
 * change and gets its own commit; T3 keeps the cm box exactly as it is so the
 * port itself changes nothing on screen.
 */
export function LengthField<T>(props: FieldProps<T>): ReactElement {
  return <NumericRow {...props} unit="cm" toDisplay={toCm} fromDisplay={fromCm} />;
}
