import { footprintPolygon } from './parts';
import type { BoardPartDef, CabinetPartDef, CustomPartDef, FreeformPartDef, Point, Zone } from './types';
import { walkSplits, walkZones } from './zones';

/**
 * The panel list is the single geometric truth for custom parts: a pure,
 * renderer-independent description of every physical board a part is made of.
 * The 3D view turns panels into meshes (src/view3d/partMeshes.ts); a future
 * manufacturing export (cut lists, CNC outlines) serializes the same list.
 * Positions are item-local meters: x/z = panel center, y = panel bottom,
 * +z = front. `rotY` yaws the panel about its own vertical axis.
 *
 * Cabinets decompose into discrete EU-frameless boards, not fused blocks:
 * two `side`s, a `bottom` + `top`, a `back` (grooved-in or screwed-on), one
 * `divider` per internal split line, plus per-leaf fronts and interior boards
 * (`drawerBottom`/`drawerBack`, `shelf`, accent open-niche liner). Polygon
 * footprints (chamfer/cornerL) decompose into `top`/`bottom` prisms + per-edge
 * `side` boards (the rear edge board doubles as the back). All physical sizing
 * flows through PanelParams so the cut-list phase reads real board dimensions.
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
 * DEFAULT_PANEL_PARAMS stays numerically identical to the bare
 * PLINTH_H/FRONT_T/GAP/WORKTOP_T constants above (external callers still use
 * those), so the default render is byte-for-byte the same geometry.
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
  | 'side'
  | 'top'
  | 'bottom'
  | 'back'
  | 'divider'
  | 'drawerBottom'
  | 'drawerBack'
  | 'shelf'
  | 'plinth'
  | 'worktop'
  | 'front'
  | 'panel'
  | 'frame'
  | 'glass'
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

/** carcass darkening applied to structural boards (matches meshKit CARCASS_DARKEN) */
const CARCASS_TINT = 0.92;

type Place = (lx: number, lz: number) => { x: number; z: number };

const AT: Place = (lx, lz) => ({ x: lx, z: lz });

/** Place along an edge whose midpoint→world is (ox, oz), yawed by `ry`. */
function edgePlace(ox: number, oz: number, ry: number): Place {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  return (lx, lz) => ({ x: ox + lx * c + lz * s, z: oz - lx * s + lz * c });
}

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

/** Split a width into n fronts with `gap` reveals; calls fn(centerX, frontW). */
function splitFronts(w: number, n: number, gap: number, fn: (x: number, fw: number) => void): void {
  const fw = (w - gap * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    fn(-w / 2 + gap + fw / 2 + i * (fw + gap), fw);
  }
}

/**
 * Interior extent of a rect within a face, in face coords. A boundary sitting
 * on the face edge is backed by a full member (side/top/bottom) → inset T; an
 * internal boundary is backed by a shared divider centered on it → inset T/2.
 * Everything sized to fit between real boards (shelves, drawer boxes, liners,
 * horizontal-divider spans) flows through this so parts genuinely assemble.
 */
export function leafInterior(
  r: { x: number; y: number; w: number; h: number },
  faceW: number,
  faceH: number,
  T: number
): { x0: number; x1: number; y0: number; y1: number } {
  const e = 1e-4;
  const insL = r.x <= e ? T : T / 2;
  const insR = r.x + r.w >= faceW - e ? T : T / 2;
  const insB = r.y <= e ? T : T / 2;
  const insT = r.y + r.h >= faceH - e ? T : T / 2;
  return { x0: r.x + insL, x1: r.x + r.w - insR, y0: r.y + insB, y1: r.y + r.h - insT };
}

interface FaceOpts {
  groove: 'top' | 'bottom';
  m: PanelParams;
  /** carcass interior depth behind the fronts (shelves / drawer boxes) */
  cd: number;
  /** z center of that interior depth (item-local for rect, face-local for polygon faces) */
  zc: number;
  /** z of the accent open-niche liner (just in front of the structural back) */
  linerZ: number;
  /** rect path emits real drawer boxes; polygon faces stay reduced (no drawer internals) */
  structural: boolean;
}

/** Panels for a zone tree laid onto one face: x across it, y up, fronts ending at zFront. */
function facePanels(
  out: Panel[],
  face: Zone,
  faceW: number,
  faceH: number,
  yBase: number,
  zFront: number,
  place: Place,
  rotY: number,
  o: FaceOpts
): void {
  const { m } = o;
  const T = m.carcassT;
  const g = m.reveal;
  const front = (id: string, w: number, h: number, lx: number, y: number): void => {
    out.push(
      boxPanel(id, 'front', w, h, m.frontT, lx, y, zFront - m.frontT / 2, place, rotY, { groove: o.groove })
    );
  };
  for (const r of walkZones(face, faceW, faceH)) {
    const zid = `z${r.path.join('-') || 'r'}`;
    const xc = r.x + r.w / 2 - faceW / 2;
    const yb = yBase + r.y;
    const leaf = r.leaf;
    if (leaf.fill === 'drawers') {
      const n = Math.max(1, leaf.drawers ?? 1);
      const fh = (r.h - g * (n + 1)) / n;
      const iv = leafInterior(r, faceW, faceH, T);
      const dbW = iv.x1 - iv.x0 - m.drawer.widthDeduction;
      const dDepth = o.cd - m.drawer.depthDeduction;
      const dxc = (iv.x0 + iv.x1) / 2 - faceW / 2;
      for (let i = 0; i < n; i++) {
        const fy = yb + g + i * (fh + g);
        front(`${zid}.front${i}`, r.w - g * 2, fh, xc, fy);
        // drawer box: a metal-sided system, so only the ply bottom + back are boards
        if (o.structural && dbW > 0.02 && dDepth > 0.02) {
          const dby = fy + 0.03;
          out.push(
            boxPanel(`${zid}.drawer${i}.bottom`, 'drawerBottom', dbW, m.drawer.bottomT, dDepth, dxc, dby, o.zc, place, rotY),
            boxPanel(
              `${zid}.drawer${i}.back`,
              'drawerBack',
              dbW,
              m.drawer.boxHeight,
              m.drawer.backT,
              dxc,
              dby + m.drawer.bottomT,
              o.zc - dDepth / 2 + m.drawer.backT / 2,
              place,
              rotY
            )
          );
        }
      }
    } else if (leaf.fill === 'door' || leaf.fill === 'doorPair') {
      let i = 0;
      splitFronts(r.w, leaf.fill === 'doorPair' ? 2 : 1, g, (dx, fw) =>
        front(`${zid}.front${i++}`, fw, r.h - g, xc + dx, yb + g / 2)
      );
    } else if (leaf.fill === 'panel') {
      out.push(
        boxPanel(`${zid}.panel`, 'panel', r.w - g * 2, r.h - g, m.frontT, xc, yb + g / 2, zFront - m.frontT / 2, place, rotY)
      );
    } else if (leaf.fill === 'glass') {
      const fw = r.w - g * 2;
      const fh = r.h - g;
      const s = 0.05;
      const zf = zFront - m.frontT / 2;
      const yg = yb + g / 2;
      out.push(
        boxPanel(`${zid}.frame0`, 'frame', fw, s, m.frontT, xc, yg, zf, place, rotY),
        boxPanel(`${zid}.frame1`, 'frame', fw, s, m.frontT, xc, yg + fh - s, zf, place, rotY),
        boxPanel(`${zid}.frame2`, 'frame', s, fh - s * 2, m.frontT, xc - fw / 2 + s / 2, yg + s, zf, place, rotY),
        boxPanel(`${zid}.frame3`, 'frame', s, fh - s * 2, m.frontT, xc + fw / 2 - s / 2, yg + s, zf, place, rotY),
        boxPanel(`${zid}.glass`, 'glass', fw - s * 2, fh - s * 2, 0.006, xc, yg + s, zf, place, rotY, { slot: 'glass' })
      );
    } else {
      // open niche: an accent-wood back-liner + adjustable accent shelves. Rule E
      // keeps the liner/shelves clear of the surrounding sides/dividers.
      const iv = leafInterior(r, faceW, faceH, T);
      const iw = iv.x1 - iv.x0;
      const ih = iv.y1 - iv.y0;
      const ixc = (iv.x0 + iv.x1) / 2 - faceW / 2;
      const iyb = yBase + iv.y0;
      const acc: Partial<Panel> = { slot: 'accent', finish: 'wood' };
      out.push(boxPanel(`${zid}.liner`, 'back', iw, ih, 0.003, ixc, iyb, o.linerZ, place, rotY, acc));
      const nsh = Math.max(0, leaf.shelves ?? 1);
      for (let i = 0; i < nsh; i++) {
        const sy = iyb + ((i + 1) * ih) / (nsh + 1);
        out.push(
          boxPanel(`${zid}.shelf${i}`, 'shelf', iw - 0.002, T, o.cd - m.shelfSetback, ixc, sy - T / 2, o.zc - m.shelfSetback / 2, place, rotY, acc)
        );
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

export function cabinetPanels(part: CabinetPartDef, dims: PartDims, m: PanelParams = DEFAULT_PANEL_PARAMS): Panel[] {
  const { w, d, h } = dims;
  const out: Panel[] = [];
  const T = m.carcassT;
  const wallMounted = dims.elevation > 0.3;
  const hasPlinth = !wallMounted && part.plinth;
  const topT = part.worktop ? m.worktopT : 0;
  const y0 = hasPlinth ? m.plinthH : 0;
  const bodyH = h - y0 - topT;
  if (bodyH <= 0.05) return out;
  const groove: 'top' | 'bottom' = wallMounted ? 'bottom' : 'top';

  const fpPoly = footprintPolygon(part, w, d);
  if (!fpPoly) {
    // rect footprint: discrete carcass boards + fronts
    // carcass depth: rear at −d/2, front plane at d/2 − frontT (screwed backs steal backT off the rear)
    const screwed = m.backMode === 'screwed';
    const Dc = screwed ? d - m.frontT - m.backT : d - m.frontT;
    const zc = screwed ? -m.frontT / 2 + m.backT / 2 : -m.frontT / 2;
    const Wi = w - 2 * T;
    const Hi = bodyH - 2 * T;

    if (hasPlinth) {
      // thin front kickboard; its front face lands where the old plinth block's did
      out.push(boxPanel('plinth', 'plinth', w - 0.06, m.plinthH, T, 0, 0, d / 2 - m.plinthInset - T / 2, AT, 0, { slot: 'plinth' }));
    }
    const carc: Partial<Panel> = { tint: CARCASS_TINT };
    out.push(
      boxPanel('side-l', 'side', T, bodyH, Dc, -(w / 2 - T / 2), y0, zc, AT, 0, carc),
      boxPanel('side-r', 'side', T, bodyH, Dc, w / 2 - T / 2, y0, zc, AT, 0, carc),
      boxPanel('bottom', 'bottom', Wi, T, Dc, 0, y0, zc, AT, 0, carc),
      boxPanel('top', 'top', Wi, T, Dc, 0, y0 + bodyH - T, zc, AT, 0, carc)
    );
    if (screwed) {
      out.push(boxPanel('back', 'back', w, bodyH, m.backT, 0, y0, -d / 2 + m.backT / 2, AT, 0, carc));
    } else {
      // grooved back: captured grooveDepth into sides/top/bottom on every edge
      out.push(
        boxPanel(
          'back',
          'back',
          Wi + 2 * m.grooveDepth,
          Hi + 2 * m.grooveDepth,
          m.backT,
          0,
          y0 + T - m.grooveDepth,
          -d / 2 + m.backInset + m.backT / 2,
          AT,
          0,
          carc
        )
      );
    }

    // dividers from the split lines of the zone tree
    const splits = walkSplits(part.face, w, bodyH);
    for (let si = 0; si < splits.length; si++) {
      const s = splits[si];
      const iv = leafInterior(s, w, bodyH, T);
      for (let bi = 0; bi < s.boundaries.length; bi++) {
        const b = s.boundaries[bi];
        if (s.dir === 'v') {
          out.push(boxPanel(`div-v${si}-${bi}`, 'divider', T, iv.y1 - iv.y0, Dc, b - w / 2, y0 + iv.y0, zc, AT, 0, carc));
        } else {
          out.push(boxPanel(`div-h${si}-${bi}`, 'divider', iv.x1 - iv.x0, T, Dc, (iv.x0 + iv.x1) / 2 - w / 2, y0 + b - T / 2, zc, AT, 0, carc));
        }
      }
    }

    const linerZ = screwed ? -d / 2 + m.backT + 0.0015 : -d / 2 + m.backInset + m.backT + 0.0015;
    facePanels(out, part.face, w, bodyH, y0, d / 2, AT, 0, { groove, m, cd: Dc, zc, linerZ, structural: true });

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

  // polygon footprint (chamfer / cornerL): top/bottom prisms + per-edge side
  // boards. The rear edge board doubles as an 18mm screwed-style back; no
  // grooved back, dividers or drawer internals in v1.
  const fp = part.footprint;
  const n = fpPoly.length;
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
  const faceEdges = new Set(faces.map((f) => f.i));
  for (const f of faces) insetEdge(carcassPoly, f.i, f.j, f.outward, m.frontT);

  if (hasPlinth) {
    const c = fpPoly.reduce((s, p) => ({ x: s.x + p.x / n, y: s.y + p.y / n }), { x: 0, y: 0 });
    out.push({
      id: 'plinth',
      role: 'plinth',
      shape: { kind: 'prism', outline: fpPoly.map((p) => ({ x: c.x + (p.x - c.x) * 0.94, y: c.y + (p.y - c.y) * 0.94 })), h: m.plinthH },
      x: 0,
      y: 0,
      z: 0,
      rotY: 0,
      slot: 'plinth',
      finish: 'matte',
    });
  }
  // bottom + top slabs (inset like the fronts so they finish flush with the outline)
  for (const [id, role, y] of [
    ['bottom', 'bottom', y0],
    ['top', 'top', y0 + bodyH - T],
  ] as const) {
    out.push({
      id,
      role,
      shape: { kind: 'prism', outline: carcassPoly.map((p) => ({ ...p })), h: T },
      x: 0,
      y,
      z: 0,
      rotY: 0,
      slot: 'front',
      finish: 'matte',
      tint: CARCASS_TINT,
    });
  }
  // per-edge vertical side boards on every edge NOT carrying a front
  const isSide = (e: number): boolean => !faceEdges.has(e);
  for (let k = 0; k < n; k++) {
    if (!isSide(k)) continue;
    const a = fpPoly[k];
    const b = fpPoly[(k + 1) % n];
    const dxE = b.x - a.x;
    const dyE = b.y - a.y;
    const edgeLen = Math.hypot(dxE, dyE) || 1;
    const ux = dxE / edgeLen;
    const uy = dyE / edgeLen;
    // butt joint: at a shared corner between two side boards the lower edge
    // index keeps full length, the higher is trimmed T so they don't collide
    const startCut = k >= 1 && isSide(k - 1) ? T : 0;
    const endCut = k === n - 1 && isSide(0) ? T : 0;
    const boardLen = edgeLen - startCut - endCut;
    if (boardLen <= 0.001) continue;
    const shift = (startCut - endCut) / 2;
    const ox = (a.x + b.x) / 2 + shift * ux;
    const oz = (a.y + b.y) / 2 + shift * uy;
    const ry = Math.atan2(uy, -ux); // outward normal (dy, −dx) → yaw
    out.push(boxPanel(`edge${k}`, 'side', boardLen, bodyH - 2 * T, T, 0, y0 + T, -T / 2, edgePlace(ox, oz, ry), ry, { tint: CARCASS_TINT }));
  }

  let fi = 0;
  const nicheD = Math.min(0.3, d);
  const cd = nicheD - m.frontT;
  for (const f of faces) {
    const a = fpPoly[f.i];
    const b = fpPoly[f.j];
    const faceW = Math.hypot(b.x - a.x, b.y - a.y);
    const ry = Math.atan2(f.outward.x, f.outward.y);
    const place = edgePlace((a.x + b.x) / 2, (a.y + b.y) / 2, ry);
    const id = `f${fi++}`;
    if (f.content === 'zones') {
      facePanels(out, part.face, faceW, bodyH, y0, 0, place, ry, {
        groove,
        m,
        cd,
        zc: -m.frontT - cd / 2,
        linerZ: -nicheD + 0.02,
        structural: false,
      });
    } else if (f.content === 'door') {
      out.push(
        boxPanel(`${id}.front`, 'front', faceW - m.reveal * 2, bodyH - m.reveal, m.frontT, 0, y0 + m.reveal / 2, -m.frontT / 2, place, ry, {
          groove,
        })
      );
    } else {
      out.push(
        boxPanel(`${id}.panel`, 'panel', faceW - m.reveal * 2, bodyH - m.reveal, m.frontT, 0, y0 + m.reveal / 2, -m.frontT / 2, place, ry)
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

export function boardPanels(part: BoardPartDef, dims: PartDims, _m: PanelParams = DEFAULT_PANEL_PARAMS): Panel[] {
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

export function freeformPanels(part: FreeformPartDef, dims: PartDims, _m: PanelParams = DEFAULT_PANEL_PARAMS): Panel[] {
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
export function partPanels(part: CustomPartDef, dims: PartDims, m: PanelParams = DEFAULT_PANEL_PARAMS): Panel[] {
  if (part.type === 'cabinet') return cabinetPanels(part, dims, m);
  if (part.type === 'board') return boardPanels(part, dims, m);
  return freeformPanels(part, dims, m);
}
