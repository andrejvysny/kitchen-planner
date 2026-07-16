import {
  BACK_T,
  CARCASS_T,
  defaultInterior,
  DRAWER_BOTTOM_T,
  DRAWER_SIDE_T,
  drawerBoxDims,
  resolveInterior,
} from './interior';
import { footprintPolygon } from './parts';
import type { BoardPartDef, CabinetPartDef, CustomPartDef, FreeformPartDef, Point, Zone } from './types';
import { walkSplits, walkZones, type ZoneRect } from './zones';

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

export type PanelShape =
  | { kind: 'box'; w: number; h: number; d: number }
  | { kind: 'cyl'; dia: number; h: number }
  /** vertical extrusion of a plan-local polygon (+y = front), thickness h */
  | { kind: 'prism'; outline: Point[]; holes?: Point[][]; h: number };

export type PanelRole =
  | 'carcass'
  | 'divider'
  | 'plinth'
  | 'worktop'
  | 'front'
  | 'panel'
  | 'frame'
  | 'glass'
  | 'niche'
  | 'shelf'
  | 'drawerBox'
  | 'board';

/**
 * How a panel moves for the open-preview — and which hardware it implies.
 * Geometric truth (the hinge side is a drilling datum, the slide travel
 * derives from the cavity depth only the generator knows); the ANGLE/pose is
 * cosmetic and lives in the mesh layer + ephemeral view state.
 */
export interface PanelMotion {
  /** all panels moving together share it (the owning front's id) */
  unit: string;
  kind: 'hinge' | 'slide';
  /** hinge only: the edge carrying the hinges */
  side?: 'left' | 'right' | 'top' | 'bottom';
  /** slide only: extension in meters (≈ cavity depth × 0.9) */
  travel?: number;
}

export interface Panel {
  /** stable within the part, e.g. 'z0-1.front2' */
  id: string;
  role: PanelRole;
  shape: PanelShape;
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** colour slot — the renderer/exporter resolves it against the part/item;
   * 'counter' follows the room worktop style (per-item override wins) */
  slot: 'front' | 'accent' | 'plinth' | 'glass' | 'counter';
  finish: 'matte' | 'wood';
  /** shade factor on the resolved colour (carcass darkening, leg tint) */
  tint?: number;
  /** handleless fronts carry a routed groove along this edge (decoration) */
  groove?: 'top' | 'bottom';
  /** doors/drawers: how this panel opens in the 3D preview */
  motion?: PanelMotion;
  /** freeform only: the source board, for preview picking */
  boardId?: string;
}

export interface PartDims {
  w: number;
  d: number;
  h: number;
  elevation: number;
}

/**
 * The front face the zone tree lays out on, from the cabinet's body math
 * (single source — the studio canvas and any host-anchor math reuse it).
 */
export function cabinetFaceSize(part: CabinetPartDef): { faceW: number; faceH: number } {
  const wallMounted = part.elevation > 0.3;
  const topT = part.worktop ? WORKTOP_T : 0;
  const y0 = !wallMounted && part.plinth ? PLINTH_H : 0;
  const fp = part.footprint;
  let faceW = part.w;
  if (fp.kind === 'chamfer') faceW = fp.face === 'angled' ? Math.hypot(fp.cx, fp.cz) : part.w - fp.cx;
  else if (fp.kind === 'cornerL') faceW = part.w - fp.nw;
  return { faceW: Math.max(0.1, faceW), faceH: Math.max(0.1, part.h - y0 - topT) };
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
  /** true when a hollow shell + dividers back this face (rect cabinets) */
  shell: boolean;
}

/** A leaf's usable cavity between shell/divider boards, face-local. */
export interface Cavity {
  x0: number;
  w: number;
  y0: number;
  h: number;
}

/**
 * Inset a zone rect by the boards that bound it: full carcass thickness at
 * the shell (or on faces without a shell), half at a shared divider — so the
 * cut list counts every board exactly once and shelf widths are true.
 * Exported for the interior editor: its canvas lays out in exactly this box.
 */
export function zoneCavity(r: ZoneRect, faceW: number, faceH: number, shell: boolean): Cavity {
  const eps = 1e-4;
  const at = (outer: boolean): number => (!shell || outer ? CARCASS_T : CARCASS_T / 2);
  const l = at(r.x < eps);
  const rt = at(r.x + r.w > faceW - eps);
  const b = at(r.y < eps);
  const t = at(r.y + r.h > faceH - eps);
  return { x0: r.x + l, w: r.w - l - rt, y0: r.y + b, h: r.h - b - t };
}

/**
 * The box interior elements lay out in, per fill: open niches sit inside
 * their accent lining, closed fills inside the carcass cavity. The interior
 * editor and facePanels share this — WYSIWYG down to the millimetre.
 */
export function interiorBox(
  r: ZoneRect,
  faceW: number,
  faceH: number,
  fill: string,
  shell: boolean
): Cavity {
  if (fill === 'open') {
    return { x0: r.x + 0.015, w: r.w - 0.03, y0: r.y + 0.015, h: r.h - 0.03 };
  }
  return zoneCavity(r, faceW, faceH, shell);
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
  // interior space shares the classic carcass depth: inset FRONT_T behind the fronts
  const cd = o.nicheD - FRONT_T;
  const zc = zFront - FRONT_T - cd / 2;
  // usable cavity depth ends at the back board
  const cavD = cd - BACK_T;
  const zCav = zc + BACK_T / 2;
  const acc: Partial<Panel> = { slot: 'accent', finish: 'wood' };
  const front = (id: string, w: number, h: number, lx: number, y: number, motion?: PanelMotion): void => {
    out.push(
      boxPanel(id, 'front', w, h, FRONT_T, lx, y, zFront - FRONT_T / 2, place, rotY, {
        groove: o.groove,
        motion,
      })
    );
  };
  /** one physical drawer box (sides/back/bottom) at cavity coords */
  const drawerBox = (
    id: string,
    cav: Cavity,
    boxY: number,
    boxH: number,
    unit: string
  ): { boxW: number; boxD: number; travel: number } | null => {
    const dims = drawerBoxDims(cav.w, boxH, cavD);
    if (!dims) return null;
    const motion: PanelMotion = { unit, kind: 'slide', travel: dims.travel };
    const xc = cav.x0 + cav.w / 2 - faceW / 2;
    const zBoxC = zFront - FRONT_T - 0.005 - dims.boxD / 2;
    const y = y0 + boxY;
    const rest: Partial<Panel> = { ...acc, motion };
    out.push(
      boxPanel(`${id}.side-l`, 'drawerBox', DRAWER_SIDE_T, dims.sideH, dims.boxD, xc - dims.boxW / 2 + DRAWER_SIDE_T / 2, y, zBoxC, place, rotY, rest),
      boxPanel(`${id}.side-r`, 'drawerBox', DRAWER_SIDE_T, dims.sideH, dims.boxD, xc + dims.boxW / 2 - DRAWER_SIDE_T / 2, y, zBoxC, place, rotY, rest),
      boxPanel(`${id}.back`, 'drawerBox', dims.boxW - DRAWER_SIDE_T * 2, dims.sideH, DRAWER_SIDE_T, xc, y, zBoxC - dims.boxD / 2 + DRAWER_SIDE_T / 2, place, rotY, rest),
      boxPanel(`${id}.bottom`, 'drawerBox', dims.boxW, DRAWER_BOTTOM_T, dims.boxD, xc, y, zBoxC, place, rotY, rest)
    );
    return dims;
  };
  for (const r of walkZones(face, faceW, faceH)) {
    const zid = `z${r.path.join('-') || 'r'}`;
    const xc = r.x + r.w / 2 - faceW / 2;
    const yb = y0 + r.y;
    const leaf = r.leaf;
    const cav = zoneCavity(r, faceW, faceH, o.shell);
    if (leaf.fill === 'drawers') {
      const n = Math.max(1, leaf.drawers ?? 1);
      const fh = (r.h - GAP * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        const fy = yb + GAP + i * (fh + GAP);
        const unit = `${zid}.front${i}`;
        // every drawer front pulls a real box — the cut list needs its boards
        const dims = drawerBox(`${zid}.dbox${i}`, cav, fy - y0 + 0.01, Math.max(0.05, fh - 0.03), unit);
        front(unit, r.w - GAP * 2, fh, xc, fy, {
          unit,
          kind: 'slide',
          travel: dims?.travel ?? cavD * 0.9,
        });
      }
    } else if (leaf.fill === 'door' || leaf.fill === 'doorPair') {
      let i = 0;
      splitFronts(r.w, leaf.fill === 'doorPair' ? 2 : 1, (dx, fw) => {
        const unit = `${zid}.front${i}`;
        // pairs hinge on their outer edges; single doors carry the leaf's side
        const side =
          leaf.fill === 'doorPair' ? (i === 0 ? 'left' : 'right') : (leaf.hinge ?? 'left');
        i++;
        front(unit, fw, r.h - GAP, xc + dx, yb + GAP / 2, { unit, kind: 'hinge', side });
      });
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
    } else if (leaf.fill === 'appliance') {
      // empty appliance niche: a carcass-toned housing an oven slides into —
      // no front; the appliance item itself renders separately
      const hous: Partial<Panel> = { tint: 0.92 };
      out.push(
        boxPanel(`${zid}.niche-back`, 'niche', r.w, r.h, 0.012, xc, yb, zFront - o.nicheD + 0.02, place, rotY, hous),
        boxPanel(`${zid}.niche-left`, 'niche', 0.015, r.h, cd, xc - r.w / 2 + 0.0075, yb, zc, place, rotY, hous),
        boxPanel(`${zid}.niche-right`, 'niche', 0.015, r.h, cd, xc + r.w / 2 - 0.0075, yb, zc, place, rotY, hous),
        boxPanel(`${zid}.niche-bottom`, 'niche', r.w, 0.015, cd, xc, yb, zc, place, rotY, hous),
        boxPanel(`${zid}.niche-top`, 'niche', r.w, 0.015, cd, xc, yb + r.h - 0.015, zc, place, rotY, hous)
      );
    } else {
      // open niche: a real accent-wood lining, visible from the front
      out.push(
        boxPanel(`${zid}.niche-back`, 'niche', r.w, r.h, 0.012, xc, yb, zFront - o.nicheD + 0.02, place, rotY, acc),
        boxPanel(`${zid}.niche-left`, 'niche', 0.015, r.h, cd, xc - r.w / 2 + 0.0075, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-right`, 'niche', 0.015, r.h, cd, xc + r.w / 2 - 0.0075, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-bottom`, 'niche', r.w, 0.015, cd, xc, yb, zc, place, rotY, acc),
        boxPanel(`${zid}.niche-top`, 'niche', r.w, 0.015, cd, xc, yb + r.h - 0.015, zc, place, rotY, acc)
      );
    }
    // interior elements (shelves / internal drawers) behind closed fronts,
    // glass and inside open niches — resolved to exact positions so the 3D
    // view, the editor and the cut list all see the same boards
    if (['door', 'doorPair', 'glass', 'open'].includes(leaf.fill)) {
      const box = interiorBox(r, faceW, faceH, leaf.fill, o.shell);
      const exc = xc; // shelves stay zone-centred inside asymmetric cavities
      const elements = resolveInterior(leaf.interior ?? defaultInterior(leaf.fill), box.h);
      let si = 0;
      let bi = 0;
      for (const e of elements) {
        if (e.kind === 'shelf') {
          out.push(
            boxPanel(
              `${zid}.shelf${si++}`,
              'shelf',
              box.w,
              CARCASS_T,
              cavD - 0.01,
              exc,
              y0 + box.y0 + e.y - CARCASS_T / 2,
              zCav,
              place,
              rotY,
              acc
            )
          );
        } else {
          const id = `${zid}.ib${bi++}`;
          const dims = drawerBox(id, box, box.y0 + e.y, e.h, id);
          if (dims) {
            // internal drawers carry their own small front board
            out.push(
              boxPanel(`${id}.front`, 'drawerBox', dims.boxW, e.h + 0.02, FRONT_T, exc, y0 + box.y0 + e.y - 0.01, zFront - FRONT_T - GAP - FRONT_T / 2, place, rotY, {
                ...acc,
                motion: { unit: id, kind: 'slide', travel: dims.travel },
              })
            );
          }
        }
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

/** cutout rects (host-local plan coords, +y front) as prism hole polygons */
function cutoutHoles(ctx: HostContext | undefined): Point[][] {
  return (ctx?.cutouts ?? []).map((c) => [
    { x: c.x - c.w / 2, y: c.y - c.d / 2 },
    { x: c.x + c.w / 2, y: c.y - c.d / 2 },
    { x: c.x + c.w / 2, y: c.y + c.d / 2 },
    { x: c.x - c.w / 2, y: c.y + c.d / 2 },
  ]);
}

export function cabinetPanels(part: CabinetPartDef, dims: PartDims, ctx?: HostContext): Panel[] {
  const { w, d, h } = dims;
  const out: Panel[] = [];
  const wallMounted = dims.elevation > 0.3;
  const hasPlinth = !wallMounted && part.plinth;
  const topT = part.worktop ? WORKTOP_T : 0;
  const y0 = hasPlinth ? PLINTH_H : 0;
  const bodyH = h - y0 - topT;
  if (bodyH <= 0.05) return out;
  const opts: FaceOpts = { groove: wallMounted ? 'bottom' : 'top', nicheD: d, shell: true };

  const fpPoly = footprintPolygon(part, w, d);
  if (!fpPoly) {
    if (hasPlinth) {
      out.push(boxPanel('plinth', 'plinth', w - 0.06, PLINTH_H, d - 0.05, 0, 0, -0.02, AT, 0, { slot: 'plinth' }));
    }
    // hollow carcass: one shared shell + one divider board per zone boundary —
    // the same boards a shop would cut, so the panel list IS the cut list
    const cd = d - FRONT_T;
    const zc = -FRONT_T / 2;
    const shell: Partial<Panel> = { tint: 0.92 };
    out.push(
      boxPanel('carcass.left', 'carcass', CARCASS_T, bodyH, cd, -w / 2 + CARCASS_T / 2, y0, zc, AT, 0, shell),
      boxPanel('carcass.right', 'carcass', CARCASS_T, bodyH, cd, w / 2 - CARCASS_T / 2, y0, zc, AT, 0, shell),
      boxPanel('carcass.bottom', 'carcass', w - CARCASS_T * 2, CARCASS_T, cd, 0, y0, zc, AT, 0, shell),
      boxPanel('carcass.top', 'carcass', w - CARCASS_T * 2, CARCASS_T, cd, 0, y0 + bodyH - CARCASS_T, zc, AT, 0, shell),
      boxPanel('carcass.back', 'carcass', w - CARCASS_T * 2, bodyH - CARCASS_T * 2, BACK_T, 0, y0 + CARCASS_T, -d / 2 + BACK_T / 2, AT, 0, shell)
    );
    for (const b of walkSplits(part.face, w, bodyH)) {
      const id = `div.${b.path.join('-') || 'r'}.${b.index}`;
      if (b.dir === 'v') {
        out.push(boxPanel(id, 'divider', CARCASS_T, b.len, cd, b.x - w / 2, y0 + b.y, zc, AT, 0, shell));
      } else {
        out.push(boxPanel(id, 'divider', b.len, CARCASS_T, cd, b.x + b.len / 2 - w / 2, y0 + b.y - CARCASS_T / 2, zc, AT, 0, shell));
      }
    }
    facePanels(out, part.face, w, bodyH, y0, d / 2, AT, 0, opts);
    if (part.finishedBack) {
      out.push(
        boxPanel('back', 'panel', w, bodyH, FRONT_T, 0, y0, -d / 2 + FRONT_T / 2, AT, 0)
      );
    }
    if (topT) {
      // overhang extends the slab beyond the carcass, per edge (default snug)
      const ov = part.worktopOverhang ?? { front: 0.015, back: 0.005, sides: 0.01 };
      const holes = cutoutHoles(ctx);
      if (holes.length) {
        // a sink/hob cutout turns the slab into a prism with real holes —
        // exactly what a CNC cut list needs
        out.push({
          id: 'worktop',
          role: 'worktop',
          shape: {
            kind: 'prism',
            outline: [
              { x: -w / 2 - ov.sides, y: -d / 2 - ov.back },
              { x: w / 2 + ov.sides, y: -d / 2 - ov.back },
              { x: w / 2 + ov.sides, y: d / 2 + ov.front },
              { x: -w / 2 - ov.sides, y: d / 2 + ov.front },
            ],
            holes,
            h: topT,
          },
          x: 0,
          y: h - topT,
          z: 0,
          rotY: 0,
          slot: 'counter',
          finish: 'wood',
        });
      } else {
        out.push(
          boxPanel(
            'worktop',
            'worktop',
            w + ov.sides * 2,
            topT,
            d + ov.front + ov.back,
            0,
            h - topT,
            (ov.front - ov.back) / 2,
            AT,
            0,
            { slot: 'counter', finish: 'wood' }
          )
        );
      }
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
      facePanels(out, part.face, faceW, bodyH, y0, 0, place, ry, { ...opts, nicheD: Math.min(0.3, d), shell: false });
    } else if (f.content === 'door') {
      out.push(
        boxPanel(`${id}.front`, 'front', faceW - GAP * 2, bodyH - GAP, FRONT_T, 0, y0 + GAP / 2, -FRONT_T / 2, place, ry, {
          groove: opts.groove,
          motion: {
            unit: `${id}.front`,
            kind: 'hinge',
            side: fp.kind === 'cornerL' && fp.notch === 'right' ? 'right' : 'left',
          },
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
      shape: {
        kind: 'prism',
        outline: fpPoly.map((p) => ({ x: p.x * 1.01, y: p.y * 1.01 })),
        holes: cutoutHoles(ctx),
        h: topT,
      },
      x: 0,
      y: h - topT,
      z: 0,
      rotY: 0,
      slot: 'counter',
      finish: 'wood',
    });
  }
  return out;
}

export function boardPanels(part: BoardPartDef, dims: PartDims, ctx?: HostContext): Panel[] {
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
  // appliance cutouts arrive in INSTANCE-local meters — appended after the
  // def-space holes were scaled, never scaled themselves
  holes.push(...cutoutHoles(ctx));
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

/** Per-instance host context: cutouts appliances take out of this item's worktop. */
export interface HostContext {
  cutouts: { x: number; y: number; w: number; d: number }[];
}

/** Every physical panel of a custom part, at the given instance dimensions. */
export function partPanels(part: CustomPartDef, dims: PartDims, ctx?: HostContext): Panel[] {
  if (part.type === 'cabinet') return cabinetPanels(part, dims, ctx);
  if (part.type === 'board') return boardPanels(part, dims, ctx);
  return freeformPanels(part, dims);
}
