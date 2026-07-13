import { FRONT_COLORS, OAK, type CatalogDef } from './catalog';
import { clamp, polygonBounds, polygonIsSimple, signedArea } from './geometry';
import { cabinetTreeFromCounts } from './partsMigrate';
import type { Board, BoardPartDef, CabinetPartDef, CustomPartDef, FreeformPartDef, Point } from './types';
import { uid } from './types';
import { sanitizeZone } from './zones';

/**
 * Custom parts are user-created components (Part Studio). Three types:
 *  - 'cabinet': carcass + plinth/worktop + a zone tree on the front face
 *    (doors, drawers, open niches, panels, glass — any split layout).
 *  - 'board': a horizontal slab extruded from a free polygon outline
 *    (worktops, table tops, floating shelves), with optional cutouts.
 *  - 'freeform': a list of boards/cylinders composing arbitrary furniture.
 */

export const MAX_BOARDS = 40;
export const MAX_OUTLINE_POINTS = 16;

export const TEMPLATE_LABELS: Record<'cabinet' | 'desk', string> = {
  cabinet: 'Cabinet / shelving',
  desk: 'Desk / table',
};

export function newCabinetPart(): CabinetPartDef {
  return {
    id: uid('part'),
    name: 'My cabinet',
    type: 'cabinet',
    w: 0.8,
    d: 0.45,
    h: 0.9,
    elevation: 0,
    color: FRONT_COLORS[2],
    accentColor: OAK,
    footprint: { kind: 'rect' },
    plinth: true,
    worktop: true,
    face: cabinetTreeFromCounts({ drawers: 2, doors: 0, shelves: 0 }),
  };
}

export function newBoardPart(): BoardPartDef {
  return {
    id: uid('part'),
    name: 'My worktop',
    type: 'board',
    w: 1.2,
    d: 0.6,
    h: 0.04,
    elevation: 0.86,
    color: OAK,
    accentColor: OAK,
    outline: [
      { x: -0.6, y: -0.3 },
      { x: 0.6, y: -0.3 },
      { x: 0.6, y: 0.3 },
      { x: -0.6, y: 0.3 },
    ],
    holes: [],
    material: 'wood',
  };
}

export function newFreeformPart(): FreeformPartDef {
  return {
    id: uid('part'),
    name: 'My furniture',
    type: 'freeform',
    w: 1.4,
    d: 0.7,
    h: 0.75,
    elevation: 0,
    color: FRONT_COLORS[2],
    accentColor: OAK,
    boards: [],
  };
}

/** Present a custom part as a CatalogDef so the rest of the app treats it uniformly. */
export function toCatalogDef(part: CustomPartDef): CatalogDef {
  const resize: CatalogDef['resize'] =
    part.type === 'board'
      ? { w: [0.2, 4.0], d: [0.1, 2.0], h: [0.012, 0.08] }
      : part.type === 'freeform'
        ? { w: [0.2, 4.0], d: [0.1, 2.0], h: [0.1, 2.6] }
        : { w: [0.2, 3.5], d: [0.2, 1.4], h: [0.2, 2.6] };
  return {
    id: part.id,
    kind: 'custom',
    label: part.name,
    w: part.w,
    d: part.d,
    h: part.h,
    elevation: part.elevation,
    color: part.color,
    resize,
    elevAdjust: [0, 2.2],
  };
}

/**
 * Plan-local footprint polygon (+y = front) scaled to the given dims, or null
 * for a plain rectangle. Used by plan symbols, hit-testing and prism meshes.
 */
export function footprintPolygon(part: CustomPartDef, w: number, d: number): Point[] | null {
  if (part.type === 'board') {
    const sx = w / (part.w || 1);
    const sy = d / (part.d || 1);
    return part.outline.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  }
  if (part.type !== 'cabinet' || part.footprint.kind === 'rect') return null;
  const fp = part.footprint;
  const sx = w / (part.w || 1);
  const sz = d / (part.d || 1);
  if (fp.kind === 'chamfer') {
    const cx = clamp(fp.cx * sx, 0.02, w - 0.02);
    const cz = clamp(fp.cz * sz, 0.02, d - 0.02);
    return fp.corner === 'left'
      ? [
          { x: -w / 2, y: -d / 2 },
          { x: w / 2, y: -d / 2 },
          { x: w / 2, y: d / 2 },
          { x: -w / 2 + cx, y: d / 2 },
          { x: -w / 2, y: d / 2 - cz },
        ]
      : [
          { x: -w / 2, y: -d / 2 },
          { x: w / 2, y: -d / 2 },
          { x: w / 2, y: d / 2 - cz },
          { x: w / 2 - cx, y: d / 2 },
          { x: -w / 2, y: d / 2 },
        ];
  }
  const nw = clamp(fp.nw * sx, 0.02, w - 0.02);
  const nd = clamp(fp.nd * sz, 0.02, d - 0.02);
  return fp.notch === 'left'
    ? [
        { x: -w / 2, y: -d / 2 },
        { x: w / 2, y: -d / 2 },
        { x: w / 2, y: d / 2 },
        { x: -w / 2 + nw, y: d / 2 },
        { x: -w / 2 + nw, y: d / 2 - nd },
        { x: -w / 2, y: d / 2 - nd },
      ]
    : [
        { x: -w / 2, y: -d / 2 },
        { x: w / 2, y: -d / 2 },
        { x: w / 2, y: d / 2 - nd },
        { x: w / 2 - nw, y: d / 2 - nd },
        { x: w / 2 - nw, y: d / 2 },
        { x: -w / 2, y: d / 2 },
      ];
}

/** Re-center a board outline on its bbox, enforce CCW, refresh part.w/d. */
export function normalizeBoardOutline(part: BoardPartDef): void {
  if (part.outline.length < 3) return;
  if (signedArea(part.outline) < 0) part.outline.reverse();
  const b = polygonBounds(part.outline);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  for (const p of part.outline) {
    p.x -= cx;
    p.y -= cy;
  }
  part.w = Math.max(0.05, b.maxX - b.minX);
  part.d = Math.max(0.05, b.maxY - b.minY);
}

/** Axis-aligned bounds of a board list (rotation included). */
export function freeformBounds(boards: Board[]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = 0;
  for (const b of boards) {
    const c = Math.abs(Math.cos(b.rotY));
    const s = Math.abs(Math.sin(b.rotY));
    const ex = b.shape === 'cyl' ? b.w / 2 : (b.w * c + b.d * s) / 2;
    const ez = b.shape === 'cyl' ? b.w / 2 : (b.w * s + b.d * c) / 2;
    minX = Math.min(minX, b.x - ex);
    maxX = Math.max(maxX, b.x + ex);
    minZ = Math.min(minZ, b.z - ez);
    maxZ = Math.max(maxZ, b.z + ez);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, maxX, minZ, maxZ, maxY };
}

/**
 * Re-center a freeform part's boards on x/z, clamp them above the floor and
 * refresh part.w/d/h from the board bounds.
 */
export function normalizeFreeform(part: FreeformPartDef): void {
  if (!part.boards.length) return;
  for (const b of part.boards) b.y = Math.max(0, b.y);
  const bb = freeformBounds(part.boards);
  const cx = (bb.minX + bb.maxX) / 2;
  const cz = (bb.minZ + bb.maxZ) / 2;
  for (const b of part.boards) {
    b.x -= cx;
    b.z -= cz;
  }
  part.w = Math.max(0.05, bb.maxX - bb.minX);
  part.d = Math.max(0.05, bb.maxZ - bb.minZ);
  part.h = Math.max(0.05, bb.maxY);
}

/** Validate + repair a v2 part parsed from storage. Null when unusable. */
export function sanitizePart(raw: unknown): CustomPartDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || !['cabinet', 'board', 'freeform'].includes(p.type as string)) {
    return null;
  }
  const part = p as unknown as CustomPartDef;
  part.name = typeof part.name === 'string' ? part.name.slice(0, 32) : 'Part';
  part.w = clamp(Number(part.w) || 0.6, 0.05, 4.0);
  part.d = clamp(Number(part.d) || 0.5, 0.02, 2.0);
  part.h = clamp(Number(part.h) || 0.8, 0.012, 2.6);
  part.elevation = clamp(Number(part.elevation) || 0, 0, 2.2);
  if (typeof part.color !== 'string') part.color = FRONT_COLORS[2];
  if (typeof part.accentColor !== 'string') part.accentColor = OAK;
  if (part.type === 'cabinet') {
    part.face = sanitizeZone(part.face);
    if (typeof part.plinth !== 'boolean') part.plinth = true;
    if (typeof part.worktop !== 'boolean') part.worktop = false;
    const fp = part.footprint as { kind?: string } | undefined;
    if (!fp || !['rect', 'chamfer', 'cornerL'].includes(fp.kind ?? '')) {
      part.footprint = { kind: 'rect' };
    }
  } else if (part.type === 'board') {
    const pts = Array.isArray(part.outline)
      ? part.outline.filter((q) => typeof q?.x === 'number' && typeof q?.y === 'number')
      : [];
    part.outline = pts.slice(0, MAX_OUTLINE_POINTS);
    if (part.outline.length < 3 || !polygonIsSimple(part.outline)) {
      part.outline = [
        { x: -part.w / 2, y: -part.d / 2 },
        { x: part.w / 2, y: -part.d / 2 },
        { x: part.w / 2, y: part.d / 2 },
        { x: -part.w / 2, y: part.d / 2 },
      ];
    }
    normalizeBoardOutline(part);
    if (!Array.isArray(part.holes)) part.holes = [];
    part.holes = part.holes.filter((hle) => typeof hle?.x === 'number' && hle.w > 0 && hle.d > 0);
    if (part.material !== 'matte') part.material = 'wood';
  } else {
    if (!Array.isArray(part.boards)) part.boards = [];
    part.boards = part.boards
      .filter((b) => b && typeof b.x === 'number' && typeof b.w === 'number')
      .slice(0, MAX_BOARDS);
    for (const b of part.boards) {
      if (typeof b.id !== 'string') b.id = uid('b');
      b.w = clamp(b.w, 0.005, 4.0);
      b.h = clamp(Number(b.h) || 0.02, 0.005, 2.6);
      b.d = clamp(Number(b.d) || 0.02, 0.005, 2.0);
      b.rotY = Number(b.rotY) || 0;
      if (b.shape !== 'cyl') b.shape = 'box';
      if (b.slot !== 'accent') b.slot = 'front';
      if (b.style !== 'front') b.style = 'plain';
      if (b.tint !== undefined) b.tint = clamp(Number(b.tint) || 1, 0.3, 1.5);
    }
  }
  return part;
}

/** A sample part so the "My parts" section shows what's possible. */
export function samplePart(): CustomPartDef {
  return {
    id: uid('part'),
    name: 'Oak sideboard',
    type: 'cabinet',
    w: 1.2,
    d: 0.42,
    h: 0.75,
    elevation: 0,
    color: FRONT_COLORS[1],
    accentColor: OAK,
    footprint: { kind: 'rect' },
    plinth: false,
    worktop: true,
    face: cabinetTreeFromCounts({ drawers: 1, doors: 2, shelves: 1 }),
  };
}
