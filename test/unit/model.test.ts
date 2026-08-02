import { describe, expect, it } from 'vitest';
import { catalogDef } from '../../src/model/catalog';
import { projectOnWall, signedArea, wallPoint } from '../../src/model/geometry';
import { toCatalogDef } from '../../src/model/parts';
import { presetPart } from '../../src/model/presets';
import { allWalls, openingsOfWall, rectangleSizeOf, wallByIdIn } from '../../src/model/rooms';
import { snapItem } from '../../src/model/snapping';
import {
  DESIGN_VERSION,
  emptyDesign,
  normalizeDesign,
  sanitizeDesign,
  Store,
} from '../../src/model/store';
import type { Corner, Design, Opening, Point, Room } from '../../src/model/types';

const c = (id: string, x: number, y: number): Corner => ({ id, x, y });

/** Built-in cabinet presets projected the way the app consumes them. */
const presetDef = (id: string) => toCatalogDef(presetPart(id)!);

const RECT = () => [c('c0', 0, 0), c('c1', 4, 0), c('c2', 4, 3), c('c3', 0, 3)];

function rectDesign(): Design {
  const d = emptyDesign();
  d.rooms[0].corners = RECT();
  return normalizeDesign(d);
}

describe('normalizeDesign', () => {
  it('reverses clockwise polygons and remaps openings to the flipped walls', () => {
    const d = emptyDesign();
    // clockwise in y-down plan space => signed area negative => must reverse
    d.rooms[0].corners = [c('a', 0, 0), c('b', 0, 3), c('d', 4, 3), c('e', 4, 0)];
    d.openings = [
      { id: 'o1', wallId: 'a', type: 'door', offset: 1, width: 0.9, height: 2, sill: 0 },
    ];
    expect(signedArea(d.rooms[0].corners)).toBeLessThan(0);
    normalizeDesign(d);
    expect(signedArea(d.rooms[0].corners)).toBeGreaterThan(0);
    // wall a→b (len 3) became b→a: same world spot means offset mirrors
    expect(d.openings[0].wallId).toBe('b');
    expect(d.openings[0].offset).toBeCloseTo(2);
  });

  it('keeps counter-clockwise polygons untouched', () => {
    const d = rectDesign();
    const ids = d.rooms[0].corners.map((k) => k.id);
    normalizeDesign(d);
    expect(d.rooms[0].corners.map((k) => k.id)).toEqual(ids);
  });

  it('normalizes each room independently', () => {
    const d = emptyDesign();
    d.rooms = [
      { id: 'ccw', name: 'A', corners: RECT(), style: d.rooms[0].style },
      {
        id: 'cw',
        name: 'B',
        corners: [c('b0', 5, 0), c('b1', 5, 3), c('b2', 9, 3), c('b3', 9, 0)],
        style: d.rooms[0].style,
      },
    ];
    d.openings = [
      { id: 'o1', wallId: 'c0', type: 'window', offset: 1, width: 0.9, height: 1, sill: 1 },
      { id: 'o2', wallId: 'b0', type: 'window', offset: 1, width: 0.9, height: 1, sill: 1 },
    ];
    normalizeDesign(d);
    // only the reversed room's opening moves
    expect(d.openings[0].wallId).toBe('c0');
    expect(d.openings[0].offset).toBeCloseTo(1);
    expect(d.openings[1].wallId).toBe('b1');
    expect(d.openings[1].offset).toBeCloseTo(2);
    expect(d.rooms.every((r) => signedArea(r.corners) > 0)).toBe(true);
  });
});

describe('sanitizeDesign', () => {
  it('rejects unusable payloads — including any pre-v5 design (no migration path)', () => {
    expect(sanitizeDesign(null)).toBeNull();
    expect(sanitizeDesign('x')).toBeNull();
    expect(sanitizeDesign({})).toBeNull();
    expect(sanitizeDesign({ version: 1, corners: RECT() })).toBeNull();
    expect(sanitizeDesign({ version: 4, corners: RECT() })).toBeNull();
    // no step ABOVE the current version either
    expect(sanitizeDesign({ version: 7, rooms: [] })).toBeNull();
    expect(sanitizeDesign({ version: 5, corners: [c('a', 0, 0), c('b', 1, 0)] })).toBeNull();
    expect(sanitizeDesign({ version: 6, rooms: [] })).toBeNull();
  });

  it('migrates a valid v5 payload into a single v6 room', () => {
    const d = sanitizeDesign({
      version: 5,
      corners: RECT(),
      room: { wallColor: '#112233', wallHeight: 2.8, wallThickness: 0.2 },
    })!;
    expect(d).not.toBeNull();
    expect(d.version).toBe(6);
    expect(d.rooms).toHaveLength(1);
    expect(d.rooms[0].name).toBe('Room 1');
    expect(d.rooms[0].style.wallColor).toBe('#112233');
    expect(d.rooms[0].style.wallHeight).toBe(2.8);
    // v5 corners were centrelines; v6 corners are the room-side wall face
    expect(d.rooms[0].corners[0].x).toBeCloseTo(0.1);
    expect(d.rooms[0].corners[0].y).toBeCloseTo(0.1);
    expect(d.rooms[0].corners[2].x).toBeCloseTo(3.9);
    // corner ids survive the inset, so wall ids (and openings) stay valid
    expect(d.rooms[0].corners.map((k) => k.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('repairs a minimal v5 payload with defaults', () => {
    const d = sanitizeDesign({ version: 5, corners: [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)] });
    expect(d).not.toBeNull();
    expect(Array.isArray(d!.items)).toBe(true);
    expect(Array.isArray(d!.openings)).toBe(true);
    expect(Array.isArray(d!.customParts)).toBe(true);
    expect(d!.rooms[0].style.wallThickness).toBeGreaterThan(0);
    // no scene at all → the defaults
    expect(d!.scene).toEqual({ sunAzimuth: 215, sunElevation: 35, brightness: 1, night: false });
    expect(signedArea(d!.rooms[0].corners)).toBeGreaterThan(0);
  });

  it('remaps wall visibility overrides when the polygon is reversed', () => {
    const d = emptyDesign();
    d.rooms[0].corners = [c('a', 0, 0), c('b', 0, 3), c('e', 4, 3), c('f', 4, 0)];
    d.rooms[0].wallVisibility = { a: 'hide' };
    normalizeDesign(d);
    // wall a→b (keyed by a) flips to b→a (keyed by b); override follows
    expect(d.rooms[0].wallVisibility).toEqual({ b: 'hide' });
  });

  it('keeps only valid non-auto wall visibility overrides', () => {
    const base = [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)];
    const d = sanitizeDesign({
      version: 5,
      corners: base,
      wallVisibility: { a: 'hide', b: 'auto', d: 'bogus' },
    });
    expect(d!.rooms[0].wallVisibility).toEqual({ a: 'hide' });
  });

  it('keeps only a valid non-auto ceiling visibility override', () => {
    const base = [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)];
    const hide = sanitizeDesign({ version: 5, corners: base, ceilingVisibility: 'hide' });
    expect(hide!.rooms[0].ceilingVisibility).toBe('hide');
    const auto = sanitizeDesign({ version: 5, corners: base, ceilingVisibility: 'auto' });
    expect(auto!.rooms[0].ceilingVisibility).toBeUndefined();
    const bogus = sanitizeDesign({ version: 5, corners: base, ceilingVisibility: 'bogus' });
    expect(bogus!.rooms[0].ceilingVisibility).toBeUndefined();
  });

  it('clamps out-of-range scene values', () => {
    const base = [c('a', 0, 0), c('b', 3, 0), c('d', 3, 2)];
    const d = sanitizeDesign({
      version: 5,
      corners: base,
      scene: { sunAzimuth: 725, sunElevation: 200, brightness: -1, night: 'x' },
    });
    expect(d!.scene).toEqual({ sunAzimuth: 5, sunElevation: 85, brightness: 0, night: false });
  });

  it('drops openings whose wall resolves nowhere', () => {
    const d = sanitizeDesign({
      version: 5,
      corners: RECT(),
      openings: [
        { id: 'ok', wallId: 'c0', type: 'window', offset: 2, width: 1, height: 1, sill: 1 },
        { id: 'gone', wallId: 'nope', type: 'door', offset: 1, width: 0.9, height: 2, sill: 0 },
      ],
    })!;
    expect(d.openings.map((o) => o.id)).toEqual(['ok']);
  });

  it('re-ids colliding corners across rooms and keeps room ids unique', () => {
    const d = sanitizeDesign({
      version: 6,
      rooms: [
        { id: 'r', name: 'A', corners: RECT() },
        { id: 'r', name: 'B', corners: RECT() },
      ],
    })!;
    expect(d.rooms).toHaveLength(2);
    expect(d.rooms[0].id).not.toBe(d.rooms[1].id);
    const ids = d.rooms.flatMap((r) => r.corners.map((k) => k.id));
    expect(new Set(ids).size).toBe(ids.length);
    // the first room keeps the authored ids
    expect(d.rooms[0].corners.map((k) => k.id)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });
});

describe('v5 → v6 migration', () => {
  /** A full v5 design exercising every field the migration has to carry. */
  const v5 = () => ({
    version: 5,
    corners: [c('c0', 0, 0), c('c1', 4.2, 0), c('c2', 4.2, 3.4), c('c3', 0, 3.4)],
    openings: [
      { id: 'w1', wallId: 'c0', type: 'window', offset: 1.25, width: 1.3, height: 1.15, sill: 0.95 },
      {
        id: 'd1',
        wallId: 'c2',
        type: 'door',
        offset: 0.85,
        width: 0.95,
        height: 2.05,
        sill: 0,
        hinge: 'right',
        swing: 'out',
      },
    ],
    items: [
      {
        id: 'host',
        defId: 'base-cabinet',
        x: 1.25,
        y: 0.35,
        rotation: 0,
        w: 0.8,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: 'var:v1',
      },
      {
        id: 'sink',
        defId: 'appl-sink',
        x: 1.25,
        y: 0.35,
        rotation: 0,
        w: 0.5,
        d: 0.4,
        h: 0.2,
        elevation: 0.9,
        color: '#ccc',
        attach: { kind: 'counter', hostId: 'host', u: 0, v: 0 },
      },
    ],
    variables: [{ id: 'v1', name: 'Sage', color: '#8a9683' }],
    room: { wallColor: 'var:v1', floorColor: '#cfccc6', counterColor: '#c9a87c', wallHeight: 2.6, wallThickness: 0.1 },
    wallVisibility: { c0: 'hide' },
    ceilingVisibility: 'show',
    scene: { sunAzimuth: 100, sunElevation: 40, brightness: 0.8, night: true },
  });

  it('slides every opening with its wall, preserving its world position', () => {
    const raw = v5();
    // world point of each opening on the ORIGINAL centreline ring
    const before = new Map<string, Point>(
      raw.openings.map((o) => {
        const i = raw.corners.findIndex((k) => k.id === o.wallId);
        const a = raw.corners[i];
        const b = raw.corners[(i + 1) % raw.corners.length];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        return [
          o.id,
          { x: a.x + ((b.x - a.x) / len) * o.offset, y: a.y + ((b.y - a.y) / len) * o.offset },
        ];
      })
    );
    const d = sanitizeDesign(raw)!;
    expect(d.openings).toHaveLength(2);
    for (const o of d.openings) {
      const g = wallByIdIn(d.rooms, o.wallId)!;
      const old = before.get(o.id)!;
      // the new offset is the old world point projected onto the moved wall …
      expect(projectOnWall(g, old).t).toBeCloseTo(o.offset, 9);
      // … so it only travelled perpendicular, by exactly the t/2 inset
      const now = wallPoint(g, o.offset);
      expect(Math.hypot(now.x - old.x, now.y - old.y)).toBeCloseTo(0.05, 9);
    }
  });

  it('carries style, visibility, scene, variables and attachments over', () => {
    const d = sanitizeDesign(v5())!;
    expect(d.version).toBe(DESIGN_VERSION);
    expect(d.rooms).toHaveLength(1);
    const room = d.rooms[0];
    expect(room.style.wallColor).toBe('var:v1'); // live ref survives
    expect(room.style.wallThickness).toBeCloseTo(0.1);
    expect(room.wallVisibility).toEqual({ c0: 'hide' });
    expect(room.ceilingVisibility).toBe('show');
    expect(d.scene).toEqual({ sunAzimuth: 100, sunElevation: 40, brightness: 0.8, night: true });
    expect(d.variables.map((v) => v.id)).toEqual(['v1']);
    // door hinge/swing are untouched by the inset
    const door = d.openings.find((o) => o.id === 'd1')!;
    expect(door.hinge).toBe('right');
    expect(door.swing).toBe('out');
    // the attached sink survives and stays mounted
    expect(d.items.find((i) => i.id === 'sink')!.attach).toBeTruthy();
  });

  it('stamps every item with the new room id', () => {
    const d = sanitizeDesign(v5())!;
    for (const it of d.items) expect(it.roomId).toBe(d.rooms[0].id);
  });

  it('is idempotent — sanitizing the result again changes nothing', () => {
    const once = sanitizeDesign(v5())!;
    const twice = sanitizeDesign(JSON.parse(JSON.stringify(once)))!;
    expect(JSON.parse(JSON.stringify(twice))).toEqual(JSON.parse(JSON.stringify(once)));
  });
});

describe('Store mutations', () => {
  it('moveCorner keeps the CCW invariant when the polygon is dragged inside-out', () => {
    const store = new Store(rectDesign());
    store.addOpening(catalogDef('window'), store.allWalls()[0].id, 2);
    store.commit();
    store.moveCorner('c0', 5.5, 4.5, false);
    store.commit();
    expect(signedArea(store.activeRoom().corners)).toBeGreaterThan(0);
    for (const o of store.design.openings) {
      const g = store.wallById(o.wallId)!;
      expect(g).toBeTruthy();
      expect(o.offset).toBeGreaterThanOrEqual(0);
      expect(o.offset).toBeLessThanOrEqual(g.len);
    }
  });

  it('sets per-wall and bulk wall visibility overrides', () => {
    const store = new Store(rectDesign());
    const ids = store.allWalls().map((w) => w.id);
    expect(store.wallVisibility(ids[0])).toBe('auto');
    store.setWallVisibility(ids[0], 'hide');
    expect(store.wallVisibility(ids[0])).toBe('hide');
    // 'auto' clears the override rather than storing it
    store.setWallVisibility(ids[0], 'auto');
    expect(store.activeRoom().wallVisibility?.[ids[0]]).toBeUndefined();
    store.setAllWallVisibility('hide');
    for (const id of ids) expect(store.wallVisibility(id)).toBe('hide');
    store.setAllWallVisibility('auto');
    expect(store.activeRoom().wallVisibility).toEqual({});
  });

  it('sets and clears the ceiling visibility override', () => {
    const store = new Store(rectDesign());
    expect(store.ceilingVisibility()).toBe('auto');
    store.setCeilingVisibility('show');
    expect(store.ceilingVisibility()).toBe('show');
    // 'auto' clears the override rather than storing it
    store.setCeilingVisibility('auto');
    expect(store.activeRoom().ceilingVisibility).toBeUndefined();
  });

  it('clamps opening offsets sanely on very short walls', () => {
    const store = new Store(rectDesign());
    const left = store.allWalls().find((w) => Math.abs(w.dir.x) < 1e-6)!;
    store.addOpening(catalogDef('door'), left.id, 1.5);
    store.setWallLength(left.id, 0.35);
    const o = store.design.openings[0];
    const g = store.wallById(o.wallId)!;
    expect(o.offset).toBeGreaterThanOrEqual(0);
    expect(o.offset).toBeLessThanOrEqual(g.len);
  });

  it('deleteCorner re-projects openings onto the merged wall', () => {
    const store = new Store(rectDesign());
    const bottomStart = store.allWalls().find((w) => w.a.y === 0 && w.b.y === 0)!;
    const mid = store.splitWall(bottomStart.id, bottomStart.len / 2)!;
    // opening at world x=3 on the second half of the split wall
    store.addOpening(catalogDef('window'), mid.id, 1);
    store.deleteCorner(mid.id);
    const o = store.design.openings[0];
    const g = store.wallById(o.wallId)!;
    const world = { x: g.a.x + g.dir.x * o.offset, y: g.a.y + g.dir.y * o.offset };
    expect(world.x).toBeCloseTo(3);
    expect(world.y).toBeCloseTo(0);
  });

  it('setWallLength keeps rectangles rectangular', () => {
    const store = new Store(rectDesign());
    const left = store.allWalls().find((w) => Math.abs(w.dir.x) < 1e-6)!;
    store.setWallLength(left.id, 3.5);
    const rect = store.rectangleSize();
    expect(rect).not.toBeNull();
    expect([rect!.w, rect!.d].sort()).toEqual([3.5, 4]);
  });

  it('outlet gangs param extends the box width by one cell each', () => {
    const store = new Store(rectDesign());
    const item = store.addItem(catalogDef('outlet'), 1, 1);
    expect(item.w).toBeCloseTo(0.086);
    store.setItemParam(item.id, 'gangs', 3);
    expect(store.itemById(item.id)!.w).toBeCloseTo(0.258); // 3 × 0.086
    store.setItemParam(item.id, 'gangs', 1);
    expect(store.itemById(item.id)!.w).toBeCloseTo(0.086);
  });

  it('undo with an uncommitted gesture lands on the last committed state', () => {
    const store = new Store(rectDesign());
    const item = store.addItem(presetDef('base-cabinet'), 1, 1);
    store.commit();
    store.updateItem(item.id, { x: 2 }); // gesture without commit
    store.undo();
    expect(store.itemById(item.id)!.x).toBe(1);
    store.redo();
    expect(store.itemById(item.id)!.x).toBe(2);
  });
});

describe('active room', () => {
  it('falls back to rooms[0] and only accepts real ids', () => {
    const store = new Store(rectDesign());
    const first = store.design.rooms[0].id;
    expect(store.activeRoomId).toBe(first);
    store.setActiveRoom('nope');
    expect(store.activeRoomId).toBe(first);
  });

  it('emits on change and is not serialized or undoable', () => {
    const store = new Store(rectDesign());
    const d = store.design;
    d.rooms.push({ ...d.rooms[0], id: 'second', corners: d.rooms[0].corners.map((k) => ({ ...k })) });
    const seen: string[] = [];
    store.on('activeRoom', (id) => seen.push(id));
    store.setActiveRoom('second');
    expect(seen).toEqual(['second']);
    expect(store.activeRoomId).toBe('second');
    expect(JSON.stringify(store.design)).not.toContain('activeId');
    // a replace that drops the room falls back rather than dangling
    store.replaceDesign(rectDesign());
    expect(store.activeRoomId).toBe(store.design.rooms[0].id);
  });
});

describe('rooms CRUD', () => {
  const xs = (r: Room) => r.corners.map((c) => c.x);
  const ys = (r: Room) => r.corners.map((c) => c.y);
  /** the two walls of a partition, or [] when nothing is shared */
  const seam = (store: Store) => store.allWalls().filter((w) => w.shared);

  it('addRoom lands a freestanding room clear of everything, and activates it', () => {
    const store = new Store(rectDesign());
    const r = store.addRoom()!;
    expect(store.design.rooms).toHaveLength(2);
    expect(r.name).toBe('Room 2');
    // right of the bbox (maxX 4) with a 1 m gap, top aligned to the bbox top
    expect(Math.min(...xs(r))).toBeCloseTo(5);
    expect(Math.min(...ys(r))).toBeCloseTo(0);
    expect(rectangleSizeOf(r)).toEqual({ w: 4, d: 3 });
    expect(signedArea(r.corners)).toBeGreaterThan(0);
    expect(store.activeRoomId).toBe(r.id);
    expect(seam(store)).toHaveLength(0); // the gap keeps it standalone
    // a third room clears BOTH of them
    const third = store.addRoom()!;
    expect(Math.min(...xs(third))).toBeCloseTo(10);
  });

  it('addRoom({at}) honours the exact min-corner and size', () => {
    const store = new Store(rectDesign());
    const r = store.addRoom({ at: { x: -6, y: 2 }, w: 2, d: 2.5, name: '  Bath  ' })!;
    expect(r.name).toBe('Bath');
    expect(Math.min(...xs(r))).toBeCloseTo(-6);
    expect(Math.min(...ys(r))).toBeCloseTo(2);
    expect(rectangleSizeOf(r)).toEqual({ w: 2, d: 2.5 });
    expect(signedArea(r.corners)).toBeGreaterThan(0);
  });

  it('addRoom({against}) builds a shared partition on the whole wall', () => {
    const store = new Store(rectDesign());
    const host = store.wallById('c1')!; // right wall, (4,0) → (4,3)
    expect(host.faceOffset).toBe(0); // exterior today
    const a0 = { x: host.a.x, y: host.a.y };
    const b0 = { x: host.b.x, y: host.b.y };

    const r = store.addRoom({ against: { wallId: 'c1' }, d: 3 })!;

    const pair = seam(store);
    expect(pair).toHaveLength(2);
    expect(pair.filter((w) => w.shared!.owner)).toHaveLength(1);
    const hostSide = pair.find((w) => w.roomId === store.design.rooms[0].id)!;
    const newSide = pair.find((w) => w.roomId === r.id)!;
    expect(hostSide.id).toBe('c1');
    expect(hostSide.shared!.owner).toBe(true); // rooms[0] owns it
    expect(newSide.shared!.wallId).toBe('c1');
    // seam coordinates are bit-identical, and reversed
    expect(newSide.a).toMatchObject(b0);
    expect(newSide.b).toMatchObject(a0);
    // the host wall flipped exterior → partition (documented side effect)
    expect(hostSide.faceOffset).toBeCloseTo(0.05);
    expect(newSide.faceOffset).toBeCloseTo(0.05);

    expect(signedArea(r.corners)).toBeGreaterThan(0);
    expect(store.activeRoomId).toBe(r.id);
    expect(Math.max(...xs(r))).toBeCloseTo(7); // grew away from the host room
    expect(store.design.rooms[0].corners).toHaveLength(4); // host untouched
  });

  it('addRoom({against, span}) carves the sub-span and re-keys its openings', () => {
    const store = new Store(rectDesign());
    store.addOpening(catalogDef('window'), 'c1', 1.5); // world (4, 1.5)
    const openingId = store.design.openings[0].id;

    const r = store.addRoom({ against: { wallId: 'c1', span: { t0: 0.5, t1: 2.5 } }, d: 2 })!;

    // two cuts landed in the host ring
    expect(store.design.rooms[0].corners).toHaveLength(6);
    const pair = seam(store);
    expect(pair).toHaveLength(2);
    const hostSide = pair.find((w) => w.roomId === store.design.rooms[0].id)!;
    expect(hostSide.len).toBeCloseTo(2);
    expect(hostSide.a).toMatchObject({ x: 4, y: 0.5 });
    expect(hostSide.b).toMatchObject({ x: 4, y: 2.5 });
    expect(hostSide.id).not.toBe('c1'); // the middle segment, not the original
    expect(rectangleSizeOf(r)).toEqual({ w: 2, d: 2 });

    // the opening survived the splits, on the middle segment, at its world spot
    const o = store.design.openings.find((k) => k.id === openingId)!;
    expect(o.wallId).toBe(hostSide.id);
    const p = wallPoint(store.wallById(o.wallId)!, o.offset);
    expect(p.x).toBeCloseTo(4);
    expect(p.y).toBeCloseTo(1.5);
  });

  it('addRoom({against, span}) skips cuts a span cannot justify', () => {
    // wall 'c1' is (4,0) → (4,3); a cut is only worth making 10 cm from an end
    const cases: { span: { t0: number; t1: number }; corners: number; len: number }[] = [
      { span: { t0: 0, t1: 3 }, corners: 4, len: 3 }, // the whole wall
      { span: { t0: -5, t1: 99 }, corners: 4, len: 3 }, // clamped to the whole wall
      { span: { t0: 1, t1: 1.05 }, corners: 4, len: 3 }, // too short to be a wall
      { span: { t0: 2, t1: 1 }, corners: 6, len: 1 }, // reversed, still carved
      { span: { t0: 0.05, t1: 2 }, corners: 5, len: 2 }, // stub at the start absorbed
      { span: { t0: 1, t1: 2.95 }, corners: 5, len: 2 }, // stub at the end absorbed
    ];
    for (const { span, corners, len } of cases) {
      const store = new Store(rectDesign());
      const r = store.addRoom({ against: { wallId: 'c1', span }, d: 2 })!;
      expect(store.design.rooms[0].corners, JSON.stringify(span)).toHaveLength(corners);
      const pair = seam(store);
      expect(pair, JSON.stringify(span)).toHaveLength(2);
      expect(pair[0].len, JSON.stringify(span)).toBeCloseTo(len);
      expect(signedArea(r.corners)).toBeGreaterThan(0);
    }
  });

  it('addRoom({against}) refuses a partition or an unknown wall, changing nothing', () => {
    const store = new Store(rectDesign());
    store.addRoom({ against: { wallId: 'c1' } });
    const before = JSON.stringify(store.design);
    expect(store.addRoom({ against: { wallId: 'c1' } })).toBeNull();
    expect(store.addRoom({ against: { wallId: 'nope' } })).toBeNull();
    expect(JSON.stringify(store.design)).toBe(before);
    expect(store.design.rooms).toHaveLength(2);
  });

  it('deleteRoom refuses the last room', () => {
    const store = new Store(rectDesign());
    expect(store.deleteRoom(store.design.rooms[0].id)).toBeNull();
    expect(store.deleteRoom('nope')).toBeNull();
    expect(store.design.rooms).toHaveLength(1);
  });

  it('deleteRoom cascades items, re-homes partition openings and drops the rest', () => {
    const store = new Store(rectDesign());
    const b = store.addRoom({ against: { wallId: 'c1' }, d: 3, name: 'B' })!;
    const a = store.design.rooms[0];

    // a door on the partition (stored on the owner, room A) and a window outside
    const door = store.addOpening(catalogDef('door'), 'c1', 1);
    const window = store.addOpening(catalogDef('window'), 'c0', 2);
    const twinId = store.wallTwin('c1')!.id;

    // room A: a cabinet with a sink mounted in its worktop; room B: a survivor
    const host = store.addItem(presetDef('base-cabinet'), 1, 1);
    const sink = store.addItem(catalogDef('appl-sink'), 1, 1);
    store.setAttachment(sink.id, { kind: 'counter', hostId: host.id, u: 0, v: 0 });
    expect(store.itemById(sink.id)!.attach).toBeTruthy();
    // an appliance whose cached room says otherwise still dies with its host —
    // the cascade, not the room filter, is what takes it
    store.itemById(sink.id)!.roomId = b.id;
    const survivor = store.addItem(presetDef('base-cabinet'), 5.5, 1.5);

    store.setActiveRoom(a.id);
    store.select({ kind: 'item', id: host.id });

    expect(store.deleteRoom(a.id)).toEqual({ items: 2, openings: 1 });

    expect(store.design.rooms.map((r) => r.id)).toEqual([b.id]);
    expect(store.design.items.map((i) => i.id)).toEqual([survivor.id]);
    // the partition door moved to the twin, mirrored; the window died with the wall
    expect(store.design.openings.map((o) => o.id)).toEqual([door.id]);
    expect(store.openingById(window.id)).toBeUndefined();
    const moved = store.openingById(door.id)!;
    expect(moved.wallId).toBe(twinId);
    expect(moved.offset).toBeCloseTo(2); // twinLen 3 − 1
    expect(moved.hinge).toBe('right'); // default 'left' flipped
    expect(moved.swing).toBe('out'); // default 'in' flipped
    // that wall is exterior again
    expect(seam(store)).toHaveLength(0);
    expect(store.wallById(twinId)!.faceOffset).toBe(0);

    expect(store.activeRoomId).toBe(b.id);
    expect(store.selection).toEqual({ kind: 'none' });
  });

  it('duplicateRoom copies the shell with fresh ids and no items', () => {
    const store = new Store(rectDesign());
    const src = store.design.rooms[0];
    src.wallVisibility = { c0: 'hide' };
    const orig = store.addOpening(catalogDef('window'), 'c0', 2);
    store.addItem(presetDef('base-cabinet'), 1, 1);
    const before = JSON.parse(JSON.stringify(src)) as Room;

    const copy = store.duplicateRoom(src.id)!;

    expect(store.design.rooms).toHaveLength(2);
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('Room 1 copy');
    expect(store.design.rooms[0]).toEqual(before); // original untouched
    // translated by its own width + the 1 m gap
    expect(xs(copy)).toEqual([5, 9, 9, 5]);
    expect(ys(copy)).toEqual([0, 0, 3, 3]);
    expect(seam(store)).toHaveLength(0);

    // corner ids are fresh and unique design-wide
    const ids = store.design.rooms.flatMap((r) => r.corners.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(copy.corners.every((c) => !src.corners.some((k) => k.id === c.id))).toBe(true);
    // …and wallVisibility followed them
    expect(copy.wallVisibility).toEqual({ [copy.corners[0].id]: 'hide' });

    // the opening was copied onto the copy's matching wall, with a fresh id
    expect(store.design.openings).toHaveLength(2);
    const dup = store.design.openings[1];
    expect(dup.id).not.toBe(orig.id);
    expect(dup.wallId).toBe(copy.corners[0].id);
    expect(dup.offset).toBeCloseTo(orig.offset);
    // items are NOT copied (documented v6 scope)
    expect(store.design.items).toHaveLength(1);

    // sanitize is a no-op: nothing collided, nothing dangles
    const round = sanitizeDesign(JSON.parse(JSON.stringify(store.design)))!;
    expect(round.rooms.map((r) => r.corners.map((c) => c.id))).toEqual(
      store.design.rooms.map((r) => r.corners.map((c) => c.id))
    );
    expect(round.openings.map((o) => o.wallId)).toEqual(
      store.design.openings.map((o) => o.wallId)
    );
  });

  it('duplicateRoom takes an explicit offset and rejects unknown ids', () => {
    const store = new Store(rectDesign());
    const copy = store.duplicateRoom(store.design.rooms[0].id, { x: 0, y: -4 })!;
    expect(ys(copy)).toEqual([-4, -4, -1, -1]);
    expect(store.duplicateRoom('nope')).toBeNull();
  });

  it('renameRoom trims and keeps the old name when handed nothing', () => {
    const store = new Store(rectDesign());
    const id = store.design.rooms[0].id;
    store.renameRoom(id, '  Living  ');
    expect(store.roomById(id)!.name).toBe('Living');
    store.renameRoom(id, '   ');
    expect(store.roomById(id)!.name).toBe('Living');
    // non-structural: nothing geometric moved
    const infos: boolean[] = [];
    store.on('change', (i) => infos.push(i.structural));
    store.renameRoom(id, 'Den');
    expect(infos).toEqual([false]);
  });

  it('undo unwinds an added room and leaves the active room resolvable', () => {
    const store = new Store(rectDesign());
    const r = store.addRoom()!;
    store.commit();
    expect(store.activeRoomId).toBe(r.id);

    store.undo();

    expect(store.design.rooms).toHaveLength(1);
    expect(store.activeRoomId).toBe(store.design.rooms[0].id);
    expect(store.roomById(store.activeRoomId)).toBeTruthy();
    expect(allWalls(store.design.rooms)).toHaveLength(4);
  });
});

describe('shared walls', () => {
  const seam = (store: Store) => store.allWalls().filter((w) => w.shared);

  /** Kitchen + a second room hung off its right wall — one shared partition. */
  function twoRoomFixture() {
    const store = new Store(rectDesign());
    const b = store.addRoom({ against: { wallId: 'c1' }, d: 3, name: 'B' })!;
    const a = store.design.rooms[0];
    return { store, a, b };
  }

  it('splitWall on a partition splits both rings and keeps the seam bit-identical', () => {
    const { store, a, b } = twoRoomFixture();
    const ownerWall = seam(store).find((w) => w.shared!.owner)!;
    expect(ownerWall.roomId).toBe(a.id);
    const beforeBIds = new Set(store.roomById(b.id)!.corners.map((k) => k.id));

    const nc = store.splitWall(ownerWall.id, 1.2)!;
    expect(nc).toBeTruthy();

    const roomA = store.roomById(a.id)!;
    const roomB = store.roomById(b.id)!;
    expect(roomA.corners).toHaveLength(5); // 4 → 5
    expect(roomB.corners).toHaveLength(5); // 4 → 5
    expect(roomA.corners.some((k) => k.id === nc.id)).toBe(true);

    // room B gained exactly one corner, bit-identical to the owner's new one
    const bNew = roomB.corners.find((k) => !beforeBIds.has(k.id))!;
    expect(bNew).toBeTruthy();
    expect(bNew.x).toBe(nc.x);
    expect(bNew.y).toBe(nc.y);

    // two shared pairs now (4 shared-tagged walls, 2 owners)
    const pairs = seam(store);
    expect(pairs).toHaveLength(4);
    expect(pairs.filter((w) => w.shared!.owner)).toHaveLength(2);
    expect(pairs.filter((w) => w.roomId === a.id)).toHaveLength(2);
    expect(pairs.filter((w) => w.roomId === b.id)).toHaveLength(2);
    // every shared wall's endpoint COORDINATES match its twin's, reversed
    // (ids differ — a and twin.b are distinct corners in distinct rooms)
    for (const w of pairs) {
      const twin = store.wallById(w.shared!.wallId)!;
      expect({ x: w.a.x, y: w.a.y }).toEqual({ x: twin.b.x, y: twin.b.y });
      expect({ x: w.b.x, y: w.b.y }).toEqual({ x: twin.a.x, y: twin.a.y });
    }
  });

  it('an opening before the split point keeps its exact world position', () => {
    const { store } = twoRoomFixture();
    const ownerWall = seam(store).find((w) => w.shared!.owner)!;
    const opening = store.addOpening(catalogDef('door'), ownerWall.id, 0.6);
    const before = wallPoint(store.wallById(opening.wallId)!, opening.offset);

    store.splitWall(ownerWall.id, 1.5); // split past the opening

    expect(opening.wallId).toBe(ownerWall.id); // stayed on the first segment
    const after = wallPoint(store.wallById(opening.wallId)!, opening.offset);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('an opening past the split re-keys and mirrors correctly on the twin side', () => {
    const { store } = twoRoomFixture();
    const ownerWall = seam(store).find((w) => w.shared!.owner)!;
    const twinIdBefore = ownerWall.shared!.wallId;
    const opening = store.addOpening(catalogDef('door'), ownerWall.id, 2.5);

    const nc = store.splitWall(ownerWall.id, 1.0)!;

    // the opening moved onto the new (owner-side) second segment
    const moved = store.openingById(opening.id)!;
    expect(moved.wallId).toBe(nc.id);
    expect(moved.offset).toBeCloseTo(1.5);

    // its twin is the twin's OWN first segment (unchanged id) — asking from
    // that side must see the same door, mirrored, at the same world point
    const newSegment = store.wallById(nc.id)!;
    const twinSegment = store.wallById(newSegment.shared!.wallId)!;
    expect(twinSegment.id).toBe(twinIdBefore);

    const worldOnOwner = wallPoint(newSegment, moved.offset);
    const mirrored = openingsOfWall(store.design, twinSegment).find((w) => w.id === opening.id)!;
    expect(mirrored).toBeTruthy();
    expect(mirrored.mirrored).toBe(true);
    const worldOnTwin = wallPoint(twinSegment, mirrored.offset);
    expect(worldOnTwin.x).toBeCloseTo(worldOnOwner.x, 6);
    expect(worldOnTwin.y).toBeCloseTo(worldOnOwner.y, 6);
  });

  it('splitWall on an exterior wall has no twin side effects (unchanged single-room behavior)', () => {
    const store = new Store(rectDesign());
    const wall = store.allWalls()[0];
    const nc = store.splitWall(wall.id, 1.0)!;
    expect(nc).toBeTruthy();
    expect(store.design.rooms).toHaveLength(1);
    expect(store.design.rooms[0].corners).toHaveLength(5);
    expect(seam(store)).toHaveLength(0);
  });

  it('addRoom({against, span}) still ends with exactly one shared pair', () => {
    const store = new Store(rectDesign());
    // carveSpan's two splitWall calls run BEFORE the seam exists (no twin
    // yet) — only after addRoom builds room B does the middle segment share
    store.addRoom({ against: { wallId: 'c1', span: { t0: 0.5, t1: 2.5 } }, d: 2 });
    const pairs = seam(store);
    expect(pairs).toHaveLength(2);
    expect(pairs.filter((w) => w.shared!.owner)).toHaveLength(1);
  });

  it('sanitizeDesign re-homes an opening stranded on the non-owner side, mirrored', () => {
    const { store } = twoRoomFixture();
    const ownerWall = seam(store).find((w) => w.shared!.owner)!;
    const nonOwnerWall = store.wallById(ownerWall.shared!.wallId)!;

    const raw = JSON.parse(JSON.stringify(store.design)) as Design;
    // hand-plant a door on the NON-owner side — Store itself never produces
    // this (addOpening/updateOpening always resolve ownerWall), but an old
    // file or a hand edit can
    const door: Opening = {
      id: 'o-nonowner',
      wallId: nonOwnerWall.id,
      type: 'door',
      offset: 1.0,
      width: 0.9,
      height: 2.0,
      sill: 0,
      hinge: 'left',
      swing: 'in',
    };
    raw.openings = [door];
    const worldBefore = wallPoint(nonOwnerWall, door.offset);

    const sane = sanitizeDesign(raw)!;
    expect(sane).not.toBeNull();
    expect(sane.openings).toHaveLength(1);
    const o = sane.openings[0];
    expect(o.id).toBe('o-nonowner'); // same id
    expect(o.wallId).toBe(ownerWall.id); // repaired onto the owner
    expect(o.hinge).toBe('right'); // default 'left' flipped
    expect(o.swing).toBe('out'); // default 'in' flipped
    expect(o.offset).toBeCloseTo(nonOwnerWall.len - 1.0);

    const g = allWalls(sane.rooms).find((w) => w.id === ownerWall.id)!;
    const worldAfter = wallPoint(g, o.offset);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);

    // idempotent: sanitizing the already-repaired design changes nothing
    const again = sanitizeDesign(JSON.parse(JSON.stringify(sane)))!;
    expect(again.openings).toEqual(sane.openings);
  });

  it('undo unwinds a partition split back to 4 corners on both sides, still shared', () => {
    const { store, a, b } = twoRoomFixture();
    store.commit();

    const ownerWall = seam(store).find((w) => w.shared!.owner)!;
    store.splitWall(ownerWall.id, 1.2);
    store.commit();
    expect(store.roomById(a.id)!.corners).toHaveLength(5);
    expect(store.roomById(b.id)!.corners).toHaveLength(5);

    store.undo();

    expect(store.roomById(a.id)!.corners).toHaveLength(4);
    expect(store.roomById(b.id)!.corners).toHaveLength(4);
    expect(seam(store)).toHaveLength(2);
  });
});

describe('snapItem', () => {
  it('snaps an item back-to-wall with auto-rotation', () => {
    const store = new Store(rectDesign());
    const res = snapItem(store, presetDef('base-cabinet'), null, 2, 2.8, 0);
    expect(res.wallId).toBeTruthy();
    // corners ARE the wall face now, so the back sits flush at y = 3
    expect(res.y).toBeCloseTo(2.7);
    expect(res.roomId).toBe(store.activeRoomId);
    expect(Math.abs(Math.abs(res.rotation) - Math.PI)).toBeLessThan(0.01);
  });

  it('edge snapping cannot push a wall-snapped item past the wall end', () => {
    const store = new Store(rectDesign());
    // neighbour sitting beyond the wall end lures the edge snap outward
    const rogue = store.addItem(presetDef('base-cabinet'), 4.55, 2.7, Math.PI);
    expect(rogue).toBeTruthy();
    const res = snapItem(store, presetDef('base-cabinet'), null, 3.9, 2.75, 0);
    expect(res.wallId).toBeTruthy();
    expect(res.x).toBeLessThanOrEqual(3.71);
    expect(res.x).toBeGreaterThanOrEqual(0.29);
  });
});
