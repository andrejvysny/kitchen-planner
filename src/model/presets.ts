import { FRONT_COLORS, OAK } from './catalog';
import type { CabinetPartDef, CustomPartDef, FreeformPartDef, Zone } from './types';

/**
 * Built-in cabinet presets: readonly part defs that replace the retired
 * hardcoded catalog kinds. They resolve through Store.partOf like user parts
 * (design-local custom parts deliberately shadow same-id presets) but are
 * never copied into a design or persisted — "Customize part…" forks a copy
 * into design.customParts when an instance needs its own layout.
 */

export interface PresetEntry {
  part: CustomPartDef;
  /** catalog section the preset tile renders under */
  section: string;
}

const door: Zone = { kind: 'leaf', fill: 'door' };

const cabinet = (p: Omit<CabinetPartDef, 'type'>): CabinetPartDef => ({ type: 'cabinet', ...p });

const SHELF_T = 0.028;

const wallShelf: FreeformPartDef = {
  id: 'wall-shelf',
  name: 'Open shelves',
  type: 'freeform',
  w: 0.8,
  d: 0.25,
  h: 0.55,
  elevation: 1.45,
  color: OAK,
  accentColor: OAK,
  boards: [
    { id: 'shelf-0', x: 0, y: 0, z: 0, w: 0.8, h: SHELF_T, d: 0.25, rotY: 0, shape: 'box', slot: 'front', style: 'plain' },
    { id: 'shelf-1', x: 0, y: 0.55 - SHELF_T, z: 0, w: 0.8, h: SHELF_T, d: 0.25, rotY: 0, shape: 'box', slot: 'front', style: 'plain' },
  ],
};

export const PRESETS: PresetEntry[] = [
  {
    section: 'Base units',
    part: cabinet({
      id: 'base-cabinet',
      name: 'Base cabinet',
      w: 0.6,
      d: 0.6,
      h: 0.9,
      elevation: 0,
      color: FRONT_COLORS[2],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: true,
      face: door,
    }),
  },
  {
    section: 'Base units',
    part: cabinet({
      id: 'base-drawers',
      name: 'Drawer unit',
      w: 0.6,
      d: 0.6,
      h: 0.9,
      elevation: 0,
      color: FRONT_COLORS[2],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: true,
      face: { kind: 'leaf', fill: 'drawers', drawers: 3 },
    }),
  },
  {
    section: 'Base units',
    part: cabinet({
      id: 'island',
      name: 'Island',
      w: 1.8,
      d: 0.9,
      h: 0.9,
      elevation: 0,
      color: FRONT_COLORS[0],
      accentColor: OAK,
      placement: 'free',
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: true,
      worktopOverhang: { front: 0.15, back: 0.03, sides: 0.03 },
      finishedBack: true,
      face: {
        kind: 'split',
        dir: 'v',
        weights: [1, 1, 1],
        children: [
          { kind: 'leaf', fill: 'drawers', drawers: 3 },
          { kind: 'leaf', fill: 'drawers', drawers: 3 },
          { kind: 'leaf', fill: 'drawers', drawers: 3 },
        ],
      },
    }),
  },
  {
    section: 'Tall units',
    part: cabinet({
      id: 'pantry',
      name: 'Tall cabinet',
      w: 0.6,
      d: 0.6,
      h: 2.2,
      elevation: 0,
      color: FRONT_COLORS[2],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      face: { kind: 'split', dir: 'h', weights: [0.62, 0.38], children: [door, door] },
    }),
  },
  {
    section: 'Wall units',
    part: cabinet({
      id: 'wall-cabinet',
      name: 'Wall cabinet',
      w: 0.6,
      d: 0.35,
      h: 0.7,
      elevation: 1.45,
      color: FRONT_COLORS[2],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: false,
      worktop: false,
      face: door,
    }),
  },
  { section: 'Wall units', part: wallShelf },
];

function deepFreeze(o: unknown): void {
  if (!o || typeof o !== 'object') return;
  Object.freeze(o);
  for (const v of Object.values(o)) deepFreeze(v);
}

const byId = new Map<string, CustomPartDef>();
for (const e of PRESETS) {
  byId.set(e.part.id, e.part);
  deepFreeze(e.part); // presets are shared: consumers must clone before editing
}

export function presetPart(id: string): CustomPartDef | undefined {
  return byId.get(id);
}

export function hasPreset(id: string): boolean {
  return byId.has(id);
}
