import { useRef, type ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { useNativeChange } from './useNativeChange';
import { useSyncedValue } from './useLiveValue';

export interface SwatchRowProps {
  /** Curated palette for this slot (FRONT_COLORS, WALL_COLORS, …). */
  colors: readonly string[];
  /** The slot's current colour, already resolved to a literal hex. */
  current: string;
  onPick: (c: string) => void;
}

/**
 * A palette row plus a free colour picker — src/ui/ui.ts's swatchRow, node for
 * node: `.swatches` > n × `.swatch[title]` + one `<input type="color">`.
 *
 * The picker commits on the native change event (the OS dialog's confirm), the
 * swatches on click; both then `store.commit()`, exactly as the helper did.
 */
export function SwatchRow({ colors, current, onPick }: SwatchRowProps): ReactElement {
  const picker = useRef<HTMLInputElement>(null);

  useSyncedValue(picker, current);
  useNativeChange(picker, (el) => {
    onPick(el.value);
    store.commit();
  });

  const pick = (c: string): void => {
    onPick(c);
    store.commit();
  };

  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c}
          className={current.toLowerCase() === c.toLowerCase() ? 'swatch active' : 'swatch'}
          style={{ background: c }}
          title={c}
          onClick={() => pick(c)}
        ></button>
      ))}
      <input
        type="color"
        defaultValue={current}
        title="Custom colour"
        ref={picker}
        style={{
          width: 26,
          height: 26,
          border: 'none',
          borderRadius: '50%',
          padding: 0,
          background: 'none',
          cursor: 'pointer',
        }}
      />
    </div>
  );
}
