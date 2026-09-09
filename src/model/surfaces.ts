/**
 * Usable flat surfaces — the pure answer to "what can an object be put down on".
 *
 * The app models cabinets, worktops and shelves as PANELS (src/model/panels.ts)
 * and everything else as bespoke meshes, and until now nothing joined the two
 * into "here is a rectangle at this height that a mug could sit on".
 * `elevation + h` was re-derived at six unrelated call sites and no two of them
 * agreed about overhangs, merged runs or shelf thickness. This module is that
 * derivation, written once.
 *
 * It DERIVES, it never decides: every surface is read back out of the panel IR
 * the renderer already draws, so surfaces.ts cannot disagree with the 3D view
 * about where a worktop is. Anything that would need new geometry (a windowsill
 * ledge, say) is out of scope rather than invented here — a second source of
 * truth for a shape is exactly what the panel IR exists to prevent.
 *
 * Frames and units. `outline`/`holes` are WORLD PLAN polygons in metres
 * (`Point.x` right, `Point.y` down — the convention across src/model), already
 * pushed through the host item's `localToWorld`. `top` is metres ABOVE THE
 * FLOOR, which is a different axis from `Point.y`; it is named `top` and not
 * `y` for exactly that reason.
 *
 * The one rule that makes the derivation short: for EVERY panel shape,
 * `topLocal = panel.y + panel.shape.h`, because `panel.y` is the panel's bottom
 * (meshKit's `box` sets `position.y = y + h/2`, its `prism` sets
 * `position.y = y0 + h`). Per-role thickness constants would drift; this cannot.
 */

import { defOfDesign, partOfDesign } from './attach';
import { isDecorative } from './catalog';
import { localToWorld, pointInPolygon, polygonBounds, rot, signedArea } from './geometry';
import { cabinetFaceSize, partPanels, type HostContext, type Panel, type PartDims } from './panels';
import { NO_ROOM, roomOfItem } from './rooms';
import type { Design, Item, Point, ZoneFill } from './types';
import { hostContexts } from './worktops';
import { walkZones } from './zones';

export type SurfaceKind = 'worktop' | 'shelf' | 'niche' | 'table' | 'floor';

export interface Surface {
  /** host-local and stable: a Panel id ('worktop', 'z0-1.shelf0'), 'top' for a
   *  bespoke-builder item, or 'floor' for a room. Phase 2 stores exactly this. */
  localId: string;
  /** `${hostId}:${localId}` — unique design-wide. */
  id: string;
  kind: SurfaceKind;
  /** the item this belongs to; the ROOM id for a floor (whose hostId is ''). */
  hostId: string;
  roomId: string;
  /** height of the usable face, metres above the floor. */
  top: number;
  /** world plan polygon, metres, counter-clockwise. */
  outline: Point[];
  /** world plan polygons cut out of it (sink / hob cutouts). */
  holes: Point[][];
  /** the host's rotation, so a dropped object can align to the run. */
  rotation: number;
  /** false when a door or drawer front stands in front of it. Still placeable
   *  by hand — fronts open in the preview — but never auto-staged. */
  visible: boolean;
}

/** Plan-drop ceiling: above a worktop, below a wall unit's shelf. A click in
 *  the 2D plan carries no height, so it has to mean "the counter", not "the
 *  shelf 1.8 m above it". The 3D view knows better and passes its own ray hit. */
export const DROP_CEIL = 1.15;

/** A panel this thin and this wide reads as a slab you could put something on,
 *  rather than as a leg, a post or a front lying on its back. */
const SLAB_MAX_T = 0.06;

/** Roles that can ever be a surface. `board` is conditional (see `slabLike`);
 *  `niche` is conditional (only an OPEN zone's floor — see `cabinetZoneFills`);
 *  `carcass` is conditional (only the TOP board — see `TOP_EPS`). */
const SURFACE_ROLES: ReadonlySet<string> = new Set([
  'worktop',
  'shelf',
  'niche',
  'board',
  'carcass',
]);

/**
 * How close a carcass board's top must be to the part's own height to BE the
 * part's top.
 *
 * A unit with no worktop — a nightstand, a dresser, a TV bench, a wardrobe —
 * still has a real surface on top of it, and it is the one people actually use
 * (the lamp, the plant, the boxes above the wardrobe). That board is emitted
 * with role `carcass`, indistinguishable from the sides and the bottom except
 * by where it sits, so this is the test. It cannot double-count a worktopped
 * unit: there the carcass top lies WORKTOP_T lower and the slab above it is
 * what reaches `h`.
 */
const TOP_EPS = 1e-4;

/* ---------------- panel → local rect ---------------- */

function panelTop(p: Panel): number | null {
  if (p.shape.kind === 'cyl') return null; // a rod is not a surface
  return p.y + p.shape.h;
}

function slabLike(p: Panel): boolean {
  if (p.shape.kind !== 'box') return p.shape.kind === 'prism';
  const { w, h, d } = p.shape;
  return h <= SLAB_MAX_T && h < Math.min(w, d);
}

/**
 * The panel's footprint in ITEM-local plan coords (x across the part, +y its
 * front — the `Point` frame every part generator uses).
 *
 * Two things here are not guesses and must not be "simplified":
 *  - a PRISM's `x`/`z` are ignored, because src/view3d/partMeshes.ts ignores
 *    them too; every prism the generator emits is authored at the origin;
 *  - a rotated BOX yaws by `−p.rotY`, not `+p.rotY`. The `Place` closure in
 *    panels.ts is `x = ox + lx·cos(ry) + lz·sin(ry)`, `z = oz − lx·sin(ry) +
 *    lz·cos(ry)`, which is `rot(·, −ry)` in geometry.ts's convention. Getting
 *    the sign wrong mirrors the surface about the face and fails silently —
 *    it only shows on chamfer/cornerL cabinets, the sole source of rotY ≠ 0.
 */
function panelLocalPoly(p: Panel): { outline: Point[]; holes: Point[][] } | null {
  if (p.shape.kind === 'prism') {
    return {
      outline: p.shape.outline.map((q) => ({ ...q })),
      holes: (p.shape.holes ?? []).map((h) => h.map((q) => ({ ...q }))),
    };
  }
  if (p.shape.kind !== 'box') return null;
  const hw = p.shape.w / 2;
  const hd = p.shape.d / 2;
  const corners: Point[] = [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
  const outline = corners.map((c) => {
    const r = rot(c, -p.rotY);
    return { x: p.x + r.x, y: p.z + r.y };
  });
  return { outline, holes: [] };
}

/** CCW in this app's y-down plan frame is NEGATIVE signed area (see rooms.ts
 *  `normalizeRoom`). Every Surface outline is normalized so consumers may
 *  assume one winding. */
function toCcw(poly: Point[]): Point[] {
  return signedArea(poly) > 0 ? [...poly].reverse() : poly;
}

function toWorld(it: Item, poly: Point[]): Point[] {
  const o = { x: it.x, y: it.y };
  return poly.map((p) => localToWorld(o, it.rotation, p));
}

/* ---------------- visibility ---------------- */

/**
 * Is this surface reachable, or does a door / drawer front stand in front of it?
 *
 * Deliberately GEOMETRIC rather than part-specific: a `front`-role panel that
 * overlaps the candidate in x, sits in front of it in z, and spans its height
 * hides it. That one test covers cabinet zone leaves, wardrobe sections and
 * whatever part type lands next, without any of them having to declare
 * anything. A `glass` front does not hide — you can see a vase in a display
 * cabinet, and staging one there is the point.
 */
function frontHides(panels: Panel[], p: Panel, top: number): boolean {
  const rect = p.shape.kind === 'box' ? p.shape : null;
  if (!rect) return false; // a merged worktop prism is never behind a front
  const x0 = p.x - rect.w / 2;
  const x1 = p.x + rect.w / 2;
  for (const f of panels) {
    if (f.role !== 'front' || f.shape.kind !== 'box') continue;
    if (f.z <= p.z) continue; // behind or level: not in the way
    if (f.x + f.shape.w / 2 <= x0 + 1e-6 || f.x - f.shape.w / 2 >= x1 - 1e-6) continue;
    if (f.y > top - 1e-6) continue; // starts above the surface
    if (f.y + f.shape.h < top + 1e-6) continue; // ends below it
    return true;
  }
  return false;
}

/* ---------------- niche disambiguation (C2) ---------------- */

/**
 * `${zid}.niche-bottom` is emitted TWICE by panels.ts: once as the floor of an
 * OPEN zone (a shelf you can put a bowl on) and once as the floor of an
 * APPLIANCE housing (an oven slot). The ids are identical, so matching on the
 * id alone puts the fruit bowl inside the oven. The only honest discriminator
 * is the leaf's fill, so a cabinet's zone tree is walked to recover it.
 *
 * Wardrobes need no equivalent: an open wardrobe section emits no niche lining
 * at all (its cavity IS the opening — see src/model/wardrobe.ts's header).
 */
function cabinetZoneFills(design: Design, it: Item): Map<string, ZoneFill> {
  const out = new Map<string, ZoneFill>();
  const part = partOfDesign(design, it.defId);
  if (!part || part.type !== 'cabinet') return out;
  const { faceW, faceH } = cabinetFaceSize(part);
  for (const r of walkZones(part.face, faceW, faceH)) {
    out.set(`z${r.path.join('-') || 'r'}`, r.leaf.fill);
  }
  return out;
}

/* ---------------- per-item surfaces ---------------- */

const BESPOKE_TOPS: ReadonlySet<string> = new Set(['table', 'stool', 'woodPlane']);

export function itemDims(it: Item): PartDims {
  return { w: it.w, d: it.d, h: it.h, elevation: it.elevation };
}

/**
 * Every surface one item offers. `ctx` is that item's entry from
 * `hostContexts(design)` — pass it when you already have the map, so a caller
 * iterating the design does not rebuild it per item.
 */
export function surfacesOfItem(design: Design, it: Item, ctx?: HostContext): Surface[] {
  const out: Surface[] = [];
  const roomId = roomOfItem(design, it)?.id ?? it.roomId ?? NO_ROOM;
  const push = (
    localId: string,
    kind: SurfaceKind,
    top: number,
    outline: Point[],
    holes: Point[][],
    visible: boolean
  ): void => {
    if (outline.length < 3) return;
    out.push({
      localId,
      id: `${it.id}:${localId}`,
      kind,
      hostId: it.id,
      roomId,
      top,
      outline: toCcw(toWorld(it, outline)),
      holes: holes.map((h) => toCcw(toWorld(it, h))),
      rotation: it.rotation,
      visible,
    });
  };

  const part = partOfDesign(design, it.defId);
  if (part) {
    const panels = partPanels(part, itemDims(it), ctx);
    const fills = cabinetZoneFills(design, it);
    for (const p of panels) {
      if (!SURFACE_ROLES.has(p.role)) continue;
      if (!slabLike(p)) continue;
      const localTop = panelTop(p);
      if (localTop === null) continue;
      if (p.role === 'niche') {
        // only an OPEN zone's floor board — see cabinetZoneFills
        if (!p.id.endsWith('.niche-bottom')) continue;
        const zid = p.id.slice(0, -'.niche-bottom'.length);
        if (fills.get(zid) !== 'open') continue;
      }
      // a carcass board is a surface only when it IS the top of the unit
      if (p.role === 'carcass' && Math.abs(localTop - it.h) > TOP_EPS) continue;
      const poly = panelLocalPoly(p);
      if (!poly) continue;
      const kind: SurfaceKind =
        p.role === 'worktop'
          ? 'worktop'
          : p.role === 'board' || p.role === 'carcass'
            ? 'table'
            : p.role === 'niche'
              ? 'niche'
              : 'shelf';
      push(
        p.id,
        kind,
        it.elevation + localTop,
        poly.outline,
        poly.holes,
        !frontHides(panels, p, localTop)
      );
    }
    return out;
  }

  const def = defOfDesign(design, it.defId);
  if (def && BESPOKE_TOPS.has(def.kind)) {
    // Bespoke builders keep their tops in src/view3d/itemMeshes.ts, so there is
    // no panel to read: a table/stool/plane slab spans the whole footprint and
    // its top is the item's own height. A chair seat is deliberately NOT a
    // surface — nobody stages a chair seat.
    const hw = it.w / 2;
    const hd = it.d / 2;
    push(
      'top',
      'table',
      it.elevation + it.h,
      [
        { x: -hw, y: -hd },
        { x: hw, y: -hd },
        { x: hw, y: hd },
        { x: -hw, y: hd },
      ],
      [],
      true
    );
  }
  return out;
}

/* ---------------- the design-wide pass ---------------- */

/**
 * Every surface in the design, floors included.
 *
 * `hosting` defaults to `hostContexts(design)` — the same optional-parameter
 * inversion `worktopRuns(design, hosting?)` already uses, so a caller that has
 * the map (View3D's rebuild, the BOM) never builds it twice. Worktop RUNS need
 * no code here: merging is already baked into the context, so `partPanels`
 * hands a run leader the whole merged slab and every follower no worktop panel
 * at all. This module does not know runs exist, and therefore cannot disagree
 * with the renderer about where the joint is.
 *
 * Order is stable — items in `design.items` order, panels in generator order,
 * floors last — because `planStaging` seeds off it.
 */
export function surfacesOf(design: Design, hosting?: Map<string, HostContext>): Surface[] {
  const hosts = hosting ?? hostContexts(design);
  const out: Surface[] = [];
  for (const it of design.items) {
    if (it.attach) continue; // an appliance sits IN its host, offering nothing
    const def = defOfDesign(design, it.defId);
    if (def && isDecorative(def)) continue; // clutter is not a shelf
    out.push(...surfacesOfItem(design, it, hosts.get(it.id)));
  }
  for (const room of design.rooms) {
    const outline = room.corners.map((c) => ({ x: c.x, y: c.y }));
    if (outline.length < 3) continue;
    out.push({
      localId: 'floor',
      id: `${room.id}:floor`,
      kind: 'floor',
      hostId: '',
      roomId: room.id,
      top: 0,
      outline: toCcw(outline),
      holes: [],
      rotation: 0,
      visible: true,
    });
  }
  return out;
}

/* ---------------- lookups ---------------- */

export function surfaceContains(s: Surface, p: Point): boolean {
  if (!pointInPolygon(p, s.outline)) return false;
  for (const h of s.holes) if (pointInPolygon(p, h)) return false;
  return true;
}

/** The HIGHEST surface under `ceil` that contains `p`, or null. */
export function surfaceAt(surfaces: readonly Surface[], p: Point, ceil: number): Surface | null {
  let best: Surface | null = null;
  for (const s of surfaces) {
    if (s.top > ceil + 1e-6) continue;
    if (!surfaceContains(s, p)) continue;
    if (!best || s.top > best.top) best = s;
  }
  return best;
}

/** What an object dropped at `p` should rest on. Falls back to the floor. */
export function restingElevation(surfaces: readonly Surface[], p: Point, ceil: number): number {
  return surfaceAt(surfaces, p, ceil)?.top ?? 0;
}

/**
 * Clear height above a surface, or Infinity when nothing is over it.
 *
 * Deliberately a function and not a `Surface` field: the scan is O(S²) and only
 * `planStaging` needs it, so a pointer drag must not pay for it. The overlap
 * test is axis-aligned BOUNDS, not polygon — approximate for a chamfered
 * cabinet, and honest about it here rather than surprising downstream.
 */
export function clearanceAbove(surfaces: readonly Surface[], s: Surface): number {
  const a = polygonBounds(s.outline);
  let best = Infinity;
  for (const o of surfaces) {
    if (o === s || o.top <= s.top + 1e-6) continue;
    const b = polygonBounds(o.outline);
    if (b.minX >= a.maxX || b.maxX <= a.minX || b.minY >= a.maxY || b.maxY <= a.minY) continue;
    best = Math.min(best, o.top - s.top);
  }
  return best;
}
