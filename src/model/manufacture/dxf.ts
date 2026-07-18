import type { CutPart, DrillOp, GrooveOp } from './types';
import type { Point } from '../types';

/**
 * Cut parts → minimal DXF R12 (AC1009) for maximum CAM compatibility. Every part
 * row is laid out once in a left-to-right shelf-packed grid (sorted by area,
 * wrapped at 2800 mm) with its outline on CUT, drills as CIRCLEs on a
 * per-diameter/depth DRILL layer (through-holes on DRILL_D5_THRU), grooves as
 * closed polylines on GROOVE, and an id + size label on ETCH. Box parts render a
 * rectangle; prism parts (chamfer tops, worktops, boards) render their stored
 * CNC outline polygon. String building only — no external dependency.
 *
 * Coordinates are millimetres (u → X, v → Y), rounded to 0.1 mm.
 */

const MAX_ROW_W = 2800;
const GUTTER = 50;
const LABEL_H = 20;
const LABEL_GAP = 10;

const f = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
};

class Dxf {
  private out: string[] = [];
  pair(code: number, value: string | number): void {
    this.out.push(String(code), String(value));
  }
  toString(): string {
    return this.out.join('\n') + '\n';
  }
}

interface Placed {
  part: CutPart;
  ox: number;
  oy: number;
  dw: number;
  dh: number;
}

/** Drawn bbox extents of a part (mm): box → length × width, prism → outline bbox. */
function drawnSize(p: CutPart): { dw: number; dh: number } {
  if (p.outline && p.outline.length >= 3) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of p.outline) {
      minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    }
    return { dw: maxX - minX, dh: maxY - minY };
  }
  return { dw: p.lengthMm, dh: p.widthMm };
}

/** DRILL layer name for an op — confirmat is a through-hole. */
function drillLayer(op: DrillOp): string {
  if (op.kind === 'confirmat') return 'DRILL_D5_THRU';
  return `DRILL_D${op.dia}_T${op.depth}`;
}

function layerColor(name: string): number {
  if (name === 'CUT') return 7;
  if (name === 'ETCH') return 3;
  if (name === 'GROOVE') return 5;
  if (name === 'DRILL_D5_THRU') return 2;
  return 1;
}

function polyline(dxf: Dxf, layer: string, pts: Point[]): void {
  dxf.pair(0, 'POLYLINE');
  dxf.pair(8, layer);
  dxf.pair(66, 1);
  dxf.pair(70, 1); // closed
  for (const q of pts) {
    dxf.pair(0, 'VERTEX');
    dxf.pair(8, layer);
    dxf.pair(10, f(q.x));
    dxf.pair(20, f(q.y));
  }
  dxf.pair(0, 'SEQEND');
}

function grooveRect(g: GrooveOp, ox: number, oy: number): Point[] {
  // axis 'u' runs along the length (u = from..to) at v = at..at+width;
  // axis 'v' runs along the width (v = from..to) at u = at..at+width.
  const [u0, u1, v0, v1] = g.axis === 'u'
    ? [g.from, g.to, g.at, g.at + g.width]
    : [g.at, g.at + g.width, g.from, g.to];
  return [
    { x: ox + u0, y: oy + v0 },
    { x: ox + u1, y: oy + v0 },
    { x: ox + u1, y: oy + v1 },
    { x: ox + u0, y: oy + v1 },
  ];
}

export function cutPartsDxf(parts: CutPart[]): string {
  // ---- shelf-pack layout ----
  const sized = parts.map((p) => ({ p, ...drawnSize(p) }));
  sized.sort((a, b) => b.dw * b.dh - a.dw * a.dh);
  const placed: Placed[] = [];
  let x = 0;
  let baseY = 0;
  let rowH = 0;
  for (const s of sized) {
    if (x > 0 && x + s.dw > MAX_ROW_W) {
      baseY -= rowH + LABEL_H + LABEL_GAP + GUTTER;
      x = 0;
      rowH = 0;
    }
    placed.push({ part: s.p, ox: x, oy: baseY, dw: s.dw, dh: s.dh });
    x += s.dw + GUTTER;
    rowH = Math.max(rowH, s.dh);
  }

  // ---- distinct layers ----
  const drillLayers = new Set<string>();
  for (const p of parts) for (const op of p.drills) drillLayers.add(drillLayer(op));
  const layers = ['CUT', 'ETCH', 'GROOVE', ...[...drillLayers].sort()];

  const dxf = new Dxf();
  // HEADER
  dxf.pair(0, 'SECTION');
  dxf.pair(2, 'HEADER');
  dxf.pair(9, '$ACADVER');
  dxf.pair(1, 'AC1009');
  dxf.pair(9, '$INSUNITS');
  dxf.pair(70, 4); // millimetres
  dxf.pair(0, 'ENDSEC');
  // TABLES → LAYER table
  dxf.pair(0, 'SECTION');
  dxf.pair(2, 'TABLES');
  dxf.pair(0, 'TABLE');
  dxf.pair(2, 'LAYER');
  dxf.pair(70, layers.length);
  for (const name of layers) {
    dxf.pair(0, 'LAYER');
    dxf.pair(2, name);
    dxf.pair(70, 0);
    dxf.pair(62, layerColor(name));
    dxf.pair(6, 'CONTINUOUS');
  }
  dxf.pair(0, 'ENDTAB');
  dxf.pair(0, 'ENDSEC');
  // ENTITIES
  dxf.pair(0, 'SECTION');
  dxf.pair(2, 'ENTITIES');
  for (const pl of placed) {
    const p = pl.part;
    // outline
    if (p.outline && p.outline.length >= 3) {
      let minX = Infinity, minY = Infinity;
      for (const q of p.outline) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); }
      polyline(dxf, 'CUT', p.outline.map((q) => ({ x: pl.ox + q.x - minX, y: pl.oy + q.y - minY })));
    } else {
      polyline(dxf, 'CUT', [
        { x: pl.ox, y: pl.oy },
        { x: pl.ox + pl.dw, y: pl.oy },
        { x: pl.ox + pl.dw, y: pl.oy + pl.dh },
        { x: pl.ox, y: pl.oy + pl.dh },
      ]);
    }
    // grooves
    for (const g of p.grooves) polyline(dxf, 'GROOVE', grooveRect(g, pl.ox, pl.oy));
    // drills
    for (const op of p.drills) {
      dxf.pair(0, 'CIRCLE');
      dxf.pair(8, drillLayer(op));
      dxf.pair(10, f(pl.ox + op.u));
      dxf.pair(20, f(pl.oy + op.v));
      dxf.pair(40, f(op.dia / 2));
    }
    // label
    const size = `${p.lengthMm}×${p.widthMm}×${p.thicknessMm}`;
    const label = p.qty > 1 ? `${p.refId} ${size} ×${p.qty}` : `${p.refId} ${size}`;
    dxf.pair(0, 'TEXT');
    dxf.pair(8, 'ETCH');
    dxf.pair(10, f(pl.ox));
    dxf.pair(20, f(pl.oy + pl.dh + LABEL_GAP));
    dxf.pair(40, LABEL_H);
    dxf.pair(1, label);
  }
  dxf.pair(0, 'ENDSEC');
  dxf.pair(0, 'EOF');
  return dxf.toString();
}
