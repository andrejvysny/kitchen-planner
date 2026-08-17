import type { ReactElement } from 'react';
import { fromDeg, toDeg } from './convert';
import { NumericRow, type FieldProps } from './NumberField';

/**
 * An angle. The model holds radians, unbounded; this shows whole degrees
 * normalized to [0, 360) — src/ui/ui.ts's displayDeg, applied at the rotation
 * fields.
 */
export function AngleField<T>(props: FieldProps<T>): ReactElement {
  return <NumericRow {...props} unit="°" toDisplay={toDeg} fromDisplay={fromDeg} />;
}
