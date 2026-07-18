import { catalogDef, hasCatalogDef, OAK, type CatalogDef } from '../catalog';
import { clamp } from '../geometry';
import { PLINTH_H, type Panel, type PartDims } from '../panels';
import { cabinetTreeFromCounts } from '../partsMigrate';
import type { CabinetPartDef, Design, Item, Zone } from '../types';
import type { ApplianceEntry } from './types';

/**
 * Catalog → panel bridge. The custom-part panel generator (src/model/panels.ts)
 * only knows how to decompose a `CustomPartDef`; the built-in catalog kinds are
 * drawn by bespoke Three.js builders (src/view3d/itemMeshes.ts). This module
 * synthesizes an EPHEMERAL `CabinetPartDef` (or a direct panel list) per catalog
 * item so the cut-list pipeline treats built-ins and user parts uniformly. The
 * synthesized part mirrors the corresponding builder's front layout so drawings
 * match what the 3D view shows; it is never persisted (id `bridge:<kind>`).
 *
 * Pure model code — no Three.js, no Store.
 */

/**
 * 3D counter-slab thickness. Mirrors `COUNTER_T` in src/view3d/meshKit.ts, which
 * cannot be imported here (that module pulls in three.js). Counter kinds place a
 * slab of this height on top of the carcass; the bridged carcass height is
 * `item.h − COUNTER_T` and the worktop is emitted as its own cut-list row.
 */
export const COUNTER_T = 0.04;

const GAP = 0.004;

export interface BridgedItem {
  /** synthesized cabinet, or null when the item is an appliance / direct-panel slab */
  part: CabinetPartDef | null;
  dims: PartDims;
  /** emit a separate worktop cut row for this item (counter kinds) */
  worktop: boolean;
  /**
   * Appliances the item introduces. The recipe's BridgedItem carries a single
   * `appliance?`; this is widened to an array so an oven tower with N bays emits
   * N rows. Collectors flatten it into `Collected.appliances`.
   */
  appliance?: ApplianceEntry[];
  /**
   * Direct panel list for the board-like kinds (open shelves, backsplash, wood
   * plane) whose geometry isn't a carcass. `part` is null when this is set.
   */
  panels?: Panel[];
  note?: string;
}

const mm = (v: number): number => Math.round(v * 1000);

/** Kinds handled as appliance placeholders only — no cabinet, no worktop row. */
const APPLIANCE_ONLY = new Set(['fridge', 'dishwasher', 'hood']);

/** Kinds carrying a counter slab (catalog `counter: true`), minus appliance-only. */
const COUNTER_KINDS = new Set(['baseCabinet', 'baseDrawers', 'sink', 'hob', 'oven', 'island']);

/** Kinds returning null from the bridge: lights, furniture, markers, openings. */
const NULL_KINDS = new Set([
  'door',
  'window',
  'water',
  'outlet',
  'pendant',
  'spot',
  'strip',
  'table',
  'chair',
  'stool',
]);

function appliance(item: Item, def: CatalogDef, note: string, dims?: PartDims): ApplianceEntry {
  const w = dims?.w ?? item.w;
  const d = dims?.d ?? item.d;
  const h = dims?.h ?? item.h;
  return { itemId: item.id, kind: def.kind, label: def.label, wMm: mm(w), dMm: mm(d), hMm: mm(h), note };
}

/** Build the ephemeral cabinet part shared by every carcass-backed catalog kind. */
function cabinet(
  item: Item,
  def: CatalogDef,
  face: Zone,
  plinth: boolean,
  h: number
): CabinetPartDef {
  return {
    id: `bridge:${def.kind}`,
    name: def.label,
    type: 'cabinet',
    w: item.w,
    d: item.d,
    h,
    elevation: item.elevation,
    color: item.color,
    accentColor: item.accentColor ?? OAK,
    footprint: { kind: 'rect' },
    plinth,
    worktop: false, // worktop is a separate cut-list row, never a carcass panel
    face,
  };
}

/** Individual `shelf`-role boards, mirroring the open-shelves builder. */
function shelfPanels(item: Item): Panel[] {
  const n = clamp(Math.round(item.params?.shelves ?? 2), 1, 3);
  const t = 0.028; // mirror the shelf builder's board thickness
  const out: Panel[] = [];
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : (i * (item.h - t)) / (n - 1);
    out.push({
      id: `shelf${i}`,
      role: 'shelf',
      shape: { kind: 'box', w: item.w, h: t, d: item.d },
      x: 0,
      y,
      z: 0,
      rotY: 0,
      slot: 'accent',
      finish: 'wood',
    });
  }
  return out;
}

/** A single flat board panel (backsplash: a vertical slab; wood plane: a slab). */
function slabPanels(item: Item, def: CatalogDef): Panel[] {
  const d = def.kind === 'backsplash' ? 0.018 : item.d;
  return [
    {
      id: 'slab',
      role: 'board',
      shape: { kind: 'box', w: item.w, h: item.h, d },
      x: 0,
      y: 0,
      z: 0,
      rotY: 0,
      slot: 'front',
      finish: 'wood',
    },
  ];
}

/**
 * Bridge a placed catalog item to a manufacturable description, or null when the
 * item produces nothing (lights, furniture, markers, openings).
 */
export function bridgeItem(_design: Design, item: Item): BridgedItem | null {
  if (!hasCatalogDef(item.defId)) return null;
  const def = catalogDef(item.defId);
  const kind = def.kind;
  if (NULL_KINDS.has(kind) || def.opening || def.marker || def.light) return null;

  const counter = COUNTER_KINDS.has(kind);
  const carcassH = counter ? item.h - COUNTER_T : item.h;
  const dims: PartDims = { w: item.w, d: item.d, h: carcassH, elevation: item.elevation };

  if (APPLIANCE_ONLY.has(kind)) {
    return {
      part: null,
      dims,
      worktop: false,
      appliance: [appliance(item, def, 'appliance placeholder — confirm clearances')],
    };
  }

  switch (kind) {
    case 'baseCabinet': {
      const doors = clamp(Math.round(item.params?.doors ?? 1), 1, 2);
      const face = cabinetTreeFromCounts({ drawers: 0, doors, shelves: 0 });
      return { part: cabinet(item, def, face, true, carcassH), dims, worktop: true };
    }
    case 'baseDrawers': {
      const drawers = clamp(Math.round(item.params?.drawers ?? 3), 1, 5);
      const face: Zone = { kind: 'leaf', fill: 'drawers', drawers };
      return { part: cabinet(item, def, face, true, carcassH), dims, worktop: true };
    }
    case 'sink': {
      // Builder draws baseCabinet (one door) + a bowl; the real unit has a false
      // front at the top and a bowl cutout milled into the worktop.
      const face: Zone = { kind: 'leaf', fill: 'door' };
      return {
        part: cabinet(item, def, face, true, carcassH),
        dims,
        worktop: true,
        appliance: [appliance(item, def, 'sink cutout in worktop — confirm bowl model')],
        note: 'false front at top; sink cutout in worktop',
      };
    }
    case 'hob': {
      // Builder = baseDrawers({drawers:2}) + a glass hob milled into the worktop.
      const face: Zone = { kind: 'leaf', fill: 'drawers', drawers: 2 };
      return {
        part: cabinet(item, def, face, true, carcassH),
        dims,
        worktop: true,
        appliance: [appliance(item, def, 'hob cutout in worktop')],
      };
    }
    case 'oven': {
      // Builder: a false front at the bottom, an appliance bay (glass) above.
      const bodyH = carcassH - PLINTH_H;
      const ovenH = Math.min(0.6, bodyH - 0.12);
      const bottomH = Math.max(0.05, bodyH - ovenH - 2 * GAP);
      const face: Zone = {
        kind: 'split',
        dir: 'h',
        weights: [bottomH, ovenH],
        children: [
          { kind: 'leaf', fill: 'door' },
          { kind: 'leaf', fill: 'open', shelves: 0 },
        ],
      };
      return {
        part: cabinet(item, def, face, true, carcassH),
        dims,
        worktop: true,
        appliance: [appliance(item, def, 'built-in oven — 600×600 nominal niche')],
      };
    }
    case 'island': {
      const n = clamp(Math.round(item.params?.drawers ?? 3), 0, 5);
      const face: Zone = n > 0 ? { kind: 'leaf', fill: 'drawers', drawers: n } : { kind: 'leaf', fill: 'panel' };
      return {
        part: cabinet(item, def, face, true, carcassH),
        dims,
        worktop: true,
        note: 'rear face finished panel',
      };
    }
    case 'pantry': {
      const sections = clamp(Math.round(item.params?.split ?? 2), 1, 3);
      const heights = sections === 1 ? [1] : sections === 2 ? [0.62, 0.38] : [0.5, 0.28, 0.22];
      const doorLeaf = (): Zone => ({ kind: 'leaf', fill: item.w > 0.75 ? 'doorPair' : 'door' });
      const face: Zone =
        sections === 1
          ? doorLeaf()
          : { kind: 'split', dir: 'h', weights: heights, children: heights.map(doorLeaf) };
      return { part: cabinet(item, def, face, true, carcassH), dims, worktop: false };
    }
    case 'ovenTower': {
      const n = clamp(Math.round(item.params?.appliances ?? 2), 1, 3);
      const bodyH = carcassH - PLINTH_H;
      const bottomDoor = 0.72; // zoneY − PLINTH_H in the builder
      const appH = [0.6, 0.38, 0.38].slice(0, n);
      const used = bottomDoor + appH.reduce((s, v) => s + v, 0);
      const topDoor = Math.max(0.1, bodyH - used);
      const weights = [bottomDoor, ...appH, topDoor];
      const children: Zone[] = [
        { kind: 'leaf', fill: 'door' },
        ...appH.map((): Zone => ({ kind: 'leaf', fill: 'open', shelves: 0 })),
        { kind: 'leaf', fill: 'door' },
      ];
      const face: Zone = { kind: 'split', dir: 'h', weights, children };
      return {
        part: cabinet(item, def, face, true, carcassH),
        dims,
        worktop: false,
        appliance: appH.map((h, i) => appliance(item, def, `appliance bay ${i + 1} — confirm niche`, { ...dims, h })),
      };
    }
    case 'wallCabinet': {
      const doors = clamp(Math.round(item.params?.doors ?? 1), 1, 3);
      const face: Zone =
        doors === 1
          ? { kind: 'leaf', fill: 'door' }
          : doors === 2
            ? { kind: 'leaf', fill: 'doorPair' }
            : {
                kind: 'split',
                dir: 'v',
                weights: [1, 1, 1],
                children: [
                  { kind: 'leaf', fill: 'door' },
                  { kind: 'leaf', fill: 'door' },
                  { kind: 'leaf', fill: 'door' },
                ],
              };
      // plinth irrelevant: elevation > 0.3 makes cabinetPanels treat it as wall-mounted
      return { part: cabinet(item, def, face, false, carcassH), dims, worktop: false };
    }
    case 'shelf':
      return { part: null, dims, worktop: false, panels: shelfPanels(item) };
    case 'backsplash':
    case 'woodPlane':
      return { part: null, dims, worktop: false, panels: slabPanels(item, def) };
    default:
      return null;
  }
}
