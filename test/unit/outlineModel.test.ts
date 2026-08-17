import { describe, expect, it } from 'vitest';
import type { CatalogDef } from '../../src/model/catalog';
import type { Design, Item, Opening, Room, Selection } from '../../src/model/types';
import { outlineGroups, type OutlineData, type OutlineSource } from '../../src/ui/outlineModel';

/**
 * The components outline's grouping rules, pinned without a DOM.
 *
 * `outlineGroups` reads a structural subset of the Store, so the source below
 * is a plain literal: the point of the module is that the grouping is decided
 * by data, not by whatever the app happens to hold. The defId → group map it
 * builds is the REAL one (CATALOG + PRESETS), so the membership assertions
 * below break if a catalog section is renamed — which is the whole idea.
 */

const room = (id: string, name: string): Room =>
  ({ id, name, corners: [], style: {} }) as unknown as Room;

const item = (id: string, defId: string): Item => ({ id, defId }) as Item;

const opening = (id: string, type: 'door' | 'window'): Opening =>
  ({ id, type, wallId: 'w', offset: 1, width: 0.9, height: 2, sill: 0 }) as Opening;

/** label/kind per defId; anything unlisted resolves as a plain non-custom def. */
function source(
  parts: Partial<Design> & { rooms: Room[] },
  opts: {
    selection?: Selection;
    activeRoomId?: string;
    defs?: Record<string, { kind: string; label: string }>;
  } = {}
): OutlineSource {
  const design = { openings: [], items: [], ...parts } as Design;
  return {
    design,
    selection: opts.selection ?? { kind: 'none' },
    activeRoomId: opts.activeRoomId ?? parts.rooms[0]?.id,
    defOf: (defId) =>
      (opts.defs?.[defId] ?? { kind: 'cabinet', label: defId }) as Pick<
        CatalogDef,
        'kind' | 'label'
      >,
    floorArea: (roomId) => (roomId === parts.rooms[0]?.id ? 12 : 9),
  };
}

const titles = (data: OutlineData): string[] => data.groups.map((g) => g.title);

describe('outlineGroups', () => {
  it('reports the rooms even when the design holds nothing else', () => {
    const data = outlineGroups(
      source({ rooms: [room('r1', 'Kitchen'), room('r2', 'Bedroom')] }, { activeRoomId: 'r2' })
    );
    expect(data.total).toBe(0);
    expect(data.groups).toEqual([]);
    expect(data.roomRows).toEqual([
      { id: 'r1', name: 'Kitchen', area: 12, active: false },
      { id: 'r2', name: 'Bedroom', area: 9, active: true },
    ]);
  });

  it('counts items and openings together, and rooms not at all', () => {
    const data = outlineGroups(
      source({
        rooms: [room('r1', 'Kitchen'), room('r2', 'Bedroom')],
        items: [item('i1', 'base-cabinet'), item('i2', 'fridge')],
        openings: [opening('o1', 'door')],
      })
    );
    expect(data.total).toBe(3);
  });

  it('lists a base cabinet under its catalog section, not under "My parts"', () => {
    // presets read as kind 'custom', so the defId map has to win over the kind
    const data = outlineGroups(
      source(
        { rooms: [room('r1', 'Kitchen')], items: [item('i1', 'base-cabinet')] },
        { defs: { 'base-cabinet': { kind: 'custom', label: 'Base cabinet' } } }
      )
    );
    expect(data.groups).toEqual([
      {
        title: 'Kitchen · base units',
        rows: [
          {
            id: 'i1',
            label: 'Base cabinet',
            sel: { kind: 'item', id: 'i1' },
            active: false,
          },
        ],
      },
    ]);
  });

  it('files a design-local custom part under "My parts"', () => {
    const data = outlineGroups(
      source(
        { rooms: [room('r1', 'Kitchen')], items: [item('i1', 'part_abc')] },
        { defs: { part_abc: { kind: 'custom', label: 'Oak sideboard' } } }
      )
    );
    expect(titles(data)).toEqual(['My parts']);
    expect(data.groups[0].rows[0].label).toBe('Oak sideboard');
  });

  it('puts every opening in "Doors & windows", labelled by type', () => {
    const data = outlineGroups(
      source({
        rooms: [room('r1', 'Kitchen')],
        openings: [opening('o1', 'window'), opening('o2', 'door')],
      })
    );
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].title).toBe('Doors & windows');
    expect(data.groups[0].rows.map((r) => r.label)).toEqual(['Window', 'Door']);
    expect(data.groups[0].rows.map((r) => r.sel)).toEqual([
      { kind: 'opening', id: 'o1' },
      { kind: 'opening', id: 'o2' },
    ]);
  });

  it('orders known groups by the catalog, openings first', () => {
    const data = outlineGroups(
      source({
        rooms: [room('r1', 'Kitchen')],
        // deliberately reversed against the display order
        items: [item('i1', 'pendant'), item('i2', 'fridge'), item('i3', 'base-cabinet')],
        openings: [opening('o1', 'door')],
      })
    );
    expect(titles(data)).toEqual([
      'Doors & windows',
      'Kitchen · base units',
      'Appliances',
      'Lighting',
    ]);
  });

  it('sorts unknown groups alphabetically after every known one', () => {
    const data = outlineGroups(
      source(
        {
          rooms: [room('r1', 'Kitchen')],
          items: [
            item('i1', 'zebra'),
            item('i2', 'base-cabinet'),
            item('i3', 'aardvark'),
            item('i4', 'mongoose'),
          ],
        },
        {
          // an id in neither CATALOG nor PRESETS, and not custom → 'Other'
          defs: {
            zebra: { kind: 'sofa', label: 'Zebra' },
            aardvark: { kind: 'sofa', label: 'Aardvark' },
            mongoose: { kind: 'custom', label: 'Mongoose' },
          },
        }
      )
    );
    // 'My parts' is a KNOWN group (it ends OUTLINE_ORDER); 'Other' is the leftover
    expect(titles(data)).toEqual(['Kitchen · base units', 'My parts', 'Other']);
    expect(data.groups[2].rows.map((r) => r.label)).toEqual(['Zebra', 'Aardvark']);
  });

  it('marks the selected row, and only that one', () => {
    const data = outlineGroups(
      source(
        {
          rooms: [room('r1', 'Kitchen')],
          items: [item('i1', 'base-cabinet'), item('i2', 'base-cabinet')],
          openings: [opening('o1', 'door')],
        },
        { selection: { kind: 'item', id: 'i2' } }
      )
    );
    expect(data.groups.flatMap((g) => g.rows.map((r) => [r.id, r.active]))).toEqual([
      ['o1', false],
      ['i1', false],
      ['i2', true],
    ]);
  });

  it('marks a selected opening the same way', () => {
    const data = outlineGroups(
      source(
        { rooms: [room('r1', 'Kitchen')], openings: [opening('o1', 'door')] },
        { selection: { kind: 'opening', id: 'o1' } }
      )
    );
    expect(data.groups[0].rows[0].active).toBe(true);
  });
});
