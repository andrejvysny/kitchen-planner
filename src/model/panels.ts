import { footprintPolygon } from './parts';
import type { BoardPartDef, CabinetPartDef, CustomPartDef, FreeformPartDef, Point, Zone } from './types';
import { walkZones } from './zones';

/**
 * The panel list is the single geometric truth for custom parts: a pure,
 * renderer-independent description of every physical board a part is made of.
 * The 3D view turns panels into meshes (src/view3d/partMeshes.ts); a future
 * manufacturing export (cut lists, CNC outlines) serializes the same list.
 * Positions are item-local meters: x/z = panel center, y = panel bottom,
 * +z = front. `rotY` yaws the panel about its own vertical axis.
 */

export const PLINTH_H = 0.1;
export const FRONT_T = 0.018;
export const GAP = 0.004;
export const WORKTOP_T = 0.035;

/** Drawer-box sizing knobs, mirrored from ManufactureSettings.drawer (src/model/manufacture/settings.ts). */
export interface DrawerPanelParams {
  bottomT: number;
  backT: number;
  widthDeduction: number;
  depthDeduction: number;
  boxHeight: number;
}

/**
 * Geometric knobs threaded through the panel generators, sourced from the
 * design's `manufacture` settings via `panelParamsFrom` (manufacture/settings.ts).
 * Unused by the generators in this phase — Phase 1 threads it through; today's
 * generators still use the bare PLINTH_H/FRONT_T/GAP/WORKTOP_T constants above,
 * which is why DEFAULT_PANEL_PARAMS must stay numerically identical to them.
 */
export interface PanelParams {
  carcassT: number;
  frontT: number;
  reveal: number;
  plinthH: number;
  plinthInset: number;
  worktopT: number;
  backMode: 'groove' | 'screwed';
  backT: number;
  grooveDepth: number;
  backInset: number;
  shelfSetback: number;
  drawer: DrawerPanelParams;
}

export const DEFAULT_PANEL_PARAMS: PanelParams = {
  carcassT: 0.018,
  frontT: FRONT_T,
  reveal: GAP,
  plinthH: PLINTH_H,
  plinthInset: 0.045,
  worktopT: WORKTOP_T,
  backMode: 'groove',
  backT: 0.003,
  grooveDepth: 0.008,
  backInset: 0.012,
  shelfSetback: 0.02,
  drawer: { bottomT: 0.016, backT: 0.016, widthDeduction: 0.084, depthDeduction: 0.01, boxHeight: 0.09 },
};

export type PanelShape =
  | { kind: 'box'; w: number; h: number; d: number }
  | { kind: 'cyl'; dia: number; h: number }
  /** vertical extrusion of a plan-local polygon (+y = front), thickness h */
  | { kind: 'prism'; outline: Point[]; holes?: Point[][]; h: number };

export type PanelRole =
  | 'carcass'
  | 'plinth'
  | 'worktop'
  | 'front'
  | 'panel'
  | 'frame'
  | 'glass'
  | 'niche'
  | 'shelf'
  | 'board';

export interface Panel {
  /** stable within the part, e.g. 'z0-1.front2' */
  id: string;
  role: PanelRole;
  shape: PanelShape;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** colour slot — the renderer/exporter resolves it against the part/item */
  slot: 'front' | 'accent' | 'plinth' | 'glass';
  finish: 'matte' | 'wood';
  /** shade factor on the resolved colour (carcass darkening, leg tint) */
  tint?: number;
  /** handleless fronts carry a routed groove along this edge (decoration) */
  groove?: 'top' | 'bottom';
  /** freeform only: the source board, for preview picking */
  boardId?: string;
}

export interface PartDims {
  w: number;
  d: number;
  h: number;
  elevation: number;
}

type Place = (lx: number, lz: number) => { x: number; z: number };

const AT: Place = (lx, lz) => ({ x: lx, z: lz });

function boxPanel(
  id: string,
  role: PanelRole,
  w: number,
  h: number,
  d: number,
  lx: number,
  y: number,
  lz: number,
  place: Place,
  rotY: number,
  rest: Partial<Panel> = {}
): Panel {
  return {
    id,
    role,
    shape: { kind: 'box', w, h, d },
    ...place(lx, lz),
    y,
    rotY,
    slot: 'front',
    finish: 'matte',
    ...rest,
  };
}

/** Split a width into n fronts with small gaps; calls fn(centerX, frontW). */
function splitFronts(w: number, n: number, fn: (x: number, fw: number) => void): void {
  const fw = (w - GAP * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    fn(-w / 2 + GAP + fw / 2 + i * (fw + GAP), fw);
  }
}

interface FaceOpts {
  groove: 'top' | 'bottom';
  /** interior depth available behind the face */
  nicheD: number;
  /** emit per-zone carcass blocks behind closed zones (rect cabinets) */
  carcass: boolean;
}

/** Panels for a zone tree laid onto one face: x across it, y up, fronts ending at zFront. */
function facePanels(
  out: Panel[],
  face: Zone,
  faceW: number,
  faceH: number,
  y0: number,
  zFront: number,
  place: Place,
  rotY: number,
  o: FaceOpts
): void {
  // interior blocks share the classic carcass depth: inset FRONT_T behind the fronts
  const cd = o.nicheD - FRONT_T;
  const zc = zFront - FRONT_T - cd / 2;
  const front = (id: string, w: number, h: number, lx: number, y: number): void => {
    out.push(
      boxPanel(id, 'front', w, h, FRONT_T, lx, y, zFront - FRONT_T / 2, place, rotY, {
        groove: o.groove,
      })
    );
  };
  for (const r of walkZones(face, faceW, faceH)) {
    const zid = `z${r.path.join('-') || 'r'}`;
    const xc = r.x + r.w / 2 - faceW / 2;
    const yb = y0 + r.y;
    const leaf = r.leaf;
    if (o.carcass && leaf.fill !== 'open') {
      out.push(boxPanel(`${zid}.carcass`, 'carcass', r.w, r.h, cd, xc, yb, zc, place, rotY, { tint: 0.92 }));
    }
    if (leaf.fill === 'drawers') {
      const n = Math.max(1, leaf.drawers ?? 1);
      const fh = (r.h - GAP * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        front(`${zid}.front${i}`, r.w - GAP * 2, fh, xc, yb + GAP + i * (fh + GAP));
      }
    } else if (leaf.fill === 'door' || leaf.fill === 'doorPair') {
      let i = 0;
      splitFronts(r.w, leaf.fill === 'doorPair' ? 2 : 1, (dx, fw) =>
        front(`${zid}.front${i++}`, fw, r.h - GAP, xc + dx, yb + GAP / 2)
      );
    } else if (leaf.fill === 'panel') {
      out.push(
        boxPanel(`${zid}.panel`, 'panel', r.w - GAP * 2, r.h - GAP, FRONT_T, xc, yb + GAP / 2, zFront - FRONT_T / 2, place, rotY)
      );
    } else if (leaf.fill === 'glass') {
      const fw = r.w - GAP * 2;
      const fh = r.h - GAP;
      const s = 0.05;
      const zf = zFront - FRONT_T / 2;
      const yg = yb + GAP / 2;
      out.push(
        boxPanel(`${zid}.frame0`, 'frame', fw, s, FRONT_T, xc, yg, zf, place, rotY),
        boxPanel(`${zid}.frame1`, 'frame', fw, s, FRONT_T, xc, yg + fh - s, zf, place, rotY),
        boxPanel(`${zid}.frame2`, 'frame', s, fh - s * 2, FRONT_T, xc - fw / 2 + s / 2, yg + s, zf, place, rotY),
        boxPanel(`${zid}.frame3`, 'frame', s, fh - s * 2, FRONT_T, xc + fw / 2 - s / 2, yg + s, zf, place, rotY),
        boxPanel(`${zid}.glass`, 'glass', fw - s * 2, fh - s * 2, 0.006, xc, yg + s, zf, place, rotY, { slot: 'glass' })
      );
    } else {
      // open niche: a real accent-wood box, visible from the front
      const acc: Partial<Panel> = { slot: 'accent', finish: 'wood' };
      out.push(
        boxPanel(`${zid}.niche-back`, 'niche', r.w, r.h, 0.012, xc, yb, zFront - o.nicheD + 0.02, place, rotY, acc),
        boxPanel(`${zid}.niche-left`, 'niche', 0.015, r.h, cd, xc - r.w / 2 + 0.0075, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-right`, 'niche', 0.015, r.h, cd, xc + r.w / 2 - 0.0075, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-bottom`, 'niche', r.w, 0.015, cd, xc, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-top`, 'niche', r.w, 0.015, cd, xc, yb + r.h - 0.015, zc, place, rotY, acc)
      );
      const n = Math.max(0, leaf.shelves ?? 1);
      for (let i = 0; i < n; i++) {
        const sy = yb + ((i + 1) * r.h) / (n + 1);
        out.push(boxPanel(`${zid}.shelf${i}`, 'shelf', r.w - 0.03, 0.02, cd - 0.02, xc, sy - 0.01, zc, place, rotY, acc));
      }
    }
  }
}

/** Pull an edge (vertex indices i, j) of a footprint inward by `amount` along -outward. */
function insetEdge(poly: Point[], i: number, j: number, outward: Point, amount: number): void {
  for (const k of [i, j]) {
    poly[k] = { x: poly[k].x - outward.x * amount, y: poly[k].y - outward.y * amount };
  }
}

export function cabinetPanels(part: CabinetPartDef, dims: PartDims): Panel[] {
  const { w, d, h } = dims;
  const out: Panel[] = [];
  const wallMounted = dims.elevation > 0.3;
  const hasPlinth = !wallMounted && part.plinth;
  const topT = part.worktop ? WORKTOP_T : 0;
  const y0 = hasPlinth ? PLINTH_H : 0;
  const bodyH = h - y0 - topT;
  if (bodyH <= 0.05) return out;
  const opts: FaceOpts = { groove: wallMounted ? 'bottom' : 'top', nicheD: d, carcass: true };

  const fpPoly = footprintPolygon(part, w, d);
  if (!fpPoly) {
    if (hasPlinth) {
      out.push(boxPanel('plinth', 'plinth', w - 0.06, PLINTH_H, d - 0.05, 0, 0, -0.02, AT, 0, { slot: 'plinth' }));
    }
    facePanels(out, part.face, w, bodyH, y0, d / 2, AT, 0, opts);
    if (topT) {
      out.push(
        boxPanel('worktop', 'worktop', w + 0.02, topT, d + 0.02, 0, h - topT, 0.005, AT, 0, {
          slot: 'accent',
          finish: 'wood',
        })
      );
    }
    return out;
  }

  // polygon footprint (chamfer / cornerL): prism carcass with the face edges
  // inset by FRONT_T so slabs finish flush with the footprint outline
  const fp = part.footprint;
  const carcassPoly = fpPoly.map((p) => ({ ...p }));
  const faces: { i: number; j: number; outward: Point; content: 'zones' | 'panel' | 'door' }[] = [];
  if (fp.kind === 'chamfer') {
    const [i, j] = fp.corner === 'left' ? [3, 4] : [2, 3];
    const ex = fpPoly[j].x - fpPoly[i].x;
    const ey = fpPoly[j].y - fpPoly[i].y;
    const len = Math.hypot(ex, ey) || 1;
    // for both chamfer corners the outward normal of edge i→j is (ey, -ex)
    faces.push({ i, j, outward: { x: ey / len, y: -ex / len }, content: fp.face === 'angled' ? 'zones' : 'panel' });
    const [fi, fj] = fp.corner === 'left' ? [2, 3] : [3, 4];
    faces.push({ i: fi, j: fj, outward: { x: 0, y: 1 }, content: fp.face === 'front' ? 'zones' : 'panel' });
  } else if (fp.kind === 'cornerL') {
    const front = fp.notch === 'left' ? [2, 3] : [4, 5];
    faces.push({ i: front[0], j: front[1], outward: { x: 0, y: 1 }, content: 'zones' });
    faces.push({ i: 3, j: 4, outward: { x: fp.notch === 'left' ? -1 : 1, y: 0 }, content: fp.face2 });
  }
  for (const f of faces) insetEdge(carcassPoly, f.i, f.j, f.outward, FRONT_T);

  if (hasPlinth) {
    const c = fpPoly.reduce((s, p) => ({ x: s.x + p.x / fpPoly.length, y: s.y + p.y / fpPoly.length }), { x: 0, y: 0 });
    out.push({
      id: 'plinth',
      role: 'plinth',
      shape: { kind: 'prism', outline: fpPoly.map((p) => ({ x: c.x + (p.x - c.x) * 0.94, y: c.y + (p.y - c.y) * 0.94 })), h: PLINTH_H },
      x: 0,
      y: 0,
      z: 0,
      rotY: 0,
      slot: 'plinth',
      finish: 'matte',
    });
  }
  out.push({
    id: 'carcass',
    role: 'carcass',
    shape: { kind: 'prism', outline: carcassPoly, h: bodyH },
    x: 0,
    y: y0,
    z: 0,
    rotY: 0,
    slot: 'front',
    finish: 'matte',
    tint: 0.92,
  });

  let fi = 0;
  for (const f of faces) {
    const a = fpPoly[f.i];
    const b = fpPoly[f.j];
    const faceW = Math.hypot(b.x - a.x, b.y - a.y);
    // plan (x, y) → world (x, z); the face plane's +z points along `outward`
    const ry = Math.atan2(f.outward.x, f.outward.y);
    const ox = (a.x + b.x) / 2;
    const oz = (a.y + b.y) / 2;
    const place: Place = (lx, lz) => ({
      x: ox + lx * Math.cos(ry) + lz * Math.sin(ry),
      z: oz - lx * Math.sin(ry) + lz * Math.cos(ry),
    });
    const id = `f${fi++}`;
    if (f.content === 'zones') {
      facePanels(out, part.face, faceW, bodyH, y0, 0, place, ry, { ...opts, nicheD: Math.min(0.3, d), carcass: false });
    } else if (f.content === 'door') {
      out.push(
        boxPanel(`${id}.front`, 'front', faceW - GAP * 2, bodyH - GAP, FRONT_T, 0, y0 + GAP / 2, -FRONT_T / 2, place, ry, {
          groove: opts.groove,
        })
      );
    } else {
      out.push(
        boxPanel(`${id}.panel`, 'panel', faceW - GAP * 2, bodyH - GAP, FRONT_T, 0, y0 + GAP / 2, -FRONT_T / 2, place, ry)
      );
    }
  }
  if (topT) {
    out.push({
      id: 'worktop',
      role: 'worktop',
      shape: { kind: 'prism', outline: fpPoly.map((p) => ({ x: p.x * 1.01, y: p.y * 1.01 })), h: topT },
      x: 0,
      y: h - topT,
      z: 0,
      rotY: 0,
      slot: 'accent',
      finish: 'wood',
    });
  }
  return out;
}

export function boardPanels(part: BoardPartDef, dims: PartDims): Panel[] {
  const outline = footprintPolygon(part, dims.w, dims.d);
  if (!outline || outline.length < 3) return [];
  const sx = dims.w / (part.w || 1);
  const sy = dims.d / (part.d || 1);
  const holes = part.holes.map((hole) => {
    const x = hole.x * sx;
    const y = hole.y * sy;
    const hw = (hole.w * sx) / 2;
    const hd = (hole.d * sy) / 2;
    return [
      { x: x - hw, y: y - hd },
      { x: x + hw, y: y - hd },
      { x: x + hw, y: y + hd },
      { x: x - hw, y: y + hd },
    ];
  });
  return [
    {
      id: 'slab',
      role: 'board',
      shape: { kind: 'prism', outline, holes, h: dims.h },
      x: 0,
      y: 0,
      z: 0,
      rotY: 0,
      slot: 'front',
      finish: part.material === 'matte' ? 'matte' : 'wood',
    },
  ];
}

export function freeformPanels(part: FreeformPartDef, dims: PartDims): Panel[] {
  const sx = dims.w / (part.w || 1);
  const sy = dims.h / (part.h || 1);
  const sz = dims.d / (part.d || 1);
  return part.boards.map((b): Panel => {
    const base = {
      id: b.id,
      role: 'board' as const,
      x: b.x * sx,
      y: b.y * sy,
      z: b.z * sz,
      rotY: b.rotY,
      slot: b.slot,
      tint: b.tint !== undefined && b.tint !== 1 ? b.tint : undefined,
      boardId: b.id,
    };
    if (b.shape === 'cyl') {
      return { ...base, shape: { kind: 'cyl', dia: b.w * sx, h: b.h * sy }, finish: 'matte' };
    }
    return {
      ...base,
      shape: { kind: 'box', w: b.w * sx, h: b.h * sy, d: b.d * sz },
      finish: b.slot === 'accent' ? 'wood' : 'matte',
      groove: b.style === 'front' ? 'top' : undefined,
    };
  });
}

/** Every physical panel of a custom part, at the given instance dimensions. */
export function partPanels(part: CustomPartDef, dims: PartDims): Panel[] {
  if (part.type === 'cabinet') return cabinetPanels(part, dims);
  if (part.type === 'board') return boardPanels(part, dims);
  return freeformPanels(part, dims);
}
