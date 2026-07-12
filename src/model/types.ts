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
}

export interface LightProps {
  on: boolean;
  /** 0..1 slider — mapped to lumens-ish intensity per fixture kind */
  intensity: number;
  /** 0 = cool white, 1 = warm candle */
  warmth: number;
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

export interface Scene {
  night: boolean;
}

/** A user-created parametric part, built in the Part Studio. */
export interface CustomPartDef {
  id: string;
  name: string;
  template: 'cabinet' | 'desk';
  w: number;
  d: number;
  h: number;
  elevation: number;
  color: string;
  /** wood tone used for worktops, open niches, table tops */
  accentColor: string;
  /** template-specific options, e.g. { drawers: 2, doors: 2, shelves: 0, plinth: 1, worktop: 1 } */
  options: Record<string, number>;
}

export interface Design {
  version: 1;
  corners: Corner[];
  openings: Opening[];
  items: Item[];
  customParts: CustomPartDef[];
  room: RoomStyle;
  scene: Scene;
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
