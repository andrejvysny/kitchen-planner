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

import type { CatalogDef } from '../model/catalog';
import type { Severity, Warning } from '../model/checks';
import { fmtCm, polygonCentroid, rot, wallPoint } from '../model/geometry';
import { footprintPolygon } from '../model/parts';
import type { RoomWall } from '../model/rooms';
import type { Guide } from '../model/snapping';
import type { AddRoomOptions, Store } from '../model/store';
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
 * Where a wall slab's centreline sits relative to its polygon edge, measured
 * along the edge's inward normal. Room corners are the ROOM-SIDE wall face, so
 * an exterior wall lies wholly outside (−t/2) and a partition straddles (0).
 */
export const bandCenter = (g: RoomWall): number => g.faceOffset - g.thickness / 2;

/** How far a wall must run past its corners for the joint to close. */
export const bandExtend = (g: RoomWall): number => g.thickness - g.faceOffset;

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
 * Preview of the room the add-room tool would create: the exact polygon plus
 * the `addRoom` call that produces it, so the click cannot drift from the ghost.
 */
export interface RoomGhost {
  poly: Point[];
  opts: AddRoomOptions;
  /** hung off an existing wall (vs. free-standing) — drawn slightly differently */
  attached: boolean;
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
  roomGhost: RoomGhost | null;
  measure: Measure;
  /** the ⚠ toggle: warn/info findings on top of the always-drawn errors */
  advisoryChecks: boolean;
}

const NO_SELECTION: Selection = { kind: 'none' };

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
  const local =
    footprintOf(store, it) ??
    [
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

  const design = store.design;
  // the selection is an editing affordance: paper shows the plan, not the cursor
  const sel = opts.handles ? store.selection : NO_SELECTION;
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
      ctx.strokeStyle = GUIDE;
      ctx.lineWidth = hair;
      ctx.setLineDash([hair * 5, hair * 4]);
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
          color: GUIDE,
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
      footprint: armedPart ? (footprintPolygon(armedPart, armed.w, armed.d) ?? undefined) : undefined,
    });
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ---- walls ----
  ctx.lineCap = 'butt';
  const walls = store.allWalls();
  for (const g of walls) {
    // both halves of a partition describe the same slab — draw the owner's
    if (g.shared && !g.shared.owner) continue;
    // selecting either half highlights the one partition on screen
    const selectedWall = sel.kind === 'wall' && (sel.id === g.id || sel.id === g.shared?.wallId);
    const mine = !opts.roomEmphasis || g.roomId === activeId || g.shared?.roomId === activeId;
    ctx.strokeStyle = selectedWall ? ACCENT : mine ? INK : MUTED;
    ctx.lineWidth = g.thickness;
    // the slab sits outside the room-side face; extend it past both corners
    // so the joints close
    const off = bandCenter(g);
    const ext = bandExtend(g);
    ctx.beginPath();
    ctx.moveTo(g.a.x - g.dir.x * ext + g.inward.x * off, g.a.y - g.dir.y * ext + g.inward.y * off);
    ctx.lineTo(g.b.x + g.dir.x * ext + g.inward.x * off, g.b.y + g.dir.y * ext + g.inward.y * off);
    ctx.stroke();

    if (g.shared) {
      // hairline down the seam, so a partition reads apart from an exterior wall
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = hair;
      ctx.beginPath();
      ctx.moveTo(g.a.x, g.a.y);
      ctx.lineTo(g.b.x, g.b.y);
      ctx.stroke();
    }

    // dimension label — only for walls the active room can actually edit
    if (!mine) continue;
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
      color: selectedWall ? ACCENT : '#8a877f',
      size: 12,
      bold: selectedWall,
    });
  }

  // ---- add-room ghost ----
  if (opts.ghosts && overlays?.roomGhost) {
    const poly = overlays.roomGhost.poly;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    ctx.fillStyle = ACCENT;
    ctx.globalAlpha = 0.12;
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = hair * 2;
    ctx.setLineDash([hair * 7, hair * 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    const c = polygonCentroid(poly);
    labels.push({
      x: c.x,
      y: c.y,
      text: overlays.roomGhost.attached ? 'New room · shares this wall' : 'New room',
      color: ACCENT,
      size: 12,
      bold: true,
    });
  }

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
    for (const g of walls) {
      if (g.roomId !== activeId) continue;
      const m = wallPoint(g, g.len / 2);
      const r = 4.5 / zoom;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#a5a29a';
      ctx.lineWidth = hair;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
    for (const c of store.activeRoom().corners) {
      const selectedC = sel.kind === 'corner' && sel.id === c.id;
      const r = (selectedC ? 6.5 : 5) / zoom;
      ctx.fillStyle = selectedC ? ACCENT : '#fff';
      ctx.strokeStyle = selectedC ? ACCENT : INK;
      ctx.lineWidth = hair * 1.3;
      ctx.fillRect(c.x - r, c.y - r, r * 2, r * 2);
      ctx.strokeRect(c.x - r, c.y - r, r * 2, r * 2);
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
