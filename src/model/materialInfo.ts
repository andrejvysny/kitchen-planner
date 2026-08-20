/**
 * Human names + one-clause captions for every value that can appear in a
 * swatch/material row: the 19 built-in material ids (src/model/materials.ts)
 * and the plain colour hexes used by the built-in palettes (src/model/
 * catalog.ts FRONT_COLORS/FLOOR_COLORS/WALL_COLORS/COUNTER_COLORS/
 * LIGHT_COLORS). Pure model code — no three.js, no DOM.
 *
 * An unknown value (a custom colour the user picked in the native `<input
 * type=color>`, say) falls back to itself. That fallback is deliberate load-
 * bearing behaviour: every KNOWN entry below is written so its `name` never
 * equals the raw id/hex it names (Title Case words vs. a lowercase-dashed id
 * or a `#` hex triplet), so `materialInfo(x).name !== x` is exactly the test
 * test/unit/materialInfo.test.ts uses to prove every shipped palette entry
 * actually resolved to a real name instead of silently falling through.
 */

import { MATERIALS } from './materials';

export type MaterialGroup = 'wood' | 'stone' | 'tile' | 'glass' | 'plastic' | 'colour';

export interface MaterialInfo {
  name: string;
  /** One clause on character/use — materials only; colours stay caption-free. */
  caption?: string;
  /** Family for group headers in a mixed swatch row (MaterialRow). */
  group?: MaterialGroup;
}

/** Display label for each MaterialGroup — the group-header text. */
export const GROUP_LABELS: Record<MaterialGroup, string> = {
  wood: 'Wood',
  stone: 'Stone',
  tile: 'Tile',
  glass: 'Glass',
  plastic: 'Plastic',
  colour: 'Colour',
};

interface MatMeta {
  caption: string;
  group: MaterialGroup;
}

/** Keyed by MaterialDef.id (materials.ts) — name comes from `.label` there, not duplicated here. */
const MATERIAL_META: Record<string, MatMeta> = {
  oak: { caption: 'Warm, straight grain — the everyday cabinet wood', group: 'wood' },
  walnut: { caption: 'Rich chocolate-brown, fine grain — a premium look', group: 'wood' },
  ash: { caption: 'Pale, subtle grain — bright and contemporary', group: 'wood' },
  beech: { caption: 'Even pale-tan tone — durable and classic', group: 'wood' },
  birch: { caption: 'Light, fine grain — clean Scandinavian look', group: 'wood' },
  maple: { caption: 'Smooth honey tone — hard-wearing', group: 'wood' },
  cherry: { caption: 'Reddish-brown, deepens with age — traditional and warm', group: 'wood' },
  pine: { caption: 'Light and knotty — casual, rustic', group: 'wood' },
  wenge: { caption: 'Near-black, dramatic grain — bold accents', group: 'wood' },
  'marble-light': { caption: 'Pale veined stone — classic worktops', group: 'stone' },
  'marble-dark': { caption: 'Dark veined stone — dramatic worktops', group: 'stone' },
  concrete: { caption: 'Matte industrial grey — raw and minimal', group: 'stone' },
  'floor-oak': { caption: 'Oak plank flooring — warm and traditional', group: 'wood' },
  'floor-walnut': { caption: 'Walnut plank flooring — rich and formal', group: 'wood' },
  'tiles-grey': { caption: 'Grey ceramic tile — clean and practical', group: 'tile' },
  'tiles-terracotta': { caption: 'Terracotta tile — earthy and warm', group: 'tile' },
  glass: { caption: 'Clear and translucent — doors and splashbacks', group: 'glass' },
  'plastic-matte': { caption: 'Smooth matte finish — freely recolourable', group: 'plastic' },
  'plastic-gloss': { caption: 'High-gloss finish — freely recolourable', group: 'plastic' },
};

const labelById = new Map(MATERIALS.map((m) => [m.id, m.label]));

/**
 * Nearest-name table for the flat colour hexes used by FRONT_COLORS,
 * FLOOR_COLORS, WALL_COLORS, COUNTER_COLORS and LIGHT_COLORS (catalog.ts).
 * Keys are lowercase; every array's entries are covered even where two
 * arrays share a literal hex (e.g. '#f2f1ec' in both FRONT_COLORS and
 * COUNTER_COLORS) — one entry serves both.
 */
const HEX_NAMES: Record<string, string> = {
  // FRONT_COLORS
  '#f2f1ec': 'Warm white',
  '#e6dfd0': 'Cream',
  '#8a9683': 'Sage',
  '#31455a': 'Navy',
  '#3f4447': 'Anthracite',
  '#c9a87c': 'Oak tan',
  // FLOOR_COLORS
  '#cfccc6': 'Light grey',
  '#d9c4a0': 'Sand',
  '#b7b4ad': 'Taupe',
  '#8f8b83': 'Stone grey',
  '#e3e0da': 'Ivory',
  // WALL_COLORS
  '#f4f1ea': 'Soft white',
  '#e9e4d8': 'Linen',
  '#dfe4de': 'Pale sage',
  '#d8dee3': 'Pale blue-grey',
  '#efe2d2': 'Pale sand',
  // COUNTER_COLORS (own entries; '#c9a87c' / '#f2f1ec' already covered above)
  '#e8e5de': 'Bone',
  '#3a3835': 'Charcoal',
  '#8b6748': 'Walnut',
  // LIGHT_COLORS (bulb tint chips)
  '#ffb46b': 'Warm amber',
  '#ffd9a0': 'Soft gold',
  '#fff4e0': 'Candlelight',
  '#ffffff': 'Daylight white',
  '#dfeaff': 'Cool white',
  '#ff7a3c': 'Amber',
  '#7ec8ff': 'Cool blue',
};

/**
 * Name (+ caption, + family group) for a swatch/material row value. `value`
 * is either a MaterialDef id or a literal `#rrggbb` hex; anything else
 * (a custom-picked colour) falls back to itself as the name.
 */
export function materialInfo(value: string): MaterialInfo {
  const label = labelById.get(value);
  if (label !== undefined) {
    const meta = MATERIAL_META[value];
    return { name: label, caption: meta?.caption, group: meta?.group };
  }
  const hexName = HEX_NAMES[value.toLowerCase()];
  if (hexName !== undefined) return { name: hexName, group: 'colour' };
  return { name: value };
}

/** `title` attribute text: name alone, or "name — caption" when one exists. */
export function titleFor(info: MaterialInfo): string {
  return info.caption ? `${info.name} — ${info.caption}` : info.name;
}
