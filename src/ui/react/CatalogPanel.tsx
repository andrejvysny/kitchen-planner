import { useMemo, type KeyboardEvent, type ReactElement } from 'react';
import { useAppServices } from './services';
import { CATALOG, type CatalogDef } from '../../model/catalog';
import { toCatalogDef } from '../../model/parts';
import { PRESETS } from '../../model/presets';
import type { CustomPartDef } from '../../model/types';
import { CatalogTile } from './CatalogTile';
import { useChannel } from './hooks/useStore';

/**
 * The Library tab: every placeable def, in catalog sections, plus the user's
 * own parts. Ported from src/ui/ui.ts renderCatalog node for node — same
 * `.cat-section` / `.cat-title` / `.cat-grid` frame, same tile order, same
 * "My parts" position.
 *
 * The old code guarded a full innerHTML rebuild behind a JSON signature of
 * `design.customParts` (renderCatalogIfPartsChanged). That signature survives,
 * with a different job: it keys the useMemo that builds the section list, so
 * every def object below keeps its identity until the parts library actually
 * moves — which is what lets <CatalogTile/>'s memo skip the thumbnail redraw
 * on the 'editor' ticks that arming causes.
 */
export function CatalogPanel(): ReactElement {
  const { store, editor } = useAppServices();
  useChannel('history'); // the parts library is design data
  useChannel('editor'); // which tile wears `.armed`

  const sig = JSON.stringify(store.design.customParts);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the dependency; store.design mutates in place
  const sections = useMemo(() => buildSections(store.design.customParts), [sig]);
  const armedId = editor.armedDefId;

  return (
    <>
      {sections.map((section) => (
        <div className="cat-section" key={section.title}>
          <div className="cat-title">{section.title}</div>
          <div className="cat-grid">
            {section.newTile ? <NewPartTile /> : null}
            {section.tiles.map((t) => (
              <CatalogTile
                key={t.def.id}
                def={t.def}
                editable={t.editable}
                armed={armedId === t.def.id}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

interface TileView {
  def: CatalogDef;
  editable: boolean;
}

interface SectionView {
  title: string;
  /** "My parts" leads with the ＋ New part tile, which is not a def */
  newTile: boolean;
  tiles: TileView[];
}

/** part type → the order its tiles appear in "My parts": cabinets, boards, freeform. */
const PART_ORDER = { cabinet: 0, board: 1, freeform: 2 };

function buildSections(parts: readonly CustomPartDef[]): SectionView[] {
  const out: SectionView[] = [];
  let first = true;
  for (const section of CATALOG) {
    const tiles: TileView[] = [];
    // built-in cabinet presets lead their sections; legacy defs follow
    for (const e of PRESETS) {
      if (e.section === section.title) tiles.push({ def: toCatalogDef(e.part), editable: false });
    }
    for (const def of section.items) tiles.push({ def, editable: false });
    out.push({ title: section.title, newTile: false, tiles });
    if (first) {
      first = false;
      // "My parts" right after the room tools: create → sketch → furnish
      const sorted = [...parts].sort((a, b) => PART_ORDER[a.type] - PART_ORDER[b.type]);
      out.push({
        title: 'My parts',
        newTile: true,
        tiles: sorted.map((part) => ({ def: toCatalogDef(part), editable: true })),
      });
    }
  }
  return out;
}

/** The one tile that places nothing: it opens the Part Studio on a blank part. */
function NewPartTile(): ReactElement {
  const { plan, studio } = useAppServices();
  const open = (): void => {
    // a live place tool would keep ghosting under the modal
    plan.setArmed(null);
    studio.open();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  return (
    <div
      className="cat-item cat-new"
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
    >
      <span style={{ fontSize: '20px' }}>＋</span>
      <span>New part</span>
    </div>
  );
}
