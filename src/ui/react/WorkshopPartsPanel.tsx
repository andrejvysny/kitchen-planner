import type { ReactElement } from 'react';
import type { CustomPartDef } from '../../model/types';
import { PRESETS } from '../../model/presets';
import { openInWorkshop } from '../workspaceState';
import { useAppServices } from './services';
import { useChannel } from './hooks/useStore';

/**
 * Mirrors src/ui/partstudio/index.ts's TYPE_LABELS — not exported from there
 * (and partstudio/** is out of scope for this change), so duplicated here as
 * the same three literals rather than adding a shared module for three
 * strings.
 */
const TYPE_LABELS: Record<CustomPartDef['type'], string> = {
  cabinet: 'Cabinet',
  board: 'Worktop / board',
  freeform: 'Free boards',
};

/**
 * The Workshop workspace's sidebar: a flat list of editable parts instead of
 * the plan/furnish tab strip. "My parts" opens the user's own custom parts;
 * "Built-in presets" opens a preset (which forks into a custom part on save,
 * same as "Customize part…" in the props panel). Every row hands off through
 * `openInWorkshop` — the Workshop canvas pane itself lands in WP 1.6, so
 * clicking a row today only switches workspace + sets the target.
 */
export function WorkshopPartsPanel(): ReactElement {
  const { store } = useAppServices();
  useChannel('history'); // the parts library is design data
  useChannel('workspace');

  const parts = store.design.customParts;

  return (
    <div id="workshop-parts">
      <div className="cat-section">
        <div className="cat-title">My parts</div>
        <button id="wsp-new" className="btn" onClick={() => openInWorkshop(null)}>
          ＋ New part
        </button>
        {parts.length === 0 ? (
          <>
            <p className="cat-empty">
              Nothing here yet — start from a preset below or a blank part.
            </p>
            <p className="cat-empty">Cabinets here are fully yours — fronts, drawers, interiors.</p>
          </>
        ) : (
          parts.map((p) => (
            <button
              key={p.id}
              className="wsp-row"
              data-part-id={p.id}
              onClick={() => openInWorkshop(p.id)}
            >
              <span className="wsp-name">{p.name}</span>
              <span className="wsp-badge">{TYPE_LABELS[p.type]}</span>
            </button>
          ))
        )}
      </div>
      <div className="cat-section">
        <div className="cat-title">Built-in presets</div>
        {PRESETS.map((entry) => (
          <button
            key={entry.part.id}
            className="wsp-row wsp-preset"
            data-part-id={entry.part.id}
            onClick={() => openInWorkshop(entry.part.id)}
          >
            <span className="wsp-name">{entry.part.name}</span>
            <span className="wsp-badge">{TYPE_LABELS[entry.part.type]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
