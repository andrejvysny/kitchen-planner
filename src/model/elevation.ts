import { partOfDesign, type HostContext } from './attach';
import { angleClose, clamp, projectOnWall } from './geometry';
import { partPanels, type Panel } from './panels';
import { openingsOfWall, roomById, wallByIdIn } from './rooms';
import { rotationFromInward } from './snapping';
import type { Design, Item } from './types';
import { hostContexts } from './worktops';

/**
 * Front ("elevation") view of a single wall: the wall seen straight-on from
 * inside the room, with only the furniture that actually backs onto it.
 *
 * All geometry is pure — no store, no three.js — so it is unit-testable and
 * can later feed a manufacturing/wall-layout export. Along-wall distances run
 * left→right from the wall start corner; heights run up from the floor.
 */

/**
 * One rectangle of a custom part's FRONT as it reads on the wall: a door, a
 * drawer front, a fixed panel, a glass pane or an appliance niche. Projected
 * from the panel IR (src/model/panels.ts), so the elevation shows exactly the
 * boards the cut list bills — never a second, hand-drawn idea of the layout.
 */
export interface ElevationFront {
  /** along-wall span, in the same frame as `WallElevationItem.center` (m) */
  t0: number;
  t1: number;
  /** height band above the floor (m) */
  z0: number;
  z1: number;
  kind: 'front' | 'panel' | 'glass' | 'niche';
  /** hinged fronts: the edge carrying the hinges (the drilling datum) */
  hinge?: 'left' | 'right' | 'top' | 'bottom';
  /** sliding fronts: 1 = the outer track lane, 0 = the lane behind it */
  slide?: 0 | 1;
}

export interface WallElevationItem {
  id: string;
  defId: string;
  /** along-wall centre distance from the wall start corner (m) */
  center: number;
  /** half of the item width measured along the wall (m) */
  halfW: number;
  /** bottom height above the floor (m) */
  z0: number;
  /** top height above the floor (m) */
  z1: number;
  color: string;
  /** perpendicular distance of the item centre from the wall centreline —
   *  used to draw items nearer the viewer on top */
  depth: number;
  /** the part's front layout, present only when `wallElevation` was asked for
   *  it AND the item resolves to a custom part (a bought appliance has none) */
  front?: ElevationFront[];
}

export interface WallElevationOpening {
  id: string;
  type: 'door' | 'window';
  /** along-wall centre distance from the wall start corner (m) */
  center: number;
  width: number;
  /** sill height (m) */
  z0: number;
  /** head height (m) */
  z1: number;
}

export interface WallElevation {
  wallId: string;
  /** the room this elevation is seen FROM (a partition has one per side) */
  roomId: string;
  roomName: string;
  /** interior length of the wall (m) */
  len: number;
  /** ceiling height (m) */
  height: number;
  thickness: number;
  /** back-to-front (against-wall first) */
  items: WallElevationItem[];
  openings: WallElevationOpening[];
}

/** how far (m) an item's back may sit off the wall face and still count as attached */
const BACK_GAP = 0.15;
/** how far (rad) an item may face off the wall's inward normal and still count */
const FACE_TOL = 0.3;

/** panel roles that read as part of the FRONT of a part, and the kind each becomes */
const FRONT_KIND: Partial<Record<Panel['role'], ElevationFront['kind']>> = {
  front: 'front',
  panel: 'panel',
  glass: 'glass',
  niche: 'niche',
};

export interface WallElevationOpts {
  /**
   * Also project every custom part's front layout into
   * `WallElevationItem.front`. OFF by default, deliberately: `ElevationView`
   * re-runs `wallElevation` on every pointer move to hit-test, and a hit test
   * has no use for a panel list. Only `draw()` asks for fronts.
   */
  fronts?: boolean;
}

/**
 * Project one item's panel list onto the wall it backs onto.
 *
 * THE PROJECTION SIGN — item-local +x maps onto +t un-mirrored, on every
 * wall. An item only reaches this function because its rotation matched
 * `rotationFromInward(n) = atan2(-n.x, n.y)`, and a wall's normal is
 * `n = (-dir.y, dir.x)` (geometry.ts), so `cos r = n.y = dir.x` and
 * `sin r = -n.x = dir.y`; rotating local (1, 0) by r therefore gives exactly
 * `dir`. So `t = center + panel.x`, with no flip: the face's LEFT column
 * (item-local −x, which is also the viewer's left looking at the front) always
 * lands at the smaller `t`, whichever way the wall runs.
 */
function itemFronts(item: Item, center: number, panels: Panel[]): ElevationFront[] {
  // the outer sliding lane is the frontmost z among this item's own sliders
  let outerZ = -Infinity;
  for (const p of panels) {
    if (p.motion?.kind === 'slide' && p.motion.axis === 'x') outerZ = Math.max(outerZ, p.z);
  }

  const out: ElevationFront[] = [];
  for (const p of panels) {
    const kind = FRONT_KIND[p.role];
    if (!kind) continue;
    let h: number;
    let halfT: number;
    if (p.shape.kind === 'box') {
      h = p.shape.h;
      // a rotY'd board (a chamfered or L-corner face) shows wider than it is
      halfT = (Math.abs(p.shape.w * Math.cos(p.rotY)) + Math.abs(p.shape.d * Math.sin(p.rotY))) / 2;
    } else if (p.shape.kind === 'cyl' && p.shape.axis === 'x') {
      h = p.shape.dia;
      halfT = p.shape.h / 2;
    } else {
      // upright rods and extruded prisms have no honest front rectangle
      continue;
    }
    const z0 = item.elevation + p.y;
    const front: ElevationFront = {
      t0: center + p.x - halfT,
      t1: center + p.x + halfT,
      z0,
      z1: z0 + h,
      kind,
    };
    if (p.motion?.kind === 'hinge' && p.motion.side) front.hinge = p.motion.side;
    if (p.motion?.kind === 'slide' && p.motion.axis === 'x') {
      front.slide = p.z >= outerZ - 1e-4 ? 1 : 0;
    }
    out.push(front);
  }
  return out;
}

/**
 * An item belongs to a wall's elevation when its back sits against that wall
 * (within a thickness of the face) AND it faces into the room off that wall.
 * Free-standing items (tables, chairs, island, ceiling lights) fail one or
 * both tests by their geometry, so they never appear.
 *
 * `opts.fronts` additionally projects each matched custom part's front layout
 * off the panel IR — see `WallElevationOpts` for why that is opt-in.
 */
export function wallElevation(
  design: Design,
  wallId: string,
  opts?: WallElevationOpts
): WallElevation | null {
  const g = wallByIdIn(design.rooms, wallId);
  if (!g) return null;
  const room = roomById(design.rooms, g.roomId);
  const wantRot = rotationFromInward(g.inward);

  // hostContexts walks the WHOLE design (appliance cutouts + worktop runs), so
  // it is built at most once per call, and only once an item actually needs it
  let ctxs: Map<string, HostContext> | null = null;
  const frontsOf = (it: Item, center: number): ElevationFront[] | undefined => {
    if (!opts?.fronts) return undefined;
    // the ONE part resolver (design-local shadow first, then the preset)
    const part = partOfDesign(design, it.defId);
    if (!part) return undefined; // a bought appliance has no panel list
    ctxs ??= hostContexts(design);
    const dims = { w: it.w, d: it.d, h: it.h, elevation: it.elevation };
    return itemFronts(it, center, partPanels(part, dims, ctxs.get(it.id)));
  };

  const items: WallElevationItem[] = [];
  const memberIds = new Set<string>();
  for (const it of design.items) {
    if (it.attach) continue; // mounted appliances follow their host below
    const pr = projectOnWall(g, { x: it.x, y: it.y });
    if (pr.t < -0.3 || pr.t > g.len + 0.3) continue; // beyond the wall span
    if (pr.side <= 0) continue; // outside the room (behind the wall)
    // distance from the interior wall face to the item's back plane
    const backGap = pr.side - it.d / 2 - g.faceOffset;
    if (backGap < -0.05 || backGap > BACK_GAP) continue; // not hugging this wall
    if (!angleClose(it.rotation, wantRot, FACE_TOL)) continue; // faces elsewhere
    memberIds.add(it.id);
    const center = clamp(pr.t, 0, g.len);
    items.push({
      id: it.id,
      defId: it.defId,
      center,
      halfW: it.w / 2,
      z0: it.elevation,
      z1: it.elevation + it.h,
      color: it.color,
      depth: pr.side,
      front: frontsOf(it, center),
    });
  }
  // mounted appliances belong to whichever wall their HOST belongs to —
  // their own back sits nowhere near it (a sink is centred on the cabinet)
  for (const it of design.items) {
    if (!it.attach || !memberIds.has(it.attach.hostId)) continue;
    const pr = projectOnWall(g, { x: it.x, y: it.y });
    const center = clamp(pr.t, 0, g.len);
    items.push({
      id: it.id,
      defId: it.defId,
      center,
      halfW: it.w / 2,
      z0: it.elevation,
      z1: it.elevation + it.h,
      color: it.color,
      depth: pr.side,
      front: frontsOf(it, center),
    });
  }

  // against-wall (small side) first so nearer items paint over them
  items.sort((a, b) => a.depth - b.depth);

  // a partition's openings are stored on the owning side; openingsOfWall
  // mirrors them so the door shows up in BOTH rooms' elevations
  const openings: WallElevationOpening[] = openingsOfWall(design, g).map((o) => ({
    id: o.id,
    type: o.type,
    center: o.offset,
    width: o.width,
    z0: o.sill,
    z1: o.sill + o.height,
  }));

  return {
    wallId,
    roomId: g.roomId,
    roomName: room?.name ?? '',
    len: g.len,
    height: room?.style.wallHeight ?? design.rooms[0].style.wallHeight,
    thickness: g.thickness,
    items,
    openings,
  };
}
