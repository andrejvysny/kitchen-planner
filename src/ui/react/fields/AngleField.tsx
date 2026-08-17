import type { ReactElement } from 'react';
import { formatAngle, parseAngle } from '../../../model/units';
import { wrapAngle } from './convert';
import { NumericRow, type FieldProps } from './NumberField';

/**
 * An angle. The model holds radians, unbounded; the box shows degrees wrapped
 * into [0, 360) — src/ui/ui.ts's displayDeg, now composed out of units.ts's
 * own formatter so degrees are parsed by the same expression engine lengths
 * are ('90+45' is a rotation).
 *
 * Degrees never carry a unit suffix, which is exactly what `parseAngle` is:
 * the same parser with units switched off, so a stray 'mm' is rejected rather
 * than silently swallowed.
 */
export function AngleField<T>(props: FieldProps<T>): ReactElement {
  return (
    <NumericRow
      {...props}
      unit="°"
      format={(rad) => formatAngle(wrapAngle(rad))}
      parse={parseAngle}
    />
  );
}
