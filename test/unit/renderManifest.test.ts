/**
 * Render manifest v1 — `buildRenderManifest` (src/model/renderManifest.ts).
 *
 * The manifest is the only description of lights, sun and window apertures the
 * Blender worker ever sees, so every derivation here is pinned against the
 * transforms View3D actually applies: `itemBaseY + lightLocalY` for emitters,
 * `SPOT_AIM` turned by `-item.rotation`, and `zc = faceOffset - thickness/2`
 * for the wall-local aperture plane.
 *
 * GOLDEN FILE — `render/manifest/examples/kitchen-min.json` is checked in and
 * read by BOTH this suite and the worker's pytest, so the two can never drift.
 * Regenerate it (after a DELIBERATE manifest change, never to make a red test
 * green) with:
 *
 *     UPDATE_GOLDEN=1 npx vitest run test/unit/renderManifest.test.ts
 *
 * That rewrites the file instead of comparing, and the diff is the review.
 * The compare path imports the JSON (Vite resolves it, tsc types it); only the
 * rare rewrite path reaches for `node:fs`, and it does so through a computed
 * specifier because this repo carries no `@types/node`.
 */

import { describe, expect, it } from 'vitest';
import { DESIGN_VERSION } from '../../src/model/migrate';
import goldenManifest from '../../render/manifest/examples/kitchen-min.json';
import { OAK, SPOT_AIM } from '../../src/model/catalog';
import {
  buildRenderManifest,
  MANIFEST_VERSION,
  type ManifestCamera,
  type ManifestInput,
  type ManifestLight,
  type ManifestMaterial,
  type ManifestPortal,
  type ManifestRender,
} from '../../src/model/renderManifest';
import { DEFAULT_WALL_W, defaultRoomStyle } from '../../src/model/rooms';
import { AMBIENT_DAY, skyState } from '../../src/model/sky';
import type { Design, Item, Opening, Room, RoomStyle } from '../../src/model/types';

/* ---------------- fixtures ---------------- */

/** Literal-id room; the ring is CCW in `signedArea`'s sense, as the model requires. */
function room(id: string, pts: [number, number][], style: Partial<RoomStyle> = {}): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => ({ id: `${id}-c${i}`, x, y })),
    style: { ...defaultRoomStyle(), ...style },
  };
}

/** 4 × 3 rectangle with its min corner at the origin. */
const rect4x3 = (id = 'A', style: Partial<RoomStyle> = {}): Room =>
  room(
    id,
    [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ],
    style
  );

function mkDesign(rooms: Room[], over: Partial<Design> = {}): Design {
  return {
    version: DESIGN_VERSION,
    rooms,
    openings: [],
    items: [],
    customParts: [],
    variables: [],
    scene: { sunAzimuth: 135, sunElevation: 35, brightness: 1, night: false },
    ...over,
  };
}

function item(over: Partial<Item> & Pick<Item, 'id' | 'defId'>): Item {
  return {
    x: 2,
    y: 1.5,
    rotation: 0,
    w: 0.6,
    d: 0.6,
    h: 0.9,
    elevation: 0,
    color: OAK,
    ...over,
  };
}

const CAMERA: ManifestCamera = {
  position: { x: 5.2, y: 1.65, z: 4.8 },
  target: { x: 2, y: 1.1, z: 1.5 },
  up: { x: 0, y: 1, z: 0 },
  fovYDeg: 50,
  viewportAspect: 1.777778,
  nearM: 0.05,
  farM: 120,
};

const RENDER: ManifestRender = {
  widthPx: 1920,
  heightPx: 1080,
  tier: 'final',
  sensorFit: 'vertical',
};

const MATERIALS: ManifestMaterial[] = [
  {
    name: 'kp:m:oak:c9a87c',
    kind: 'library',
    matId: 'oak',
    baseColorHex: OAK,
    rot: false,
    meshCount: 12,
  },
  {
    name: 'kp:s:wall:f4f1ea',
    kind: 'shell',
    surface: 'wall',
    baseColorHex: '#f4f1ea',
    rot: false,
    meshCount: 4,
  },
];

function mkInput(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    camera: CAMERA,
    materials: MATERIALS,
    render: RENDER,
    appVersion: '0.0.0-test',
    now: new Date('2026-01-02T03:04:05.000Z'),
    ...over,
  };
}

const lightOf = (design: Design, itemId: string): ManifestLight => {
  const hit = buildRenderManifest(design, mkInput()).lights.find((l) => l.itemId === itemId);
  if (!hit) throw new Error(`no light for ${itemId}`);
  return hit;
};

const portalsOf = (design: Design): ManifestPortal[] =>
  buildRenderManifest(design, mkInput()).portals;

/* ---------------- envelope ---------------- */

describe('manifest envelope', () => {
  it('stamps version, units, axis, files and passes the view layer through', () => {
    const m = buildRenderManifest(mkDesign([rect4x3()]), mkInput({ appVersion: '1.2.3' }));
    expect(m.manifestVersion).toBe(MANIFEST_VERSION);
    expect(m.designVersion).toBe(DESIGN_VERSION);
    expect(m.appVersion).toBe('1.2.3');
    expect(m.exportedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(m.units).toBe('m');
    expect(m.axis).toBe('gltf-y-up');
    expect(m.files).toEqual({ glb: 'scene.glb', design: 'design.json' });
    expect(m.camera).toEqual(CAMERA);
    expect(m.materials).toEqual(MATERIALS);
    expect(m.render).toEqual(RENDER);
  });

  it('falls back to the wall clock when `now` is absent', () => {
    const before = Date.now();
    const m = buildRenderManifest(mkDesign([rect4x3()]), mkInput({ now: undefined }));
    const at = Date.parse(m.exportedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

/* ---------------- lights ---------------- */

describe('lights', () => {
  it('places a pendant at elevation + lightLocalY (h × 0.18)', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-pendant',
          defId: 'pendant',
          x: 1.25,
          y: 2.4,
          w: 0.35,
          d: 0.35,
          h: 0.3,
          elevation: 1.85,
          light: { on: true, intensity: 0.7, warmth: 0.75 },
        }),
      ],
    });
    const l = lightOf(design, 'i-pendant');
    expect(l.kind).toBe('point');
    expect(l.defId).toBe('pendant');
    expect(l.on).toBe(true);
    expect(l.intensity).toBeCloseTo(0.7, 9);
    expect(l.warmth).toBeCloseTo(0.75, 9);
    // plan (x, y) → world (x, z); y = 1.85 + 0.3 × 0.18
    expect(l.position).toEqual({ x: 1.25, y: 1.904, z: 2.4 });
    expect(l.direction).toEqual({ x: 0, y: -1, z: 0 });
    expect(l.yawRad).toBe(0);
    // point fixtures carry no cone and no rectangle
    expect(l.coneAngleRad).toBeUndefined();
    expect(l.coneBlend).toBeUndefined();
    expect(l.sizeX).toBeUndefined();
    expect(l.colorHex).toBeUndefined();
  });

  it('hangs a ceiling spot from the ROOM height, not its stored elevation', () => {
    // wallHeight 2.8 ≠ the 2.6 default, so a copied constant would show up
    const design = mkDesign([rect4x3('A', { wallHeight: 2.8 })], {
      items: [
        item({
          id: 'i-spot',
          defId: 'spot',
          x: 3,
          y: 0.8,
          w: 0.12,
          d: 0.12,
          h: 0.04,
          elevation: 0.4, // deliberately wrong — the ceiling rule must win
          roomId: 'A',
          light: { on: true, intensity: 0.6, warmth: 0.55 },
        }),
      ],
    });
    const l = lightOf(design, 'i-spot');
    expect(l.kind).toBe('spot');
    // (wallHeight − 0.02) + lightLocalY(−0.04)
    expect(l.position).toEqual({ x: 3, y: 2.74, z: 0.8 });
    expect(l.coneAngleRad).toBeCloseTo(1.5, 9); // 2 × the SpotLight's 0.75 half-angle
    expect(l.coneBlend).toBeCloseTo(0.45, 9);
  });

  it('aims an unrotated spot down and toward the item front (+z world)', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-spot',
          defId: 'spot',
          w: 0.12,
          d: 0.12,
          h: 0.04,
          elevation: 2.5,
          light: { on: true, intensity: 0.7, warmth: 0.55 },
        }),
      ],
    });
    const l = lightOf(design, 'i-spot');
    // normalize(SPOT_AIM) = (0, −2.5, 0.35) / 2.5243811…
    expect(l.direction.x).toBeCloseTo(0, 9);
    expect(l.direction.y).toBeCloseTo(-0.990342, 6);
    expect(l.direction.z).toBeCloseTo(0.138648, 6);
    const len = Math.hypot(l.direction.x, l.direction.y, l.direction.z);
    expect(len).toBeCloseTo(1, 5);
    // the same vector the model constant describes, just normalized
    expect(l.direction.z / l.direction.y).toBeCloseTo(SPOT_AIM.z / SPOT_AIM.y, 6);
  });

  it('turns the spot aim by the item yaw (= −rotation)', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-spot',
          defId: 'spot',
          rotation: Math.PI / 2,
          w: 0.12,
          d: 0.12,
          h: 0.04,
          elevation: 2.5,
          light: { on: true, intensity: 0.7, warmth: 0.55 },
        }),
      ],
    });
    const l = lightOf(design, 'i-spot');
    expect(l.yawRad).toBeCloseTo(-Math.PI / 2, 6);
    // rotation +90° in plan turns the item front to world −x
    expect(l.direction.x).toBeCloseTo(-0.138648, 6);
    expect(l.direction.y).toBeCloseTo(-0.990342, 6);
    expect(l.direction.z).toBeCloseTo(0, 9);
  });

  it('gives a bar fixture the item width and a 6 cm emitter depth', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-strip',
          defId: 'strip',
          x: 0.9,
          y: 0.2,
          w: 1.4,
          d: 0.05,
          h: 0.03,
          elevation: 1.42,
          light: { on: true, intensity: 0.55, warmth: 0.7 },
        }),
      ],
    });
    const l = lightOf(design, 'i-strip');
    expect(l.kind).toBe('bar');
    expect(l.sizeX).toBeCloseTo(1.4, 9);
    expect(l.sizeY).toBeCloseTo(0.06, 9);
    expect(l.direction).toEqual({ x: 0, y: -1, z: 0 });
    // strip lightLocalY is the −0.02 default branch
    expect(l.position).toEqual({ x: 0.9, y: 1.4, z: 0.2 });
    expect(l.coneAngleRad).toBeUndefined();
  });

  it('passes an explicit colour through and omits the key otherwise', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-tinted',
          defId: 'pendant',
          h: 0.3,
          elevation: 1.85,
          light: { on: true, intensity: 0.5, warmth: 0.4, color: '#ff5522' },
        }),
        item({
          id: 'i-plain',
          defId: 'pendant',
          h: 0.3,
          elevation: 1.85,
          light: { on: true, intensity: 0.5, warmth: 0.4 },
        }),
      ],
    });
    expect(lightOf(design, 'i-tinted').colorHex).toBe('#ff5522');
    expect('colorHex' in lightOf(design, 'i-plain')).toBe(false);
  });

  it('lists a switched-off lamp with on:false rather than dropping it', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({
          id: 'i-off',
          defId: 'pendant',
          h: 0.3,
          elevation: 1.85,
          light: { on: false, intensity: 0.7, warmth: 0.75 },
        }),
      ],
    });
    const m = buildRenderManifest(design, mkInput());
    expect(m.lights).toHaveLength(1);
    expect(m.lights[0].on).toBe(false);
  });

  it('omits a light def placed without item.light, and every non-light item', () => {
    const design = mkDesign([rect4x3()], {
      items: [
        item({ id: 'i-dark', defId: 'pendant', h: 0.3, elevation: 1.85 }), // def.light, no item.light
        item({ id: 'i-cab', defId: 'base-cabinet' }), // preset part, no light at all
        item({ id: 'i-ghost', defId: 'no-such-def' }), // unresolvable def
      ],
    });
    expect(buildRenderManifest(design, mkInput()).lights).toEqual([]);
  });

  it('keeps design.items order', () => {
    const mk = (id: string, defId: string): Item =>
      item({
        id,
        defId,
        h: 0.3,
        elevation: 1.85,
        light: { on: true, intensity: 0.5, warmth: 0.5 },
      });
    const design = mkDesign([rect4x3()], {
      items: [mk('a', 'strip'), mk('b', 'pendant'), mk('c', 'spot')],
    });
    expect(buildRenderManifest(design, mkInput()).lights.map((l) => l.itemId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

/* ---------------- portals ---------------- */

function window1(wallId: string, over: Partial<Opening> = {}): Opening {
  return {
    id: 'op-1',
    wallId,
    type: 'window',
    offset: 1.5,
    width: 1.2,
    height: 1.4,
    sill: 0.9,
    ...over,
  };
}

describe('portals', () => {
  it('centres an axis-aligned window on the wall mid-thickness plane', () => {
    const design = mkDesign([rect4x3()], { openings: [window1('A-c0')] });
    const portals = portalsOf(design);
    expect(portals).toHaveLength(1);
    const p = portals[0];
    expect(p.openingId).toBe('op-1');
    expect(p.wallId).toBe('A-c0');
    expect(p.roomId).toBe('A');
    expect(p.type).toBe('window');
    // wall (0,0)→(4,0): dir (1,0), inward (0,1); exterior ⇒ zc = 0 − t/2
    expect(p.center).toEqual({ x: 1.5, y: 1.6, z: -DEFAULT_WALL_W / 2 }); // y = sill + height/2
    expect(p.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(p.tangent).toEqual({ x: 1, y: 0, z: 0 });
    expect(p.width).toBeCloseTo(1.2, 9);
    expect(p.height).toBeCloseTo(1.4, 9);
    expect(p.sill).toBeCloseTo(0.9, 9);
    expect(p.wallThickness).toBeCloseTo(DEFAULT_WALL_W, 9);
    expect(p.interior).toBe(false);
  });

  it('keeps the aperture raw — no frame inset — and reports every wall side', () => {
    // west wall of the same room: (0,3)→(0,0), dir (0,−1), inward (1,0)
    const design = mkDesign([rect4x3()], {
      openings: [window1('A-c3', { offset: 1, width: 0.9, height: 2.05, sill: 0 })],
    });
    const p = portalsOf(design)[0];
    expect(p.width).toBeCloseTo(0.9, 9);
    expect(p.height).toBeCloseTo(2.05, 9);
    expect(p.center).toEqual({ x: -DEFAULT_WALL_W / 2, y: 1.025, z: 2 });
    expect(p.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(p.tangent).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('handles a wall at 30° numerically', () => {
    const t = (30 * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const rot = ([x, y]: [number, number]): [number, number] => [x * c - y * s, x * s + y * c];
    const design = mkDesign([room('A', [rot([0, 0]), rot([4, 0]), rot([4, 3]), rot([0, 3])])], {
      openings: [window1('A-c0')],
    });
    const p = portalsOf(design)[0];
    // a + dir·1.5 + inward·(−t/2), dir = (cos30, sin30), inward = (−sin30, cos30)
    const h = DEFAULT_WALL_W / 2;
    expect(p.center.x).toBeCloseTo(1.5 * Math.cos(Math.PI / 6) + h * Math.sin(Math.PI / 6), 6);
    expect(p.center.y).toBeCloseTo(1.6, 9);
    expect(p.center.z).toBeCloseTo(1.5 * Math.sin(Math.PI / 6) - h * Math.cos(Math.PI / 6), 6);
    expect(p.normal.x).toBeCloseTo(-0.5, 6);
    expect(p.normal.z).toBeCloseTo(0.866025, 6);
    expect(p.tangent.x).toBeCloseTo(0.866025, 6);
    expect(p.tangent.z).toBeCloseTo(0.5, 6);
    expect(p.normal.y).toBe(0);
    expect(p.tangent.y).toBe(0);
  });

  it('emits a shared-partition opening exactly once, interior, on the owner side', () => {
    // A and B are 4×3 rectangles meeting on x = 4 — the same coincident-and-
    // reversed pair rooms.test.ts welds; rooms[0] (A) owns the partition.
    const A = rect4x3('A');
    const B = room('B', [
      [4, 0],
      [8, 0],
      [8, 3],
      [4, 3],
    ]);
    const design = mkDesign([A, B], {
      openings: [
        {
          id: 'op-door',
          wallId: 'A-c1', // A's east edge (4,0)→(4,3)
          type: 'door',
          offset: 1.5,
          width: 0.9,
          height: 2.05,
          sill: 0,
        },
      ],
    });
    const portals = portalsOf(design);
    expect(portals).toHaveLength(1);
    const p = portals[0];
    expect(p.wallId).toBe('A-c1');
    expect(p.roomId).toBe('A');
    expect(p.type).toBe('door');
    expect(p.interior).toBe(true);
    // shared ⇒ faceOffset = t/2 ⇒ zc = 0: the aperture sits ON the polygon edge
    expect(p.center).toEqual({ x: 4, y: 1.025, z: 1.5 });
    expect(p.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(p.tangent).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('mirrors an opening stored on the NON-owner side into the owner frame', () => {
    const A = rect4x3('A');
    const B = room('B', [
      [4, 0],
      [8, 0],
      [8, 3],
      [4, 3],
    ]);
    const design = mkDesign([A, B], {
      openings: [
        {
          id: 'op-door',
          wallId: 'B-c3', // B's west edge (4,3)→(4,0) — the non-owner twin
          type: 'door',
          offset: 1,
          width: 0.9,
          height: 2.05,
          sill: 0,
        },
      ],
    });
    const portals = portalsOf(design);
    expect(portals).toHaveLength(1);
    const p = portals[0];
    expect(p.openingId).toBe('op-door');
    expect(p.wallId).toBe('A-c1'); // re-keyed onto the drawn side
    expect(p.interior).toBe(true);
    // mirrored offset = twinLen − offset = 3 − 1
    expect(p.center).toEqual({ x: 4, y: 1.025, z: 2 });
  });

  it('sorts the openings of one wall along it', () => {
    const design = mkDesign([rect4x3()], {
      openings: [
        window1('A-c0', { id: 'far', offset: 3 }),
        window1('A-c0', { id: 'near', offset: 0.8 }),
      ],
    });
    expect(portalsOf(design).map((p) => p.openingId)).toEqual(['near', 'far']);
  });

  it('drops an opening whose wall resolves nowhere', () => {
    const design = mkDesign([rect4x3()], { openings: [window1('nope')] });
    expect(portalsOf(design)).toEqual([]);
  });
});

/* ---------------- sky ---------------- */

describe('sky', () => {
  it('mirrors skyState by day and derives the sun direction from it', () => {
    const design = mkDesign([rect4x3()]);
    const { sky } = buildRenderManifest(design, mkInput());
    const s = skyState(135, 35, false);
    expect(sky.azimuthDeg).toBe(135);
    expect(sky.elevationDeg).toBe(35);
    expect(sky.night).toBe(false);
    expect(sky.viewport).toEqual({
      sunColor: s.sunColor,
      sunIntensity: s.sunIntensity,
      ambientColor: s.ambientColor,
      ambientIntensity: s.ambientIntensity,
      background: s.background,
    });
    // (sin az·cos el, sin el, cos az·cos el) — relight's own placement formula
    expect(sky.sunDirection.x).toBeCloseTo(0.579228, 6);
    expect(sky.sunDirection.y).toBeCloseTo(0.573576, 6);
    expect(sky.sunDirection.z).toBeCloseTo(-0.579228, 6);
    const len = Math.hypot(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z);
    expect(len).toBeCloseTo(1, 6);
  });

  it('saturates daylight at a high sun: lamps stay gated off', () => {
    const { sky } = buildRenderManifest(mkDesign([rect4x3()]), mkInput());
    expect(sky.daylight).toBe(1);
    expect(sky.lampBoost).toBe(0);
  });

  it('fades lamps in through dusk (daylight = ambient / AMBIENT_DAY)', () => {
    const design = mkDesign([rect4x3()], {
      scene: { sunAzimuth: 260, sunElevation: 5, brightness: 1, night: false },
    });
    const { sky } = buildRenderManifest(design, mkInput());
    const s = skyState(260, 5, false);
    const daylight = Math.min(1, s.ambientIntensity / AMBIENT_DAY);
    expect(sky.daylight).toBeCloseTo(daylight, 6);
    expect(sky.daylight).toBeCloseTo(0.633333, 6);
    expect(sky.lampBoost).toBeCloseTo(1.44 * (1 - daylight), 6);
    expect(sky.lampBoost).toBeCloseTo(0.528, 6);
  });

  it('parks the night sun below the horizon and lifts the lamp gate', () => {
    const design = mkDesign([rect4x3()], {
      scene: { sunAzimuth: 135, sunElevation: 35, brightness: 0.8, night: true },
    });
    const { sky } = buildRenderManifest(design, mkInput());
    const s = skyState(135, 35, true);
    expect(sky.night).toBe(true);
    // the stored angles survive; only the DERIVED direction goes below the horizon
    expect(sky.elevationDeg).toBe(35);
    expect(sky.sunDirection.y).toBeCloseTo(Math.sin(-8 * (Math.PI / 180)), 6);
    expect(sky.sunDirection.y).toBeCloseTo(-0.139173, 6);
    expect(sky.viewport.ambientIntensity).toBe(s.ambientIntensity);
    expect(sky.daylight).toBeCloseTo(0.2, 6);
    expect(sky.lampBoost).toBeCloseTo(1.152, 6);
  });

  it('passes brightness through untouched (it is a master scale, not a light)', () => {
    const design = mkDesign([rect4x3()], {
      scene: { sunAzimuth: 10, sunElevation: 60, brightness: 1.6, night: false },
    });
    expect(buildRenderManifest(design, mkInput()).sky.brightness).toBe(1.6);
  });
});

/* ---------------- rooms ---------------- */

describe('rooms', () => {
  it('reports area, centroid and shell dimensions of a known rectangle', () => {
    const design = mkDesign([rect4x3('A', { wallHeight: 2.75, wallThickness: 0.12 })]);
    const { rooms } = buildRenderManifest(design, mkInput());
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toEqual({
      id: 'A',
      name: 'A',
      wallHeight: 2.75,
      wallThickness: 0.12,
      floorAreaM2: 12,
      centroid: { x: 2, y: 0, z: 1.5 },
    });
  });

  it('keeps every room, in design order, and skips degenerate rings', () => {
    const design = mkDesign([
      rect4x3('A'),
      room('B', [
        [4, 0],
        [8, 0],
        [8, 3],
        [4, 3],
      ]),
      room('C', [
        [0, 10],
        [1, 10],
      ]),
    ]);
    const { rooms } = buildRenderManifest(design, mkInput());
    expect(rooms.map((r) => r.id)).toEqual(['A', 'B']);
    expect(rooms[1].centroid).toEqual({ x: 6, y: 0, z: 1.5 });
  });
});

/* ---------------- determinism ---------------- */

describe('determinism', () => {
  it('is a pure function of (design, input) once `now` is pinned', () => {
    const build = (): ReturnType<typeof buildRenderManifest> =>
      buildRenderManifest(kitchenMinDesign(), kitchenMinInput());
    expect(build()).toEqual(build());
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('never leaks −0 into a vector (JSON prints 0, deep-equals does not)', () => {
    const design = mkDesign([rect4x3()], {
      openings: [window1('A-c2')], // north edge (4,3)→(0,3): dir (−1,0), inward (0,−1)
      items: [
        item({
          id: 'i-spot',
          defId: 'spot',
          rotation: Math.PI, // yaw = −π; cos = −1, sin ≈ −1.2e−16
          light: { on: true, intensity: 0.7, warmth: 0.55 },
        }),
      ],
    });
    const m = buildRenderManifest(design, mkInput());
    const zeros = [
      m.portals[0].normal.x, // inward.x = −dir.y = −0 on a due-west wall
      m.portals[0].tangent.y,
      m.lights[0].direction.x, // aim.z × sin(−π) = −1.7e−17
      m.lights[0].yawRad + Math.PI, // yaw = −π exactly
    ];
    for (const v of zeros) expect(Object.is(v, -0)).toBe(false);
    expect(m.portals[0].normal.x).toBe(0);
    expect(m.lights[0].direction.x).toBe(0);
  });
});

/* ---------------- golden ---------------- */

/**
 * One rectangular kitchen: a window on the south wall, an oak base cabinet,
 * and all three fixture kinds. Small enough to read in a diff, wide enough
 * that every derivation in the builder shows up in the file.
 */
function kitchenMinDesign(): Design {
  const kitchen = room('room-kitchen', [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]);
  kitchen.name = 'Kitchen';
  return mkDesign([kitchen], {
    openings: [
      {
        id: 'op-window',
        wallId: 'room-kitchen-c0',
        type: 'window',
        offset: 2,
        width: 1.4,
        height: 1.2,
        sill: 0.95,
      },
    ],
    items: [
      item({
        id: 'it-cabinet',
        defId: 'base-cabinet',
        x: 0.9,
        y: 0.3,
        rotation: 0,
        w: 0.6,
        d: 0.6,
        h: 0.9,
        elevation: 0,
        color: OAK,
        roomId: 'room-kitchen',
      }),
      item({
        id: 'it-pendant',
        defId: 'pendant',
        x: 2,
        y: 1.5,
        w: 0.35,
        d: 0.35,
        h: 0.3,
        elevation: 1.85,
        color: '#3f3e3b',
        roomId: 'room-kitchen',
        light: { on: true, intensity: 0.7, warmth: 0.75 },
      }),
      item({
        id: 'it-spot',
        defId: 'spot',
        x: 3.2,
        y: 0.7,
        rotation: Math.PI / 4,
        w: 0.12,
        d: 0.12,
        h: 0.04,
        elevation: 2.5,
        color: '#e8e6e1',
        roomId: 'room-kitchen',
        light: { on: true, intensity: 0.65, warmth: 0.55, color: '#ffd9a8' },
      }),
      item({
        id: 'it-strip',
        defId: 'strip',
        x: 0.9,
        y: 0.12,
        w: 1.2,
        d: 0.05,
        h: 0.03,
        elevation: 1.42,
        color: '#f4f2ea',
        roomId: 'room-kitchen',
        light: { on: false, intensity: 0.55, warmth: 0.7 },
      }),
    ],
    scene: { sunAzimuth: 135, sunElevation: 35, brightness: 1, night: false },
  });
}

function kitchenMinInput(): ManifestInput {
  return {
    camera: CAMERA,
    materials: MATERIALS,
    render: RENDER,
    appVersion: '0.0.0-golden',
    now: new Date('2026-08-18T00:00:00Z'),
  };
}

/** Repo-relative — vitest runs with the repo root as its cwd. */
const GOLDEN_DIR = 'render/manifest/examples';
const GOLDEN_PATH = `${GOLDEN_DIR}/kitchen-min.json`;

interface NodeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readFileSync(path: string, enc: 'utf8'): string;
  writeFileSync(path: string, data: string, enc: 'utf8'): void;
}

/** `@types/node` is not a dependency here, so the specifier is computed (which
 *  makes tsc hand back `any`) and the shape asserted locally instead. */
const nodeFs = async (): Promise<NodeFs> =>
  (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as NodeFs;

const updateGolden = (): boolean =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.UPDATE_GOLDEN === '1';

describe('golden manifest', () => {
  it('matches render/manifest/examples/kitchen-min.json', async () => {
    const built = buildRenderManifest(kitchenMinDesign(), kitchenMinInput());
    if (updateGolden()) {
      const fs = await nodeFs();
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
      // the file just written IS the new baseline; re-run without the flag to
      // compare against the checked-in one
      expect(JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'))).toEqual(built);
      return;
    }
    expect(built).toEqual(goldenManifest);
  });

  it('covers all three fixture kinds and one exterior window', () => {
    const m = buildRenderManifest(kitchenMinDesign(), kitchenMinInput());
    expect(m.lights.map((l) => l.kind)).toEqual(['point', 'spot', 'bar']);
    expect(m.portals).toHaveLength(1);
    expect(m.portals[0].interior).toBe(false);
    expect(m.rooms).toHaveLength(1);
  });
});
