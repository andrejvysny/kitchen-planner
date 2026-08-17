import type { ReactElement } from 'react';
import { unitPrefs } from '../../../model/prefs';
import { formatLength, parseLength } from '../../../model/units';
import { useChannel } from '../hooks/useStore';
import { NumericRow, type FieldProps } from './NumberField';

/**
 * A length. The model holds metres; the box shows — and reads — the user's
 * unit, mm by default (src/model/prefs.ts), through src/model/units.ts.
 *
 * That parser is the point: a length field takes an EXPRESSION, so '600-18*2'
 * is a valid cabinet width and '1.2m' is valid in a millimetre box. Bare
 * numbers are read as the preferred unit; a suffix overrides it. Nothing here
 * multiplies by 100 any more — units.ts is the single conversion authority
 * (CLAUDE.md), and this component is the seam it plugs into.
 *
 * The preference is a module singleton with its own change event, bridged onto
 * the 'units' channel, so switching mm→cm reformats every open field.
 */
export function LengthField<T>(props: FieldProps<T>): ReactElement {
  useChannel('units');
  const prefs = unitPrefs();

  return (
    <NumericRow
      {...props}
      unit={prefs.unit}
      format={(m) => formatLength(m, prefs)}
      parse={(s) => parseLength(s, prefs)}
    />
  );
}
