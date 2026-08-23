/**
 * The floor-plan renderer, extracted from Plan2D so the print sheet can draw
 * the SAME plan onto an offscreen canvas at true scale (src/print/sheet.ts).
 *
 * `renderPlan` owns every pixel of the plan; Plan2D owns the gestures and
 * hands its transient state in through `PlanOverlays`. What the two callers
 * differ in is `PlanRenderOpts` — the screen turns everything on, the printed
 * sheet asks for paper: no handles, no ghosts, no guides, no measure, no check
 * overlay and no active-room emphasis (all rooms in full ink).
 *
 * The caller sets the base transform (`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`)
 * before calling: `view.cssW/cssH` are in those units, and the device-pixel
 * ratio is how the print path renders 150 dpi output from a 96 dpi layout.
 */

import { emptySelection, type SelectionState } from '../editor/selection';
import type { CatalogDef } from '../model/catalog';
import type { Severity, Warning } from '../model/checks';
import { convexHull, fmtCm, polygonCentroid, rot, wallPoint } from '../model/geometry';
import { footprintPolygon } from '../model/parts';
import { bandCenter, slabQuad, wallCentrelines, wallJoints, type RoomWall } from '../model/rooms';
import type { SnapKind, SnapResult } from '../model/snap';
import type { Guide } from '../model/snapping';
import type { Store } from '../model/store';
import type { CustomPartDef, Item, Point, Selection } from '../model/types';
import { resolveColor } from '../model/variables';
import { drawPlanSymbol, isOverhead } from './symbols';

export const INK = '#3a3934';
export const ACCENT = '#2f6f5e';
export const GUIDE = '#c26d3f';
export const MEASURE = '#2563eb';
/** Walls (and labels) of rooms that are not the active one. */
export const MUTED = '#9a978f';
export const LABEL_MUTED = '#a09d95';
/** Paper / pane background — the plan is never transparent. */
export const PAPER = '#f4f3f0';

/** Spatial-check overlay, one colour per severity. */
const SEVERITY_COLOR: Record<Severity, string> = {
  error: '#c0392b',
  warn: '#d98324',
  info: '#2563eb',
};
/**
 * Plan labels are centred single lines, so a long detail runs off the pane.
 * Clip it here — the props panel carries the sentence in full.
 */
const CHECK_LABEL_MAX = 52;

/**
 * How each kind of guide is drawn. `dash` is in hairlines, `width` a multiple
 * of one.
 *
 * The visual grammar is deliberate: an INFERENCE (something the tool worked
 * out) is thin and dashed, a REFERENCE line borrowed from real geometry is
 * dotted, and a CONSTRUCTION line the user is being held against (⊥ / ∥ / the
 * angle lock) is solid and slightly heavier, because it is the only one of the
 * three that is actively steering the cursor. `default` keeps the old
 * clearance-dimension look for `snapItem`'s kind-less guides.
 */
const GUIDE_STYLE: Record<string, { color: string; width: number; dash: number[] }> = {
  default: { color: GUIDE, width: 1, dash: [5, 4] },
  align: { color: GUIDE, width: 1, dash: [5, 4] },
  extension: { color: GUIDE, width: 1, dash: [1.5, 3] },
  onSegment: { color: GUIDE, width: 1, dash: [1.5, 3] },
  intersection: { color: GUIDE, width: 1, dash: [1.5, 3] },
  perpendicular: { color: ACCENT, width: 1.4, dash: [] },
  parallel: { color: ACCENT, width: 1.4, dash: [] },
  angle: { color: ACCENT, width: 1.4, dash: [] },
};

/**
 * The cursor glyph for each snap kind, in the plan's own notation. Drawn at a
 * fixed SCREEN size, because it is a cursor decoration and not part of the
 * drawing — it must stay legible at every zoom. `grid` and `free` get nothing:
 * "I snapped to nothing in particular" is exactly the absence of a marker, and
 * a symbol on every single pointermove would be noise.
 */
const SNAP_GLYPH: Partial<
  Record<SnapKind, 'square' | 'diamond' | 'cross' | 'perp' | 'par' | 'circle' | 'junction'>
> = {
  // the loop closes here — a ring, matching the close target drawn on pts[0]
  close: 'circle',
  // two centrelines meeting: a square turned 45° INSIDE a square, so it never
  // reads as the plain endpoint it has to be told apart from
  junction: 'junction',
  endpoint: 'square',
  midpoint: 'diamond',
  intersection: 'cross',
  onSegment: 'square',
  extension: 'cross',
  perpendicular: 'perp',
  parallel: 'par',
};

/**
 * Re-exported from src/model/rooms.ts, where the wall tool also needs it. The
 * plan-geometry helpers this module exports are the one import site for its
 * consumers, so keep the name reachable from here.
 */
export { bandCenter };

interface Label {
  x: number;
  y: number;
  text: string;
  angle?: number;
  color?: string;
  size?: number;
  bold?: boolean;
  /** screen-space nudge (px), so stacked lines keep their spacing at any zoom */
  dy?: number;
}

/**
 * The wall tool's in-progress ring — overlay only, never in the model.
 *
 * `pts` are wall CENTRELINES, not the room-side face ring a Room stores: the
 * tool insets by `width / 2` only when it commits (Plan2D `commitRing`). That
 * is what lets the preview and the finished wall occupy the same pixels.
 */
export interface DrawRing {
  /** centreline corners placed so far */
  pts: Point[];
  /** snapped cursor the pending segment rubber-bands to */
  hover: Point | null;
  /**
   * Per SEGMENT of `pts` (plus the wrap edge), whether it will merge into an
   * existing wall rather than build a new one. Drawn in the accent instead of
   * ink, because "this becomes one shared partition" and "this becomes a
   * second wall beside the one already there" are the two outcomes that used
   * to be indistinguishable until after the commit.
   */
  sharedEdges?: boolean[];
  /** the cursor is on the first corner, i.e. a click would close the ring */
  closing: boolean;
  /** already a full ring (the drag rectangle) — no rubber band, no close target */
  closed: boolean;
  /** wall width (m) the bodies are drawn at */
  width: number;
  /** typed dimension for the pending segment; '' = follow the cursor */
  typed: string;
  /** the angle lock is in force — right-angle markers are worth drawing */
  angleSnap: boolean;
}

/** Transient two-point distance measurement (overlay only — never touches the model). */
export interface Measure {
  a: Point | null; // first point
  b: Point | null; // second point, set once the measurement is complete
  hover: Point | null; // snapped cursor while measuring / before the first click
  snapped: boolean; // whether `hover` locked onto a corner/edge (vs. a free point)
  measuring: boolean; // first point placed, waiting for the second
}

/** Placement preview of the armed catalog def. */
export interface ItemGhost {
  x: number;
  y: number;
  rotation: number;
  valid: boolean;
}

/** Where an opening would land on a wall. */
export interface OpeningGhost {
  wallId: string;
  t: number;
  valid: boolean;
}

/**
 * Pre-highlight target under the cursor in select mode (WP 2.3, WS-SPEC §5.3):
 * pure paint, computed by Plan2D from the SAME hit testers the cursor already
 * runs — never new geometry. `handle` covers corner/midpoint (the rotate
 * handle is selection-bound already, so it never needs a hover state of its
 * own); `wallId` is null whenever a handle is hovered, an item/opening sits
 * under the cursor, or nothing does.
 */
export interface HoverOverlay {
  handle: { kind: 'corner' | 'midpoint'; id: string } | null;
  wallId: string | null;
}

/** The plan's view transform, in the caller's transform units (CSS px by default). */
export interface PlanViewport {
  /** px per metre */
  zoom: number;
  panX: number;
  panY: number;
  cssW: number;
  cssH: number;
}

/** Which layers to draw. The printed sheet turns every interactive one off. */
export interface PlanRenderOpts {
  /** the imported tracing photo, under everything else (never printed) */
  underlay: boolean;
  /** the underlay's image finished decoding — the caller should redraw */
  onUnderlayLoad?: () => void;
  /** corner / wall-bend / rotate handles AND the whole selection highlight */
  handles: boolean;
  /** snapping guide lines */
  guides: boolean;
  /** item / opening / room placement previews */
  ghosts: boolean;
  /** the two-point measurement overlay */
  measure: boolean;
  /** the spatial-check overlay at all (advisory findings gate separately) */
  checks: boolean;
  /** dim the rooms that are not active; false = every room in full ink */
  roomEmphasis: boolean;
}

/** Plan2D's in-flight gesture state — absent for a static (print) render. */
export interface PlanOverlays {
  guides: Guide[];
  armedDef: CatalogDef | null;
  ghost: ItemGhost | null;
  ghostOpening: OpeningGhost | null;
  drawRing: DrawRing | null;
  /**
   * What the cursor is currently snapped to, if anything — the source of the
   * glyph AND of `guides` while a snapping tool is live. Kept separate from
   * `guides` because the glyph needs the kind and the point, not the spans.
   */
  snap: SnapResult | null;
  measure: Measure;
  /**
   * What is selected. Since M18 the selection lives on `EditorState`, not the
   * Store, so it arrives with the rest of the in-flight editor state instead of
   * being read off `store` — which is also why the print sheet, passing no
   * overlays at all, draws no selection without needing to say so.
   */
  selection: SelectionState;
  /** the ⚠ toggle: warn/info findings on top of the always-drawn errors */
  advisoryChecks: boolean;
  hover: HoverOverlay;
}

const NO_SELECTION: Selection = { kind: 'none' };
const NO_ENTITIES = emptySelection();

/* ---------------- underlay image cache ---------------- */

/**
 * Decoded tracing photos, keyed by their data URL. Exactly one underlay can be
 * live at a time, so a miss clears the map before loading: replacing or
 * removing the photo drops the old (multi-hundred-kB) element on the next
 * draw, and a changed `src` is simply a different key.
 */
const underlayCache = new Map<string, HTMLImageElement>();

/**
 * The decoded image for `src`, or null while it loads (the caller is pinged
 * through `onLoad` once and redraws). Also used by Plan2D's hit test, which is
 * why it lives here with the rest of the shared plan geometry.
 */
export function underlayImage(src: string, onLoad?: () => void): HTMLImageElement | null {
  const hit = underlayCache.get(src);
  if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
  underlayCache.clear();
  const img = new Image();
  underlayCache.set(src, img);
  img.onload = () => onLoad?.();
  img.src = src;
  return null;
}

/* ---------------- shared item geometry (also used by hit-testing) ---------------- */

export const partOfItem = (store: Store, it: Item): CustomPartDef | undefined =>
  store.partOf(it.defId);

/** The item's true plan outline (custom parts only), in item-local coords. */
export function footprintOf(store: Store, it: Item): Point[] | null {
  const part = store.partOf(it.defId);
  return part ? footprintPolygon(part, it.w, it.d) : null;
}

/** An item's plan outline in world coordinates (custom footprint or the bounding rect). */
export function itemOutlineWorld(store: Store, it: Item): Point[] {
  const local = footprintOf(store, it) ?? [
    { x: -it.w / 2, y: -it.d / 2 },
    { x: it.w / 2, y: -it.d / 2 },
    { x: it.w / 2, y: it.d / 2 },
    { x: -it.w / 2, y: it.d / 2 },
  ];
  return local.map((p) => {
    const r = rot(p, it.rotation);
    return { x: it.x + r.x, y: it.y + r.y };
  });
}

/**
 * A room's corner handles, keyed by corner id — the wall CENTRELINE junctions,
 * not the raw face-ring corners.
 *
 * A corner on the ring is the room-side wall FACE, so a handle drawn there sits
 * visibly off-centre inside the wall band and reads as misaligned. The junction
 * is that ring offset per edge by `bandCenter`, which is exactly
 * `wallCentrelines`' output — the same points the wall tool snaps to, so a
 * handle always lands where the tool would have put a corner.
 *
 * Exported because `Plan2D.hitCorner` MUST test against these very positions:
 * a handle that hit-tests somewhere other than where it draws is the bug this
 * shared helper exists to prevent.
 */
export function cornerHandlePositions(store: Store, roomId: string): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const ring of wallCentrelines(store.design.rooms).rings) {
    if (ring.roomId !== roomId) continue;
    for (const p of ring.points) out.set(p.cornerId, { x: p.x, y: p.y });
  }
  return out;
}

/** A wall's bend handle: the midpoint of its centreline, not of its face edge. */
export function midpointHandlePos(g: RoomWall): Point {
  const off = bandCenter(g);
  const m = wallPoint(g, g.len / 2);
  return { x: m.x + g.inward.x * off, y: m.y + g.inward.y * off };
}

export function rotateHandlePos(it: Item): Point {
  const r = 0.22 + it.d / 2;
  return {
    x: it.x - Math.sin(it.rotation) * r,
    y: it.y + Math.cos(it.rotation) * r,
  };
}

/** Paint order: surfaces below, overhead fixtures on top. */
export function sortedItems(store: Store): Item[] {
  const layer = (it: Item): number => {
    const def = store.defOf(it.defId);
    // wall panels and rugs are surfaces: everything else paints over them
    if (def.kind === 'backsplash' || def.kind === 'rug') return 0;
    // mounted appliances paint above their host cabinets and worktops
    if (it.attach) return 3;
    if (def.marker) return 3;
    if (def.kind === 'custom') {
      // worktop boards sit above base units but below overhead items
      if (partOfItem(store, it)?.type === 'board') return 2;
      return it.elevation > 0.5 ? 4 : 1;
    }
    if (isOverhead(def.kind)) return def.light ? 5 : 4;
    return 1;
  };
  return [...store.design.items].sort((a, b) => layer(a) - layer(b));
}

/** Fill a closed polygon in world units — wall slabs and their joint patches. */
function fillPoly(ctx: CanvasRenderingContext2D, poly: Point[]): void {
  if (poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fill();
}

/* ---------------- the renderer ---------------- */

export function renderPlan(
  ctx: CanvasRenderingContext2D,
  store: Store,
  view: PlanViewport,
  opts: PlanRenderOpts,
  overlays?: PlanOverlays
): void {
  const { zoom, panX, panY, cssW, cssH } = view;
  const labels: Label[] = [];
  const toWorld = (sx: number, sy: number): Point => ({
    x: (sx - panX) / zoom,
    y: (sy - panY) / zoom,
  });

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, cssW, cssH);

  // ---- grid ----
  const w0 = toWorld(0, 0);
  const w1 = toWorld(cssW, cssH);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);
  const hair = 1 / zoom;

  // ---- grid, then the tracing underlay OVER it ----
  // Order is deliberate and was the other way round: a 10 cm grid drawn on top
  // of a scanned plan is a moiré over the very lines the user is trying to
  // trace. The photo has its own opacity slider — that, not the grid, is how
  // you see through it.
  const gridStep = zoom > 55 ? 0.1 : 0.5;
  ctx.lineWidth = hair;
  for (let x = Math.floor(w0.x / gridStep) * gridStep; x < w1.x; x += gridStep) {
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    ctx.strokeStyle = major ? '#dcdad3' : '#eae8e2';
    ctx.beginPath();
    ctx.moveTo(x, w0.y);
    ctx.lineTo(x, w1.y);
    ctx.stroke();
  }
  for (let y = Math.floor(w0.y / gridStep) * gridStep; y < w1.y; y += gridStep) {
    const major = Math.abs(y - Math.round(y)) < 1e-6;
    ctx.strokeStyle = major ? '#dcdad3' : '#eae8e2';
    ctx.beginPath();
    ctx.moveTo(w0.x, y);
    ctx.lineTo(w1.x, y);
    ctx.stroke();
  }

  if (opts.underlay) drawUnderlay(ctx, store, opts.onUnderlayLoad);

  const design = store.design;
  // the selection is an editing affordance: paper shows the plan, not the cursor
  const selState = opts.handles ? (overlays?.selection ?? NO_ENTITIES) : NO_ENTITIES;
  const sel: Selection = selState.primary
    ? { kind: selState.primary.kind, id: selState.primary.id }
    : NO_SELECTION;
  const activeId = store.activeRoomId;
  // a lone room needs no name plate — keep the single-room plan pixel-identical
  const multiRoom = design.rooms.length > 1;

  // ---- floors ----
  for (const room of design.rooms) {
    const corners = room.corners;
    if (corners.length < 3) continue;
    const isActive = !opts.roomEmphasis || room.id === activeId;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = resolveColor(design, room.style.floorColor);
    ctx.globalAlpha = isActive ? 0.42 : 0.18;
    ctx.fill();
    ctx.globalAlpha = 1;

    const c = polygonCentroid(corners);
    const area = `${store.floorArea(room.id).toFixed(1)} m²`;
    if (!multiRoom) {
      labels.push({ x: c.x, y: c.y, text: area, color: LABEL_MUTED, size: 13 });
      continue;
    }
    labels.push({
      x: c.x,
      y: c.y,
      dy: -8,
      text: room.name,
      color: isActive ? INK : MUTED,
      size: 13,
      bold: isActive,
    });
    labels.push({ x: c.x, y: c.y, dy: 9, text: area, color: LABEL_MUTED, size: 13 });
  }

  // ---- guides (behind items) ----
  if (opts.guides && overlays) {
    for (const g of overlays.guides) {
      const style = GUIDE_STYLE[g.kind ?? 'default'] ?? GUIDE_STYLE.default;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = hair * style.width;
      ctx.setLineDash(style.dash.map((d) => d * hair));
      ctx.beginPath();
      ctx.moveTo(g.a.x, g.a.y);
      ctx.lineTo(g.b.x, g.b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (g.label) {
        labels.push({
          x: (g.a.x + g.b.x) / 2,
          y: (g.a.y + g.b.y) / 2,
          text: g.label,
          color: style.color,
          size: 11,
          bold: true,
        });
      }
    }
  }

  // ---- items ----
  for (const it of sortedItems(store)) {
    const def = store.defOf(it.defId);
    const selected = sel.kind === 'item' && sel.id === it.id;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rotation);
    if (selected) {
      ctx.fillStyle = ACCENT;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(-it.w / 2 - 0.04, -it.d / 2 - 0.04, it.w + 0.08, it.d + 0.08);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = hair * 2;
      ctx.strokeRect(-it.w / 2 - 0.04, -it.d / 2 - 0.04, it.w + 0.08, it.d + 0.08);
    }
    const part = partOfItem(store, it);
    drawPlanSymbol(ctx, def.kind, it.w, it.d, {
      color: resolveColor(design, it.color),
      selected,
      pxPerM: zoom,
      overhead:
        def.kind === 'custom' ? (part?.type === 'board' ? false : it.elevation > 0.5) : undefined,
      bodyAlpha: part?.type === 'board' ? 0.5 : undefined,
      footprint: footprintOf(store, it) ?? undefined,
      gangs: it.params?.gangs,
      seats: it.params?.seats,
    });
    ctx.restore();

    if (selected && !it.attach) {
      // rotation handle (attached appliances follow their host)
      const h = rotateHandlePos(it);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = hair;
      ctx.beginPath();
      ctx.moveTo(it.x, it.y);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(h.x, h.y, 6 / zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = hair * 1.6;
      ctx.stroke();

      labels.push({
        x: it.x,
        y: it.y - it.d / 2 - 0.18,
        text: `${def.label} · ${Math.round(it.w * 100)}×${Math.round(it.d * 100)} cm`,
        color: ACCENT,
        size: 12,
        bold: true,
      });
    }
  }

  // ---- ghost preview ----
  if (opts.ghosts && overlays?.ghost && overlays.armedDef) {
    const armed = overlays.armedDef;
    const ghost = overlays.ghost;
    ctx.save();
    ctx.globalAlpha = ghost.valid ? 0.55 : 0.3;
    ctx.translate(ghost.x, ghost.y);
    ctx.rotate(ghost.rotation);
    const armedPart = store.partOf(armed.id);
    drawPlanSymbol(ctx, armed.kind, armed.w, armed.d, {
      color: ghost.valid ? armed.color : '#d66',
      selected: false,
      pxPerM: zoom,
      footprint: armedPart
        ? (footprintPolygon(armedPart, armed.w, armed.d) ?? undefined)
        : undefined,
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- walls ----
  ctx.lineCap = 'butt';
  const walls = store.allWalls();
  // both halves of a partition describe the same slab — draw the owner's
  const drawnWalls = walls.filter((g) => !g.shared || g.shared.owner);
  // selecting either half highlights the one partition on screen
  const wallSelected = (g: RoomWall): boolean =>
    sel.kind === 'wall' && (sel.id === g.id || sel.id === g.shared?.wallId);
  // a free-standing chain belongs to no room, so it is never "another room's"
  // wall — it always draws in full ink and always carries its dimension label
  const wallMine = (g: RoomWall): boolean =>
    !opts.roomEmphasis || !!g.freeWallId || g.roomId === activeId || g.shared?.roomId === activeId;
  // a joint takes the strongest ink of the walls meeting there
  const wallInk = (gs: RoomWall[]): string =>
    gs.some(wallSelected) ? ACCENT : gs.some(wallMine) ? INK : MUTED;

  // junction patches go UNDER the slabs: only what a slab does not already
  // cover — the true gap — shows the joint's colour, so a patch that merely
  // overlaps a neighbouring room's wall cannot bleed ink into it
  for (const j of wallJoints(walls)) {
    ctx.fillStyle = wallInk(j.walls);
    fillPoly(ctx, j.hull);
  }

  for (const g of drawnWalls) {
    // slabs are butt-ended — the patches above close every junction
    ctx.fillStyle = wallInk([g]);
    fillPoly(ctx, slabQuad(g));

    // dimension label — only for walls the active room can actually edit
    if (!wallMine(g)) continue;
    const mid = wallPoint(g, g.len / 2);
    // a partition has no "outside" to hang the label off; sit it on the seam
    const lblOff = g.shared ? 0 : 0.32;
    let ang = g.angle;
    if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI; // keep text upright
    labels.push({
      x: mid.x - g.inward.x * lblOff,
      y: mid.y - g.inward.y * lblOff,
      text: fmtCm(g.len),
      angle: ang,
      color: wallSelected(g) ? ACCENT : '#8a877f',
      size: 12,
      bold: wallSelected(g),
    });
  }

  // hairline down each seam, so a partition reads apart from an exterior wall —
  // last, or a joint patch would bury the end of it
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = hair;
  for (const g of drawnWalls) {
    if (!g.shared) continue;
    ctx.beginPath();
    ctx.moveTo(g.a.x, g.a.y);
    ctx.lineTo(g.b.x, g.b.y);
    ctx.stroke();
  }

  // ---- wall hover pre-highlight ----
  // WS-SPEC I1 (deviation, pre-approved — see plan2d.ts onPointerMove): Plan2D
  // cannot read which workspace is active, so this paints whenever the tool is
  // 'select' in EITHER Plan or Furnish, since selection/manipulation there is
  // identical by design and a pre-highlight that lied about clickability in
  // Furnish would be wrong the other way. Reuses the exact fill+path the
  // selected-wall ink above already uses, just layered on top at lower alpha.
  if (opts.handles && overlays?.hover.wallId) {
    const hoveredId = overlays.hover.wallId;
    for (const g of drawnWalls) {
      if (wallSelected(g)) continue;
      if (g.id !== hoveredId && g.shared?.wallId !== hoveredId) continue;
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = ACCENT;
      fillPoly(ctx, slabQuad(g));
      ctx.restore();
      break; // a wall id identifies at most one drawn slab
    }
  }

  // ---- wall tool ring ----
  if (opts.ghosts && overlays?.drawRing) {
    drawDrawRing(ctx, overlays.drawRing, zoom, hair, labels);
  }

  // ---- snap glyph ----
  // Under `guides`, not `ghosts`: it is feedback about the cursor, so it belongs
  // with the other things the print sheet has no use for.
  if (opts.guides && overlays?.snap) drawSnapMarker(ctx, overlays.snap, zoom, hair);

  // ---- openings ----
  for (const o of design.openings) {
    const g = store.wallById(o.wallId);
    if (!g) continue;
    const t = g.thickness;
    const p = wallPoint(g, o.offset);
    const off = bandCenter(g);
    const selectedO = sel.kind === 'opening' && sel.id === o.id;
    ctx.save();
    // local +y is the wall's inward normal, so translating by the band centre
    // puts the cut symbol on the slab whatever the face offset is
    ctx.translate(p.x + g.inward.x * off, p.y + g.inward.y * off);
    ctx.rotate(g.angle);
    // clear the wall
    ctx.fillStyle = PAPER;
    ctx.fillRect(-o.width / 2, -t / 2 - hair, o.width, t + hair * 2);
    drawPlanSymbol(ctx, o.type, o.width, t, {
      color: '#fff',
      selected: selectedO,
      pxPerM: zoom,
      doorHinge: o.hinge,
      doorSwing: o.swing,
    });
    ctx.restore();

    if (selectedO) {
      // distances to both wall ends
      const l = o.offset - o.width / 2;
      const r = g.len - o.offset - o.width / 2;
      const dimOff = -0.32;
      const gp = (tp: number): Point => ({
        x: g.a.x + g.dir.x * tp + g.inward.x * dimOff,
        y: g.a.y + g.dir.y * tp + g.inward.y * dimOff,
      });
      for (const [from, to, val] of [
        [0, o.offset - o.width / 2, l],
        [o.offset + o.width / 2, g.len, r],
      ] as const) {
        if (val < 0.03) continue;
        const a = gp(from);
        const b = gp(to);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = hair;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        labels.push({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          text: fmtCm(val),
          color: ACCENT,
          size: 11,
          bold: true,
        });
      }
    }
  }

  // ---- ghost opening ----
  if (opts.ghosts && overlays?.ghostOpening && overlays.armedDef) {
    const armed = overlays.armedDef;
    const g = store.wallById(overlays.ghostOpening.wallId);
    if (g) {
      const t = g.thickness;
      const off = bandCenter(g);
      const p = wallPoint(g, overlays.ghostOpening.t);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.translate(p.x + g.inward.x * off, p.y + g.inward.y * off);
      ctx.rotate(g.angle);
      ctx.fillStyle = PAPER;
      ctx.fillRect(-armed.w / 2, -t / 2, armed.w, t);
      drawPlanSymbol(ctx, armed.kind, armed.w, t, {
        color: '#fff',
        selected: false,
        pxPerM: zoom,
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  // ---- corner + midpoint handles (active room only, like every gesture) ----
  if (opts.handles) {
    const hoverHandle = overlays?.hover.handle ?? null;
    for (const g of walls) {
      if (g.roomId !== activeId) continue;
      const hoveredM = hoverHandle?.kind === 'midpoint' && hoverHandle.id === g.id;
      const m = midpointHandlePos(g);
      const r = (hoveredM ? 6.5 : 4.5) / zoom;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = hoveredM ? ACCENT : '#fff';
      ctx.strokeStyle = hoveredM ? ACCENT : '#a5a29a';
      ctx.lineWidth = hair;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
    const aRoom = store.activeRoom();
    const handles = aRoom ? cornerHandlePositions(store, aRoom.id) : null;
    for (const c of aRoom?.corners ?? []) {
      const selectedC = sel.kind === 'corner' && sel.id === c.id;
      const hoveredC = hoverHandle?.kind === 'corner' && hoverHandle.id === c.id;
      const activeC = selectedC || hoveredC;
      const r = (activeC ? 6.5 : 5) / zoom;
      const h = handles?.get(c.id) ?? c;
      ctx.fillStyle = activeC ? ACCENT : '#fff';
      ctx.strokeStyle = activeC ? ACCENT : INK;
      ctx.lineWidth = hair * 1.3;
      ctx.fillRect(h.x - r, h.y - r, r * 2, r * 2);
      ctx.strokeRect(h.x - r, h.y - r, r * 2, r * 2);
    }
  }

  // ---- spatial checks + measure overlays (on top of everything) ----
  if (opts.checks) drawChecks(ctx, store, hair, labels, overlays?.advisoryChecks ?? false);
  if (opts.measure && overlays) drawMeasure(ctx, overlays.measure, zoom, hair, labels);

  ctx.restore();

  // ---- labels in screen space ----
  for (const l of labels) {
    ctx.save();
    ctx.translate(l.x * zoom + panX, l.y * zoom + panY + (l.dy ?? 0));
    if (l.angle) ctx.rotate(l.angle);
    ctx.font = `${l.bold ? 600 : 500} ${l.size ?? 12}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(244, 243, 240, 0.9)';
    ctx.strokeText(l.text, 0, 0);
    ctx.fillStyle = l.color ?? INK;
    ctx.fillText(l.text, 0, 0);
    ctx.restore();
  }
}

/**
 * The imported photo, in world units: the ctx is already in metres, so scaling
 * by `scale` (m per image pixel) lets drawImage place the bitmap at its natural
 * pixel size. Rotation and scaling both pivot on the image's top-left, which is
 * exactly the anchor `underlay.x/y` names.
 */
function drawUnderlay(ctx: CanvasRenderingContext2D, store: Store, onLoad?: () => void): void {
  const ref = store.underlayRef();
  if (!ref || !ref.u.visible) return;
  const img = underlayImage(ref.src, onLoad);
  if (!img) return;
  ctx.save();
  ctx.globalAlpha = ref.u.opacity;
  ctx.translate(ref.u.x, ref.u.y);
  ctx.rotate(ref.u.rotation);
  ctx.scale(ref.u.scale, ref.u.scale);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * The wall tool's preview. Unlike the old wireframe, this paints the REAL wall
 * body at the tool's width so what the user sees while drawing is what lands:
 * per segment a quad `centreline ± width/2`, plus a convex-hull patch at each
 * interior junction — the same butt-slab + joint-patch scheme `slabQuad` /
 * `wallJoints` use for committed walls, so the preview and the result cannot
 * look different.
 *
 * `ring.closed` is the drag rectangle (a full ring, no rubber band); otherwise
 * the clicked segments are solid, the pending one is a dashed outline, and the
 * first corner is ringed as the close target. Segment labels carry the length
 * in cm — or the TYPED dimension with a caret, which is what the user is about
 * to commit rather than what the cursor happens to measure.
 */
function drawDrawRing(
  ctx: CanvasRenderingContext2D,
  ring: DrawRing,
  zoom: number,
  hair: number,
  labels: Label[]
): void {
  const pts = ring.pts;
  if (!pts.length) return;
  const half = ring.width / 2;

  /** One segment's wall body, `[aL, bL, bR, aR]` about its centreline. */
  const band = (a: Point, b: Point): Point[] | null => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) return null;
    const n = { x: (-(b.y - a.y) / len) * half, y: ((b.x - a.x) / len) * half };
    return [
      { x: a.x + n.x, y: a.y + n.y },
      { x: b.x + n.x, y: b.y + n.y },
      { x: b.x - n.x, y: b.y - n.y },
      { x: a.x - n.x, y: a.y - n.y },
    ];
  };

  const label = (a: Point, b: Point, pending: boolean): void => {
    const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
    const text = pending && ring.typed ? `${ring.typed}|` : fmtCm(len);
    labels.push({
      // clear the wall body, not just the centreline
      x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * (half + 0.16),
      y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * (half + 0.16),
      text,
      color: ACCENT,
      size: 11,
      bold: true,
    });
  };

  // the full centreline path, pending segment included, so the joints between
  // clicked and rubber-banded walls close the same way
  const path: Point[] = [...pts];
  if (!ring.closed && ring.hover) path.push(ring.hover);
  const wrap = ring.closed || (ring.closing && ring.hover !== null);

  const bands: (Point[] | null)[] = [];
  for (let i = 0; i + 1 < path.length; i++) bands.push(band(path[i], path[i + 1]));
  if (wrap && path.length >= 3) bands.push(band(path[path.length - 1], path[0]));

  // ---- bodies ----
  ctx.save();
  ctx.globalAlpha = 0.55;
  const shared = ring.sharedEdges ?? [];
  bands.forEach((q, i) => {
    if (!q) return;
    ctx.fillStyle = shared[i] ? ACCENT : INK;
    fillPoly(ctx, q);
  });
  ctx.fillStyle = INK;
  // junction patches: the convex hull of the two incident bands' facing ends,
  // which is what squares off a 90° corner instead of leaving it chamfered
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i];
    const b = bands[i + 1];
    if (a && b) fillPoly(ctx, convexHull([a[1], a[2], b[0], b[3]]));
  }
  if (wrap && bands.length >= 3) {
    const a = bands[bands.length - 1];
    const b = bands[0];
    if (a && b) fillPoly(ctx, convexHull([a[1], a[2], b[0], b[3]]));
  }
  ctx.restore();

  // ---- outlines + labels ----
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = hair * 1.6;
  const committed = ring.closed ? bands.length : pts.length - 1;
  bands.forEach((q, i) => {
    if (!q) return;
    const pending = i >= committed;
    ctx.setLineDash(pending ? [hair * 7, hair * 5] : []);
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let k = 1; k < q.length; k++) ctx.lineTo(q[k].x, q[k].y);
    ctx.closePath();
    ctx.stroke();
    const a = path[i];
    const b = path[(i + 1) % path.length];
    label(a, b, pending);
  });
  ctx.setLineDash([]);

  // ---- right-angle markers ----
  // Only at a TRUE right angle, and only while the lock is on: the marker is
  // there to confirm the snap did what the user wanted, so drawing it at 87°
  // would be the opposite of useful. The square is the standard plan notation
  // — two half-length legs off the vertex, closed across.
  if (ring.angleSnap && path.length >= 3) {
    const n = path.length;
    // an open path has no corner at either end; a wrapped one is corners all
    // the way round
    const from = wrap ? 0 : 1;
    const to = wrap ? n - 1 : n - 2;
    // twice, halo first: the marker straddles the wall body it belongs to, and
    // a single accent stroke disappears against that dark band
    for (const [color, width] of [
      [PAPER, hair * 4],
      [ACCENT, hair * 1.6],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (let i = from; i <= to; i++) {
        drawRightAngle(ctx, path[i], path[(i - 1 + n) % n], path[(i + 1) % n], zoom, half);
      }
    }
  }

  if (ring.closed) return;

  // ---- centreline corner dots + the close target ----
  ctx.fillStyle = '#fff';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = hair * 1.6;
    ctx.stroke();
  }
  if (pts.length >= 3) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, (ring.closing ? 9 : 6.5) / zoom, 0, Math.PI * 2);
    ctx.lineWidth = hair * (ring.closing ? 2.4 : 1.4);
    ctx.stroke();
  }
}

/**
 * The cursor glyph for a snap, in the plan's own notation and at a fixed SCREEN
 * size (hence every dimension divided by `zoom`).
 *
 * Drawn twice, halo first: the marker lands on top of wall bodies, guide lines
 * and the paper alike, and a single accent stroke disappears against a dark
 * slab. Same trick the right-angle markers already use.
 *
 * Exported because the wall tool is not the only caller — the measure tool and
 * the corner drag snap through the same engine and want the same vocabulary.
 */
export function drawSnapMarker(
  ctx: CanvasRenderingContext2D,
  snap: SnapResult,
  zoom: number,
  hair: number
): void {
  const glyph = SNAP_GLYPH[snap.kind];
  if (!glyph) return;
  const { x, y } = snap.p;
  const r = 5.5 / zoom;

  const path = (): void => {
    ctx.beginPath();
    switch (glyph) {
      case 'square':
        ctx.rect(x - r, y - r, r * 2, r * 2);
        break;
      case 'diamond':
        ctx.moveTo(x, y - r * 1.25);
        ctx.lineTo(x + r * 1.25, y);
        ctx.lineTo(x, y + r * 1.25);
        ctx.lineTo(x - r * 1.25, y);
        ctx.closePath();
        break;
      case 'cross':
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        break;
      case 'perp':
        // ⊥ — an upright meeting a base, the standard notation
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
        ctx.moveTo(x - r, y + r);
        ctx.lineTo(x + r, y + r);
        break;
      case 'par':
        // ∥ — two strokes, leaning so it never reads as a pause symbol
        ctx.moveTo(x - r * 0.45, y + r);
        ctx.lineTo(x + r * 0.15, y - r);
        ctx.moveTo(x + r * 0.25, y + r);
        ctx.lineTo(x + r * 0.85, y - r);
        break;
      case 'circle':
        ctx.arc(x, y, r * 1.2, 0, Math.PI * 2);
        break;
      case 'junction':
        ctx.rect(x - r, y - r, r * 2, r * 2);
        ctx.moveTo(x, y - r * 0.62);
        ctx.lineTo(x + r * 0.62, y);
        ctx.lineTo(x, y + r * 0.62);
        ctx.lineTo(x - r * 0.62, y);
        ctx.closePath();
        break;
    }
  };

  ctx.save();
  ctx.lineJoin = 'round';
  for (const [color, width] of [
    [PAPER, hair * 4.5],
    [ACCENT, hair * 1.8],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    path();
    ctx.stroke();
  }
  ctx.restore();
}

/** Is the corner at `v`, between `a` and `b`, square to within half a degree? */
function isRightAngle(v: Point, a: Point, b: Point): boolean {
  const u = { x: a.x - v.x, y: a.y - v.y };
  const w = { x: b.x - v.x, y: b.y - v.y };
  const lu = Math.hypot(u.x, u.y);
  const lw = Math.hypot(w.x, w.y);
  if (lu < 1e-6 || lw < 1e-6) return false;
  return Math.abs((u.x * w.x + u.y * w.y) / (lu * lw)) < RIGHT_ANGLE_EPS;
}

/** cos of the tolerance either side of 90° (≈0.5°). */
const RIGHT_ANGLE_EPS = 0.009;

/**
 * The plan-notation square at a right-angle corner: a leg along each wall and
 * a line closing them. Sized in SCREEN pixels so it stays readable at any
 * zoom, but never larger than the walls it marks — a 90° corner between two
 * short stubs must not sprout a box bigger than either.
 */
function drawRightAngle(
  ctx: CanvasRenderingContext2D,
  v: Point,
  a: Point,
  b: Point,
  zoom: number,
  half: number
): void {
  if (!isRightAngle(v, a, b)) return;
  const leg = (p: Point): Point => {
    const d = Math.hypot(p.x - v.x, p.y - v.y);
    const r = Math.min(11 / zoom, d * 0.4, Math.max(half * 2, 11 / zoom));
    return { x: v.x + ((p.x - v.x) / d) * r, y: v.y + ((p.y - v.y) / d) * r };
  };
  const p1 = leg(a);
  const p2 = leg(b);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p1.x + p2.x - v.x, p1.y + p2.y - v.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
}

/**
 * The spatial-check overlay: every flagged item outlined in its severity
 * colour, plus the region the check measured (a wall segment, a door sector,
 * a clearance rectangle). Errors are unconditional; warn/info wait for the ⚠
 * toggle, and only then does each finding get its detail spelled out.
 */
function drawChecks(
  ctx: CanvasRenderingContext2D,
  store: Store,
  hair: number,
  labels: Label[],
  advisory: boolean
): void {
  const warnings = store.warnings();
  if (!warnings.length) return;
  const byId = new Map(store.design.items.map((it) => [it.id, it]));
  // two findings about the same wall share a midpoint; stack their lines
  const stacked = new Map<string, number>();

  for (const w of warnings) {
    if (w.severity !== 'error' && !advisory) continue;
    const color = SEVERITY_COLOR[w.severity];
    ctx.strokeStyle = color;
    ctx.lineWidth = hair * 2;

    for (const id of w.itemIds) {
      const it = byId.get(id);
      if (!it) continue;
      const o = itemOutlineWorld(store, it);
      ctx.beginPath();
      ctx.moveTo(o[0].x, o[0].y);
      for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
      ctx.closePath();
      ctx.stroke();
    }

    const anchor = drawWarningGeom(ctx, hair, w, color);
    if (!advisory) continue;
    const at = anchor ?? warningItemCenter(w, byId);
    if (!at) continue;
    const key = `${at.x.toFixed(2)},${at.y.toFixed(2)}`;
    const n = stacked.get(key) ?? 0;
    stacked.set(key, n + 1);
    const text =
      w.detail.length > CHECK_LABEL_MAX
        ? `${w.detail.slice(0, CHECK_LABEL_MAX - 1).trimEnd()}…`
        : w.detail;
    labels.push({ x: at.x, y: at.y, dy: n * 14, text, color, size: 11, bold: true });
  }
}

/** Draws a warning's region (dashed); returns the point to hang its label off. */
function drawWarningGeom(
  ctx: CanvasRenderingContext2D,
  hair: number,
  w: Warning,
  color: string
): Point | null {
  const g = w.geom;
  if (!g) return null;
  ctx.strokeStyle = color;
  ctx.lineWidth = hair * 1.8;
  ctx.setLineDash([hair * 6, hair * 4]);
  if (g.kind === 'segment') {
    ctx.beginPath();
    ctx.moveTo(g.a.x, g.a.y);
    ctx.lineTo(g.b.x, g.b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    return { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
  }
  const pts = g.points;
  if (pts.length < 2) {
    ctx.setLineDash([]);
    return null;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.08;
  ctx.fill();
  ctx.globalAlpha = 1;
  return polygonCentroid(pts);
}

/** Fallback label anchor for a geom-less warning: the first item it names. */
function warningItemCenter(w: Warning, byId: Map<string, Item>): Point | null {
  for (const id of w.itemIds) {
    const it = byId.get(id);
    if (it) return { x: it.x, y: it.y };
  }
  return null;
}

/** Draws the two-point measurement: dashed line, endpoint dots, snap ring, label. */
function drawMeasure(
  ctx: CanvasRenderingContext2D,
  measure: Measure,
  zoom: number,
  hair: number,
  labels: Label[]
): void {
  const a = measure.a;
  const hover = measure.hover;
  // while measuring the hover position stands in for the second point
  const b = measure.b ?? (measure.measuring ? hover : null);

  const dot = (p: Point): void => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 / zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = hair * 1.8;
    ctx.strokeStyle = MEASURE;
    ctx.stroke();
  };

  if (a && b) {
    ctx.strokeStyle = MEASURE;
    ctx.lineWidth = hair * 1.8;
    ctx.setLineDash([hair * 6, hair * 4]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    dot(a);
    dot(b);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // nudge the label off the line so it stays readable
    const len = Math.max(1e-6, dist);
    const off = 0.24;
    labels.push({
      x: mid.x - (dy / len) * off,
      y: mid.y + (dx / len) * off,
      text: `${fmtCm(dist)}  (${Math.round(Math.abs(dx) * 100)}×${Math.round(Math.abs(dy) * 100)})`,
      color: MEASURE,
      size: 12,
      bold: true,
    });
  } else if (a) {
    dot(a);
  }

  // snap indicator on the live cursor (before the segment is complete)
  if (hover && measure.snapped && !measure.b) {
    ctx.beginPath();
    ctx.arc(hover.x, hover.y, 6.5 / zoom, 0, Math.PI * 2);
    ctx.strokeStyle = MEASURE;
    ctx.lineWidth = hair * 1.4;
    ctx.stroke();
  }
}
