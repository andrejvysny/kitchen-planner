import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react';
import { useAppServices } from './services';
import { CATALOG, type CatalogDef } from '../../model/catalog';
import { toCatalogDef } from '../../model/parts';
import { PRESETS } from '../../model/presets';
import type { CustomPartDef } from '../../model/types';
import { openInWorkshop, workspace } from '../workspaceState';
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
  const wsVersion = useChannel('workspace');

  const sig = JSON.stringify(store.design.customParts);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the dependency; store.design mutates in place
  const sections = useMemo(() => buildSections(store.design.customParts), [sig]);
  const armedId = editor.armedDefId;
  const ws = workspace();

  // workshop/output aren't wired to their own catalog view yet (WP 1.5) — show
  // furnish's set. plan sees ONLY plan-tagged sections; everything else
  // (including "My parts") is furnish.
  const visible = useMemo(
    () => sections.filter((s) => (ws === 'plan' ? s.workspace === 'plan' : s.workspace !== 'plan')),
    [sections, ws]
  );

  const [query, setQuery] = useState('');
  // clear the search on every workspace switch, not just a plan<->furnish flip
  useEffect(() => setQuery(''), [wsVersion]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return visible;
    const out: SectionView[] = [];
    for (const section of visible) {
      const tiles = section.tiles.filter((t) => t.def.label.toLowerCase().includes(q));
      if (tiles.length > 0) out.push({ ...section, newTile: false, tiles });
    }
    return out;
  }, [visible, q]);

  const noMatches = q.length > 0 && filtered.length === 0;

  return (
    <>
      <input
        id="catalog-search"
        type="search"
        placeholder="Search catalog"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {noMatches ? <div className="cat-empty">No matches — try a shorter word</div> : null}
      {filtered.map((section) => (
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
  /** which workspace's library shows this section; absent = 'furnish' (WS-SPEC §4.3) */
  workspace?: 'plan' | 'furnish';
}

/** part type → the order its tiles appear in "My parts": cabinets, wardrobes, boards, freeform. */
const PART_ORDER = { cabinet: 0, wardrobe: 1, board: 2, freeform: 3 };

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
    out.push({ title: section.title, newTile: false, tiles, workspace: section.workspace });
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

/** The one tile that places nothing: it opens the Workshop on a blank part. */
function NewPartTile(): ReactElement {
  const { plan } = useAppServices();
  const open = (): void => {
    // a live place tool would keep ghosting under the pane we are switching to
    plan.setArmed(null);
    openInWorkshop(null);
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
