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
  /** front colour slot; may hold a literal hex or a `var:<id>` reference to a DesignVar */
  color: string;
  /** accent colour override; missing = the part's own accent. May be a `var:<id>` reference */
  accentColor?: string;
  /** built-in PBR material id (src/model/materials.ts); missing = plain colour */
  material?: string;
  /** rotate the material's texture 90° (e.g. wood grain vertical → horizontal) */
  materialRot?: boolean;
  /** worktop material override for items with a counter; missing = room worktop */
  counterMaterial?: string;
  counterMaterialRot?: boolean;
  light?: LightProps;
  /** parametric options, e.g. { drawers: 3, doors: 2 } — keys defined per catalog entry */
  params?: Record<string, number>;
  /** appliances only: host-local mounting anchor */
  attach?: Attachment;
  /**
   * Room this item belongs to. Authoritative when set; re-inferred from the
   * item centre's containment when absent or dangling (see rooms.ts
   * `roomOfItem`). Drives the per-room worktop/counter finish.
   */
  roomId?: string;
}

export interface RoomStyle {
  wallColor: string;
  floorColor: string;
  counterColor: string;
  /** built-in PBR material ids (src/model/materials.ts); missing = plain colour */
  wallMaterial?: string;
  floorMaterial?: string;
  counterMaterial?: string;
  /** rotate the surface's texture 90° */
  wallMaterialRot?: boolean;
  floorMaterialRot?: boolean;
  counterMaterialRot?: boolean;
  wallHeight: number;
  wallThickness: number;
}

/** Per-wall 3D visibility override. 'auto' = camera-based hide (default). */
export type WallVisMode = 'auto' | 'show' | 'hide';

/**
 * One enclosed space: its own CCW corner ring plus the finishes applied to it.
 * Corner ids are unique across the whole design, so a wall id (start corner id)
 * alone identifies a wall without naming its room.
 *
 * The ring is the ROOM-SIDE WALL FACE (not the centreline): an exterior wall
 * slab lies entirely outside the polygon, a shared partition straddles it.
 * `RoomWall.faceOffset` (rooms.ts) is the single sanctioned source for that
 * offset — never hardcode wallThickness / 2.
 */
export interface Room {
  id: string;
  name: string;
  corners: Corner[];
  style: RoomStyle;
  /** per-wall visibility override, keyed by wall id; missing = 'auto' */
  wallVisibility?: Record<string, WallVisMode>;
  /**
   * Per-wall WIDTH override in metres, keyed by wall id; missing falls back to
   * `style.wallThickness`. Named `wallWidths`, not `wallThickness`, so it can
   * never be misread as the room-wide `RoomStyle.wallThickness` it overrides.
   * Resolved in one place: `allWalls` (src/model/rooms.ts).
   */
  wallWidths?: Record<string, number>;
  /** ceiling visibility override; missing = 'auto' */
  ceilingVisibility?: WallVisMode;
}

/**
 * Global lighting. The sun angles + night flag drive everything derived —
 * colour temperature, ambient, sky background — via src/model/sky.ts;
 * `brightness` is the single master level for sun + ambient + reflections.
 * Angles are DEGREES here (the one exception to the radians convention):
 * they are user-facing slider values and read naturally in saved files.
 */
export interface Scene {
  /** sun compass direction in plan, degrees 0..360; 0 = +z, increasing toward +x */
  sunAzimuth: number;
  /** sun height above the horizon ("skew"), degrees 5..85 */
  sunElevation: number;
  /** master light level 0..2 (1 = tuned default); 0 = fixture lamps only */
  brightness: number;
  /** night preset: parks the sun below the horizon so fixture lamps carry the room */
  night: boolean;
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
  /** 'free' = never snaps to walls (islands); absent = wall-hugging */
  placement?: 'free';
}

export type ZoneFill = 'door' | 'doorPair' | 'drawers' | 'open' | 'panel' | 'glass' | 'appliance';

/**
 * How an appliance item is mounted on a host item. Anchors are HOST-LOCAL
 * (they survive host moves/rotations); the item's x/y/rotation/elevation stay
 * the authoritative world-pose cache, recomputed by syncAttachments
 * (src/model/attach.ts) whenever the host changes.
 */
export type Attachment =
  /** sits on/in the host worktop: u along the host width from its center, v along depth (+v = front) */
  | { kind: 'counter'; hostId: string; u: number; v: number }
  /** slotted into an 'appliance' zone leaf of the host cabinet */
  | { kind: 'zone'; hostId: string; path: number[] };

/** One concrete interior element; `y` is meters up from the cavity bottom. */
export type InteriorElement =
  | { kind: 'shelf'; y: number }
  /** internal drawer box (behind a door / in an open zone), box height h */
  | { kind: 'drawerBox'; y: number; h: number }
  /** wardrobe hanging rail spanning the cavity; y = the bar's axis height */
  | { kind: 'rail'; y: number };

/**
 * Zone interior, two-level: 'auto' holds parametric counts that resolve to
 * evenly-spaced elements (src/model/interior.ts resolveInterior — the ONLY
 * bridge; the panel generator and editors all consume the resolved form),
 * 'custom' holds explicit elements with exact positions.
 */
export type Interior =
  | { mode: 'auto'; shelves: number; innerDrawers: number }
  | { mode: 'custom'; elements: InteriorElement[] };

export interface LeafZone {
  kind: 'leaf';
  fill: ZoneFill;
  /** fill 'drawers': stacked fronts, 1..5 */
  drawers?: number;
  /** shelves / internal drawers inside the cavity; missing = per-fill default */
  interior?: Interior;
  /** fill 'door': hinge side (drilling datum); missing = 'left' */
  hinge?: 'left' | 'right' | 'top' | 'bottom';
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

/** Worktop overhang beyond the carcass, per edge (m). Absent = snug default. */
export interface WorktopOverhang {
  front: number;
  back: number;
  sides: number;
}

export interface CabinetPartDef extends PartBase {
  type: 'cabinet';
  footprint: Footprint;
  plinth: boolean;
  worktop: boolean;
  /** rect footprints only; polygon worktops keep their snug outline */
  worktopOverhang?: WorktopOverhang;
  /** emit a finished back board (visible islands) instead of bare carcass */
  finishedBack?: boolean;
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

/**
 * A named, reusable finish token ("design variable"). Colour slots bind to it
 * by storing `var:<id>` in their `color` string; the resolver
 * (src/model/variables.ts) turns that into this variable's concrete finish.
 */
export interface DesignVar {
  id: string;
  name: string;
  color: string;
  /** built-in PBR material id (src/model/materials.ts); missing = plain colour */
  material?: string;
  /** rotate the material's texture 90° */
  materialRot?: boolean;
}

/**
 * Placement of the floor-plan tracing photo. TRANSFORM ONLY — the image bytes
 * live in their own localStorage key (storageKeys.ts UNDERLAY_KEY), because a
 * Design is JSON-cloned for every undo step and every autosave, and a multi-MB
 * data URL there would blow both up. Consequence: moving/scaling the reference
 * is undoable, swapping or removing the photo itself is not.
 */
export interface Underlay {
  /** world position of the image's TOP-LEFT pixel (m) */
  x: number;
  y: number;
  /** meters per image pixel (> 0) */
  scale: number;
  /** rotation about the top-left corner, radians */
  rotation: number;
  /** 0..1 */
  opacity: number;
  visible: boolean;
  /** locked underlays are completely inert to plan gestures */
  locked: boolean;
}

/**
 * A wall chain that encloses nothing — a divider, a peninsula, a corner stub.
 *
 * The counterpart to a `Room`'s ring, and deliberately the same SHAPE: a list
 * of `Corner`s whose ids are unique design-wide, so a segment is named by its
 * start corner exactly like a room wall is, and an `Opening` can sit on one
 * without knowing which kind of wall it found. The chain is OPEN — the last
 * corner does not join back to the first — which is the only structural
 * difference from a room, and why it carries its own thickness rather than
 * borrowing a `RoomStyle`.
 *
 * Its centreline IS the polyline (the slab straddles it, `faceOffset` t/2),
 * because a free wall has no interior side to measure a face from.
 */
export interface FreeWall {
  id: string;
  /** open polyline of >= 2 corners, in centreline coords */
  corners: Corner[];
  /** wall width (m) */
  thickness: number;
  /** wall height (m); missing = the active room's, else a default */
  height?: number;
  /** per-segment width override, keyed by segment (start corner) id */
  wallWidths?: Record<string, number>;
}

export interface Design {
  version: 7;
  /** ≥1 room; rooms[0] is the fallback active room and the shared-edge owner tiebreak */
  rooms: Room[];
  /** design-global; `wallId` (a globally unique corner id) alone names the wall */
  openings: Opening[];
  /** design-global, world coords; `roomId` caches which room each one sits in */
  items: Item[];
  customParts: CustomPartDef[];
  /** named finish tokens; slots reference them as `var:<id>` */
  variables: DesignVar[];
  /** var id applied to a new item's front colour when set */
  defaultFrontVar?: string;
  /** var id applied to a new item's accent colour when set */
  defaultAccentVar?: string;
  scene: Scene;
  /**
   * Wall chains belonging to no room. Optional so a design that has none stays
   * byte-identical to what earlier versions wrote.
   */
  walls?: FreeWall[];
  /** tracing photo placement; the image itself is stored outside the design */
  underlay?: Underlay;
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
