import { useEffect, useRef, type ReactElement } from 'react';
import { useStore } from '../services';
import type { MaterialDef } from '../../../model/materials';
import { materialSwatch } from '../../../view3d/textures';

/** The "no texture" chip: a diagonal split, as ui.ts's materialRow drew it. */
const PLAIN_BG = 'linear-gradient(135deg,#fff 44%,#b9bdc0 44%,#b9bdc0 56%,#fff 56%)';

export interface MaterialRowProps {
  /** Curated chips for this surface (ITEM_MATERIALS, WALL_MATERIALS, …). */
  mats: readonly MaterialDef[];
  /** Active material id; undefined = the plain-colour chip. */
  current?: string;
  onPick: (id?: string) => void;
  plainTitle?: string;
}

/**
 * Built-in PBR material chips + a "plain colour" chip — src/ui/ui.ts's
 * materialRow, same `.swatches` > `.swatch[title]` markup.
 */
export function MaterialRow({
  mats,
  current,
  onPick,
  plainTitle = 'Plain colour',
}: MaterialRowProps): ReactElement {
  return (
    <div className="swatches">
      <Chip active={current === undefined} title={plainTitle} onPick={() => onPick(undefined)} />
      {mats.map((m) => (
        <Chip
          key={m.id}
          mat={m}
          active={current === m.id}
          title={m.label}
          onPick={() => onPick(m.id)}
        />
      ))}
    </div>
  );
}

/**
 * One chip. The preview is a real canvas painted by the texture module, then
 * inlined as a background image — the chip is 26 px of border-radius, so a
 * background is all it can be. Done in a ref effect rather than during render
 * because materialSwatch() touches `document`.
 */
function Chip({
  mat,
  active,
  title,
  onPick,
}: {
  mat?: MaterialDef;
  active: boolean;
  title: string;
  onPick: () => void;
}): ReactElement {
  const store = useStore();
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cnv = mat ? materialSwatch(mat.id, 52) : null;
    el.style.background = mat ? (cnv ? `url(${cnv.toDataURL()})` : mat.color) : PLAIN_BG;
    el.style.backgroundSize = 'cover';
  }, [mat]);

  return (
    <button
      className={active ? 'swatch active' : 'swatch'}
      title={title}
      ref={ref}
      onClick={() => {
        onPick();
        store.commit();
      }}
    ></button>
  );
}
