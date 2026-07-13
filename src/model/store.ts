import { catalogDef, defaultParams, hasCatalogDef, type CatalogDef } from './catalog';
import { clamp, dist, projectOnWall, signedArea, wallGeom, wallPoint, type WallGeom } from './geometry';
import { samplePart, sanitizePart, toCatalogDef } from './parts';
import { migrateDesignV1, migratePartV1 } from './partsMigrate';
import type { ChangeInfo, Corner, CustomPartDef, Design, Item, Opening, Point, Selection } from './types';
import { uid } from './types';

type EventMap = {
  change: ChangeInfo;
  selection: Selection;
  history: void;
};

type Handler<T> = (payload: T) => void;

const AUTOSAVE_KEY = 'kitchen-planner-design-v1';

export class Store {
  design: Design;
  selection: Selection = { kind: 'none' };

  private handlers: { [K in keyof EventMap]: Handler<EventMap[K]>[] } = {
    change: [],
    selection: [],
    history: [],
  };

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCommitted: string;

  constructor(design: Design) {
    this.design = design;
    this.lastCommitted = JSON.stringify(design);
  }

  /* ---------------- events ---------------- */

  on<K extends keyof EventMap>(evt: K, fn: Handler<EventMap[K]>): void {
    this.handlers[evt].push(fn as Handler<EventMap[K]>);
  }

  private emit<K extends keyof EventMap>(evt: K, payload: EventMap[K]): void {
    for (const fn of this.handlers[evt]) fn(payload);
  }

  notify(info: ChangeInfo): void {
    this.emit('change', info);
  }

  /* ---------------- selection ---------------- */

  select(sel: Selection): void {
    this.selection = sel;
    this.emit('selection', sel);
  }

  selectedItem(): Item | undefined {
    return this.selection.kind === 'item' ? this.itemById(this.selection.id) : undefined;
  }

  /* ---------------- history ---------------- */

  /** Push an undo snapshot if anything changed since the last commit. Call at the end of a gesture. */
  commit(): void {
    const now = JSON.stringify(this.design);
    if (now === this.lastCommitted) return;
    this.undoStack.push(this.lastCommitted);
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
    this.lastCommitted = now;
    this.autosave();
    this.emit('history', undefined);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    // an uncommitted gesture first becomes its own undo step, so nothing is skipped
    this.commit();
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.design));
    this.restore(this.undoStack.pop()!);
  }

  redo(): void {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.design));
    this.restore(this.redoStack.pop()!);
  }

  private restore(json: string): void {
    this.design = normalizeDesign(JSON.parse(json));
    this.lastCommitted = json;
    this.select({ kind: 'none' });
    this.autosave();
    this.notify({ structural: true });
    this.emit('history', undefined);
  }

  replaceDesign(design: Design): void {
    this.undoStack.push(JSON.stringify(this.design));
    this.redoStack = [];
    this.design = normalizeDesign(design);
    this.lastCommitted = JSON.stringify(this.design);
    this.select({ kind: 'none' });
    this.autosave();
    this.notify({ structural: true });
    this.emit('history', undefined);
  }

  /* ---------------- persistence ---------------- */

  autosave(): void {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.design));
    } catch {
      /* storage may be unavailable — ignore */
    }
  }

  static loadAutosaved(): Design | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? sanitizeDesign(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  exportJson(): string {
    return JSON.stringify(this.design, null, 2);
  }

  /* ---------------- room queries ---------------- */

  walls(): WallGeom[] {
    const c = this.design.corners;
    const out: WallGeom[] = [];
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      out.push(wallGeom({ id: a.id, a, b }));
    }
    return out;
  }

  wallById(id: string): WallGeom | undefined {
    return this.walls().find((w) => w.id === id);
  }

  cornerById(id: string): Corner | undefined {
    return this.design.corners.find((c) => c.id === id);
  }

  openingById(id: string): Opening | undefined {
    return this.design.openings.find((o) => o.id === id);
  }

  itemById(id: string): Item | undefined {
    return this.design.items.find((i) => i.id === id);
  }

  customPartById(id: string): CustomPartDef | undefined {
    return this.design.customParts.find((p) => p.id === id);
  }

  /** Resolve any defId — built-in catalog entry or user-created part. */
  defOf(defId: string): CatalogDef {
    const part = this.customPartById(defId);
    return part ? toCatalogDef(part) : catalogDef(defId);
  }

  floorArea(): number {
    return Math.abs(signedArea(this.design.corners));
  }

  /** True when the room is a 4-corner axis-aligned rectangle. */
  rectangleSize(): { w: number; d: number } | null {
    const c = this.design.corners;
    if (c.length !== 4) return null;
    const eps = 1e-3;
    for (let i = 0; i < 4; i++) {
      const a = c[i];
      const b = c[(i + 1) % 4];
      if (Math.abs(a.x - b.x) > eps && Math.abs(a.y - b.y) > eps) return null;
    }
    const xs = c.map((p) => p.x);
    const ys = c.map((p) => p.y);
    return {
      w: Math.max(...xs) - Math.min(...xs),
      d: Math.max(...ys) - Math.min(...ys),
    };
  }

  /* ---------------- room mutations ---------------- */

  /** Re-establish the CCW invariant + opening bounds after any corner mutation. */
  private renormalize(): void {
    normalizeDesign(this.design);
    this.clampAllOpenings();
  }

  moveCorner(id: string, x: number, y: number, transient = true): void {
    const c = this.cornerById(id);
    if (!c) return;
    c.x = x;
    c.y = y;
    this.renormalize();
    this.notify({ structural: true, transient });
  }

  /** Insert a corner on a wall at distance t from its start. Returns the new corner. */
  splitWall(wallId: string, t: number): Corner | null {
    const c = this.design.corners;
    const idx = c.findIndex((k) => k.id === wallId);
    if (idx < 0) return null;
    const g = this.wallById(wallId)!;
    t = clamp(t, 0.1, g.len - 0.1);
    const nc: Corner = { id: uid('c'), x: g.a.x + g.dir.x * t, y: g.a.y + g.dir.y * t };
    c.splice(idx + 1, 0, nc);
    // openings past the split belong to the new (second) wall
    for (const o of this.design.openings) {
      if (o.wallId === wallId && o.offset > t) {
        o.wallId = nc.id;
        o.offset -= t;
      }
    }
    this.renormalize();
    this.notify({ structural: true });
    return nc;
  }

  deleteCorner(id: string): void {
    const c = this.design.corners;
    if (c.length <= 3) return;
    const idx = c.findIndex((k) => k.id === id);
    if (idx < 0) return;
    const prev = c[(idx - 1 + c.length) % c.length];
    // openings on the two merging walls keep their world position, not their old offset
    const affected: { o: Opening; p: Point }[] = [];
    for (const o of this.design.openings) {
      if (o.wallId === id || o.wallId === prev.id) {
        const g = this.wallById(o.wallId);
        if (g) affected.push({ o, p: wallPoint(g, o.offset) });
      }
    }
    c.splice(idx, 1);
    const merged = this.wallById(prev.id);
    for (const { o, p } of affected) {
      o.wallId = prev.id;
      if (merged) o.offset = projectOnWall(merged, p).t;
    }
    this.renormalize();
    if (this.selection.kind === 'corner' && this.selection.id === id) this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  /**
   * Set a wall's length by moving its end corner along the wall direction.
   * Perpendicular neighbour walls are shifted too, so rectangles stay rectangles.
   */
  setWallLength(wallId: string, len: number): void {
    const g = this.wallById(wallId);
    if (!g || len < 0.3) return;
    const delta = len - g.len;
    const dx = g.dir.x * delta;
    const dy = g.dir.y * delta;
    const c = this.design.corners;
    const startIdx = c.findIndex((k) => k.id === wallId);
    if (startIdx < 0) return;
    // move corner b, then keep moving subsequent corners while the ORIGINAL
    // edges stay perpendicular to the edited wall — so orthogonal rooms keep
    // their shape (a rectangle stays a rectangle when one side is resized)
    const original = c.map((k) => ({ x: k.x, y: k.y }));
    let i = (startIdx + 1) % c.length;
    let moved = 0;
    while (moved < c.length - 1) {
      c[i].x += dx;
      c[i].y += dy;
      moved++;
      const ni = (i + 1) % c.length;
      if (c[ni].id === wallId) break; // never wrap all the way around
      const ex = original[ni].x - original[i].x;
      const ey = original[ni].y - original[i].y;
      const elen = Math.hypot(ex, ey) || 1;
      const dot = Math.abs((ex / elen) * g.dir.x + (ey / elen) * g.dir.y);
      if (dot > 0.05) break; // next edge not perpendicular — stop propagating
      i = ni;
    }
    this.renormalize();
    this.notify({ structural: true });
  }

  setRectangleSize(w: number, d: number): void {
    const rect = this.rectangleSize();
    if (!rect || w < 1 || d < 1) return;
    const c = this.design.corners;
    const minX = Math.min(...c.map((p) => p.x));
    const minY = Math.min(...c.map((p) => p.y));
    for (const p of c) {
      p.x = minX + (p.x - minX > 1e-3 ? w : 0);
      p.y = minY + (p.y - minY > 1e-3 ? d : 0);
    }
    this.renormalize();
    this.notify({ structural: true });
  }

  /** Replace the room outline with a preset shape (items are kept). */
  setShapePreset(preset: 'rect' | 'lshape'): void {
    const c = (x: number, y: number): Corner => ({ id: uid('c'), x, y });
    this.design.corners =
      preset === 'rect'
        ? [c(0, 0), c(4, 0), c(4, 3), c(0, 3)]
        : [c(0, 0), c(4.2, 0), c(4.2, 2.2), c(2.4, 2.2), c(2.4, 3.4), c(0, 3.4)];
    normalizeDesign(this.design);
    // openings reference walls that no longer exist
    this.design.openings = [];
    this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  /* ---------------- opening mutations ---------------- */

  addOpening(def: CatalogDef, wallId: string, offset: number): Opening {
    const o: Opening = {
      id: uid('o'),
      wallId,
      type: def.kind === 'door' ? 'door' : 'window',
      offset,
      width: def.w,
      height: def.h,
      sill: def.kind === 'door' ? 0 : def.elevation,
    };
    this.design.openings.push(o);
    this.clampOpening(o);
    this.notify({ structural: true });
    return o;
  }

  updateOpening(id: string, patch: Partial<Opening>, info: ChangeInfo = { structural: true }): void {
    const o = this.openingById(id);
    if (!o) return;
    Object.assign(o, patch);
    this.clampOpening(o);
    this.notify(info);
  }

  deleteOpening(id: string): void {
    this.design.openings = this.design.openings.filter((o) => o.id !== id);
    if (this.selection.kind === 'opening' && this.selection.id === id) this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  private clampOpening(o: Opening): void {
    const g = this.wallById(o.wallId);
    if (!g) return;
    o.width = clamp(o.width, 0.3, Math.max(0.3, g.len - 0.2));
    const lo = o.width / 2 + 0.05;
    const hi = g.len - o.width / 2 - 0.05;
    o.offset = hi < lo ? g.len / 2 : clamp(o.offset, lo, hi);
    const maxH = this.design.room.wallHeight - 0.05;
    o.height = clamp(o.height, 0.3, maxH);
    o.sill = clamp(o.sill, 0, maxH - o.height);
  }

  private clampAllOpenings(): void {
    for (const o of this.design.openings) this.clampOpening(o);
  }

  /* ---------------- item mutations ---------------- */

  addItem(def: CatalogDef, x: number, y: number, rotation = 0): Item {
    const item: Item = {
      id: uid('i'),
      defId: def.id,
      x,
      y,
      rotation,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: def.elevation,
      color: def.color,
      light: def.light ? { on: def.light.on, intensity: def.light.intensity, warmth: def.light.warmth } : undefined,
      params: defaultParams(def),
    };
    // instances of user parts start at the part's configured elevation
    const part = this.customPartById(def.id);
    if (part) item.elevation = part.elevation;
    this.design.items.push(item);
    this.notify({ structural: true });
    return item;
  }

  /* ---------------- custom parts ---------------- */

  upsertCustomPart(part: CustomPartDef): void {
    const idx = this.design.customParts.findIndex((p) => p.id === part.id);
    if (idx >= 0) this.design.customParts[idx] = part;
    else this.design.customParts.push(part);
    this.saveSharedLibrary();
    this.notify({ structural: true });
  }

  /** Delete a part and any placed instances of it. */
  deleteCustomPart(id: string): number {
    const used = this.design.items.filter((i) => i.defId === id).length;
    this.design.items = this.design.items.filter((i) => i.defId !== id);
    this.design.customParts = this.design.customParts.filter((p) => p.id !== id);
    this.saveSharedLibrary();
    if (this.selection.kind === 'item' && !this.itemById(this.selection.id)) {
      this.select({ kind: 'none' });
    }
    this.notify({ structural: true });
    return used;
  }

  /** Parts are also kept in a shared library so new designs start with them. */
  private saveSharedLibrary(): void {
    try {
      localStorage.setItem('kitchen-planner-parts-v1', JSON.stringify(this.design.customParts));
    } catch {
      /* ignore */
    }
  }

  static sharedLibrary(): CustomPartDef[] {
    try {
      const raw = localStorage.getItem('kitchen-planner-parts-v1');
      if (!raw) return [samplePart()];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [samplePart()];
      // v1 entries carry `template`, v2 carry `type` — migrate per element
      const parts = parsed
        .map((p) => {
          const rec = p as Record<string, unknown> | null;
          if (rec && typeof rec.template === 'string') return migratePartV1(rec);
          return sanitizePart(p);
        })
        .filter((p): p is CustomPartDef => !!p);
      return parts.length ? parts : [samplePart()];
    } catch {
      return [samplePart()];
    }
  }

  setItemParam(id: string, key: string, value: number): void {
    const it = this.itemById(id);
    if (!it) return;
    if (!it.params) it.params = {};
    it.params[key] = value;
    this.notify({ structural: true });
  }

  updateItem(id: string, patch: Partial<Item>, info: ChangeInfo = { structural: true }): void {
    const it = this.itemById(id);
    if (!it) return;
    Object.assign(it, patch);
    this.notify(info);
  }

  updateItemLight(id: string, patch: Partial<NonNullable<Item['light']>>): void {
    const it = this.itemById(id);
    if (!it?.light) return;
    Object.assign(it.light, patch);
    this.notify({ structural: false });
  }

  deleteItem(id: string): void {
    this.design.items = this.design.items.filter((i) => i.id !== id);
    if (this.selection.kind === 'item' && this.selection.id === id) this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  duplicateItem(id: string): Item | undefined {
    const it = this.itemById(id);
    if (!it) return undefined;
    const copy: Item = JSON.parse(JSON.stringify(it));
    copy.id = uid('i');
    // offset the copy sideways (along its width axis) so it lands next to the original
    copy.x += Math.cos(it.rotation) * (it.w + 0.02);
    copy.y += Math.sin(it.rotation) * (it.w + 0.02);
    this.design.items.push(copy);
    this.notify({ structural: true });
    return copy;
  }

  /* ---------------- scene / room style ---------------- */

  /** Patch global lighting/environment. Non-structural — relight applies it live. */
  setScene(patch: Partial<Design['scene']>, info: ChangeInfo = { structural: false }): void {
    Object.assign(this.design.scene, patch);
    this.notify(info);
  }

  /** Back-compat quick toggle: jump the time-of-day between midday and night. */
  setNight(night: boolean): void {
    this.setScene({ timeOfDay: night ? 22 : 13 });
  }

  setRoomStyle(patch: Partial<Design['room']>): void {
    Object.assign(this.design.room, patch);
    this.clampAllOpenings();
    this.notify({ structural: true });
  }
}

/** Ensure corner order is counter-clockwise so inward normals point into the room. */
export function normalizeDesign(d: Design): Design {
  if (!Array.isArray(d.customParts)) d.customParts = [];
  if (signedArea(d.corners) < 0) {
    // reversing flips every wall a→b (keyed by a.id) into b→a (keyed by b.id),
    // so openings must switch wall id and mirror their offset
    const walls = new Map<string, { endId: string; len: number }>();
    const c = d.corners;
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      walls.set(a.id, { endId: b.id, len: dist(a, b) });
    }
    c.reverse();
    for (const o of d.openings ?? []) {
      const w = walls.get(o.wallId);
      if (w) {
        o.wallId = w.endId;
        o.offset = w.len - o.offset;
      }
    }
  }
  return d;
}

export const DESIGN_VERSION = 2;

/** Validate + repair a design parsed from storage or a file. Returns null when unusable. */
export function sanitizeDesign(raw: unknown): Design | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.version !== 'number' || d.version > DESIGN_VERSION) return null;
  if (!Array.isArray(d.corners) || d.corners.length < 3) return null;
  const base = emptyDesign();
  if (!Array.isArray(d.openings)) d.openings = [];
  if (!Array.isArray(d.items)) d.items = [];
  if (!Array.isArray(d.customParts)) d.customParts = [];
  if (d.version < 2) migrateDesignV1(d);
  d.customParts = (d.customParts as unknown[]).map(sanitizePart).filter(Boolean);
  // items whose defId resolves nowhere would crash the render loop
  const partIds = new Set((d.customParts as CustomPartDef[]).map((p) => p.id));
  d.items = (d.items as Item[]).filter(
    (i) => i && typeof i.defId === 'string' && (partIds.has(i.defId) || hasCatalogDef(i.defId))
  );
  d.room = { ...base.room, ...(d.room && typeof d.room === 'object' ? d.room : {}) };
  const rawScene = (d.scene && typeof d.scene === 'object' ? d.scene : {}) as Record<string, unknown>;
  // v1/v2-early scenes only had { night }; expand to a time-of-day before merging
  if (typeof rawScene.timeOfDay !== 'number') rawScene.timeOfDay = rawScene.night ? 22 : 13;
  delete rawScene.night;
  d.scene = { ...base.scene, ...rawScene };
  d.version = DESIGN_VERSION;
  return normalizeDesign(d as unknown as Design);
}

/* ---------------- factory designs ---------------- */

/** Default global lighting: midday, neutral studio environment. */
export function defaultScene(): Design['scene'] {
  return {
    timeOfDay: 13,
    exposure: 1.05,
    sunStrength: 1,
    ambientStrength: 1,
    envPreset: 'studio',
    envIntensity: 1,
  };
}

export function emptyDesign(): Design {
  const c = (x: number, y: number): Corner => ({ id: uid('c'), x, y });
  return normalizeDesign({
    version: 2,
    corners: [c(0, 0), c(4, 0), c(4, 3), c(0, 3)],
    openings: [],
    items: [],
    customParts: Store.sharedLibrary(),
    room: {
      wallColor: '#f4f1ea',
      floorColor: '#cfccc6',
      counterColor: '#c9a87c',
      wallHeight: 2.6,
      wallThickness: 0.1,
    },
    scene: defaultScene(),
  });
}

/**
 * Demo kitchen inspired by the reference images: sage-green matte fronts,
 * oak worktop and backsplash, appliance tower, LED strip, island with stools.
 */
export function demoDesign(): Design {
  const c1: Corner = { id: uid('c'), x: 0, y: 0 };
  const c2: Corner = { id: uid('c'), x: 4.2, y: 0 };
  const c3: Corner = { id: uid('c'), x: 4.2, y: 3.4 };
  const c4: Corner = { id: uid('c'), x: 0, y: 3.4 };

  const t = 0.1; // wall thickness
  const backY = (depth: number) => t / 2 + depth / 2; // back flush against the top wall

  const items: Item[] = [];
  const add = (defId: string, x: number, y: number, rotation = 0, patch: Partial<Item> = {}) => {
    const def = catalogDef(defId);
    const it: Item = {
      id: uid('i'),
      defId,
      x,
      y,
      rotation,
      w: def.w,
      d: def.d,
      h: def.h,
      elevation: def.elevation,
      color: def.color,
      light: def.light
        ? { on: def.light.on, intensity: def.light.intensity, warmth: def.light.warmth }
        : undefined,
      params: defaultParams(def),
      ...patch,
    };
    items.push(it);
    return it;
  };

  const SAGE = '#8a9683';

  // Worktop run along the top wall (y = 0), left to right.
  add('base-drawers', 0.45, backY(0.6), 0, { w: 0.8, color: SAGE });
  add('base-sink', 1.25, backY(0.6), 0, { color: SAGE });
  add('base-hob', 1.95, backY(0.6), 0, { color: SAGE });
  add('base-cabinet', 2.55, backY(0.6), 0, { color: SAGE });
  add('dishwasher', 3.15, backY(0.6));
  add('oven-tower', 3.78, backY(0.6), 0, { color: SAGE });

  // Fridge on the right wall (faces left, rotation +90°).
  add('fridge', 4.2 - t / 2 - 0.35, 1.2, Math.PI / 2);

  // Oak backsplash panel + wall units above the run.
  add('backsplash', 1.75, t / 2 + 0.01, 0, { w: 3.4 });
  add('wall-shelf', 0.32, backY(0.25), 0, { w: 0.5 });
  add('hood', 1.95, backY(0.45));
  add('wall-cabinet', 2.85, backY(0.35), 0, { w: 1.2, color: SAGE, params: { doors: 2 } });
  add('strip', 2.85, 0.1, 0, { w: 1.2, elevation: 1.42 });

  // Utilities sketched on the wall: water at the sink, outlets above the worktop.
  add('water', 1.25, t / 2 + 0.03);
  add('outlet', 0.45, t / 2 + 0.015);
  add('outlet', 2.55, t / 2 + 0.015);

  // Island with stools and pendants (white island, oak stools — image 7 vibe).
  add('island', 2.0, 2.0);
  add('stool', 1.4, 2.72, Math.PI);
  add('stool', 2.0, 2.72, Math.PI);
  add('stool', 2.6, 2.72, Math.PI);
  add('pendant', 1.55, 2.0, 0, { elevation: 1.55 });
  add('pendant', 2.45, 2.0, 0, { elevation: 1.55 });

  // Ceiling spots along the worktop.
  add('spot', 1.0, 1.15);
  add('spot', 2.1, 1.15);
  add('spot', 3.2, 1.15);

  const openings: Opening[] = [
    { id: uid('o'), wallId: c1.id, type: 'window', offset: 1.25, width: 1.3, height: 1.15, sill: 0.95 },
    { id: uid('o'), wallId: c3.id, type: 'door', offset: 0.85, width: 0.95, height: 2.05, sill: 0 },
  ];

  return normalizeDesign({
    version: 2,
    corners: [c1, c2, c3, c4],
    openings,
    items,
    customParts: Store.sharedLibrary(),
    room: {
      wallColor: '#f4f1ea',
      floorColor: '#cfccc6',
      counterColor: '#c9a87c',
      wallHeight: 2.6,
      wallThickness: t,
    },
    scene: defaultScene(),
  });
}
