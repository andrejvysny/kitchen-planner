import { CATALOG, type CatalogDef } from '../model/catalog';
import { PRESETS } from '../model/presets';
import { emptySelection, isSelected, type SelectionState } from '../editor/selection';
import type { Design, Selection } from '../model/types';

/**
 * The components outline, as DATA. Everything the Components tab shows —
 * which rooms lead it, which group a placed object lands in, what order the
 * groups come in and how many rows each holds — is decided here, so
 * src/ui/react/OutlinePanel.tsx is a dumb renderer and the grouping rules are
 * unit-testable without a DOM.
 *
 * Pure by contract: no React, no document, no Store import. The one input is
 * an `OutlineSource`, a structural subset of Store's read surface that a test
 * can satisfy with an object literal.
 */

/** defId → catalog section title, so placed items list under the same type group they were placed from. */
const CATALOG_GROUP = new Map<string, string>();
for (const s of CATALOG) for (const d of s.items) CATALOG_GROUP.set(d.id, s.title);
for (const e of PRESETS) CATALOG_GROUP.set(e.part.id, e.section);

/** Display order of the components-outline groups. */
const OUTLINE_ORDER = ['Doors & windows', ...CATALOG.map((s) => s.title), 'My parts'];

/** One selectable object: an item or an opening. */
export interface OutlineRow {
  /** the selected object's id — stable, so React can key on it */
  id: string;
  label: string;
  sel: Selection;
  active: boolean;
}

export interface OutlineGroup {
  title: string;
  rows: OutlineRow[];
}

/** A room row carries its own area, since the Rooms group doubles as the room switcher. */
export interface OutlineRoomRow {
  id: string;
  name: string;
  /** m², already resolved — the renderer only formats it */
  area: number;
  active: boolean;
}

export interface OutlineData {
  roomRows: OutlineRoomRow[];
  groups: OutlineGroup[];
  /** placed components; rooms are the container, not content */
  total: number;
}

/**
 * What the outline reads off the app state. `Store` satisfies this
 * structurally — pass it straight in — and so does a hand-built stub.
 */
export interface OutlineSource {
  readonly design: Design;
  readonly activeRoomId: string;
  /** THROWS on an id that resolves nowhere; sanitizeDesign guarantees it cannot happen */
  defOf(defId: string): Pick<CatalogDef, 'kind' | 'label'>;
  floorArea(roomId: string): number;
}

/**
 * Group every opening and item of the design, in display order.
 *
 * The selection arrives as a SEPARATE argument since M18: it belongs to the
 * editor, not the store, and a row is "active" when the selection HOLDS it —
 * which is already the multi-selection question, not a single-id compare.
 */
export function outlineGroups(
  src: OutlineSource,
  selection: SelectionState = emptySelection()
): OutlineData {
  const groups = new Map<string, OutlineRow[]>();
  const add = (group: string, row: OutlineRow) => {
    const list = groups.get(group) ?? (groups.set(group, []).get(group) as OutlineRow[]);
    list.push(row);
  };

  for (const o of src.design.openings) {
    add('Doors & windows', {
      id: o.id,
      label: o.type === 'door' ? 'Door' : 'Window',
      sel: { kind: 'opening', id: o.id },
      active: isSelected(selection, { kind: 'opening', id: o.id }),
    });
  }
  for (const it of src.design.items) {
    const def = src.defOf(it.defId);
    // preset ids group under their catalog section, not "My parts" —
    // checked first because presets also read as kind 'custom'
    const group = CATALOG_GROUP.get(it.defId) ?? (def.kind === 'custom' ? 'My parts' : 'Other');
    add(group, {
      id: it.id,
      label: def.label,
      sel: { kind: 'item', id: it.id },
      active: isSelected(selection, { kind: 'item', id: it.id }),
    });
  }

  // known groups in catalog order, then any leftover ('Other') alphabetically
  const known = OUTLINE_ORDER.filter((g) => groups.has(g));
  const extra = [...groups.keys()].filter((g) => !OUTLINE_ORDER.includes(g)).sort();
  const ordered: OutlineGroup[] = [];
  for (const title of [...known, ...extra]) {
    const rows = groups.get(title);
    if (rows?.length) ordered.push({ title, rows });
  }

  return {
    roomRows: src.design.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      area: src.floorArea(r.id),
      active: r.id === src.activeRoomId,
    })),
    groups: ordered,
    total: src.design.items.length + src.design.openings.length,
  };
}
