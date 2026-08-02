import type { LightProps } from './types';

/**
 * Palette derived from the reference interiors: matte two-tone fronts
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

/**
 * Cabinets live in src/model/presets.ts as zone-tree part defs; the catalog
 * keeps only openings, appliances (until they become attachable components),
 * loose furniture, lighting and wall markers.
 */
export type ItemKind =
  | 'sink'
  | 'hob'
  | 'oven'
  | 'dishwasher'
  | 'fridge'
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

/**
 * How an appliance mounts and what it takes out of its host: counter
 * appliances cut a hole in the host worktop, zone appliances need an
 * 'appliance' niche of at least the given size. Appliances are BOUGHT
 * products — their meshes stay bespoke builders and never enter panel lists;
 * only their cutouts/niches touch the manufacturing truth.
 */
export interface ApplianceSpec {
  mount: 'counter' | 'zone' | 'wall' | 'floor';
  /** counter: worktop cutout size (m) */
  cutout?: { w: number; d: number };
  /** zone: minimum niche the product fits into */
  niche?: { minW: number; minH: number };
}

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  /** if set, changing this param drives item width to value × widthPer (m) —
   * e.g. each socket gang extends the outlet box by one 80 mm cell */
  widthPer?: number;
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
  /** integer options like number of drawers or doors */
  params?: ParamDef[];
  light?: LightProps & { kind: 'point' | 'spot' | 'bar' };
  /** door/window pseudo-items are placed into walls, not on the floor */
  opening?: boolean;
  /** small utility markers (water, outlet) mounted on walls */
  marker?: boolean;
  /** 'free' = never snaps to walls (from the part def, e.g. islands) */
  placement?: 'free';
  /** appliances: mounting behaviour + host requirements */
  appliance?: ApplianceSpec;
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
        marker: true,
      }),
      def({
        id: 'outlet',
        kind: 'outlet',
        // EU Type E (CEE 7/5) — the Slovak standard: round recessed socket
        // with a protruding earth pin. Faceplate is a standard 80 mm square;
        // `gangs` widens it into a multi-socket box.
        label: 'Power outlet (EU)',
        w: 0.086,
        d: 0.035,
        h: 0.086,
        elevation: 1.05,
        color: '#f2f1ec',
        params: [{ key: 'gangs', label: 'Sockets', min: 1, max: 4, def: 1, widthPer: 0.086 }],
        marker: true,
      }),
    ],
  },
  // cabinet presets (src/model/presets.ts) render at the head of this section
  { title: 'Base units', items: [] },
  {
    title: 'Appliances',
    items: [
      def({
        id: 'appl-sink',
        kind: 'sink',
        label: 'Sink',
        // mounts INTO a worktop: the basin hangs into the cutout, the faucet
        // rises above; h is the above-counter part
        w: 0.56,
        d: 0.5,
        h: 0.05,
        elevation: 0.9,
        color: STEEL,
        params: [{ key: 'bowls', label: 'Bowls', min: 1, max: 2, def: 1 }],
        appliance: { mount: 'counter', cutout: { w: 0.5, d: 0.4 } },
      }),
      def({
        id: 'appl-hob',
        kind: 'hob',
        label: 'Hob',
        w: 0.58,
        d: 0.51,
        h: 0.05,
        elevation: 0.9,
        color: APPLIANCE_BLACK,
        params: [{ key: 'burners', label: 'Zones', min: 2, max: 5, def: 4 }],
        appliance: { mount: 'counter', cutout: { w: 0.54, d: 0.47 } },
      }),
      def({
        id: 'appl-oven',
        kind: 'oven',
        label: 'Oven',
        // slots into an 'appliance' niche of a cabinet; the niche sizes it
        w: 0.56,
        d: 0.55,
        h: 0.58,
        elevation: 0.6,
        color: APPLIANCE_BLACK,
        appliance: { mount: 'zone', niche: { minW: 0.5, minH: 0.55 } },
      }),
      def({
        id: 'appl-micro',
        kind: 'oven',
        label: 'Microwave / compact',
        w: 0.56,
        d: 0.5,
        h: 0.36,
        elevation: 1.0,
        color: APPLIANCE_BLACK,
        appliance: { mount: 'zone', niche: { minW: 0.5, minH: 0.34 } },
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
        appliance: { mount: 'floor' },
      }),
      def({
        id: 'fridge',
        kind: 'fridge',
        label: 'Fridge / freezer',
        w: 0.7,
        d: 0.7,
        h: 1.9,
        elevation: 0,
        color: STEEL,
        appliance: { mount: 'floor' },
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
        appliance: { mount: 'wall' },
      }),
    ],
  },
  { title: 'Tall units', items: [] },
  {
    title: 'Wall units',
    items: [
      def({
        id: 'backsplash',
        kind: 'backsplash',
        label: 'Backsplash panel',
        w: 1.2,
        d: 0.02,
        h: 0.55,
        elevation: 0.9,
        color: OAK,
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
  if (def.placement === 'free') return false;
  return !['table', 'chair', 'stool', 'pendant', 'spot', 'woodPlane'].includes(def.kind);
}

/** Markers and backsplash hug the wall face exactly. */
export function isWallMounted(def: CatalogDef): boolean {
  return def.marker || def.kind === 'backsplash';
}

