/** Shared model types. All linear units are meters; angles are radians. */

export interface Point {
  x: number;
  y: number;
}

export interface Corner extends Point {
  id: string;
}

/** A wall is the edge between consecutive corners; identified by its start corner id. */
export interface WallRef {
  id: string; // start corner id
  a: Corner;
  b: Corner;
}

export type OpeningType = 'door' | 'window';

export interface Opening {
  id: string;
  wallId: string; // start corner id of the wall it sits on
  type: OpeningType;
  /** distance (m) from wall start corner to the opening center, along the wall */
  offset: number;
  width: number;
  height: number;
  /** bottom of the opening above the floor (0 for doors, ~0.9 for windows) */
  sill: number;
  /** doors only: jamb carrying the hinge, seen from inside the room (default 'left') */
  hinge?: 'left' | 'right';
  /** doors only: leaf swings into the room or out of it (default 'in') */
  swing?: 'in' | 'out';
}

export interface LightProps {
  on: boolean;
  /** 0..1 slider — mapped to lumens-ish intensity per fixture kind */
  intensity: number;
  /** 0 = cool white, 1 = warm candle */
  warmth: number;
  /** explicit hex; when set, wins over the warmth-derived colour */
  color?: string;
}

export interface Item {
  id: string;
  defId: string;
  x: number;
  y: number;
  rotation: number;
  w: number;
  d: number;
  h: number;
  /** bottom of the item above the floor */
  elevation: number;
  color: string;
  light?: LightProps;
  /** parametric options, e.g. { drawers: 3, doors: 2 } — keys defined per catalog entry */
  params?: Record<string, number>;
}

export interface RoomStyle {
  wallColor: string;
  floorColor: string;
  counterColor: string;
  wallHeight: number;
  wallThickness: number;
}

export type EnvPreset = 'studio' | 'soft' | 'dusk';

/** Per-wall 3D visibility override. 'auto' = camera-based hide (default). */
export type WallVisMode = 'auto' | 'show' | 'hide';

/**
 * Global lighting / environment. `timeOfDay` is the master: it alone drives sun
 * direction, base colour/intensity and the sky — all recomputed live (see
 * src/model/sky.ts). The rest are manual adjustments layered on top, so moving
 * the time slider never clobbers a tweak.
 */
export interface Scene {
  /** 0..24 hours — sun arc, colour temperature, sky */
  timeOfDay: number;
  /** tone-mapping exposure, 0.4..2 */
  exposure: number;
  /** multiplier on the time-derived sun intensity, 0..2 */
  sunStrength: number;
  /** multiplier on the time-derived ambient intensity, 0..2 */
  ambientStrength: number;
  /** optional hex override of the time-derived sun colour */
  sunColor?: string;
  /** optional hex override of the time-derived sky/ambient colour */
  ambientColor?: string;
  /** procedural environment map used for reflections + fill */
  envPreset: EnvPreset;
  /** reflection / IBL strength, 0..2 */
  envIntensity: number;
}

/* ---------------- custom parts (Part Studio) ---------------- */

export interface PartBase {
  id: string;
  name: string;
  /** natural size (m); placed instances resize within bounds and geometry scales */
  w: number;
  d: number;
  h: number;
  /** bottom above floor */
  elevation: number;
  /** colour slot 'front' */
  color: string;
  /** colour slot 'accent' — wood tone for tops, niches, wood boards */
  accentColor: string;
}

export type ZoneFill = 'door' | 'doorPair' | 'drawers' | 'open' | 'panel' | 'glass';

export interface LeafZone {
  kind: 'leaf';
  fill: ZoneFill;
  /** fill 'drawers': stacked fronts, 1..5 */
  drawers?: number;
  /** fill 'open': interior shelves, 0..4 */
  shelves?: number;
}

export interface SplitZone {
  kind: 'split';
  /** 'h' = horizontal cuts (children stacked bottom→top); 'v' = vertical cuts (left→right) */
  dir: 'h' | 'v';
  /** one weight per child, > 0, normalized to sum 1 */
  weights: number[];
  children: Zone[];
}

export type Zone = LeafZone | SplitZone;

export type Footprint =
  | { kind: 'rect' }
  /** front corner chamfered; face 'angled' puts the zones on the diagonal plane */
  | { kind: 'chamfer'; corner: 'left' | 'right'; cx: number; cz: number; face: 'front' | 'angled' }
  /** L footprint (blind corner); the notched return front gets a single face2 slab */
  | { kind: 'cornerL'; notch: 'left' | 'right'; nw: number; nd: number; face2: 'panel' | 'door' };

export interface CabinetPartDef extends PartBase {
  type: 'cabinet';
  footprint: Footprint;
  plinth: boolean;
  worktop: boolean;
  face: Zone;
}

/** Rectangular cutout in a board top, local plan coords (center + size). */
export interface BoardHole {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface BoardPartDef extends PartBase {
  type: 'board';
  /** simple CCW polygon, local plan coords (x right, +y = front), bbox-centered; h = thickness */
  outline: Point[];
  holes: BoardHole[];
  material: 'wood' | 'matte';
}

export interface Board {
  id: string;
  /** x/z = center, y = bottom; local space: x width, y up, z depth (+z = front) */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** yaw about y, radians */
  rotY: number;
  /** 'cyl': w = diameter, d ignored */
  shape: 'box' | 'cyl';
  slot: 'front' | 'accent';
  /** 'front' = handleless slab with routed groove */
  style: 'plain' | 'front';
  /** optional shade factor on the slot colour (carcass darkening, leg tint) */
  tint?: number;
}

export interface FreeformPartDef extends PartBase {
  type: 'freeform';
  boards: Board[];
}

/** A user-created part, built in the Part Studio. */
export type CustomPartDef = CabinetPartDef | BoardPartDef | FreeformPartDef;

export interface Design {
  version: 2;
  corners: Corner[];
  openings: Opening[];
  items: Item[];
  customParts: CustomPartDef[];
  room: RoomStyle;
  scene: Scene;
  /** per-wall visibility override, keyed by wall id (start corner id); missing = 'auto' */
  wallVisibility?: Record<string, WallVisMode>;
  /** ceiling visibility override; missing = 'auto' (camera-based, visible from below) */
  ceilingVisibility?: WallVisMode;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'item'; id: string }
  | { kind: 'corner'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string };

export interface ChangeInfo {
  /** structural changes rebuild 3D geometry; transient ones only move things */
  structural: boolean;
  /** true while dragging — skip undo snapshots and autosave */
  transient?: boolean;
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${Math.floor(
    Math.random() * 1296
  ).toString(36)}`;
}
