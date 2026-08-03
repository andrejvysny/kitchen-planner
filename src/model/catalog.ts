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
/** near-black recessed plinths (renderer + cut list agree through this) */
export const PLINTH_COLOR = '#26251f';

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
  | 'bed'
  | 'sofa'
  | 'tv'
  | 'rug'
  | 'officeChair'
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
  /** how the item places: 'wall' = backs up against walls, 'free' = never
   * snaps (islands, rugs, coffee tables). Declared explicitly by every new
   * def; legacy defs fall back to the kind list in `snapsToWall`. */
  placement?: 'wall' | 'free';
  /** appliances: mounting behaviour + host requirements */
  appliance?: ApplianceSpec;
  /**
   * Decorative / non-physical: lights, sockets, rugs, wall panels. Such items
   * legitimately share space with furniture, so the spatial checks
   * (src/model/checks.ts) skip them entirely. Declarative on purpose — the
   * checks engine never keeps its own kind list.
   */
  noCollide?: true;
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
        noCollide: true,
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
        noCollide: true,
      }),
    ],
  },
  // cabinet presets (src/model/presets.ts) render at the head of this section
  { title: 'Kitchen · base units', items: [] },
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
  { title: 'Kitchen · tall units', items: [] },
  {
    title: 'Kitchen · wall units',
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
        noCollide: true,
      }),
    ],
  },
  {
    // beds back onto a wall with their headboard: d is the sleeping LENGTH,
    // w the mattress width (the standard EU 90/140/160 sizes)
    title: 'Bedroom',
    items: [
      def({
        id: 'bed-single',
        kind: 'bed',
        label: 'Bed 90',
        w: 0.9,
        d: 2.0,
        h: 0.95,
        elevation: 0,
        color: OAK,
        params: [
          { key: 'pillows', label: 'Pillows', min: 1, max: 2, def: 1 },
          { key: 'drawers', label: 'Storage drawers', min: 0, max: 2, def: 0 },
        ],
        placement: 'wall',
      }),
      def({
        id: 'bed-double',
        kind: 'bed',
        label: 'Bed 140',
        w: 1.4,
        d: 2.0,
        h: 0.95,
        elevation: 0,
        color: OAK,
        params: [
          { key: 'pillows', label: 'Pillows', min: 1, max: 2, def: 2 },
          { key: 'drawers', label: 'Storage drawers', min: 0, max: 2, def: 0 },
        ],
        placement: 'wall',
      }),
      def({
        id: 'bed-queen',
        kind: 'bed',
        label: 'Bed 160',
        w: 1.52,
        d: 2.03,
        h: 1.0,
        elevation: 0,
        color: OAK,
        params: [
          { key: 'pillows', label: 'Pillows', min: 1, max: 2, def: 2 },
          { key: 'drawers', label: 'Storage drawers', min: 0, max: 2, def: 0 },
        ],
        placement: 'wall',
      }),
    ],
  },
  {
    title: 'Living room',
    items: [
      def({
        id: 'sofa',
        kind: 'sofa',
        label: 'Sofa',
        // 3 seats × 690 mm plus the arms — `seats` drives the width from there
        w: 2.07,
        d: 0.92,
        h: 0.82,
        elevation: 0,
        color: FRONT_COLORS[2],
        params: [{ key: 'seats', label: 'Seats', min: 2, max: 4, def: 3, widthPer: 0.69 }],
        placement: 'wall',
      }),
      def({
        id: 'armchair',
        kind: 'sofa',
        label: 'Armchair',
        // same builder, no seats param: the width alone derives a single seat
        w: 0.95,
        d: 0.9,
        h: 0.82,
        elevation: 0,
        color: FRONT_COLORS[4],
        placement: 'free',
      }),
      def({
        id: 'coffee-table',
        kind: 'table',
        label: 'Coffee table',
        w: 1.1,
        d: 0.6,
        h: 0.42,
        elevation: 0,
        color: OAK,
        placement: 'free',
      }),
      def({
        id: 'tv',
        kind: 'tv',
        label: 'TV',
        // a flat panel on a wall bracket: 55" screen, centre at eye height
        w: 1.24,
        d: 0.07,
        h: 0.72,
        elevation: 1.0,
        color: '#17181a',
        placement: 'wall',
      }),
      def({
        id: 'rug',
        kind: 'rug',
        label: 'Rug',
        // lies flat on the floor, never against a wall
        w: 2.0,
        d: 1.4,
        h: 0.012,
        elevation: 0,
        color: OAK,
        placement: 'free',
        noCollide: true,
      }),
    ],
  },
  {
    title: 'Office',
    items: [
      def({
        id: 'office-chair',
        kind: 'officeChair',
        label: 'Office chair',
        // free-standing swivel chair: never snaps to a wall
        w: 0.62,
        d: 0.62,
        h: 1.05,
        elevation: 0,
        color: FRONT_COLORS[4],
        placement: 'free',
      }),
    ],
  },
  {
    title: 'Dining & seating',
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
  // lighting closes the catalog: fixtures are the last pass over a room
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
        noCollide: true,
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
        noCollide: true,
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
        noCollide: true,
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

const sectionById = new Map<string, string>();
for (const s of CATALOG) for (const d of s.items) sectionById.set(d.id, s.title);

/** Catalog section title a built-in def renders under (shopping-list category). */
export function catalogSection(defId: string): string | undefined {
  return sectionById.get(defId);
}

export function defaultParams(def: CatalogDef): Record<string, number> | undefined {
  if (!def.params?.length) return undefined;
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.key] = p.def;
  return out;
}

/** True if the item should back up against walls when dragged near them. */
export function snapsToWall(def: CatalogDef): boolean {
  // data-driven first: a def (or part) that declares its placement decides
  if (def.placement) return def.placement === 'wall';
  // legacy defs that predate the field: everything snaps except loose furniture
  return !['table', 'chair', 'stool', 'pendant', 'spot', 'woodPlane'].includes(def.kind);
}

/**
 * Seats on a sofa: the `seats` param when the def carries one, else derived
 * from the width — an armchair has no param and must still read as 1 seat.
 * Shared by the 3D builder and the plan symbol so they never disagree.
 */
export function sofaSeats(w: number, seats?: number): number {
  const raw = seats ?? Math.max(1, Math.round((w - 0.26) / 0.62));
  return Math.max(1, Math.min(5, Math.round(raw)));
}

/** Markers, backsplash and the TV hug the wall face exactly (and need one). */
export function isWallMounted(def: CatalogDef): boolean {
  return def.marker || def.kind === 'backsplash' || def.kind === 'tv';
}

/**
 * Items that legitimately share space with furniture — light fixtures,
 * sockets, rugs, wall panels — and so take no part in collision checks. The
 * flag lives on the def (`noCollide`), never in a list inside the checks
 * engine; custom parts are physical by construction and never decorative.
 */
export function isDecorative(def: CatalogDef): boolean {
  return def.noCollide === true;
}

