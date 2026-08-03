import { catalogDef, defaultParams, FLOOR_COLORS, hasCatalogDef, type CatalogDef } from './catalog';
import { hasPreset, presetPart } from './presets';
import { clamp, dist, polygonBounds, projectOnWall, signedArea, wallGeom, wallPoint, type WallGeom } from './geometry';
import { hasMaterial } from './materials';
import { DESIGN_VERSION, migrateDesign } from './migrate';
import { applianceTowerPart, samplePart, sanitizePart, toCatalogDef } from './parts';
import {
  allWalls,
  defaultRoomStyle,
  makeRoom,
  rectangleSizeOf,
  rehomeOpening,
  reidCorners,
  reprojectOpeningsNearest,
  roomArea,
  roomById,
  roomContaining,
  roomOfCorner,
  roomOfItem,
  roomOfWall,
  wallByIdIn,
  wallIndex,
  wallsOf,
  type RoomWall,
} from './rooms';
import { SUN_ELEV_MAX, SUN_ELEV_MIN } from './sky';
import type { Attachment, ChangeInfo, Corner, CustomPartDef, Design, DesignVar, Item, Opening, Point, Room, RoomStyle, Selection, WallVisMode } from './types';
import { uid } from './types';
import { syncAttachments } from './attach';
import { OpenFronts } from './openFronts';
import { DESIGN_KEY, LEGACY_DESIGN_KEYS, LEGACY_PARTS_KEYS, PARTS_KEY, readKey } from './storageKeys';
import { detach, isVarRef, refId, toVarRef, VAR_FALLBACK } from './variables';

export { DESIGN_VERSION };

type EventMap = {
  change: ChangeInfo;
  selection: Selection;
  history: void;
  /** ephemeral open-front poses changed — apply without rebuild */
  pose: void;
  /** the room subsequent edits target changed — ephemeral, never serialized */
  activeRoom: string;
};

type Handler<T> = (payload: T) => void;

export interface AddRoomOptions {
  /** default `Room <n>` */
  name?: string;
  /** freestanding seed rectangle (m) */
  w?: number;
  /** depth (m): freestanding rect side, or how far an adjacent room reaches out */
  d?: number;
  /** freestanding: min-corner of the seed rect; default = clear of every room */
  at?: Point;
  /** adjacent: grow off an existing exterior wall, optionally on a sub-span of it */
  against?: { wallId: string; span?: { t0: number; t1: number } };
  style?: Partial<RoomStyle>;
}

/** Breathing room left between a generated room and the ones already placed. */
const ROOM_GAP = 1;
/** Matches `setRectangleSize`: nothing narrower is a usable room. */
const MIN_ROOM_SIDE = 1;
/** splitWall's own clamp — no cut leaves a stub shorter than this. */
const MIN_WALL_SEG = 0.1;

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
    activeRoom: [],
  };

  /** ephemeral like the selection: never serialized, never in an undo step */
  private activeId: string | null = null;

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
    this.revalidateActiveRoom();
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
    this.revalidateActiveRoom();
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
      localStorage.setItem(DESIGN_KEY, JSON.stringify(this.design));
    } catch {
      /* storage may be unavailable — ignore */
    }
  }

  static loadAutosaved(): Design | null {
    try {
      const raw = readKey(DESIGN_KEY, LEGACY_DESIGN_KEYS);
      return raw ? sanitizeDesign(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  exportJson(): string {
    return JSON.stringify(this.design, null, 2);
  }

  /* ---------------- active room ---------------- */

  /** The room room-scoped edits default to; always resolves to a real room. */
  get activeRoomId(): string {
    const r = this.activeId ? roomById(this.design.rooms, this.activeId) : undefined;
    return (r ?? this.design.rooms[0]).id;
  }

  activeRoom(): Room {
    return roomById(this.design.rooms, this.activeRoomId) ?? this.design.rooms[0];
  }

  activeStyle(): RoomStyle {
    return this.activeRoom().style;
  }

  /** Purely a view concern: no notify, no commit, no autosave. */
  setActiveRoom(id: string): void {
    if (!roomById(this.design.rooms, id) || id === this.activeId) return;
    this.activeId = id;
    this.emit('activeRoom', id);
  }

  /** After a full-design replace the old id may name a room that is gone. */
  private revalidateActiveRoom(): void {
    if (this.activeId && !roomById(this.design.rooms, this.activeId)) this.activeId = null;
  }

  /* ---------------- room / wall queries ---------------- */

  rooms(): Room[] {
    return this.design.rooms;
  }

  roomById(id: string): Room | undefined {
    return roomById(this.design.rooms, id);
  }

  roomOfWall(wallId: string): Room | undefined {
    return roomOfWall(this.design.rooms, wallId);
  }

  roomOfCorner(cornerId: string): Room | undefined {
    return roomOfCorner(this.design.rooms, cornerId);
  }

  roomContaining(p: Point): Room | undefined {
    return roomContaining(this.design.rooms, p);
  }

  allWalls(): RoomWall[] {
    return allWalls(this.design.rooms);
  }

  wallsOf(roomId: string): RoomWall[] {
    return wallsOf(this.design.rooms, roomId);
  }

  activeWalls(): RoomWall[] {
    return this.wallsOf(this.activeRoomId);
  }

  wallById(id: string): RoomWall | undefined {
    return wallByIdIn(this.design.rooms, id);
  }

  /** The other side of a shared partition, if any. */
  wallTwin(id: string): RoomWall | undefined {
    const w = this.wallById(id);
    return w?.shared ? this.wallById(w.shared.wallId) : undefined;
  }

  /**
   * The side of a wall that stores its openings and visibility override: the
   * wall itself unless it is the non-owning half of a partition.
   */
  ownerWall(id: string): RoomWall | undefined {
    const w = this.wallById(id);
    if (!w || !w.shared || w.shared.owner) return w;
    return this.wallById(w.shared.wallId) ?? w;
  }

  cornerById(id: string): Corner | undefined {
    for (const room of this.design.rooms) {
      const c = room.corners.find((k) => k.id === id);
      if (c) return c;
    }
    return undefined;
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

  floorArea(roomId = this.activeRoomId): number {
    const room = roomById(this.design.rooms, roomId);
    return room ? roomArea(room) : 0;
  }

  totalFloorArea(): number {
    return this.design.rooms.reduce((sum, r) => sum + roomArea(r), 0);
  }

  /** Width/depth when the room is a 4-corner axis-aligned rectangle. */
  rectangleSize(roomId = this.activeRoomId): { w: number; d: number } | null {
    const room = roomById(this.design.rooms, roomId);
    return room ? rectangleSizeOf(room) : null;
  }

  /* ---------------- room CRUD ---------------- */

  /**
   * Add a room and make it active. Freestanding (`at`, or neither anchor) drops
   * an axis-aligned w×d rectangle; `against` grows one off an existing wall and
   * is the ONLY way a shared partition is born — the seam corners copy the host
   * corners bit-identically, which is what makes rooms.ts' shared-edge
   * detection deterministic. `at` wins if both anchors are given.
   *
   * Returns null when `against` names no wall or names one that is already a
   * partition (it has a room on each side; callers disable the action).
   *
   * KNOWN side effect of `against`: the host wall stops being exterior, so its
   * slab moves from fully outside the polygon to straddling it (faceOffset
   * 0 → t/2). Anything snapped flush to that wall now overlaps the slab by t/2
   * until it is re-snapped; nothing is moved for it here.
   *
   * Caller commits.
   */
  addRoom(opts: AddRoomOptions = {}): Room | null {
    const name = opts.name?.trim() || `Room ${this.design.rooms.length + 1}`;
    const w = Math.max(MIN_ROOM_SIDE, opts.w ?? 4);
    const d = Math.max(MIN_ROOM_SIDE, opts.d ?? 3);
    const style = { ...defaultRoomStyle(), ...opts.style };
    const room =
      opts.against && !opts.at
        ? this.roomAgainstWall(opts.against, name, d, style)
        : makeRoom({ name, ...(opts.at ?? this.freeRoomSpot()), w, d, style });
    if (!room) return null;
    this.design.rooms.push(room);
    this.setActiveRoom(room.id);
    this.notify({ structural: true });
    return room;
  }

  /** Min-corner of a spot clear of every existing room: right of them all. */
  private freeRoomSpot(): Point {
    const pts = this.design.rooms.flatMap((r) => r.corners);
    if (!pts.length) return { x: 0, y: 0 };
    const b = polygonBounds(pts);
    return { x: b.maxX + ROOM_GAP, y: b.minY };
  }

  /** The `against` half of addRoom: a rectangle hung off one wall's outer face. */
  private roomAgainstWall(
    against: NonNullable<AddRoomOptions['against']>,
    name: string,
    d: number,
    style: RoomStyle
  ): Room | null {
    const seed = this.wallById(against.wallId);
    if (!seed || seed.shared) return null;
    const wallId = against.span ? this.carveSpan(against.wallId, against.span) : against.wallId;
    const host = this.wallById(wallId);
    if (!host) return null;
    const out = { x: -host.inward.x, y: -host.inward.y };
    const corner = (p: Point): Corner => ({ id: uid('c'), x: p.x, y: p.y });
    // The ring walks the host edge BACKWARDS (b→a) and then out. That reversed
    // seam is exactly what shared-edge detection looks for, and since the
    // interior of a CCW ring lies left of every edge — here the outward side —
    // the ring is counter-clockwise by construction, never needing a reversal
    // (which would break the seam). model.test asserts both.
    return {
      id: uid('room'),
      name,
      corners: [
        corner(host.b),
        corner(host.a),
        corner({ x: host.a.x + out.x * d, y: host.a.y + out.y * d }),
        corner({ x: host.b.x + out.x * d, y: host.b.y + out.y * d }),
      ],
      style,
      wallVisibility: {},
    };
  }

  /**
   * Cut the sub-span [t0, t1] out of a wall and return the id of the middle
   * segment, so a room can be built against just that stretch. splitWall does
   * the opening re-keying. A span reaching (or all but reaching) an end skips
   * that cut; one too short to be a wall leaves the host whole.
   */
  private carveSpan(wallId: string, span: { t0: number; t1: number }): string {
    const host = this.wallById(wallId);
    if (!host) return wallId;
    const t0 = clamp(Math.min(span.t0, span.t1), 0, host.len);
    let t1 = clamp(Math.max(span.t0, span.t1), 0, host.len);
    if (t1 - t0 < MIN_WALL_SEG) return wallId;
    let id = wallId;
    if (t0 >= MIN_WALL_SEG && host.len - t0 >= MIN_WALL_SEG) {
      const cut = this.splitWall(id, t0);
      if (cut) {
        id = cut.id;
        t1 -= t0; // offsets are measured from the new segment's start now
      }
    }
    const seg = this.wallById(id);
    if (seg && t1 >= MIN_WALL_SEG && seg.len - t1 >= MIN_WALL_SEG) this.splitWall(id, t1);
    return id;
  }

  /**
   * Delete a room with everything only it held: its items (appliances mounted
   * on them included) and the openings on its exterior walls. An opening on a
   * partition survives on the twin, mirrored into that side's frame. Refuses
   * the last room. Returns what it removed, for a confirm dialog. Caller commits.
   */
  deleteRoom(id: string): { items: number; openings: number } | null {
    const room = roomById(this.design.rooms, id);
    if (!room || this.design.rooms.length <= 1) return null;

    // everything is resolved against the still-intact design
    const wasActive = this.activeRoomId === id;
    const doomed = this.withAttached(
      new Set(
        this.design.items
          .filter((i) => roomOfItem(this.design, i)?.id === id)
          .map((i) => i.id)
      )
    );
    const own = new Set(room.corners.map((c) => c.id));
    const rehomed: Opening[] = [];
    const dropped = new Set<string>();
    for (const o of this.design.openings) {
      if (!own.has(o.wallId)) continue;
      const twin = this.wallTwin(o.wallId);
      if (!twin) dropped.add(o.id);
      else {
        rehomeOpening(o, twin.id, twin.len);
        rehomed.push(o);
      }
    }

    this.design.openings = this.design.openings.filter((o) => !dropped.has(o.id));
    this.design.items = this.design.items.filter((i) => !doomed.has(i.id));
    this.design.rooms = this.design.rooms.filter((r) => r.id !== id);
    // a re-homed opening now answers to the twin room's ceiling height
    for (const o of rehomed) this.clampOpening(o);
    this.pruneSelection();
    if (wasActive) {
      this.activeId = null;
      this.emit('activeRoom', this.activeRoomId);
    }
    this.notify({ structural: true });
    return { items: doomed.size, openings: dropped.size };
  }

  /**
   * Copy a room's shell: geometry, style, visibility overrides and the openings
   * stored on its walls. Items are deliberately NOT copied. The copy lands one
   * room-width to the right unless `offset` says otherwise. Caller commits.
   */
  duplicateRoom(id: string, offset?: Point): Room | null {
    const src = roomById(this.design.rooms, id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src)) as Room;
    copy.id = uid('room');
    copy.name = `${src.name} copy`;
    // corner ids are wall ids and must stay unique design-wide; this also
    // remaps the copy's own wallVisibility keys
    const remap = reidCorners(copy);
    const b = polygonBounds(src.corners);
    const shift = offset ?? { x: b.maxX - b.minX + ROOM_GAP, y: 0 };
    for (const c of copy.corners) {
      c.x += shift.x;
      c.y += shift.y;
    }
    const own = new Set(src.corners.map((c) => c.id));
    for (const o of this.design.openings.filter((o) => own.has(o.wallId))) {
      this.design.openings.push({ ...o, id: uid('o'), wallId: remap.get(o.wallId) ?? o.wallId });
    }
    this.design.rooms.push(copy);
    this.notify({ structural: true });
    return copy;
  }

  /** Nothing geometric moves, so this applies live. Caller commits. */
  renameRoom(id: string, name: string): void {
    const room = roomById(this.design.rooms, id);
    const next = name.trim();
    if (!room || !next) return;
    room.name = next;
    this.notify({ structural: false });
  }

  /** Drop the selection when it names something the design no longer holds. */
  private pruneSelection(): void {
    const s = this.selection;
    const alive =
      s.kind === 'none' ||
      (s.kind === 'item' && !!this.itemById(s.id)) ||
      (s.kind === 'corner' && !!this.cornerById(s.id)) ||
      (s.kind === 'wall' && !!this.wallById(s.id)) ||
      (s.kind === 'opening' && !!this.openingById(s.id));
    if (!alive) this.select({ kind: 'none' });
  }

  /* ---------------- room mutations ---------------- */

  /** Re-establish the CCW invariant + opening bounds after a corner mutation. */
  private renormalizeRoom(roomId: string): void {
    const room = roomById(this.design.rooms, roomId);
    if (room) normalizeRoom(this.design, room);
    this.clampAllOpenings();
  }

  moveCorner(id: string, x: number, y: number, transient = true): void {
    const room = roomOfCorner(this.design.rooms, id);
    const c = room?.corners.find((k) => k.id === id);
    if (!room || !c) return;
    c.x = x;
    c.y = y;
    this.renormalizeRoom(room.id);
    this.notify({ structural: true, transient });
  }

  /**
   * Insert a corner into one room's ring at distance t from wallId's start,
   * re-keying that wall's openings past the split. `at`, when given, forces
   * the new corner's coordinates instead of deriving them from t — splitWall
   * uses this to hand the twin side the OWNER side's exact point object so
   * both edges land bit-identical (independently re-deriving it via `len - t`
   * can round differently and straddle the shared-edge quantization bucket).
   * Does not notify — the caller does that once, after both sides are done.
   */
  private splitWallRaw(roomId: string, wallId: string, t: number, at?: Point): Corner | null {
    const room = roomById(this.design.rooms, roomId);
    if (!room) return null;
    const c = room.corners;
    const idx = c.findIndex((k) => k.id === wallId);
    if (idx < 0) return null;
    const g = wallGeom({ id: wallId, a: c[idx], b: c[(idx + 1) % c.length] });
    t = clamp(t, 0.1, g.len - 0.1);
    const p = at ?? wallPoint(g, t);
    const nc: Corner = { id: uid('c'), x: p.x, y: p.y };
    c.splice(idx + 1, 0, nc);
    // openings past the split belong to the new (second) wall
    for (const o of this.design.openings) {
      if (o.wallId === wallId && o.offset > t) {
        o.wallId = nc.id;
        o.offset -= t;
      }
    }
    this.renormalizeRoom(roomId);
    return nc;
  }

  /**
   * Insert a corner on a wall at distance t from its start. Returns the new
   * corner. When the wall is a partition, the twin room's matching wall is
   * split too (at `twin.len - t`, same seam point) so the pair stays shared
   * instead of the twin silently going exterior while the slab still shows
   * on both sides.
   */
  splitWall(wallId: string, t: number): Corner | null {
    const wall = this.wallById(wallId);
    if (!wall) return null;
    t = clamp(t, 0.1, wall.len - 0.1);
    const p = wallPoint(wall, t);
    const twin = this.wallTwin(wallId); // resolved BEFORE either side mutates
    const nc = this.splitWallRaw(wall.roomId, wallId, t, p);
    if (!nc) return null;
    if (twin) this.splitWallRaw(twin.roomId, twin.id, twin.len - t, p);
    this.notify({ structural: true });
    return nc;
  }

  deleteCorner(id: string): void {
    const room = roomOfCorner(this.design.rooms, id);
    if (!room) return;
    const c = room.corners;
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
    this.renormalizeRoom(room.id);
    if (this.selection.kind === 'corner' && this.selection.id === id) this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  /**
   * Set a wall's length by moving its end corner along the wall direction.
   * Perpendicular neighbour walls are shifted too, so rectangles stay rectangles.
   */
  setWallLength(wallId: string, len: number): void {
    const room = roomOfWall(this.design.rooms, wallId);
    const g = this.wallById(wallId);
    if (!room || !g || len < 0.3) return;
    const delta = len - g.len;
    const dx = g.dir.x * delta;
    const dy = g.dir.y * delta;
    const c = room.corners;
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
    this.renormalizeRoom(room.id);
    this.notify({ structural: true });
  }

  setRectangleSize(w: number, d: number, roomId = this.activeRoomId): void {
    const room = roomById(this.design.rooms, roomId);
    const rect = room && rectangleSizeOf(room);
    if (!room || !rect || w < 1 || d < 1) return;
    const c = room.corners;
    const minX = Math.min(...c.map((p) => p.x));
    const minY = Math.min(...c.map((p) => p.y));
    for (const p of c) {
      p.x = minX + (p.x - minX > 1e-3 ? w : 0);
      p.y = minY + (p.y - minY > 1e-3 ? d : 0);
    }
    this.renormalizeRoom(room.id);
    this.notify({ structural: true });
  }

  /** Replace one room's outline with a preset shape (items and openings are kept). */
  setShapePreset(preset: 'rect' | 'lshape', roomId = this.activeRoomId): void {
    const room = roomById(this.design.rooms, roomId);
    if (!room) return;
    const stale = new Set(room.corners.map((k) => k.id));
    const before = room.corners;
    // anchor the preset to the room's current min-corner — an absolute origin
    // would teleport every room but the first onto the first
    const b = polygonBounds(before);
    const c = (x: number, y: number): Corner => ({ id: uid('c'), x: b.minX + x, y: b.minY + y });
    room.corners =
      preset === 'rect'
        ? [c(0, 0), c(4, 0), c(4, 3), c(0, 3)]
        : [c(0, 0), c(4.2, 0), c(4.2, 2.2), c(2.4, 2.2), c(2.4, 3.4), c(0, 3.4)];
    normalizeRoom(this.design, room);
    // every wall id changed: slide the room's openings onto the nearest new wall
    const affected = this.design.openings.filter((o) => stale.has(o.wallId));
    reprojectOpeningsNearest(before, room.corners, affected);
    for (const o of affected) this.clampOpening(o);
    room.wallVisibility = {};
    this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  /* ---------------- opening mutations ---------------- */

  addOpening(def: CatalogDef, wallId: string, offset: number): Opening {
    // a partition's openings live on the owning side, so both rooms see one door
    const owner = this.ownerWall(wallId);
    const o: Opening = {
      id: uid('o'),
      wallId: owner?.id ?? wallId,
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
    if (patch.wallId) o.wallId = this.ownerWall(patch.wallId)?.id ?? patch.wallId;
    this.clampOpening(o);
    this.notify(info);
  }

  deleteOpening(id: string): void {
    this.design.openings = this.design.openings.filter((o) => o.id !== id);
    if (this.selection.kind === 'opening' && this.selection.id === id) this.select({ kind: 'none' });
    this.notify({ structural: true });
  }

  private clampOpening(o: Opening, index?: Map<string, RoomWall>): void {
    const g = index ? index.get(o.wallId) : this.wallById(o.wallId);
    if (!g) return;
    const room = roomById(this.design.rooms, g.roomId);
    clampOpeningTo(o, g, room?.style.wallHeight ?? defaultRoomStyle().wallHeight);
  }

  private clampAllOpenings(): void {
    const index = wallIndex(this.design.rooms);
    for (const o of this.design.openings) this.clampOpening(o, index);
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
      roomId: (this.roomContaining({ x, y }) ?? this.activeRoom()).id,
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
      localStorage.setItem(PARTS_KEY, JSON.stringify(this.design.customParts));
    } catch {
      /* ignore */
    }
  }

  static sharedLibrary(): CustomPartDef[] {
    try {
      const raw = readKey(PARTS_KEY, LEGACY_PARTS_KEYS);
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

  /**
   * Seed ids plus every appliance mounted on one of them. A host can never
   * itself be attached (sanitizeAttachments enforces it), so one pass closes
   * the set — deleting a host always takes its appliances along.
   */
  private withAttached(seed: Set<string>): Set<string> {
    const doomed = new Set(seed);
    for (const i of this.design.items) {
      if (i.attach && doomed.has(i.attach.hostId)) doomed.add(i.id);
    }
    return doomed;
  }

  deleteItem(id: string): void {
    // deleting a host takes its mounted appliances with it (one undo step)
    const doomed = this.withAttached(new Set([id]));
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

  setRoomStyle(patch: Partial<RoomStyle>, roomId = this.activeRoomId): void {
    const room = roomById(this.design.rooms, roomId);
    if (!room) return;
    Object.assign(room.style, patch);
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
    for (const room of this.design.rooms) {
      const s = room.style;
      s.wallColor = applyTo(s.wallColor);
      s.floorColor = applyTo(s.floorColor);
      s.counterColor = applyTo(s.counterColor);
    }
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
    const w = this.ownerWall(wallId);
    if (!w) return 'auto';
    return roomById(this.design.rooms, w.roomId)?.wallVisibility?.[w.id] ?? 'auto';
  }

  setWallVisibility(wallId: string, mode: WallVisMode): void {
    const w = this.ownerWall(wallId);
    const room = w && roomById(this.design.rooms, w.roomId);
    if (!w || !room) return;
    const map = (room.wallVisibility ??= {});
    if (mode === 'auto') delete map[w.id];
    else map[w.id] = mode;
    // applied live in the render loop — no geometry rebuild needed
    this.notify({ structural: false });
  }

  setAllWallVisibility(mode: WallVisMode, roomId = this.activeRoomId): void {
    const room = roomById(this.design.rooms, roomId);
    if (!room) return;
    const map: Record<string, WallVisMode> = {};
    if (mode !== 'auto') {
      for (const w of this.wallsOf(room.id)) map[w.id] = mode;
    }
    room.wallVisibility = map;
    this.notify({ structural: false });
  }

  /* ---------------- ceiling visibility ---------------- */

  ceilingVisibility(roomId = this.activeRoomId): WallVisMode {
    return roomById(this.design.rooms, roomId)?.ceilingVisibility ?? 'auto';
  }

  setCeilingVisibility(mode: WallVisMode, roomId = this.activeRoomId): void {
    const room = roomById(this.design.rooms, roomId);
    if (!room) return;
    if (mode === 'auto') delete room.ceilingVisibility;
    else room.ceilingVisibility = mode;
    // applied live in the render loop — no geometry rebuild needed
    this.notify({ structural: false });
  }
}

/** Fit an opening inside its wall and under the ceiling. Pure. */
function clampOpeningTo(o: Opening, g: WallGeom, wallHeight: number): void {
  o.width = clamp(o.width, 0.3, Math.max(0.3, g.len - 0.2));
  const lo = o.width / 2 + 0.05;
  const hi = g.len - o.width / 2 - 0.05;
  o.offset = hi < lo ? g.len / 2 : clamp(o.offset, lo, hi);
  const maxH = wallHeight - 0.05;
  o.height = clamp(o.height, 0.3, maxH);
  o.sill = clamp(o.sill, 0, maxH - o.height);
}

/**
 * Ensure one room's corner order is counter-clockwise so inward normals point
 * into it. Reversing renames every wall, so the design's openings and the
 * room's own visibility overrides are remapped alongside.
 */
export function normalizeRoom(d: Design, room: Room): Room {
  if (signedArea(room.corners) >= 0) return room;
  // reversing flips every wall a→b (keyed by a.id) into b→a (keyed by b.id),
  // so openings must switch wall id and mirror their offset
  const walls = new Map<string, { endId: string; len: number }>();
  const c = room.corners;
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
  if (room.wallVisibility) {
    const remapped: Record<string, WallVisMode> = {};
    for (const [id, mode] of Object.entries(room.wallVisibility)) {
      remapped[walls.get(id)?.endId ?? id] = mode;
    }
    room.wallVisibility = remapped;
  }
  return room;
}

/** Apply the CCW invariant to every room. */
export function normalizeDesign(d: Design): Design {
  if (!Array.isArray(d.customParts)) d.customParts = [];
  if (!Array.isArray(d.rooms)) d.rooms = [];
  if (!Array.isArray(d.openings)) d.openings = [];
  for (const room of d.rooms) normalizeRoom(d, room);
  return d;
}

/**
 * Validate + repair a design parsed from storage or a file, migrating it up to
 * DESIGN_VERSION first. Returns null when unusable — including any design older
 * than MIN_MIGRATABLE_VERSION (callers fall back to a fresh design).
 */
export function sanitizeDesign(raw: unknown): Design | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = migrateDesign({ ...(raw as Record<string, unknown>) });
  if (!d || d.version !== DESIGN_VERSION) return null;

  // ---- rooms: drop the unusable ones, then repair each ----
  if (!Array.isArray(d.rooms)) return null;
  const rooms: Room[] = [];
  for (const r of d.rooms as unknown[]) {
    if (!r || typeof r !== 'object') continue;
    const corners = sanitizeCorners((r as Record<string, unknown>).corners);
    if (corners.length < 3) continue;
    rooms.push({ ...(r as Room), corners });
  }
  if (!rooms.length) return null;
  d.rooms = rooms;

  if (!Array.isArray(d.openings)) d.openings = [];
  if (!Array.isArray(d.items)) d.items = [];
  if (!Array.isArray(d.customParts)) d.customParts = [];

  // ---- ids unique design-wide (a wall id alone must name one wall) ----
  const seenRooms = new Set<string>();
  const seenCorners = new Set<string>();
  for (const room of rooms) {
    if (typeof room.id !== 'string' || !room.id || seenRooms.has(room.id)) room.id = uid('room');
    seenRooms.add(room.id);
    const remap = new Map<string, string>();
    for (const c of room.corners) {
      if (!seenCorners.has(c.id)) {
        seenCorners.add(c.id);
        continue;
      }
      const next = uid('c');
      remap.set(c.id, next);
      c.id = next;
      seenCorners.add(next);
    }
    // openings are design-global and keyed by wall id alone, so a collided id
    // cannot be attributed — they stay on the first room, whose ids are intact
    if (remap.size && room.wallVisibility && typeof room.wallVisibility === 'object') {
      const moved: Record<string, WallVisMode> = {};
      for (const [id, mode] of Object.entries(room.wallVisibility)) {
        moved[remap.get(id) ?? id] = mode;
      }
      room.wallVisibility = moved;
    }
  }

  // ---- per-room style / name / visibility ----
  rooms.forEach((room, i) => {
    const src = room.style && typeof room.style === 'object' ? room.style : {};
    const style = { ...defaultRoomStyle(), ...src } as unknown as Record<string, unknown>;
    // material ids must resolve in the built-in library — unknown ones are
    // dropped; rotation flags only persist as literal `true`
    for (const key of ['wallMaterial', 'floorMaterial', 'counterMaterial']) {
      if (style[key] !== undefined && !hasMaterial(style[key])) delete style[key];
      if (style[`${key}Rot`] !== true) delete style[`${key}Rot`];
    }
    room.style = style as unknown as RoomStyle;
    const name = typeof room.name === 'string' ? room.name.trim() : '';
    room.name = (name || `Room ${i + 1}`).slice(0, 40);
    room.wallVisibility = sanitizeWallVisibility(room.wallVisibility);
    if (room.ceilingVisibility !== 'show' && room.ceilingVisibility !== 'hide') {
      delete room.ceilingVisibility;
    }
  });

  d.variables = sanitizeVariables(d.variables);
  d.customParts = (d.customParts as unknown[]).map(sanitizePart).filter(Boolean);

  // ---- openings: drop the ones pointing at no wall, re-home stray
  // non-owner-side ones onto the owner, clamp the rest ----
  const walls = wallIndex(rooms);
  d.openings = (d.openings as Opening[]).filter((o) => {
    if (!o || typeof o !== 'object') return false;
    if (typeof o.id !== 'string' || typeof o.wallId !== 'string') return false;
    if (o.type !== 'door' && o.type !== 'window') return false;
    let g = walls.get(o.wallId);
    if (!g) return false;
    // a partition's openings belong on the owner side (addOpening/deleteRoom
    // enforce this going forward); an old file or hand edit can still have
    // one stranded on the non-owner half — repair it in place, in the
    // owner's frame, rather than leaving a convention violation on load
    if (g.shared && !g.shared.owner) {
      const twin = walls.get(g.shared.wallId);
      if (twin) {
        rehomeOpening(o, twin.id, twin.len);
        g = twin;
      }
    }
    o.offset = finite(o.offset, g.len / 2);
    o.width = finite(o.width, 0.9);
    o.height = finite(o.height, 2);
    o.sill = finite(o.sill, 0);
    const room = roomById(rooms, g.roomId);
    clampOpeningTo(o, g, room?.style.wallHeight ?? defaultRoomStyle().wallHeight);
    return true;
  });

  // items whose defId resolves nowhere would crash the render loop
  const partIds = new Set((d.customParts as CustomPartDef[]).map((p) => p.id));
  d.items = (d.items as Item[]).filter(
    (i) =>
      i &&
      typeof i.defId === 'string' &&
      (partIds.has(i.defId) || hasPreset(i.defId) || hasCatalogDef(i.defId))
  );
  const roomIds = new Set(rooms.map((r) => r.id));
  for (const i of d.items as Item[]) {
    if (i.material !== undefined && !hasMaterial(i.material)) delete i.material;
    if (i.counterMaterial !== undefined && !hasMaterial(i.counterMaterial)) delete i.counterMaterial;
    if (i.materialRot !== true) delete i.materialRot;
    if (i.counterMaterialRot !== true) delete i.counterMaterialRot;
    if (typeof i.roomId !== 'string' || !roomIds.has(i.roomId)) delete i.roomId;
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
  for (const room of rooms) {
    const style = room.style as unknown as Record<string, unknown>;
    for (const key of ['wallColor', 'floorColor', 'counterColor']) style[key] = settle(style[key]);
  }

  // defaults hold a bare variable id — clear ones that no longer resolve
  if (typeof d.defaultFrontVar !== 'string' || !varIds.has(d.defaultFrontVar)) delete d.defaultFrontVar;
  if (typeof d.defaultAccentVar !== 'string' || !varIds.has(d.defaultAccentVar)) delete d.defaultAccentVar;
  d.scene = sanitizeScene(d.scene);
  d.version = DESIGN_VERSION;

  const design = normalizeDesign(d as unknown as Design);
  // every item carries the room it sits in, so per-room finishes resolve O(1)
  for (const it of design.items) it.roomId = (roomOfItem(design, it) ?? design.rooms[0]).id;
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

/** Keep well-formed corners; mint an id for any that lacks a usable one. */
function sanitizeCorners(raw: unknown): Corner[] {
  if (!Array.isArray(raw)) return [];
  const out: Corner[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : uid('c'),
      x: r.x as number,
      y: r.y as number,
    });
  }
  return out;
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
    version: DESIGN_VERSION,
    rooms: [
      {
        id: uid('room'),
        name: 'Room 1',
        // v6 corners are the room-side wall face, so this is 4 × 3 of floor
        corners: [c(0, 0), c(4, 0), c(4, 3), c(0, 3)],
        style: defaultRoomStyle(),
        wallVisibility: {},
      },
    ],
    openings: [],
    items: [],
    customParts: Store.sharedLibrary(),
    variables: [],
    scene: defaultScene(),
  });
}

/**
 * Demo kitchen + bedroom inspired by the reference images: sage-green matte
 * fronts, oak worktop and backsplash, appliance tower, LED strip, island
 * with stools; an adjoining bedroom sharing the kitchen's east wall
 * showcases a partition rendered once from both sides.
 */
export function demoDesign(): Design {
  const t = 0.1; // wall thickness
  // Authored against a nominal 4.2 × 3.4 shell. v6 corners are the room-side
  // wall FACE, so the ring sits t/2 inside that: the wall slabs — and every
  // item hugging them — land exactly where the centreline version had them.
  const x0 = t / 2;
  const y0 = t / 2;
  const x1 = 4.2 - t / 2;
  const y1 = 3.4 - t / 2;
  const c1: Corner = { id: uid('c'), x: x0, y: y0 };
  const c2: Corner = { id: uid('c'), x: x1, y: y0 };
  const c3: Corner = { id: uid('c'), x: x1, y: y1 };
  const c4: Corner = { id: uid('c'), x: x0, y: y1 };
  const roomId = uid('room');

  // Bedroom sits beyond the kitchen's east wall: its west-wall corners (d1,
  // d4) are the SAME coordinates as the kitchen's east-wall corners (c2, c3)
  // — allWalls() links coincident-and-reversed edges as one shared
  // partition, built once and rendered from both sides.
  const bedDepth = 3.0; // how far the bedroom extends beyond the shared wall
  const bx1 = x1 + bedDepth;
  const d1: Corner = { id: uid('c'), x: x1, y: y0 };
  const d2: Corner = { id: uid('c'), x: bx1, y: y0 };
  const d3: Corner = { id: uid('c'), x: bx1, y: y1 };
  const d4: Corner = { id: uid('c'), x: x1, y: y1 };
  const bedroomId = uid('room');

  const backY = (depth: number) => y0 + depth / 2; // back flush against the top wall

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
      roomId,
      ...patch,
    };
    items.push(it);
    return it;
  };

  const SAGE = '#8a9683';

  // Worktop run along the top wall, left to right. Sink and hob are
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
  add('fridge', x1 - 0.35, 1.2, Math.PI / 2);

  // Oak backsplash panel + wall units above the run.
  add('backsplash', 1.75, y0 + 0.01, 0, { w: 3.4 });
  add('wall-shelf', 0.32, backY(0.25), 0, { w: 0.5 });
  add('hood', 1.95, backY(0.45));
  add('wall-cabinet', 2.55, backY(0.35), 0, { color: SAGE });
  add('wall-cabinet', 3.15, backY(0.35), 0, { color: SAGE });
  add('strip', 2.85, 0.1, 0, { w: 1.2, elevation: 1.42 });

  // Utilities sketched on the wall: water at the sink, outlets above the worktop.
  add('water', 1.25, y0 + 0.03);
  add('outlet', 0.45, y0 + 0.015);
  add('outlet', 2.55, y0 + 0.015);

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

  // Bedroom: bed against the far (east) wall, a nightstand on each side, a
  // wardrobe on the south wall, a rug reaching out from under the bed, and a
  // pendant centered on the ceiling.
  const bedY = 1.4;
  add('bed-double', bx1 - 1.0, bedY, Math.PI / 2, { roomId: bedroomId });
  add('nightstand', bx1 - 0.2, bedY - 0.945, Math.PI / 2, { roomId: bedroomId });
  add('nightstand', bx1 - 0.2, bedY + 0.945, Math.PI / 2, { roomId: bedroomId });
  add('wardrobe', x1 + 0.85, y1 - 0.3, Math.PI, { roomId: bedroomId });
  add('rug', x1 + 1.5, bedY, 0, { roomId: bedroomId });
  add('pendant', (x1 + bx1) / 2, (y0 + y1) / 2, 0, { roomId: bedroomId, elevation: 1.85 });

  const openings: Opening[] = [
    { id: uid('o'), wallId: c1.id, type: 'window', offset: 1.2, width: 1.3, height: 1.15, sill: 0.95 },
    { id: uid('o'), wallId: c3.id, type: 'door', offset: 0.8, width: 0.95, height: 2.05, sill: 0 },
  ];

  const demo = normalizeDesign({
    version: DESIGN_VERSION,
    rooms: [
      {
        id: roomId,
        name: 'Kitchen',
        corners: [c1, c2, c3, c4],
        style: { ...defaultRoomStyle(), wallThickness: t },
        wallVisibility: {},
      },
      {
        id: bedroomId,
        name: 'Bedroom',
        corners: [d1, d2, d3, d4],
        style: { ...defaultRoomStyle(), wallThickness: t, floorColor: FLOOR_COLORS[1] },
        wallVisibility: {},
      },
    ],
    openings,
    items,
    customParts: [...Store.sharedLibrary(), ...demoParts],
    variables: [],
    scene: defaultScene(),
  });
  syncAttachments(demo); // settle the sink/hob poses onto their hosts
  return demo;
}
