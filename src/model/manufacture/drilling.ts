import { FRONT_T, leafInterior, type Panel, type PartDims } from '../panels';
import type { CabinetPartDef, CustomPartDef } from '../types';
import { walkSplits, walkZones } from '../zones';
import { panelParamsFrom } from './settings';
import type { ManufactureSettings } from './settings';
import type { DrillOp, GrooveOp } from './types';

/**
 * Drilling & grooving generator for the manufacturing pipeline. Emits every
 * machining operation a rect-carcass cabinet needs — System-32 shelf-pin line
 * boring, hinge cups + pilots, hinge mounting plates, carcass joinery
 * (confirmat through-holes or cam-lock bores + dowels) and the back-panel
 * groove — as `DrillOp`/`GrooveOp` records expressed in each panel's own 2D cut
 * frame. Pure model code: no Three.js, no Store. Coordinates are millimetres,
 * face-plane positions rounded to 0.1 mm, hole diameters/depths to whole mm.
 *
 * ── COORDINATE CONTRACT (panel 3D-local → cut 2D, consistent with
 *    cutlist.ts `panelToCutPart`/`boxCut`) ─────────────────────────────────
 * A CutPart's 2D frame: u ∈ [0, lengthMm] along the LENGTH axis, v ∈ [0,
 * widthMm] along the WIDTH axis. `boxCut` sets length = the grain axis (height
 * for vertical roles, width for horizontal) and width = the remaining face
 * dimension; thickness is the min axis. Per role:
 *
 *   role            length axis   u = 0 at        width axis   v = 0 at
 *   ─────────────   ───────────   ─────────────   ──────────   ───────────────
 *   side (l/r)      height (y)    BOTTOM (y0)     depth (z)    FRONT edge (+z)
 *   divider (div-v) height (y)    member bottom   depth (z)    FRONT edge (+z)
 *   divider (div-h) width (x)     LEFT (−x)       depth (z)    FRONT edge (+z)
 *   top / bottom    width (x)     LEFT (−x)       depth (z)    FRONT edge (+z)
 *   front (door)    height (y)    BOTTOM          width (x)    HINGE edge
 *
 * For every carcass member (side/divider/top/bottom) the WIDTH axis is the
 * carcass depth Dc, and v is measured from the FRONT edge (z = zc + Dc/2)
 * toward the back. For a door FRONT, v = 0 sits at the hinge edge (the left
 * edge when hinge === 'left', the right edge when 'right'; each doorPair leaf
 * hinges on its own OUTER edge), so cups/pilots need no x-awareness.
 *
 * `face` labels which face an op is drilled from:
 *   - sides           → 'A' (the interior face).
 *   - top / bottom    → 'A' interior, 'B' exterior (confirmat enters 'B').
 *   - dividers        → 'A' = the +x face, 'B' = the −x face (so a divider
 *                       bounding open niches on both sides carries A + B rows).
 *   - door fronts     → 'A' (the rear face — cups + pilots bore from behind).
 *   - cam dowels      → 'edge' (bored into the board's end edge).
 * The DXF renders u → X, v → Y.
 */

export interface PanelOps {
  drills: DrillOp[];
  grooves: GrooveOp[];
}

/** meters → mm, face-plane resolution (0.1 mm). */
const c1 = (m: number): number => Math.round(m * 10000) / 10;
/** meters → mm, whole mm (diameters, depths). */
const ci = (m: number): number => Math.round(m * 1000);

const EPS = 1e-4;

/** Shelf-pin hinge count for a door of height H (mm). */
export function hingeCountForHeight(hMm: number): number {
  if (hMm <= 900) return 2;
  if (hMm <= 1600) return 3;
  if (hMm <= 2000) return 4;
  return 5;
}

/** Evenly spaced cup u-positions (mm): 100 from each end, intermediates between. */
export function hingeUPositions(hMm: number, count: number): number[] {
  if (count <= 1) return [hMm / 2];
  const span = hMm - 200;
  return Array.from({ length: count }, (_, i) => 100 + (span * i) / (count - 1));
}

interface Carcass {
  T: number;
  y0: number;
  bodyH: number;
  Dc: number;
  zc: number;
  Wi: number;
  w: number;
  d: number;
  /** v (from front) at which the back-panel groove starts, meters */
  grooveAt: number;
  grooveWidth: number;
  grooveDepth: number;
  screwed: boolean;
}

/** A carcass board that can receive machining, with its cut-frame mapping. */
interface Member {
  panelId: string;
  orientation: 'v' | 'h';
  /** length of the board along its u axis, meters */
  lengthM: number;
  /** v-axis extent (carcass depth Dc), meters */
  widthM: number;
  thickM: number;
  /** item-space origin subtracted to get u: bottom-Y for 'v', left-X for 'h' */
  uOrigin: number;
  /** working face toward +x/interior */
  faceA: 'A' | 'B';
  faceB: 'A' | 'B';
}

function carcassOf(part: CabinetPartDef, dims: PartDims, m: ManufactureSettings): Carcass | null {
  if (part.type !== 'cabinet' || part.footprint.kind !== 'rect') return null;
  // wall units drill exactly like floor units (hinge plates, pins, joinery,
  // groove) — only wall-hanger fixing is left to the fitter's hardware
  const wallMounted = dims.elevation > 0.3;
  const pp = panelParamsFrom(m);
  const T = pp.carcassT;
  const hasPlinth = !wallMounted && part.plinth;
  const topT = part.worktop ? pp.worktopT : 0;
  const y0 = hasPlinth ? pp.plinthH : 0;
  const bodyH = dims.h - y0 - topT;
  if (bodyH <= 0.05) return null;
  const screwed = pp.backMode === 'screwed';
  const Dc = screwed ? dims.d - pp.frontT - pp.backT : dims.d - pp.frontT;
  const zc = screwed ? -pp.frontT / 2 + pp.backT / 2 : -pp.frontT / 2;
  const Wi = dims.w - 2 * T;
  // groove near-edge from the FRONT contract: Dc − (backInset + backT); +0.2 mm play
  const grooveWidth = pp.backT + 0.0002;
  const grooveAt = Dc - (pp.backInset + pp.backT);
  return {
    T, y0, bodyH, Dc, zc, Wi, w: dims.w, d: dims.d,
    grooveAt, grooveWidth, grooveDepth: pp.grooveDepth, screwed,
  };
}

/** Collect the machinable carcass members from the emitted panel list. */
function membersOf(panels: Panel[], cc: Carcass): Member[] {
  const out: Member[] = [];
  for (const p of panels) {
    if (p.shape.kind !== 'box') continue;
    if (p.id === 'side-l' || p.id === 'side-r') {
      out.push({
        panelId: p.id, orientation: 'v', lengthM: cc.bodyH, widthM: cc.Dc, thickM: cc.T,
        uOrigin: cc.y0, faceA: 'A', faceB: 'A',
      });
    } else if (p.id === 'top' || p.id === 'bottom') {
      out.push({
        panelId: p.id, orientation: 'h', lengthM: cc.Wi, widthM: cc.Dc, thickM: cc.T,
        uOrigin: -cc.Wi / 2, faceA: 'A', faceB: 'B',
      });
    } else if (p.id.startsWith('div-v')) {
      out.push({
        panelId: p.id, orientation: 'v', lengthM: p.shape.h, widthM: cc.Dc, thickM: cc.T,
        uOrigin: p.y, faceA: 'A', faceB: 'B',
      });
    } else if (p.id.startsWith('div-h')) {
      out.push({
        panelId: p.id, orientation: 'h', lengthM: p.shape.w, widthM: cc.Dc, thickM: cc.T,
        uOrigin: p.x - p.shape.w / 2, faceA: 'A', faceB: 'B',
      });
    }
  }
  return out;
}

const opsFor = (map: Map<string, PanelOps>, id: string): PanelOps => {
  let o = map.get(id);
  if (!o) {
    o = { drills: [], grooves: [] };
    map.set(id, o);
  }
  return o;
};

// ── shelf-pin line boring ──────────────────────────────────────────────────

/** Snap a shelf-pin column onto the 32 grid within a member's u-band. */
function shelfPinUs(bandStartM: number, bandEndM: number, cc: Carcass, m: ManufactureSettings): number[] {
  const pitch = m.system32.pitch;
  const margin = m.system32.frontSetback;
  const first = bandStartM + margin;
  const last = bandEndM - margin;
  const us: number[] = [];
  for (let u = first; u <= last + 1e-6; u += pitch) us.push(u);
  return us;
}

/** Locate the vertical member bounding an open leaf on the given side. */
function verticalMemberAtX(
  faceX: number, coverY: number, cc: Carcass, members: Member[], panels: Panel[]
): { member: Member; face: 'A' | 'B' } | null {
  if (faceX <= EPS) {
    const m = members.find((x) => x.panelId === 'side-l');
    return m ? { member: m, face: 'A' } : null; // interior = +x face
  }
  if (faceX >= cc.w - EPS) {
    const m = members.find((x) => x.panelId === 'side-r');
    return m ? { member: m, face: 'A' } : null; // interior = −x face
  }
  // an interior divider: find the div-v panel whose boundary ≈ faceX and whose
  // y-band covers coverY, then pick the face pointing toward the leaf.
  for (const p of panels) {
    if (p.shape.kind !== 'box' || !p.id.startsWith('div-v')) continue;
    const b = p.x + cc.w / 2; // panel center x = boundary − w/2
    if (Math.abs(b - faceX) > 1e-3) continue;
    if (coverY < p.y - EPS || coverY > p.y + p.shape.h + EPS) continue;
    const member = members.find((x) => x.panelId === p.id);
    if (!member) return null;
    // leaf to the right of this boundary (faceX == leaf left) → drill +x ('A');
    // leaf to the left (faceX == leaf right) → drill −x ('B'). Caller passes the
    // face so we decide by whether coverY... use dedicated flag via face arg.
    return { member, face: 'A' };
  }
  return null;
}

function shelfPins(
  part: CabinetPartDef, cc: Carcass, members: Member[], panels: Panel[],
  m: ManufactureSettings, map: Map<string, PanelOps>
): void {
  const dia = ci(m.system32.holeDia);
  const depth = ci(m.system32.holeDepth);
  const setbackMm = c1(m.system32.frontSetback);
  const addColumn = (member: Member, face: 'A' | 'B', bandStartM: number, bandEndM: number): void => {
    const us = shelfPinUs(bandStartM, bandEndM, cc, m);
    const widthMm = c1(member.widthM);
    const vFront = setbackMm;
    const vBack = widthMm - setbackMm;
    if (vBack <= vFront) return;
    const o = opsFor(map, member.panelId);
    for (const uM of us) {
      const u = c1(uM - member.uOrigin);
      if (u < 0 || u > c1(member.lengthM)) continue;
      o.drills.push({ kind: 'shelfPin', u, v: vFront, dia, depth, face });
      o.drills.push({ kind: 'shelfPin', u, v: vBack, dia, depth, face });
    }
  };

  for (const r of walkZones(part.face, cc.w, cc.bodyH)) {
    // shelf-pin line boring on the members bounding a leaf with adjustable
    // shelves: open niches (default 1) and door/doorPair interiors (default 0).
    const fill = r.leaf.fill;
    const isOpen = fill === 'open';
    const isDoored = fill === 'door' || fill === 'doorPair';
    if (!isOpen && !isDoored) continue;
    const shelves = isOpen ? (r.leaf.shelves ?? 1) : (r.leaf.shelves ?? 0);
    if (shelves < 1) continue;
    const iv = leafInterior(r, cc.w, cc.bodyH, cc.T);
    const bandStartY = cc.y0 + iv.y0;
    const bandEndY = cc.y0 + iv.y1;
    const coverY = (bandStartY + bandEndY) / 2;
    // left member: leaf's left edge (drill its +x-facing / interior face)
    const left = verticalMemberAtX(r.x, coverY, cc, members, panels);
    if (left) addColumn(left.member, left.member.panelId === 'side-r' ? 'A' : left.face, bandStartY, bandEndY);
    // right member: leaf's right edge (drill its −x-facing face → 'B' for dividers)
    const right = verticalMemberAtX(r.x + r.w, coverY, cc, members, panels);
    if (right) {
      const rf: 'A' | 'B' = right.member.panelId === 'side-l' || right.member.panelId === 'side-r' ? 'A' : 'B';
      addColumn(right.member, rf, bandStartY, bandEndY);
    }
  }
}

// ── hinges: cups + pilots on fronts, mounting plates on the carcass ─────────

interface DoorHinge {
  frontId: string;
  /** door height, meters */
  hM: number;
  /** door front bottom, item-local y (meters) */
  frontBottomY: number;
  /** face-x of the hinge edge (the member it hangs on) */
  hingeFaceX: number;
  coverY: number;
  /** which vertical edge of the front carries the hinge (v = 0 in the cut frame) */
  side: 'left' | 'right';
}

/** Enumerate every hung door leaf and its hinge edge. */
function doorHinges(part: CabinetPartDef, cc: Carcass, m: ManufactureSettings): DoorHinge[] {
  const pp = panelParamsFrom(m);
  const g = pp.reveal;
  const out: DoorHinge[] = [];
  for (const r of walkZones(part.face, cc.w, cc.bodyH)) {
    const zid = `z${r.path.join('-') || 'r'}`;
    if (r.leaf.fill === 'door') {
      const hinge = r.leaf.hinge === 'right' ? 'right' : 'left';
      const fw = r.w - g * 2;
      const hM = r.h - g;
      const bottomY = cc.y0 + r.y + g / 2;
      const hingeFaceX = hinge === 'left' ? r.x : r.x + r.w;
      out.push({ frontId: `${zid}.front0`, hM, frontBottomY: bottomY, hingeFaceX, coverY: cc.y0 + r.y + r.h / 2, side: hinge });
    } else if (r.leaf.fill === 'doorPair') {
      const hM = r.h - g;
      const bottomY = cc.y0 + r.y + g / 2;
      // leaf 0 = left half hinged on the outer (left) edge; leaf 1 = right half
      out.push({ frontId: `${zid}.front0`, hM, frontBottomY: bottomY, hingeFaceX: r.x, coverY: cc.y0 + r.y + r.h / 2, side: 'left' });
      out.push({ frontId: `${zid}.front1`, hM, frontBottomY: bottomY, hingeFaceX: r.x + r.w, coverY: cc.y0 + r.y + r.h / 2, side: 'right' });
    }
  }
  return out;
}

/**
 * Hinge edge (`'left'`/`'right'`) per hung door-front panel id. Exported so the
 * drawing layer's cabinet FRONT view can place the hinge-cup circles emitted by
 * `itemDrilling` back onto the door — the cup's `v` (its cut-frame width coord)
 * is measured from this edge (see the COORDINATE CONTRACT above). Returns an
 * empty map for non-cabinet / wall-hung / polygon parts (which are not drilled).
 */
export function doorHingeSides(part: CustomPartDef, dims: PartDims, m: ManufactureSettings): Map<string, 'left' | 'right'> {
  const map = new Map<string, 'left' | 'right'>();
  if (part.type !== 'cabinet') return map;
  const cc = carcassOf(part, dims, m);
  if (!cc) return map;
  for (const dh of doorHinges(part, cc, m)) map.set(dh.frontId, dh.side);
  return map;
}

function hinges(
  part: CabinetPartDef, cc: Carcass, members: Member[], panels: Panel[],
  m: ManufactureSettings, map: Map<string, PanelOps>
): void {
  const cupDia = ci(m.system32.hingeCupDia);
  const cupInsetMm = c1(m.system32.hingeCupInset);
  const setbackMm = c1(m.system32.frontSetback);
  const plateDepth = ci(m.system32.holeDepth);
  const pinDia = ci(m.system32.holeDia);

  for (const dh of doorHinges(part, cc, m)) {
    const hMm = c1(dh.hM);
    const front = panels.find((p) => p.id === dh.frontId);
    if (!front || front.shape.kind !== 'box') continue;
    const frontLen = c1(dh.hM); // vertical role → length = height
    const frontWid = c1(front.shape.w);
    const count = hingeCountForHeight(hMm);
    const us = hingeUPositions(hMm, count);
    const fo = opsFor(map, dh.frontId);
    // cups + flanking pilots on the door's rear face ('A'), v from the hinge edge
    for (const uCup of us) {
      if (uCup < cupDia / 2 || uCup > frontLen - cupDia / 2) continue;
      fo.drills.push({ kind: 'hingeCup', u: Math.round(uCup * 10) / 10, v: cupInsetMm, dia: cupDia, depth: 13, face: 'A' });
      // two pilots flanking the cup at ±22.5 mm along u, 10 mm outboard in v
      const pv = cupInsetMm + 10;
      if (pv <= frontWid - 2) {
        for (const du of [-22.5, 22.5]) {
          const pu = Math.round((uCup + du) * 10) / 10;
          if (pu < 2 || pu > frontLen - 2) continue;
          fo.drills.push({ kind: 'hingePlate', u: pu, v: pv, dia: 3, depth: 5, face: 'A' });
        }
      }
    }
    // mounting plates on the carcass member carrying the hinge edge (drilled
    // from the door-facing face → 'A')
    const hit = verticalMemberAtX(dh.hingeFaceX, dh.coverY, cc, members, panels);
    if (!hit) continue;
    const member = hit.member;
    const mo = opsFor(map, member.panelId);
    const memLen = c1(member.lengthM);
    for (const uCup of us) {
      const centerY = dh.frontBottomY + uCup / 1000; // item-local y (meters)
      const uMid = (centerY - member.uOrigin) * 1000; // mm
      for (const du of [-16, 16]) {
        const u = Math.round((uMid + du) * 10) / 10;
        if (u < 2 || u > memLen - 2) continue;
        mo.drills.push({ kind: 'hingePlate', u, v: setbackMm, dia: pinDia, depth: plateDepth, face: 'A' });
      }
    }
  }
}

// ── carcass joinery: confirmat / cam-lock ───────────────────────────────────

export interface CarcassJoint {
  postId: string;
  beamId: string;
  postKind: 'side' | 'top' | 'bottom' | 'divV' | 'divH';
  /** joined board's centerline in the post's u-frame, meters */
  uCenterM: number;
  /** joint depth (carcass depth), meters */
  depthM: number;
  /** beam length along its own u-axis, meters */
  beamLenM: number;
  /** beam end meeting the post: 0 (u=0 end) or beamLenM */
  beamEndM: number;
  /** the post's outer face (confirmat enters here) */
  face: 'A' | 'B';
}

/** Structural joint enumeration (never guessed from raw geometry). */
export function enumerateJoints(part: CabinetPartDef, dims: PartDims, panels: Panel[], m: ManufactureSettings): CarcassJoint[] {
  const cc = carcassOf(part, dims, m);
  if (!cc) return [];
  const members = membersOf(panels, cc);
  const memberById = new Map(members.map((x) => [x.panelId, x] as const));
  const joints: CarcassJoint[] = [];

  const sideL = memberById.get('side-l');
  const sideR = memberById.get('side-r');
  const top = memberById.get('top');
  const bottom = memberById.get('bottom');

  // top + bottom butt into both sides (post = side, through-holes on the side)
  for (const side of [sideL, sideR]) {
    if (!side) continue;
    const endM = side.panelId === 'side-l' ? 0 : cc.Wi; // beam end (top/bottom) near this side
    if (top) {
      joints.push({
        postId: side.panelId, beamId: 'top', postKind: 'side',
        uCenterM: cc.bodyH - cc.T / 2, depthM: cc.Dc, beamLenM: cc.Wi, beamEndM: endM, face: 'B',
      });
    }
    if (bottom) {
      joints.push({
        postId: side.panelId, beamId: 'bottom', postKind: 'side',
        uCenterM: cc.T / 2, depthM: cc.Dc, beamLenM: cc.Wi, beamEndM: endM, face: 'B',
      });
    }
  }

  // dividers, from the zone tree's split boundaries
  const splits = walkSplits(part.face, cc.w, cc.bodyH);
  const divVAt = (faceX: number, coverY: number): Member | null => {
    if (faceX <= EPS) return sideL ?? null;
    if (faceX >= cc.w - EPS) return sideR ?? null;
    for (const p of panels) {
      if (p.shape.kind !== 'box' || !p.id.startsWith('div-v')) continue;
      if (Math.abs(p.x + cc.w / 2 - faceX) > 1e-3) continue;
      if (coverY < p.y - EPS || coverY > p.y + p.shape.h + EPS) continue;
      return memberById.get(p.id) ?? null;
    }
    return null;
  };
  const divHAt = (faceY: number, coverX: number): Member | null => {
    if (faceY <= EPS) return bottom ?? null;
    if (faceY >= cc.bodyH - EPS) return top ?? null;
    for (const p of panels) {
      if (p.shape.kind !== 'box' || !p.id.startsWith('div-h')) continue;
      const centerY = p.y + cc.T / 2;
      if (Math.abs(centerY - cc.y0 - faceY) > 1e-3) continue;
      if (coverX < p.x - p.shape.w / 2 - EPS || coverX > p.x + p.shape.w / 2 + EPS) continue;
      return memberById.get(p.id) ?? null;
    }
    return null;
  };

  for (let si = 0; si < splits.length; si++) {
    const s = splits[si];
    for (let bi = 0; bi < s.boundaries.length; bi++) {
      const b = s.boundaries[bi];
      if (s.dir === 'v') {
        const beam = memberById.get(`div-v${si}-${bi}`);
        if (!beam) continue;
        const centerX = b - cc.w / 2;
        for (const [faceY, endM] of [[s.y, 0], [s.y + s.h, beam.lengthM]] as const) {
          const post = divHAt(faceY, centerX);
          if (!post) continue;
          joints.push({
            postId: post.panelId, beamId: beam.panelId,
            postKind: post.panelId === 'top' ? 'top' : post.panelId === 'bottom' ? 'bottom' : 'divH',
            uCenterM: centerX - post.uOrigin, depthM: cc.Dc, beamLenM: beam.lengthM, beamEndM: endM,
            face: post.panelId === 'top' || post.panelId === 'bottom' ? 'B' : 'A',
          });
        }
      } else {
        const beam = memberById.get(`div-h${si}-${bi}`);
        if (!beam) continue;
        const centerY = cc.y0 + b;
        for (const [faceX, endM] of [[s.x, 0], [s.x + s.w, beam.lengthM]] as const) {
          const post = divVAt(faceX, centerY);
          if (!post) continue;
          joints.push({
            postId: post.panelId, beamId: beam.panelId,
            postKind: post.panelId === 'side-l' || post.panelId === 'side-r' ? 'side' : 'divV',
            uCenterM: centerY - post.uOrigin, depthM: cc.Dc, beamLenM: beam.lengthM, beamEndM: endM,
            face: post.panelId.startsWith('side') ? 'B' : 'A',
          });
        }
      }
    }
  }
  return joints;
}

/** Even v-positions across a joint depth with front/back margins (meters). */
function jointVs(depthMm: number, n: number): number[] {
  const margin = 50;
  if (n <= 1) return [depthMm / 2];
  const lo = margin;
  const hi = depthMm - margin;
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

function joinery(
  joints: CarcassJoint[], cc: Carcass, m: ManufactureSettings, map: Map<string, PanelOps>
): void {
  for (const j of joints) {
    const depthMm = c1(j.depthM);
    const n = depthMm < 400 ? 2 : 3;
    const vs = jointVs(depthMm, n);
    const uCenter = Math.round(j.uCenterM * 10000) / 10;
    if (m.joinery === 'confirmat') {
      const post = opsFor(map, j.postId);
      const thruDepth = ci(cc.T);
      for (const v of vs) {
        post.drills.push({ kind: 'confirmat', u: uCenter, v: Math.round(v * 10) / 10, dia: 5, depth: thruDepth, face: j.face });
      }
    } else {
      // cam-lock: cam bore on the receiving (beam) inner face 34 mm from its end,
      // plus two dowels bored into the beam's end edge.
      const beam = opsFor(map, j.beamId);
      const endMm = c1(j.beamEndM);
      const camU = j.beamEndM <= 1e-6 ? 34 : endMm - 34;
      for (const v of vs) {
        beam.drills.push({ kind: 'camBore', u: Math.round(camU * 10) / 10, v: Math.round(v * 10) / 10, dia: 15, depth: 13, face: 'A' });
      }
      const dowelVs = jointVs(depthMm, 2);
      for (const v of dowelVs) {
        beam.drills.push({ kind: 'dowel', u: Math.round(endMm * 10) / 10, v: Math.round(v * 10) / 10, dia: 8, depth: 30, face: 'edge' });
      }
    }
  }
}

// ── back-panel groove ───────────────────────────────────────────────────────

function backGroove(cc: Carcass, members: Member[], m: ManufactureSettings, map: Map<string, PanelOps>): void {
  if (cc.screwed) return; // screwed backs are surface-mounted, no groove
  const atMm = c1(cc.grooveAt);
  const widthMm = Math.round(cc.grooveWidth * 1000); // backT + 0.2 mm play → whole mm
  const depthMm = c1(cc.grooveDepth);
  for (const member of members) {
    const lengthMm = c1(member.lengthM);
    const memWidth = c1(member.widthM);
    if (atMm < 0 || atMm + widthMm > memWidth + 1e-6) continue; // out of band → skip
    const o = opsFor(map, member.panelId);
    o.grooves.push({ axis: 'u', at: atMm, width: widthMm, depth: depthMm, from: 0, to: lengthMm });
  }
}

/**
 * Every machining op for one placed part, keyed by panel id. Only rect-carcass,
 * floor-standing cabinets are drilled; wall units, polygon footprints,
 * board/freeform parts return an empty map (hardware-only or not machined here).
 */
export function itemDrilling(
  part: CustomPartDef, dims: PartDims, panels: Panel[], m: ManufactureSettings
): Map<string, PanelOps> {
  const map = new Map<string, PanelOps>();
  if (part.type !== 'cabinet') return map;
  const cc = carcassOf(part, dims, m);
  if (!cc) return map;
  const members = membersOf(panels, cc);

  shelfPins(part, cc, members, panels, m, map);
  hinges(part, cc, members, panels, m, map);
  joinery(enumerateJoints(part, dims, panels, m), cc, m, map);
  backGroove(cc, members, m, map);
  dedupeShelfPinPlates(map);
  return map;
}

/**
 * On a member carrying a doored leaf with shelves, the System-32 shelf-pin
 * column and the hinge mounting plates share the front v-column (v = frontSetback)
 * and the same Ø5 hole. When a plate hole lands exactly on a pin-row hole they
 * are one physical bore — drop the redundant shelf pin and keep the plate (whose
 * 32-mm pair the validator checks). Removing a pin leaves a 64-mm (2×32) gap in
 * the column, still a valid multiple of the pitch.
 */
function dedupeShelfPinPlates(map: Map<string, PanelOps>): void {
  for (const ops of map.values()) {
    const plates = ops.drills.filter((d) => d.kind === 'hingePlate');
    if (!plates.length) continue;
    const same = (a: DrillOp, b: DrillOp): boolean =>
      a.face === b.face && a.dia === b.dia && Math.abs(a.u - b.u) < 0.05 && Math.abs(a.v - b.v) < 0.05;
    ops.drills = ops.drills.filter(
      (d) => d.kind !== 'shelfPin' || !plates.some((p) => same(p, d))
    );
  }
}

/**
 * Human-readable machining notes per panel id, for the cut list. Door fronts get
 * their hinge side + count; sides/dividers bounding a drawer leaf get the runner
 * jig note (runners are SKU-specific, not drilled here); grooved members note the
 * rear back-panel groove.
 */
export function itemDrillNotes(
  part: CustomPartDef, dims: PartDims, panels: Panel[], m: ManufactureSettings
): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const add = (id: string, note: string): void => {
    const arr = notes.get(id) ?? [];
    if (!arr.includes(note)) arr.push(note);
    notes.set(id, arr);
  };
  if (part.type !== 'cabinet') return notes;
  const cc = carcassOf(part, dims, m);
  if (!cc) return notes;
  const members = membersOf(panels, cc);

  // door fronts: hinge side + count
  for (const r of walkZones(part.face, cc.w, cc.bodyH)) {
    const zid = `z${r.path.join('-') || 'r'}`;
    const pp = panelParamsFrom(m);
    if (r.leaf.fill === 'door') {
      const side = r.leaf.hinge === 'right' ? 'right' : 'left';
      const n = hingeCountForHeight(c1(r.h - pp.reveal));
      add(`${zid}.front0`, `hinge ${side}, ${n} hinges`);
    } else if (r.leaf.fill === 'doorPair') {
      const n = hingeCountForHeight(c1(r.h - pp.reveal));
      add(`${zid}.front0`, `hinge left, ${n} hinges`);
      add(`${zid}.front1`, `hinge right, ${n} hinges`);
    } else if (r.leaf.fill === 'drawers') {
      // runner drilling on the members bounding the drawer leaf
      const iv = leafInterior(r, cc.w, cc.bodyH, cc.T);
      const coverY = cc.y0 + (iv.y0 + iv.y1) / 2;
      for (const fx of [r.x, r.x + r.w]) {
        const hit = verticalMemberAtX(fx, coverY, cc, members, panels);
        if (hit) add(hit.member.panelId, 'runner drilling per system jig');
      }
    }
  }

  // grooved members
  if (!cc.screwed) {
    const pp = panelParamsFrom(m);
    const note = `back groove ${Math.round(pp.backT * 1000)}×${c1(pp.grooveDepth)}mm at rear`;
    for (const member of members) {
      const memWidth = c1(member.widthM);
      if (c1(cc.grooveAt) >= 0 && c1(cc.grooveAt) + Math.round(cc.grooveWidth * 1000) <= memWidth + 1e-6) {
        add(member.panelId, note);
      }
    }
  }
  return notes;
}
