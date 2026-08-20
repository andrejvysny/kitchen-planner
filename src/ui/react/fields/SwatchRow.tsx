import { useRef, type ReactElement } from 'react';
import { materialInfo, titleFor } from '../../../model/materialInfo';
import { useStore } from '../services';
import { useNativeChange } from './useNativeChange';
import { useSyncedValue } from './useLiveValue';

export interface SwatchRowProps {
  /** Curated palette for this slot (FRONT_COLORS, WALL_COLORS, …). */
  colors: readonly string[];
  /** The slot's current colour, already resolved to a literal hex. */
  current: string;
  onPick: (c: string) => void;
  /** Name of the variable this slot is bound to, if any — shown in the caption. */
  boundTo?: string;
}

/**
 * A palette row plus a free colour picker — src/ui/ui.ts's swatchRow, node for
 * node: `.swatches` > n × `.swatch[title]` + one `<input type="color">`, plus
 * a caption line naming the current swatch (WS-SPEC Phase 4: a colour is a
 * named thing, not just a hex). `data-hex` carries the literal value for
 * tests/tooling that need it regardless of its display name.
 *
 * The picker commits on the native change event (the OS dialog's confirm), the
 * swatches on click; both then `store.commit()`, exactly as the helper did.
 */
export function SwatchRow({ colors, current, onPick, boundTo }: SwatchRowProps): ReactElement {
  const store = useStore();
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

  const currentInfo = materialInfo(current);
  const caption = boundTo ? `${currentInfo.name} · ${boundTo}` : currentInfo.name;

  return (
    <div className="swatch-row">
      <div className="swatches">
        {colors.map((c) => {
          const info = materialInfo(c);
          return (
            <button
              key={c}
              className={current.toLowerCase() === c.toLowerCase() ? 'swatch active' : 'swatch'}
              style={{ background: c }}
              title={titleFor(info)}
              aria-label={info.name}
              data-hex={c.toLowerCase()}
              onClick={() => pick(c)}
            ></button>
          );
        })}
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
      <div className="swatch-caption">{caption}</div>
    </div>
  );
}
