import { FRONT_COLORS, OAK } from './catalog';
import type {
  Board,
  CabinetPartDef,
  CustomPartDef,
  FreeformPartDef,
  Interior,
  Zone,
} from './types';

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

/** hanging section: rail at coat height with the hat shelf just above it */
const hangingInterior: Interior = {
  mode: 'custom',
  elements: [
    { kind: 'rail', y: 1.6 },
    { kind: 'shelf', y: 1.68 },
  ],
};

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
    {
      id: 'shelf-0',
      x: 0,
      y: 0,
      z: 0,
      w: 0.8,
      h: SHELF_T,
      d: 0.25,
      rotY: 0,
      shape: 'box',
      slot: 'front',
      style: 'plain',
    },
    {
      id: 'shelf-1',
      x: 0,
      y: 0.55 - SHELF_T,
      z: 0,
      w: 0.8,
      h: SHELF_T,
      d: 0.25,
      rotY: 0,
      shape: 'box',
      slot: 'front',
      style: 'plain',
    },
  ],
};

const DESK_TOP_T = 0.035;

/**
 * Desk board list: a top slab + 4 legs, plus (when `drawers` > 0) a
 * right-side pedestal with stacked drawer fronts. Freeform boards carry no
 * `motion` — the pedestal "fronts" below are decorative panels only, they
 * never open (unlike a real cabinet drawer built through the panel IR).
 */
function deskBoards(w: number, d: number, h: number, drawers: number): Board[] {
  const legH = h - DESK_TOP_T;
  const inset = 0.06;
  const boards: Board[] = [
    {
      id: 'top',
      x: 0,
      y: h - DESK_TOP_T,
      z: 0,
      w,
      h: DESK_TOP_T,
      d,
      rotY: 0,
      shape: 'box',
      slot: 'accent',
      style: 'plain',
    },
  ];
  let n = 0;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    boards.push({
      id: `leg-${n++}`,
      x: sx * (w / 2 - inset),
      y: 0,
      z: sz * (d / 2 - inset),
      w: 0.044,
      h: legH,
      d: 0.044,
      rotY: 0,
      shape: 'cyl',
      slot: 'front',
      style: 'plain',
      tint: 0.8,
    });
  }
  if (drawers > 0) {
    const pw = 0.4;
    const px = w / 2 - pw / 2 - 0.02;
    const pd = d - 0.04;
    boards.push({
      id: 'pedestal',
      x: px,
      y: 0,
      z: 0,
      w: pw,
      h: legH,
      d: pd,
      rotY: 0,
      shape: 'box',
      slot: 'front',
      style: 'plain',
    });
    const fh = (legH - 0.006 * (drawers + 1)) / drawers;
    for (let i = 0; i < drawers; i++) {
      boards.push({
        id: `dr-${i}`,
        x: px,
        y: 0.006 + i * (fh + 0.006),
        z: pd / 2 - 0.009,
        w: pw - 0.02,
        h: fh,
        d: 0.018,
        rotY: 0,
        shape: 'box',
        slot: 'front',
        style: 'front',
      });
    }
  }
  return boards;
}

const desk: FreeformPartDef = {
  id: 'desk',
  name: 'Desk',
  type: 'freeform',
  w: 1.4,
  d: 0.7,
  h: 0.75,
  elevation: 0,
  color: FRONT_COLORS[4],
  accentColor: OAK,
  boards: deskBoards(1.4, 0.7, 0.75, 0),
};

const deskWithDrawers: FreeformPartDef = {
  id: 'desk-drawers',
  name: 'Desk with drawers',
  type: 'freeform',
  w: 1.4,
  d: 0.7,
  h: 0.75,
  elevation: 0,
  color: FRONT_COLORS[4],
  accentColor: OAK,
  boards: deskBoards(1.4, 0.7, 0.75, 3),
};

export const PRESETS: PresetEntry[] = [
  {
    section: 'Kitchen · base units',
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
    section: 'Kitchen · base units',
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
    section: 'Kitchen · base units',
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
    section: 'Kitchen · tall units',
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
    section: 'Kitchen · wall units',
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
  { section: 'Kitchen · wall units', part: wallShelf },
  {
    section: 'Bedroom',
    part: cabinet({
      id: 'wardrobe',
      name: 'Wardrobe',
      w: 1.0,
      d: 0.6,
      h: 2.1,
      elevation: 0,
      color: FRONT_COLORS[0],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      // a counter slot would follow the room's kitchen worktop finish
      worktop: false,
      face: { kind: 'leaf', fill: 'doorPair', interior: hangingInterior },
    }),
  },
  {
    section: 'Bedroom',
    part: cabinet({
      id: 'wardrobe-wide',
      name: 'Wardrobe 180',
      w: 1.8,
      d: 0.6,
      h: 2.1,
      elevation: 0,
      color: FRONT_COLORS[0],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      // wide hanging section + a shelved single-door column
      face: {
        kind: 'split',
        dir: 'v',
        weights: [0.62, 0.38],
        children: [
          { kind: 'leaf', fill: 'doorPair', interior: hangingInterior },
          {
            kind: 'leaf',
            fill: 'door',
            hinge: 'right',
            interior: { mode: 'auto', shelves: 4, innerDrawers: 0 },
          },
        ],
      },
    }),
  },
  {
    section: 'Bedroom',
    part: cabinet({
      id: 'nightstand',
      name: 'Nightstand',
      w: 0.45,
      d: 0.4,
      h: 0.52,
      elevation: 0,
      color: FRONT_COLORS[1],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      face: { kind: 'leaf', fill: 'drawers', drawers: 2 },
    }),
  },
  {
    section: 'Bedroom',
    part: cabinet({
      id: 'dresser',
      name: 'Dresser',
      w: 1.0,
      d: 0.45,
      h: 0.8,
      elevation: 0,
      color: FRONT_COLORS[1],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      face: {
        kind: 'split',
        dir: 'v',
        weights: [1, 1],
        children: [
          { kind: 'leaf', fill: 'drawers', drawers: 3 },
          { kind: 'leaf', fill: 'drawers', drawers: 3 },
        ],
      },
    }),
  },
  {
    section: 'Living room',
    part: cabinet({
      id: 'tv-bench',
      name: 'TV bench',
      w: 1.6,
      d: 0.4,
      h: 0.45,
      elevation: 0,
      color: FRONT_COLORS[4],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      // doors flanking an open media bay
      face: {
        kind: 'split',
        dir: 'v',
        weights: [0.32, 0.36, 0.32],
        children: [
          { kind: 'leaf', fill: 'door', hinge: 'left' },
          { kind: 'leaf', fill: 'open', interior: { mode: 'auto', shelves: 1, innerDrawers: 0 } },
          { kind: 'leaf', fill: 'door', hinge: 'right' },
        ],
      },
    }),
  },
  {
    section: 'Living room',
    part: cabinet({
      id: 'bookcase',
      name: 'Bookcase',
      w: 0.8,
      d: 0.32,
      h: 1.9,
      elevation: 0,
      color: FRONT_COLORS[0],
      accentColor: OAK,
      footprint: { kind: 'rect' },
      plinth: true,
      worktop: false,
      face: { kind: 'leaf', fill: 'open', interior: { mode: 'auto', shelves: 4, innerDrawers: 0 } },
    }),
  },
  { section: 'Office', part: desk },
  { section: 'Office', part: deskWithDrawers },
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
