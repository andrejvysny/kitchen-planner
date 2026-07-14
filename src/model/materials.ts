/**
 * Built-in PBR material library. Pure model code — the 3D view resolves these
 * into three.js materials with procedurally generated texture maps
 * (src/view3d/textures.ts); no texture assets, no user imports.
 *
 * A material = a texture PATTERN (shared, near-white luminance map) tinted by
 * `color`, plus principled-BSDF-style scalar params (roughness/metalness/
 * opacity). Tintable materials (plastic) take the user's colour instead of
 * their own, so plastic stays freely recolourable.
 */

export type TexturePattern = 'wood' | 'planks' | 'marble' | 'concrete' | 'tiles' | 'none';

export interface MaterialDef {
  id: string;
  label: string;
  pattern: TexturePattern;
  /** base colour multiplied with the pattern map; ignored when tintable */
  color: string;
  roughness: number;
  metalness: number;
  /** plastic: the user's colour drives the tint instead of `color` */
  tintable?: boolean;
  /** glass: rendered transparent at this opacity */
  opacity?: number;
}

const m = (d: MaterialDef) => d;

/** The whole integrated library. Ids are persisted in designs — never rename. */
export const MATERIALS: MaterialDef[] = [
  // furniture woods
  m({ id: 'oak', label: 'Oak', pattern: 'wood', color: '#c9a87c', roughness: 0.6, metalness: 0.02 }),
  m({ id: 'walnut', label: 'Walnut', pattern: 'wood', color: '#8b6748', roughness: 0.58, metalness: 0.02 }),
  m({ id: 'ash', label: 'Ash', pattern: 'wood', color: '#d8c7a6', roughness: 0.62, metalness: 0.02 }),
  m({ id: 'beech', label: 'Beech', pattern: 'wood', color: '#d6b08a', roughness: 0.6, metalness: 0.02 }),
  m({ id: 'birch', label: 'Birch', pattern: 'wood', color: '#e7d4b0', roughness: 0.62, metalness: 0.02 }),
  m({ id: 'maple', label: 'Maple', pattern: 'wood', color: '#e3c493', roughness: 0.58, metalness: 0.02 }),
  m({ id: 'cherry', label: 'Cherry', pattern: 'wood', color: '#a05c3c', roughness: 0.56, metalness: 0.02 }),
  m({ id: 'pine', label: 'Pine', pattern: 'wood', color: '#ddb787', roughness: 0.66, metalness: 0.02 }),
  m({ id: 'wenge', label: 'Wenge', pattern: 'wood', color: '#4c3a2a', roughness: 0.58, metalness: 0.02 }),
  // stone / mineral
  m({ id: 'marble-light', label: 'Marble', pattern: 'marble', color: '#e9e6df', roughness: 0.22, metalness: 0.02 }),
  m({ id: 'marble-dark', label: 'Dark marble', pattern: 'marble', color: '#3c3f44', roughness: 0.24, metalness: 0.02 }),
  m({ id: 'concrete', label: 'Concrete', pattern: 'concrete', color: '#9d9c97', roughness: 0.9, metalness: 0.0 }),
  // floors
  m({ id: 'floor-oak', label: 'Oak planks', pattern: 'planks', color: '#c9a87c', roughness: 0.55, metalness: 0.02 }),
  m({ id: 'floor-walnut', label: 'Walnut planks', pattern: 'planks', color: '#8b6748', roughness: 0.55, metalness: 0.02 }),
  m({ id: 'tiles-grey', label: 'Grey tiles', pattern: 'tiles', color: '#b3b1ab', roughness: 0.35, metalness: 0.02 }),
  m({ id: 'tiles-terracotta', label: 'Terracotta tiles', pattern: 'tiles', color: '#b57755', roughness: 0.5, metalness: 0.02 }),
  // glass & plastic
  m({ id: 'glass', label: 'Glass', pattern: 'none', color: '#bcd2d8', roughness: 0.08, metalness: 0.1, opacity: 0.35 }),
  m({ id: 'plastic-matte', label: 'Matte plastic', pattern: 'none', color: '#f2f1ec', roughness: 0.55, metalness: 0.0, tintable: true }),
  m({ id: 'plastic-gloss', label: 'Gloss plastic', pattern: 'none', color: '#f2f1ec', roughness: 0.15, metalness: 0.0, tintable: true }),
];

const byId = new Map<string, MaterialDef>(MATERIALS.map((d) => [d.id, d]));

export function materialDef(id: string): MaterialDef | undefined {
  return byId.get(id);
}

export function hasMaterial(id: unknown): id is string {
  return typeof id === 'string' && byId.has(id);
}

/** True when the material renders a texture pattern — i.e. rotation applies. */
export function hasPattern(id: string | undefined): boolean {
  const def = id ? byId.get(id) : undefined;
  return !!def && def.pattern !== 'none';
}

const ids = (...list: string[]) => list.map((id) => byId.get(id)!);

/** Curated per-surface choices shown in the props panel. */
export const ITEM_MATERIALS = ids(
  'oak', 'walnut', 'ash', 'beech', 'birch', 'maple', 'cherry', 'pine', 'wenge',
  'marble-light', 'marble-dark', 'concrete', 'glass', 'plastic-matte', 'plastic-gloss'
);
export const FLOOR_MATERIALS = ids(
  'floor-oak', 'floor-walnut', 'tiles-grey', 'tiles-terracotta', 'concrete', 'marble-light'
);
export const WALL_MATERIALS = ids('concrete', 'tiles-grey', 'marble-light');
export const COUNTER_MATERIALS = ids(
  'oak', 'walnut', 'wenge', 'marble-light', 'marble-dark', 'concrete'
);

/** The colour a surface should take: the user's for tintable/no material, else the preset. */
export function materialColor(matId: string | undefined, userColor: string): string {
  const def = matId ? byId.get(matId) : undefined;
  if (!def || def.tintable) return userColor;
  return def.color;
}
