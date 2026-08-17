import { type KeyboardEvent, type ReactElement } from 'react';
import { useStore } from '../services';
import type { Warning } from '../../../model/checks';

export interface ChecksSectionProps {
  /** Already filtered by the caller — the room panel takes them all, an item its own. */
  list: readonly Warning[];
  /** The item the panel is about, so a row jumps to the OTHER party of a clash. */
  exceptId?: string;
  /** Show at most this many, then a "+N more" tail. */
  cap?: number;
}

/**
 * The advisory findings, as a list of rows — src/ui/ui.ts's checksSection.
 * Nothing renders when there is nothing to say, so a clean design's panel is
 * untouched. Clicking a row jumps to the other item involved (or the first
 * one, from the room panel), which is the fastest way to see what a clash is
 * with.
 *
 * The severity dot is the whole contract: the planner warns, never blocks (see
 * CLAUDE.md), and `sev-error`/`sev-warn`/`sev-info` are what style.css colours.
 */
export function ChecksSection({ list, exceptId, cap }: ChecksSectionProps): ReactElement | null {
  if (!list.length) return null;
  const shown = cap ? list.slice(0, cap) : list;

  return (
    <div className="prop-section">
      <div className="prop-section-title">Checks</div>
      {shown.map((w) => (
        <CheckRow key={w.id} w={w} exceptId={exceptId} />
      ))}
      {shown.length < list.length ? (
        <div className="ol-empty">{`+${list.length - shown.length} more`}</div>
      ) : null}
    </div>
  );
}

/** One finding. Only rows whose target still exists are focusable buttons. */
function CheckRow({ w, exceptId }: { w: Warning; exceptId?: string }): ReactElement {
  const store = useStore();
  const target = w.itemIds.find((id) => id !== exceptId) ?? w.itemIds[0];
  const pickable = !!target && !!store.itemById(target);
  const pick = (): void => store.select({ kind: 'item', id: target });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  };

  return (
    <div
      className="ol-row check-row"
      role={pickable ? 'button' : undefined}
      tabIndex={pickable ? 0 : undefined}
      onClick={pickable ? pick : undefined}
      onKeyDown={pickable ? onKeyDown : undefined}
    >
      <span className={`check-dot sev-${w.severity}`}></span>
      <span className="check-text">
        <span className="check-title">{w.title}</span>
        <span className="check-detail">{w.detail}</span>
      </span>
    </div>
  );
}
