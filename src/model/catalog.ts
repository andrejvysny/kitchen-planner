import { styleOfItem } from './rooms';
import type { Design, Item, LightProps } from './types';

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
export const LIGHT_COLORS = [
  '#ffb46b',
  '#ffd9a0',
  '#fff4e0',
  '#ffffff',
  '#dfeaff',
  '#ff7a3c',
  '#7ec8ff',
];

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
  | 'decor'
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

/**
 * Set dressing — the silhouette family a decor item is drawn from.
 *
 * ONE `ItemKind` covers all of them on purpose: a kind decides PLACEMENT
 * semantics (does it hug a wall, does it collide, can it host), and every
 * decor object answers those identically. What differs is the shape, which is
 * data on the def, exactly as `appliance` and `light` already are. Twenty
 * kinds would mean twenty builders and twenty plan-symbol cases for no gain.
 */
export type DecorForm =
  /** lathed body of revolution: kettle, jar, canister, vase, bottle */
  | 'vessel'
  /** shallow lathed dish, optionally with contents: fruit bowl, plate stack */
  | 'bowl'
  /** a jittered pile of slabs: books, magazines, folded boards */
  | 'stack'
  /** tapered pot + foliage mass: floor plant, tabletop pot, herbs */
  | 'plant'
  /** open rod lattice: dish rack, wire basket, utensil crock */
  | 'rack'
  /** soft folded textile: tea towel, throw, cushion */
  | 'cloth'
  /** thin upright or lying slab: picture frame, tray, cutting board */
  | 'frame'
  /** tapered open box with a rim: crate, storage box, laundry basket */
  | 'basket';

export interface DecorSpec {
  form: DecorForm;
  /** what this belongs on. `planStaging` reads it; hand placement ignores it. */
  rest: 'counter' | 'shelf' | 'floor' | 'table' | 'any';
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
  light?: LightProps & {
    kind: 'point' | 'spot' | 'bar';
    /** item-local source position; overrides lightLocalY (custom parts) */
    local?: { y: number; z?: number };
  };
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
  /**
   * Procedural set dressing: which silhouette to draw and what it rests on.
   * Every def carrying this must also be `kind: 'decor'`, `placement: 'free'`,
   * `noCollide: true` and `staging: true` — pinned by decor.test.ts.
   *
   * Note what it must NOT carry: an `appliance` spec. `Plan2D.placeArmed`
   * refuses to place a `mount: 'counter'` def when no host is under the
   * cursor, which would make a mug unplaceable anywhere but a worktop.
   */
  decor?: DecorSpec;
  /**
   * Staging, not procurement: this item appears on NO export list — not the
   * cut list, not the shopping list, not the printed item schedule.
   *
   * Deliberately a separate flag from `noCollide`, which answers a different
   * question. A rug is `noCollide` and IS bought; folding the two together
   * would silently drop it from the shopping list.
   */
  staging?: true;
}

export interface CatalogSection {
  title: string;
  items: CatalogDef[];
  /** which workspace's library shows this section; absent = 'furnish' (WS-SPEC §4.3) */
  workspace?: 'plan' | 'furnish';
}

const def = (d: CatalogDef) => d;

/**
 * A set-dressing entry. Every decor def carries the same five fields, so they
 * are written once here rather than repeated (and eventually mis-typed) two
 * dozen times: `kind: 'decor'` · `placement: 'free'` · `noCollide: true` ·
 * `staging: true` · a `decor` spec.
 *
 * `placement: 'free'` is not cosmetic. `throughWallChecks` does NOT skip
 * decorative items, and it reports `error` severity — a red 3D tint — for
 * anything `snapsToWall`; free placement is what downgrades a tea towel
 * nudged against a wall to an advisory.
 */
const dec = (
  id: string,
  label: string,
  form: DecorForm,
  rest: DecorSpec['rest'],
  w: number,
  d: number,
  h: number,
  color: string,
  params?: ParamDef[]
): CatalogDef => ({
  id,
  kind: 'decor',
  label,
  w,
  d,
  h,
  elevation: 0,
  color,
  placement: 'free',
  noCollide: true,
  staging: true,
  decor: { form, rest },
  ...(params ? { params } : {}),
});

export const CATALOG: CatalogSection[] = [
  {
    title: 'Room & utilities',
    workspace: 'plan',
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
  // hallway-unit preset (src/model/presets.ts) renders at the head of this section
  { title: 'Hallway', items: [] },
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
  /**
   * Set dressing. APPENDED, never inserted: CatalogPanel injects "My parts"
   * after catalog section index 0, and outlineModel derives OUTLINE_ORDER from
   * this array's order, so a section added at the front silently moves both.
   *
   * Every entry here carries the same five fields — see `DecorSpec`.
   */
  {
    title: 'Decor · kitchen',
    items: [
      dec('decor-kettle', 'Kettle', 'vessel', 'counter', 0.16, 0.16, 0.24, '#2f3336', [
        { key: 'neck', label: 'Taper', min: 6, max: 10, def: 9 },
      ]),
      dec('decor-jars', 'Storage jar', 'vessel', 'counter', 0.11, 0.11, 0.19, '#d9d2c4', [
        { key: 'neck', label: 'Taper', min: 2, max: 10, def: 7 },
      ]),
      dec('decor-fruit-bowl', 'Fruit bowl', 'bowl', 'counter', 0.28, 0.28, 0.1, '#e6e2d8', [
        { key: 'fill', label: 'Fruit', min: 0, max: 9, def: 5 },
      ]),
      dec('decor-dish-rack', 'Dish rack', 'rack', 'counter', 0.4, 0.3, 0.16, '#b6babd', [
        { key: 'bars', label: 'Tines', min: 4, max: 12, def: 8 },
      ]),
      dec('decor-board', 'Chopping board', 'frame', 'counter', 0.34, 0.06, 0.26, '#b98a52', [
        { key: 'lean', label: 'Lean', min: 4, max: 16, def: 9 },
      ]),
      dec('decor-tea-towel', 'Tea towel', 'cloth', 'counter', 0.22, 0.16, 0.05, '#8fa7a3', [
        { key: 'folds', label: 'Folds', min: 1, max: 5, def: 3 },
      ]),
      dec('decor-crock', 'Utensil crock', 'vessel', 'counter', 0.13, 0.13, 0.17, '#5c5f57', [
        { key: 'neck', label: 'Taper', min: 8, max: 10, def: 10 },
      ]),
      dec('decor-oil', 'Oil bottle', 'vessel', 'counter', 0.08, 0.08, 0.26, '#7a6a3f', [
        { key: 'neck', label: 'Taper', min: 2, max: 5, def: 2 },
      ]),
      dec('decor-mugs', 'Mugs', 'vessel', 'counter', 0.09, 0.09, 0.1, '#e4e0d6', [
        { key: 'neck', label: 'Taper', min: 8, max: 10, def: 10 },
      ]),
      dec('decor-plates', 'Plate stack', 'stack', 'counter', 0.24, 0.24, 0.09, '#eceae3', [
        { key: 'count', label: 'Plates', min: 2, max: 8, def: 5 },
      ]),
      dec('decor-bread-bin', 'Bread bin', 'basket', 'counter', 0.32, 0.22, 0.2, '#cbbfa8', [
        { key: 'taper', label: 'Taper', min: 0, max: 2, def: 0 },
      ]),
      dec('decor-wire-basket', 'Wire basket', 'rack', 'counter', 0.26, 0.2, 0.12, '#b6babd', [
        { key: 'bars', label: 'Wires', min: 4, max: 10, def: 6 },
      ]),
    ],
  },
  {
    title: 'Decor · living',
    items: [
      dec('decor-books', 'Book stack', 'stack', 'shelf', 0.16, 0.22, 0.14, '#7b5e4a', [
        { key: 'count', label: 'Books', min: 1, max: 8, def: 4 },
      ]),
      dec('decor-vase', 'Vase', 'vessel', 'shelf', 0.14, 0.14, 0.28, '#6f7d74', [
        { key: 'neck', label: 'Taper', min: 2, max: 10, def: 4 },
      ]),
      dec('decor-frame', 'Picture frame', 'frame', 'shelf', 0.18, 0.05, 0.23, '#4a4340', [
        { key: 'lean', label: 'Lean', min: 4, max: 16, def: 10 },
        { key: 'mount', label: 'Mount', min: 0, max: 1, def: 1 },
      ]),
      dec('decor-plant', 'Floor plant', 'plant', 'floor', 0.42, 0.42, 0.95, '#9c6b4f', [
        { key: 'pot', label: 'Pot height', min: 2, max: 6, def: 4 },
        { key: 'leaves', label: 'Foliage', min: 2, max: 9, def: 5 },
      ]),
      dec('decor-pot', 'Tabletop plant', 'plant', 'table', 0.16, 0.16, 0.3, '#b08968', [
        { key: 'pot', label: 'Pot height', min: 3, max: 7, def: 5 },
        { key: 'leaves', label: 'Foliage', min: 2, max: 7, def: 4 },
      ]),
      dec('decor-basket', 'Storage basket', 'basket', 'floor', 0.36, 0.28, 0.26, '#c3a887', [
        { key: 'taper', label: 'Taper', min: 0, max: 3, def: 1 },
      ]),
      dec('decor-magazines', 'Magazines', 'stack', 'table', 0.21, 0.28, 0.05, '#8a8f96', [
        { key: 'count', label: 'Issues', min: 1, max: 6, def: 3 },
      ]),
      dec('decor-candles', 'Candles', 'vessel', 'table', 0.07, 0.07, 0.15, '#e8ded0', [
        { key: 'neck', label: 'Taper', min: 8, max: 10, def: 10 },
      ]),
      dec('decor-tray', 'Tray', 'frame', 'table', 0.36, 0.26, 0.04, '#8d6e4e', [
        { key: 'lean', label: 'Lean', min: 4, max: 8, def: 4 },
      ]),
      dec('decor-herbs', 'Herb pots', 'plant', 'shelf', 0.24, 0.1, 0.2, '#b8836a', [
        { key: 'pot', label: 'Pot height', min: 3, max: 6, def: 5 },
        { key: 'leaves', label: 'Foliage', min: 3, max: 8, def: 6 },
      ]),
      dec('decor-cushion', 'Cushion', 'cloth', 'any', 0.44, 0.44, 0.12, '#9aa8a0', [
        { key: 'folds', label: 'Layers', min: 1, max: 3, def: 1 },
      ]),
      dec('decor-throw', 'Folded throw', 'cloth', 'any', 0.42, 0.3, 0.11, '#b8a48c', [
        { key: 'folds', label: 'Folds', min: 2, max: 6, def: 4 },
      ]),
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

/** Procedural set dressing (books, plants, kitchen mess) — see `DecorSpec`. */
export function isDecor(def: CatalogDef): boolean {
  return def.decor !== undefined;
}

/** Never a line item: excluded from the cut list, shopping list and schedule. */
export function isStaging(def: CatalogDef): boolean {
  return def.staging === true;
}

/** Where the actual light source sits, in item-local coordinates. */
export function lightLocalY(def: CatalogDef, item: Item): number {
  switch (def.kind) {
    case 'pendant':
      return item.h * 0.18;
    case 'spot':
      return -0.04;
    default:
      return -0.02;
  }
}

/** Item-local aim point of a ceiling spot; View3D's spot target sits here. */
export const SPOT_AIM = { x: 0, y: -2.5, z: 0.35 } as const;

/**
 * World y of an item group's origin. Ceiling spots hang from the ceiling
 * (`wallHeight - 0.02`, just clear of the slab) regardless of their stored
 * elevation; everything else places at its own `item.elevation`.
 */
export function itemBaseY(design: Design, item: Item, def: CatalogDef): number {
  if (def.kind === 'spot') return styleOfItem(design, item).wallHeight - 0.02;
  return item.elevation;
}
