import type { LightProps } from './types';

/**
 * Palette derived from the reference kitchens: matte two-tone fronts
 * (white / cream / sage / navy / graphite) paired with warm oak.
 */
export const FRONT_COLORS = ['#f2f1ec', '#e6dfd0', '#8a9683', '#31455a', '#3f4447', '#c9a87c'];
export const STEEL = '#b9bdc0';
export const OAK = '#c9a87c';
export const WALNUT = '#8b6748';
export const APPLIANCE_BLACK = '#1d1f22';

export const FLOOR_COLORS = ['#cfccc6', '#d9c4a0', '#b7b4ad', '#8f8b83', '#e3e0da'];
export const WALL_COLORS = ['#f4f1ea', '#e9e4d8', '#dfe4de', '#d8dee3', '#efe2d2'];
export const COUNTER_COLORS = ['#c9a87c', '#e8e5de', '#3a3835', '#8b6748', '#f2f1ec'];
/** fixture light colours: warm white → neutral → cool → amber / tints */
export const LIGHT_COLORS = ['#ffb46b', '#ffd9a0', '#fff4e0', '#ffffff', '#dfeaff', '#ff7a3c', '#7ec8ff'];

export type ItemKind =
  | 'baseCabinet'
  | 'baseDrawers'
  | 'sink'
  | 'hob'
  | 'oven'
  | 'dishwasher'
  | 'island'
  | 'fridge'
  | 'pantry'
  | 'ovenTower'
  | 'wallCabinet'
  | 'shelf'
  | 'hood'
  | 'backsplash'
  | 'table'
  | 'chair'
  | 'stool'
  | 'woodPlane'
  | 'pendant'
  | 'spot'
  | 'strip'
  | 'door'
  | 'window'
  | 'water'
  | 'outlet'
  | 'custom';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
}

export interface CatalogDef {
  id: string;
  kind: ItemKind;
  label: string;
  w: number;
  d: number;
  h: number;
  elevation: number;
  color: string;
  /** which dimensions the user may edit, with [min, max] in meters */
  resize: { w?: [number, number]; d?: [number, number]; h?: [number, number] };
  elevAdjust?: [number, number];
  /** integer options like number of drawers or doors */
  params?: ParamDef[];
  /** base units carry a countertop slab on top */
  counter?: boolean;
  light?: LightProps & { kind: 'point' | 'spot' | 'bar' };
  /** door/window pseudo-items are placed into walls, not on the floor */
  opening?: boolean;
  /** small utility markers (water, outlet) mounted on walls */
  marker?: boolean;
}

export interface CatalogSection {
  title: string;
  items: CatalogDef[];
}

const def = (d: CatalogDef) => d;

export const CATALOG: CatalogSection[] = [
  {
    title: 'Room & utilities',
    items: [
      def({
        id: 'door',
        kind: 'door',
        label: 'Door',
        w: 0.9,
        d: 0.1,
        h: 2.05,
        elevation: 0,
        color: '#e8e2d5',
        resize: { w: [0.6, 1.8], h: [1.8, 2.4] },
        opening: true,
      }),
      def({
        id: 'window',
        kind: 'window',
        label: 'Window',
        w: 1.2,
        d: 0.1,
        h: 1.2,
        elevation: 0.9,
        color: '#ffffff',
        resize: { w: [0.4, 3.0], h: [0.4, 2.0] },
        opening: true,
      }),
      def({
        id: 'water',
        kind: 'water',
        label: 'Water supply',
        w: 0.2,
        d: 0.06,
        h: 0.25,
        elevation: 0.45,
        color: '#4f81a8',
        resize: {},
        marker: true,
      }),
      def({
        id: 'outlet',
        kind: 'outlet',
        label: 'Power outlet',
        w: 0.15,
        d: 0.03,
        h: 0.15,
        elevation: 1.05,
        color: '#f2f1ec',
        resize: {},
        elevAdjust: [0.2, 1.6],
        marker: true,
      }),
    ],
  },
  {
    title: 'Base units',
    items: [
      def({
        id: 'base-cabinet',
        kind: 'baseCabinet',
        label: 'Base cabinet',
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { w: [0.3, 1.2] },
        params: [{ key: 'doors', label: 'Doors', min: 1, max: 2, def: 1 }],
        counter: true,
      }),
      def({
        id: 'base-drawers',
        kind: 'baseDrawers',
        label: 'Drawer unit',
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { w: [0.3, 1.2] },
        params: [{ key: 'drawers', label: 'Drawers', min: 2, max: 4, def: 3 }],
        counter: true,
      }),
      def({
        id: 'base-sink',
        kind: 'sink',
        label: 'Sink unit',
        w: 0.8,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { w: [0.6, 1.2] },
        params: [{ key: 'bowls', label: 'Bowls', min: 1, max: 2, def: 1 }],
        counter: true,
      }),
      def({
        id: 'base-hob',
        kind: 'hob',
        label: 'Hob unit',
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { w: [0.6, 0.9] },
        params: [{ key: 'burners', label: 'Zones', min: 2, max: 5, def: 4 }],
        counter: true,
      }),
      def({
        id: 'base-oven',
        kind: 'oven',
        label: 'Oven unit',
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: {},
        counter: true,
      }),
      def({
        id: 'dishwasher',
        kind: 'dishwasher',
        label: 'Dishwasher',
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: STEEL,
        resize: {},
        counter: true,
      }),
      def({
        id: 'island',
        kind: 'island',
        label: 'Island',
        w: 1.8,
        d: 0.9,
        h: 0.9,
        elevation: 0,
        color: FRONT_COLORS[0],
        resize: { w: [0.9, 3.0], d: [0.6, 1.4] },
        params: [{ key: 'drawers', label: 'Front drawers', min: 0, max: 4, def: 3 }],
        counter: true,
      }),
    ],
  },
  {
    title: 'Tall units',
    items: [
      def({
        id: 'fridge',
        kind: 'fridge',
        label: 'Fridge / freezer',
        w: 0.7,
        d: 0.7,
        h: 1.9,
        elevation: 0,
        color: STEEL,
        resize: { h: [1.4, 2.2] },
      }),
      def({
        id: 'pantry',
        kind: 'pantry',
        label: 'Tall cabinet',
        w: 0.6,
        d: 0.6,
        h: 2.2,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { w: [0.4, 1.2], h: [1.8, 2.5] },
        params: [{ key: 'split', label: 'Sections', min: 1, max: 3, def: 2 }],
      }),
      def({
        id: 'oven-tower',
        kind: 'ovenTower',
        label: 'Appliance tower',
        w: 0.6,
        d: 0.6,
        h: 2.2,
        elevation: 0,
        color: FRONT_COLORS[2],
        resize: { h: [1.8, 2.5] },
        params: [{ key: 'appliances', label: 'Appliances', min: 1, max: 3, def: 2 }],
      }),
    ],
  },
  {
    title: 'Wall units',
    items: [
      def({
        id: 'wall-cabinet',
        kind: 'wallCabinet',
        label: 'Wall cabinet',
        w: 0.6,
        d: 0.35,
        h: 0.7,
        elevation: 1.45,
        color: FRONT_COLORS[2],
        resize: { w: [0.3, 1.6], h: [0.35, 1.3] },
        elevAdjust: [0.9, 2.1],
        params: [{ key: 'doors', label: 'Doors', min: 1, max: 3, def: 1 }],
      }),
      def({
        id: 'wall-shelf',
        kind: 'shelf',
        label: 'Open shelves',
        w: 0.8,
        d: 0.25,
        h: 0.55,
        elevation: 1.45,
        color: OAK,
        resize: { w: [0.4, 2.0] },
        elevAdjust: [0.9, 2.0],
        params: [{ key: 'shelves', label: 'Shelves', min: 1, max: 3, def: 2 }],
      }),
      def({
        id: 'hood',
        kind: 'hood',
        label: 'Range hood',
        w: 0.6,
        d: 0.45,
        h: 0.45,
        elevation: 1.55,
        color: APPLIANCE_BLACK,
        resize: { w: [0.5, 0.9] },
        elevAdjust: [1.35, 1.8],
      }),
      def({
        id: 'backsplash',
        kind: 'backsplash',
        label: 'Backsplash panel',
        w: 1.2,
        d: 0.02,
        h: 0.55,
        elevation: 0.9,
        color: OAK,
        resize: { w: [0.3, 4.0], h: [0.3, 1.5] },
        elevAdjust: [0.8, 1.2],
      }),
    ],
  },
  {
    title: 'Lighting',
    items: [
      def({
        id: 'pendant',
        kind: 'pendant',
        label: 'Pendant lamp',
        w: 0.35,
        d: 0.35,
        h: 0.3,
        elevation: 1.85,
        color: '#3f3e3b',
        resize: {},
        elevAdjust: [1.2, 2.3],
        light: { kind: 'point', on: true, intensity: 0.7, warmth: 0.75 },
      }),
      def({
        id: 'spot',
        kind: 'spot',
        label: 'Ceiling spot',
        w: 0.12,
        d: 0.12,
        h: 0.04,
        elevation: 2.5,
        color: '#e8e6e1',
        resize: {},
        light: { kind: 'spot', on: true, intensity: 0.7, warmth: 0.55 },
      }),
      def({
        id: 'strip',
        kind: 'strip',
        label: 'LED strip',
        w: 0.6,
        d: 0.05,
        h: 0.03,
        elevation: 1.42,
        color: '#f4f2ea',
        resize: { w: [0.3, 3.0] },
        elevAdjust: [0.05, 2.2],
        light: { kind: 'bar', on: true, intensity: 0.55, warmth: 0.7 },
      }),
    ],
  },
  {
    title: 'Furniture',
    items: [
      def({
        id: 'table',
        kind: 'table',
        label: 'Dining table',
        w: 1.4,
        d: 0.8,
        h: 0.75,
        elevation: 0,
        color: OAK,
        resize: { w: [0.7, 2.4], d: [0.6, 1.2] },
      }),
      def({
        id: 'chair',
        kind: 'chair',
        label: 'Chair',
        w: 0.45,
        d: 0.48,
        h: 0.85,
        elevation: 0,
        color: '#f2f1ec',
        resize: {},
      }),
      def({
        id: 'stool',
        kind: 'stool',
        label: 'Bar stool',
        w: 0.38,
        d: 0.38,
        h: 0.68,
        elevation: 0,
        color: OAK,
        resize: {},
      }),
      def({
        id: 'wood-plane',
        kind: 'woodPlane',
        label: 'Wood plane',
        // a plain wooden slab, freely usable — tabletop, shelf, board, riser.
        // every dimension is freeform in the props panel and the texture is
        // swappable via the material picker.
        w: 1.0,
        d: 0.6,
        h: 0.04,
        elevation: 0,
        color: OAK,
        resize: { w: [0.05, 4.0], d: [0.05, 4.0], h: [0.01, 2.6] },
        elevAdjust: [0, 2.5],
      }),
    ],
  },
];

const byId = new Map<string, CatalogDef>();
for (const s of CATALOG) for (const d of s.items) byId.set(d.id, d);

export function catalogDef(id: string): CatalogDef {
  const d = byId.get(id);
  if (!d) throw new Error(`Unknown catalog id: ${id}`);
  return d;
}

export function hasCatalogDef(id: string): boolean {
  return byId.has(id);
}

export function defaultParams(def: CatalogDef): Record<string, number> | undefined {
  if (!def.params?.length) return undefined;
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.def;
  return out;
}

/** True if the item should back up against walls when dragged near them. */
export function snapsToWall(def: CatalogDef): boolean {
  return !['table', 'chair', 'stool', 'pendant', 'spot', 'island', 'woodPlane'].includes(def.kind);
}

/** Markers and backsplash hug the wall face exactly. */
export function isWallMounted(def: CatalogDef): boolean {
  return def.marker || def.kind === 'backsplash';
}

/** True if the builder tops the item with a counter slab (worktop finish applies). */
export function hasWorktop(def: CatalogDef): boolean {
  return ['baseCabinet', 'baseDrawers', 'sink', 'hob', 'oven', 'dishwasher', 'island'].includes(def.kind);
}
