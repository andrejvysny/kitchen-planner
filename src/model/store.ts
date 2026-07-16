import { catalogDef, defaultParams, hasCatalogDef, type CatalogDef } from './catalog';
import { hasPreset, presetPart } from './presets';
import { clamp, dist, projectOnWall, signedArea, wallGeom, wallPoint, type WallGeom } from './geometry';
import { hasMaterial } from './materials';
import { applianceTowerPart, samplePart, sanitizePart, toCatalogDef } from './parts';
import { SUN_ELEV_MAX, SUN_ELEV_MIN } from './sky';
import type { Attachment, ChangeInfo, Corner, CustomPartDef, Design, DesignVar, Item, Opening, Point, Selection, WallVisMode } from './types';
import { uid } from './types';
import { syncAttachments } from './attach';
import { OpenFronts } from './openFronts';
import { detach, isVarRef, refId, toVarRef, VAR_FALLBACK } from './variables';

type EventMap = {
  change: ChangeInfo;
  selection: Selection;
  history: void;
  /** ephemeral open-front poses changed — apply without rebuild */
  pose: void;
};

type Handler<T> = (payload: T) => void;

const AUTOSAVE_KEY = 'kitchen-planner-design-v1';

export class Store {
  design: Design;
  selection: Selection = { kind: 'none' };
  /** ephemeral door/drawer open-preview state — like selection, never saved */
  readonly openFronts = new OpenFronts();

  private handlers: { [K in keyof EventMap]: Handler<EventMap[K]>[] } = {
    change: [],
    selection: [],
    history: [],
    pose: [],
  };

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastCommitted: string;

  constructor(design: Design) {
    this.design = design;
    this.lastCommitted = JSON.stringify(design);
    this.openFronts.onChange = () => this.emit('pose', undefined);
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
    this.saveSharedLibrary(); // undoing a part fork/save must not orphan it in the library
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
    this.openFronts.clear(); // stale poses must not leak across designs
    this.saveSharedLibrary();
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

  /**
   * Resolve any defId to its part def — a design-local custom part first
   * (deliberately shadowing a same-id preset), then the built-in presets.
   */
  partOf(defId: string): CustomPartDef | undefined {
    return this.customPartById(defId) ?? presetPart(defId);
  }

  /** Resolve any defId — built-in catalog entry or user-created part. */
  defOf(defId: string): CatalogDef {
    const part = this.partOf(defId);
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
    const part = this.partOf(def.id);
    if (part) item.elevation = part.elevation;
    // bind new items to the configured default variables where applicable
    const { defaultFrontVar, defaultAccentVar } = this.design;
    if (defaultFrontVar && !def.opening && !def.marker && this.variableById(defaultFrontVar)) {
      item.color = toVarRef(defaultFrontVar);
    }
    if (defaultAccentVar && part && this.variableById(defaultAccentVar)) {
      item.accentColor = toVarRef(defaultAccentVar);
    }
    this.design.items.push(item);
    this.notify({ structural: true });
    return item;
  }

  /* ---------------- custom parts ---------------- */

  upsertCustomPart(part: CustomPartDef): void {
    const idx = this.design.customParts.findIndex((p) => p.id === part.id);
    if (idx >= 0) this.design.customParts[idx] = part;
    else this.design.customParts.push(part);
    // a def edit can remove a worktop or an appliance niche — attachments
    // that no longer resolve detach to the world instead of dangling
    syncAttachments(this.design);
    this.saveSharedLibrary();
    this.notify({ structural: true });
  }

  /**
   * Clone the item's resolved part (preset or shared custom part) into
   * design.customParts and repoint just this instance at the copy — the
   * "Customize part…" flow. Caller commits.
   */
  forkPartForItem(itemId: string): CustomPartDef | undefined {
    const it = this.itemById(itemId);
    const src = it && this.partOf(it.defId);
    if (!it || !src) return undefined;
    const copy = JSON.parse(JSON.stringify(src)) as CustomPartDef;
    copy.id = uid('part');
    copy.name = `${src.name} (custom)`.slice(0, 32);
    this.upsertCustomPart(copy);
    this.updateItem(itemId, { defId: copy.id });
    return copy;
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
      const parts = parsed.map(sanitizePart).filter((p): p is CustomPartDef => !!p);
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
    // a param may drive item width (e.g. outlet gangs extend the box)
    const pd = this.defOf(it.defId).params?.find((p) => p.key === key);
    if (pd?.widthPer) it.w = value * pd.widthPer;
    this.notify({ structural: true });
  }

  updateItem(id: string, patch: Partial<Item>, info: ChangeInfo = { structural: true }): void {
    const it = this.itemById(id);
    if (!it) return;
    Object.assign(it, patch);
    const touchesPose = ['x', 'y', 'rotation', 'elevation', 'w', 'd', 'h'].some((k) => k in patch);
    if (touchesPose) {
      // moving an ATTACHED item re-anchors it on its host (world → host-local)
      if (it.attach?.kind === 'counter' && ('x' in patch || 'y' in patch)) {
        const host = this.itemById(it.attach.hostId);
        if (host) {
          const c = Math.cos(host.rotation);
          const s = Math.sin(host.rotation);
          const dx = it.x - host.x;
          const dy = it.y - host.y;
          it.attach.u = dx * c + dy * s;
          it.attach.v = -dx * s + dy * c;
        }
      }
      // moving a HOST carries its appliances; either way the caches resettle
      if (it.attach || this.design.items.some((o) => o.attach && o.attach.hostId === id)) {
        syncAttachments(this.design);
        // a moved cutout changes the host's panel list — must rebuild
        info = { ...info, structural: true };
      }
    }
    this.notify(info);
  }

  /** Attach/detach an appliance; poses resettle immediately. */
  setAttachment(id: string, attach: Item['attach']): void {
    const it = this.itemById(id);
    if (!it) return;
    if (attach) it.attach = attach;
    else delete it.attach;
    syncAttachments(this.design);
    this.notify({ structural: true, transient: true });
  }

  updateItemLight(id: string, patch: Partial<NonNullable<Item['light']>>): void {
    const it = this.itemById(id);
    if (!it?.light) return;
    Object.assign(it.light, patch);
    this.notify({ structural: false });
  }

  deleteItem(id: string): void {
    // deleting a host takes its mounted appliances with it (one undo step)
    const doomed = new Set([id]);
    for (const i of this.design.items) {
      if (i.attach && i.attach.hostId === id) doomed.add(i.id);
    }
    this.design.items = this.design.items.filter((i) => !doomed.has(i.id));
    if (this.selection.kind === 'item' && doomed.has(this.selection.id)) this.select({ kind: 'none' });
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
    // duplicated appliances detach (their anchor spot is taken); duplicated
    // hosts bring rehomed copies of their mounted appliances along
    delete copy.attach;
    this.design.items.push(copy);
    for (const child of [...this.design.items]) {
      if (!child.attach || child.attach.hostId !== id) continue;
      const cc: Item = JSON.parse(JSON.stringify(child));
      cc.id = uid('i');
      cc.attach = { ...child.attach, hostId: copy.id } as Item['attach'];
      this.design.items.push(cc);
    }
    syncAttachments(this.design);
    this.notify({ structural: true });
    return copy;
  }

  /* ---------------- scene / room style ---------------- */

  /** Patch global lighting. Non-structural — relight applies it live. */
  setScene(patch: Partial<Design['scene']>, info: ChangeInfo = { structural: false }): void {
    Object.assign(this.design.scene, patch);
    this.notify(info);
  }

  /** Topbar quick toggle: night preset dims global light so fixture lamps glow. */
  setNight(night: boolean): void {
    this.setScene({ night });
  }

  setRoomStyle(patch: Partial<Design['room']>): void {
    Object.assign(this.design.room, patch);
    this.clampAllOpenings();
    this.notify({ structural: true });
  }

  /* ---------------- design variables ---------------- */

  variableById(id: string): DesignVar | undefined {
    return this.design.variables.find((v) => v.id === id);
  }

  addVariable(patch: Partial<DesignVar> = {}): DesignVar {
    const v: DesignVar = {
      id: uid('var'),
      name: patch.name ?? `Variable ${this.design.variables.length + 1}`,
      color: patch.color ?? '#8a9683',
      material: patch.material,
      materialRot: patch.materialRot,
    };
    this.design.variables.push(v);
    // colour changes force a geometry rebuild, so keep this structural
    this.notify({ structural: true });
    return v;
  }

  updateVariable(id: string, patch: Partial<DesignVar>): void {
    const v = this.variableById(id);
    if (!v) return;
    Object.assign(v, patch);
    if (patch.material !== undefined && !patch.material) delete v.material;
    if (patch.materialRot !== undefined && !patch.materialRot) delete v.materialRot;
    this.notify({ structural: true });
  }

  /**
   * Delete a variable, inlining its current resolved finish back into every
   * slot that references it — so no bound component silently loses its colour.
   */
  deleteVariable(id: string): void {
    const ref = toVarRef(id);
    const fin = detach(this.design, ref); // resolve before removal
    const applyTo = (slot: string): string => (slot === ref ? fin.color : slot);
    for (const it of this.design.items) {
      if (it.color === ref) {
        it.color = fin.color;
        if (fin.material) it.material = fin.material;
        else delete it.material;
        if (fin.rot) it.materialRot = true;
        else delete it.materialRot;
      }
      if (it.accentColor === ref) it.accentColor = fin.color;
    }
    const room = this.design.room;
    room.wallColor = applyTo(room.wallColor);
    room.floorColor = applyTo(room.floorColor);
    room.counterColor = applyTo(room.counterColor);
    if (this.design.defaultFrontVar === id) delete this.design.defaultFrontVar;
    if (this.design.defaultAccentVar === id) delete this.design.defaultAccentVar;
    this.design.variables = this.design.variables.filter((v) => v.id !== id);
    this.notify({ structural: true });
  }

  setDefaultVar(slot: 'front' | 'accent', id: string | undefined): void {
    if (slot === 'front') {
      if (id) this.design.defaultFrontVar = id;
      else delete this.design.defaultFrontVar;
    } else if (id) this.design.defaultAccentVar = id;
    else delete this.design.defaultAccentVar;
    this.notify({ structural: false });
  }

  /** Bulk "apply to all": bind a colour slot on every front-painted item to a variable. */
  applyVarToItems(id: string, slot: 'front' | 'accent'): number {
    if (!this.variableById(id)) return 0;
    const ref = toVarRef(id);
    let n = 0;
    for (const it of this.design.items) {
      const def = this.defOf(it.defId);
      if (def.opening || def.marker) continue;
      if (slot === 'front') it.color = ref;
      else if (this.partOf(it.defId)) it.accentColor = ref;
      else continue;
      n++;
    }
    this.notify({ structural: true });
    return n;
  }

  /* ---------------- wall visibility ---------------- */

  wallVisibility(wallId: string): WallVisMode {
    return this.design.wallVisibility?.[wallId] ?? 'auto';
  }

  setWallVisibility(wallId: string, mode: WallVisMode): void {
    const map = (this.design.wallVisibility ??= {});
    if (mode === 'auto') delete map[wallId];
    else map[wallId] = mode;
    // applied live in the render loop — no geometry rebuild needed
    this.notify({ structural: false });
  }

  setAllWallVisibility(mode: WallVisMode): void {
    if (mode === 'auto') {
      this.design.wallVisibility = {};
    } else {
      const map: Record<string, WallVisMode> = {};
      for (const w of this.walls()) map[w.id] = mode;
      this.design.wallVisibility = map;
    }
    this.notify({ structural: false });
  }

  /* ---------------- ceiling visibility ---------------- */

  ceilingVisibility(): WallVisMode {
    return this.design.ceilingVisibility ?? 'auto';
  }

  setCeilingVisibility(mode: WallVisMode): void {
    if (mode === 'auto') delete this.design.ceilingVisibility;
    else this.design.ceilingVisibility = mode;
    // applied live in the render loop — no geometry rebuild needed
    this.notify({ structural: false });
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
    // wall a→b (keyed by a.id) becomes b→a (keyed by b.id), so remap overrides too
    if (d.wallVisibility) {
      const remapped: Record<string, WallVisMode> = {};
      for (const [id, mode] of Object.entries(d.wallVisibility)) {
        remapped[walls.get(id)?.endId ?? id] = mode;
      }
      d.wallVisibility = remapped;
    }
  }
  return d;
}

export const DESIGN_VERSION = 5;

/**
 * Validate + repair a design parsed from storage or a file. Returns null when
 * unusable — including ANY design from before the v5 preset cut (no migration
 * path; callers fall back to a fresh design).
 */
export function sanitizeDesign(raw: unknown): Design | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.version !== 'number' || d.version !== DESIGN_VERSION) return null;
  if (!Array.isArray(d.corners) || d.corners.length < 3) return null;
  const base = emptyDesign();
  if (!Array.isArray(d.openings)) d.openings = [];
  if (!Array.isArray(d.items)) d.items = [];
  if (!Array.isArray(d.customParts)) d.customParts = [];
  d.variables = sanitizeVariables(d.variables);
  d.customParts = (d.customParts as unknown[]).map(sanitizePart).filter(Boolean);
  // items whose defId resolves nowhere would crash the render loop
  const partIds = new Set((d.customParts as CustomPartDef[]).map((p) => p.id));
  d.items = (d.items as Item[]).filter(
    (i) =>
      i &&
      typeof i.defId === 'string' &&
      (partIds.has(i.defId) || hasPreset(i.defId) || hasCatalogDef(i.defId))
  );
  // material ids must resolve in the built-in library — unknown ones are dropped;
  // rotation flags only persist as literal `true`
  for (const i of d.items as Item[]) {
    if (i.material !== undefined && !hasMaterial(i.material)) delete i.material;
    if (i.counterMaterial !== undefined && !hasMaterial(i.counterMaterial)) delete i.counterMaterial;
    if (i.materialRot !== true) delete i.materialRot;
    if (i.counterMaterialRot !== true) delete i.counterMaterialRot;
  }
  d.room = { ...base.room, ...(d.room && typeof d.room === 'object' ? d.room : {}) };
  const room = d.room as Record<string, unknown>;
  for (const key of ['wallMaterial', 'floorMaterial', 'counterMaterial']) {
    if (room[key] !== undefined && !hasMaterial(room[key])) delete room[key];
    if (room[`${key}Rot`] !== true) delete room[`${key}Rot`];
  }
  // detach dangling `var:` refs so no slot points at a removed variable
  const varIds = new Set((d.variables as DesignVar[]).map((v) => v.id));
  const settle = (v: unknown): string | undefined =>
    isVarRef(v as string) && !varIds.has(refId(v as string)) ? VAR_FALLBACK : (v as string | undefined);
  for (const i of d.items as Item[]) {
    i.color = settle(i.color) ?? i.color;
    if (i.accentColor !== undefined) {
      const s = settle(i.accentColor);
      if (s === undefined || typeof s !== 'string') delete i.accentColor;
      else i.accentColor = s;
    }
  }
  for (const key of ['wallColor', 'floorColor', 'counterColor']) {
    room[key] = settle(room[key]);
  }
  // defaults hold a bare variable id — clear ones that no longer resolve
  if (typeof d.defaultFrontVar !== 'string' || !varIds.has(d.defaultFrontVar)) delete d.defaultFrontVar;
  if (typeof d.defaultAccentVar !== 'string' || !varIds.has(d.defaultAccentVar)) delete d.defaultAccentVar;
  d.scene = sanitizeScene(d.scene);
  d.wallVisibility = sanitizeWallVisibility(d.wallVisibility);
  if (d.ceilingVisibility !== 'show' && d.ceilingVisibility !== 'hide') delete d.ceilingVisibility;
  d.version = DESIGN_VERSION;
  const design = normalizeDesign(d as unknown as Design);
  sanitizeAttachments(design);
  return design;
}

/**
 * Drop malformed/unresolvable appliance attachments (the item survives,
 * detached at its cached pose), then refresh every attached pose cache.
 * One appliance per zone niche: later claimants detach deterministically.
 */
function sanitizeAttachments(design: Design): void {
  const ids = new Map(design.items.map((i) => [i.id, i]));
  const claimedZones = new Set<string>();
  for (const it of design.items) {
    const a = it.attach as Attachment | undefined;
    if (!a) continue;
    const host = typeof a.hostId === 'string' ? ids.get(a.hostId) : undefined;
    const shapeOk =
      !!host &&
      host !== it &&
      !host.attach &&
      ((a.kind === 'counter' && Number.isFinite(a.u) && Number.isFinite(a.v)) ||
        (a.kind === 'zone' && Array.isArray(a.path) && a.path.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0)));
    if (!shapeOk) {
      delete it.attach;
      continue;
    }
    if (a.kind === 'zone') {
      const key = `${a.hostId}:${a.path.join('-')}`;
      if (claimedZones.has(key)) {
        delete it.attach;
        continue;
      }
      claimedZones.add(key);
    }
  }
  syncAttachments(design);
}

/** Drop malformed variables; keep only valid material ids and literal `true` rot flags. */
function sanitizeVariables(raw: unknown): DesignVar[] {
  if (!Array.isArray(raw)) return [];
  const out: DesignVar[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.color !== 'string') continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const dv: DesignVar = { id: r.id, name: r.name, color: r.color };
    if (typeof r.material === 'string' && hasMaterial(r.material)) dv.material = r.material;
    if (r.materialRot === true) dv.materialRot = true;
    out.push(dv);
  }
  return out;
}

/** Keep only valid non-'auto' overrides; 'auto' is the implicit default. */
function sanitizeWallVisibility(raw: unknown): Record<string, WallVisMode> {
  const out: Record<string, WallVisMode> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, mode] of Object.entries(raw as Record<string, unknown>)) {
      if (mode === 'show' || mode === 'hide') out[id] = mode;
    }
  }
  return out;
}

const wrap360 = (v: number): number => ((v % 360) + 360) % 360;
const finite = (v: unknown, fb: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fb;

/**
 * Coerce/clamp a scene. Always builds a fresh object so retired fields never
 * linger in autosave.
 */
function sanitizeScene(rawIn: unknown): Design['scene'] {
  const raw = (rawIn && typeof rawIn === 'object' ? { ...rawIn } : {}) as Record<string, unknown>;
  const base = defaultScene();
  return {
    sunAzimuth: wrap360(finite(raw.sunAzimuth, base.sunAzimuth)),
    sunElevation: clamp(finite(raw.sunElevation, base.sunElevation), SUN_ELEV_MIN, SUN_ELEV_MAX),
    brightness: clamp(finite(raw.brightness, base.brightness), 0, 2),
    night: typeof raw.night === 'boolean' ? raw.night : base.night,
  };
}

/* ---------------- factory designs ---------------- */

/** Default global lighting: mid-afternoon sun from the SW — warm-neutral, oblique readable shadows. */
export function defaultScene(): Design['scene'] {
  return { sunAzimuth: 215, sunElevation: 35, brightness: 1, night: false };
}

export function emptyDesign(): Design {
  const c = (x: number, y: number): Corner => ({ id: uid('c'), x, y });
  return normalizeDesign({
    version: 5,
    corners: [c(0, 0), c(4, 0), c(4, 3), c(0, 3)],
    openings: [],
    items: [],
    customParts: Store.sharedLibrary(),
    variables: [],
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

  // design-local custom parts the demo places (besides the shared library)
  const demoParts: CustomPartDef[] = [];
  const items: Item[] = [];
  const add = (defId: string, x: number, y: number, rotation = 0, patch: Partial<Item> = {}) => {
    const part = presetPart(defId) ?? demoParts.find((p) => p.id === defId);
    const def = part ? toCatalogDef(part) : catalogDef(defId);
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

  // Worktop run along the top wall (y = 0), left to right. Sink and hob are
  // appliances mounted INTO the cabinet worktops beneath them.
  add('base-drawers', 0.45, backY(0.6), 0, { w: 0.8, color: SAGE });
  const sinkHost = add('base-cabinet', 1.25, backY(0.6), 0, { w: 0.8, color: SAGE });
  const sinkAppl = add('appl-sink', 1.25, backY(0.6));
  sinkAppl.attach = { kind: 'counter', hostId: sinkHost.id, u: 0, v: -0.03 };
  const hobHost = add('base-drawers', 1.95, backY(0.6), 0, { color: SAGE });
  const hobAppl = add('appl-hob', 1.95, backY(0.6));
  hobAppl.attach = { kind: 'counter', hostId: hobHost.id, u: 0, v: 0 };
  add('base-cabinet', 2.55, backY(0.6), 0, { color: SAGE });
  add('dishwasher', 3.15, backY(0.6));
  // appliance tower: a custom part carried BY THIS DESIGN (not the shared
  // library — a user's own library wouldn't contain it) + a zone-mounted oven
  const tower = applianceTowerPart();
  demoParts.push(tower);
  const towerItem = add(tower.id, 3.78, backY(0.6), 0, { color: SAGE });
  const ovenAppl = add('appl-oven', 3.78, backY(0.6));
  ovenAppl.attach = { kind: 'zone', hostId: towerItem.id, path: [1] };

  // Fridge on the right wall (faces left, rotation +90°).
  add('fridge', 4.2 - t / 2 - 0.35, 1.2, Math.PI / 2);

  // Oak backsplash panel + wall units above the run.
  add('backsplash', 1.75, t / 2 + 0.01, 0, { w: 3.4 });
  add('wall-shelf', 0.32, backY(0.25), 0, { w: 0.5 });
  add('hood', 1.95, backY(0.45));
  add('wall-cabinet', 2.55, backY(0.35), 0, { color: SAGE });
  add('wall-cabinet', 3.15, backY(0.35), 0, { color: SAGE });
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

  const demo = normalizeDesign({
    version: 5,
    corners: [c1, c2, c3, c4],
    openings,
    items,
    customParts: [...Store.sharedLibrary(), ...demoParts],
    variables: [],
    room: {
      wallColor: '#f4f1ea',
      floorColor: '#cfccc6',
      counterColor: '#c9a87c',
      wallHeight: 2.6,
      wallThickness: t,
    },
    scene: defaultScene(),
  });
  syncAttachments(demo); // settle the sink/hob poses onto their hosts
  return demo;
}
