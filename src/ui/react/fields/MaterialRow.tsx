import { Fragment, useEffect, useRef, type ReactElement } from 'react';
import {
  GROUP_LABELS,
  materialInfo,
  titleFor,
  type MaterialGroup,
} from '../../../model/materialInfo';
import type { MaterialDef } from '../../../model/materials';
import { useStore } from '../services';
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
  /**
   * Insert a family header (Wood / Stone / Tile / …) whenever `mats`' group
   * changes. Only sensible where the array's groups run contiguously (the
   * curated lists mostly do); leave off a row where they don't, else a
   * family header would repeat further down the row.
   */
  groupHeaders?: boolean;
}

/**
 * Built-in PBR material chips + a "plain colour" chip — src/ui/ui.ts's
 * materialRow, same `.swatches` > `.swatch[title]` markup, now with named
 * chips (WS-SPEC Phase 4) and optional family headers for rows that mix wood/
 * stone/tile/glass/plastic.
 */
export function MaterialRow({
  mats,
  current,
  onPick,
  plainTitle = 'Plain colour',
  groupHeaders = false,
}: MaterialRowProps): ReactElement {
  let prevGroup: MaterialGroup | undefined;
  return (
    <div className="swatches">
      <Chip
        active={current === undefined}
        title={plainTitle}
        ariaLabel={plainTitle}
        onPick={() => onPick(undefined)}
      />
      {mats.map((m) => {
        const info = materialInfo(m.id);
        const showHeader = groupHeaders && !!info.group && info.group !== prevGroup;
        prevGroup = info.group;
        return (
          <Fragment key={m.id}>
            {showHeader && (
              <div className="swatch-group-label">{GROUP_LABELS[info.group as MaterialGroup]}</div>
            )}
            <Chip
              mat={m}
              active={current === m.id}
              title={titleFor(info)}
              ariaLabel={info.name}
              onPick={() => onPick(m.id)}
            />
          </Fragment>
        );
      })}
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
  ariaLabel,
  onPick,
}: {
  mat?: MaterialDef;
  active: boolean;
  title: string;
  ariaLabel: string;
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
      aria-label={ariaLabel}
      data-mat={mat?.id}
      ref={ref}
      onClick={() => {
        onPick();
        store.commit();
      }}
    ></button>
  );
}
