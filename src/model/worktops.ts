import { applianceHosting, partOfDesign, type HostContext } from './attach';
import { angleClose, worldToLocal } from './geometry';
import {
  DEFAULT_WORKTOP_OVERHANG,
  isWallMountedElevation,
  PLINTH_H,
  WORKTOP_T,
  type WorktopPlan,
} from './panels';
import { roomOfItem } from './rooms';
import type { CabinetPartDef, Design, Item, Point, WorktopOverhang } from './types';

/**
 * Continuous worktops — pure model code, no renderer, no three.js.
 *
 * Cabinets standing side by side on a run share ONE physical slab; a shop cuts
 * a single board and a viewer sees no seam. The merge therefore belongs in the
 * panel IR, not in the mesh layer: `worktopRuns` hands each item a
 * `WorktopPlan` through its `HostContext`, and panels.ts emits either the whole
 * run (leader) or nothing at all (follower). The 3D view and the cut list read
 * the same plan, so they can never disagree.
 *
 * Runs of ONE produce no plan at all, which keeps the standalone-slab path in
 * panels.ts byte-identical to what it was before this file existed.
 *
 * Straight runs only: an L corner is two runs meeting at 90°, and mitring them
 * needs a real corner-joint model (deliberately out of scope).
 */

export type { WorktopPlan };

/** Joint gap (m) that still reads as one continuous board. */
export const MERGE_GAP = 0.005;
/**
 * Tolerated overlap (m) before two units stop being neighbours. A snapped run
 * lands flush; a few mm of scribe is normal. Anything deeper is a modelling
 * error (checks.ts flags the collision) — merging it would invent a slab.
 */
export const MERGE_OVERLAP = 0.02;
/** worktop surface height / depth / overhang agreement (m) */
const SIZE_TOL = 0.001;
/** across-run centre agreement (m): the units must sit on the same line */
const OFFSET_TOL = 0.002;
/** rotation agreement (rad) — float noise only, not a real angular spread */
const ROT_TOL = 1e-3;

/**
 * One member of a run, in the group's frame: `s` runs ALONG the run axis
 * (cos r, sin r), `p` ACROSS it along the front normal (−sin r, cos r). Both
 * are of the item CENTRE, so leader-local coordinates are pure differences.
 */
interface Member {
  item: Item;
  s: number;
  p: number;
}

/** Members that agree on everything a shared slab needs, before splitting into runs. */
interface Group {
  roomId: string;
  rotation: number;
  /** worktop surface height above the floor */
  plane: number;
  depth: number;
  across: number;
  ov: WorktopOverhang;
  members: Member[];
}

/** A maximal chain of touching members; every member shares the group's shape. */
interface Run {
  depth: number;
  ov: WorktopOverhang;
  members: Member[];
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/**
 * The cabinet part of an item that can join a run, or null.
 *
 * Attached items sit ON a host and never carry their own top. Polygon
 * footprints (chamfer / corner-L) keep their own snug outline: their slab
 * follows the footprint, so a straight span cannot describe it — they simply
 * terminate the run. A body too short to exist emits no worktop in panels.ts,
 * so it must not become a leader either.
 */
function runCabinet(design: Design, it: Item): CabinetPartDef | null {
  if (it.attach) return null;
  const part = partOfDesign(design, it.defId);
  if (!part || part.type !== 'cabinet' || !part.worktop) return null;
  if (part.footprint.kind !== 'rect') return null;
  const y0 = !isWallMountedElevation(it.elevation) && part.plinth ? PLINTH_H : 0;
  if (it.h - y0 - WORKTOP_T <= 0.05) return null; // cabinetPanels bails out
  return part;
}

function groupsOf(design: Design): Group[] {
  const groups: Group[] = [];
  for (const item of design.items) {
    const part = runCabinet(design, item);
    if (!part) continue;
    // project the item's world position onto its own rotated axes (origin at
    // world zero) — `local.x` = position along the run, `local.y` = across it
    const local = worldToLocal({ x: 0, y: 0 }, item.rotation, { x: item.x, y: item.y });
    const key = {
      roomId: roomOfItem(design, item)?.id ?? '',
      rotation: item.rotation,
      plane: item.elevation + item.h,
      depth: item.d,
      across: local.y,
      ov: part.worktopOverhang ?? DEFAULT_WORKTOP_OVERHANG,
    };
    const member: Member = { item, s: local.x, p: key.across };
    const hit = groups.find(
      (g) =>
        g.roomId === key.roomId &&
        angleClose(g.rotation, key.rotation, ROT_TOL) &&
        near(g.plane, key.plane, SIZE_TOL) &&
        near(g.depth, key.depth, SIZE_TOL) &&
        near(g.across, key.across, OFFSET_TOL) &&
        near(g.ov.front, key.ov.front, SIZE_TOL) &&
        near(g.ov.back, key.ov.back, SIZE_TOL) &&
        near(g.ov.sides, key.ov.sides, SIZE_TOL)
    );
    if (hit) hit.members.push(member);
    else groups.push({ ...key, members: [member] });
  }
  return groups;
}

/** Neighbours along the axis: flush, a scribe gap, or a hair of overlap. */
function touching(a: Member, b: Member): boolean {
  const gap = b.s - b.item.w / 2 - (a.s + a.item.w / 2);
  return gap <= MERGE_GAP && gap >= -MERGE_OVERLAP;
}

/** Every maximal run of adjacent worktop cabinets, singles included. */
function runsOf(design: Design): Run[] {
  const out: Run[] = [];
  for (const g of groupsOf(design)) {
    const sorted = [...g.members].sort((a, b) => a.s - b.s);
    let cur: Member[] = [];
    for (const m of sorted) {
      const prev = cur[cur.length - 1];
      if (prev && !touching(prev, m)) {
        out.push({ depth: g.depth, ov: g.ov, members: cur });
        cur = [];
      }
      cur.push(m);
    }
    if (cur.length) out.push({ depth: g.depth, ov: g.ov, members: cur });
  }
  return out;
}

/**
 * Runs of adjacent worktop-bearing cabinets, as items in run order (singles
 * included). Exported for spatial reasoning that wants the same notion of "one
 * continuous counter" the slab uses — never duplicate this grouping.
 */
export function itemRuns(design: Design): Item[][] {
  return runsOf(design).map((r) => r.members.map((m) => m.item));
}

/**
 * The merged slab outline, in the LEADER's item-local plan frame (x across the
 * leader's width, +y its front — the frame every panel prism uses):
 *
 *   x0 = min(s − w/2) − s_leader − ov.sides,  x1 = max(s + w/2) − s_leader + ov.sides
 *   y0 = −d/2 − ov.back,                      y1 =  d/2 + ov.front
 *
 * which for a run of one collapses to exactly the standalone slab.
 */
function runOutline(run: Run): Point[] {
  const s0 = run.members[0].s;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const m of run.members) {
    x0 = Math.min(x0, m.s - m.item.w / 2 - s0);
    x1 = Math.max(x1, m.s + m.item.w / 2 - s0);
  }
  x0 -= run.ov.sides;
  x1 += run.ov.sides;
  const y0 = -run.depth / 2 - run.ov.back;
  const y1 = run.depth / 2 + run.ov.front;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/**
 * Every member's appliance cutouts, moved into the leader's frame. Members
 * share the run's rotation, so the move is a pure translation by the centre
 * difference (mostly along the run; `p` differs by at most OFFSET_TOL).
 */
function runHoles(run: Run, hosting: Map<string, HostContext>): Point[][] {
  const [lead] = run.members;
  const out: Point[][] = [];
  for (const m of run.members) {
    const du = m.s - lead.s;
    const dv = m.p - lead.p;
    for (const c of hosting.get(m.item.id)?.cutouts ?? []) {
      const x = c.x + du;
      const y = c.y + dv;
      out.push([
        { x: x - c.w / 2, y: y - c.d / 2 },
        { x: x + c.w / 2, y: y - c.d / 2 },
        { x: x + c.w / 2, y: y + c.d / 2 },
        { x: x - c.w / 2, y: y + c.d / 2 },
      ]);
    }
  }
  return out;
}

/**
 * Item id → its role in a continuous worktop. Only runs of TWO OR MORE appear:
 * a lone cabinet keeps the untouched standalone path in panels.ts.
 */
export function worktopRuns(
  design: Design,
  hosting: Map<string, HostContext> = applianceHosting(design)
): Map<string, WorktopPlan> {
  const out = new Map<string, WorktopPlan>();
  for (const run of runsOf(design)) {
    if (run.members.length < 2) continue;
    out.set(run.members[0].item.id, {
      role: 'leader',
      outline: runOutline(run),
      holes: runHoles(run, hosting),
    });
    for (const m of run.members.slice(1)) out.set(m.item.id, { role: 'follower' });
  }
  return out;
}

/**
 * THE per-item context for `partPanels`: appliance cutouts/niches plus the
 * continuous-worktop plan. The 3D view and the manufacturing export both call
 * this one composer, so a merged slab renders and gets cut identically.
 */
export function hostContexts(design: Design): Map<string, HostContext> {
  const out = applianceHosting(design);
  for (const [itemId, worktop] of worktopRuns(design, out)) {
    const ctx = out.get(itemId);
    if (ctx) ctx.worktop = worktop;
    else out.set(itemId, { cutouts: [], occupiedZones: new Set(), worktop });
  }
  return out;
}
