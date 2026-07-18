/**
 * Pure IR types for the manufacturing export (cut lists, hardware, drilling,
 * drawing sheets). Nothing here does any work yet — later phases build
 * `ManufacturePack`s from a design's panel lists (src/model/panels.ts) and
 * render them to CSV/DXF/PDF. All lengths in this file are millimetres
 * (`MMInt`), unlike the rest of the model which works in meters — cut lists
 * and CNC/drilling data are conventionally specified in whole millimetres.
 */

import type { ItemKind } from '../catalog';
import type { PanelRole } from '../panels';
import type { Point } from '../types';

export type MMInt = number; // millimetres, integer

export interface EdgeBanding {
  L1: MMInt;
  L2: MMInt;
  W1: MMInt;
  W2: MMInt;
}

export interface DrillOp {
  kind: 'system32' | 'hingeCup' | 'hingePlate' | 'confirmat' | 'camBore' | 'dowel' | 'shelfPin';
  u: MMInt;
  v: MMInt;
  dia: MMInt;
  depth: MMInt;
  face: 'A' | 'B' | 'edge';
}

export interface GrooveOp {
  axis: 'u' | 'v';
  at: MMInt;
  width: MMInt;
  depth: MMInt;
  from: MMInt;
  to: MMInt;
}

export interface CutPart {
  key: string;
  refId: string;
  cabinet: string;
  name: string;
  role: PanelRole;
  lengthMm: MMInt;
  widthMm: MMInt;
  thicknessMm: MMInt;
  qty: number;
  material: string;
  grain: boolean;
  edge: EdgeBanding;
  drills: DrillOp[];
  grooves: GrooveOp[];
  outline?: Point[];
  holes?: Point[][];
  notes: string;
}

export interface HardwareItem {
  key: string;
  name: string;
  category: 'hinge' | 'runner' | 'leg' | 'shelfPin' | 'connector' | 'handle' | 'misc';
  qty: number;
  unit: 'pc' | 'set' | 'pair';
  spec: string;
}

export interface ApplianceEntry {
  itemId: string;
  kind: ItemKind;
  label: string;
  wMm: MMInt;
  dMm: MMInt;
  hMm: MMInt;
  note: string;
}

export type DrawPrim =
  | { t: 'poly'; pts: Point[]; closed: boolean; layer: string }
  | { t: 'circle'; c: Point; r: number; layer: string }
  | { t: 'text'; p: Point; s: string; size: number; layer: string; anchor?: 'l' | 'c' | 'r' }
  | { t: 'dim'; a: Point; b: Point; text: string; off: number };

export interface SheetTable {
  headers: string[];
  rows: string[][];
}

export interface DrawingSheet {
  id: string;
  title: string;
  kind: 'cover' | 'floorplan' | 'elevation' | 'cabinet' | 'table';
  wMm: number;
  hMm: number;
  prims: DrawPrim[];
  table?: SheetTable;
}

export interface ManufacturePack {
  cutParts: CutPart[];
  hardware: HardwareItem[];
  appliances: ApplianceEntry[];
  sheets: DrawingSheet[];
  meta: { unit: 'mm'; itemCount: number };
}
