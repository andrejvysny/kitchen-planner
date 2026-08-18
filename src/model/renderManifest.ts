/**
 * Render manifest v1 — the sidecar that travels with the render-package GLB
 * and tells the Blender worker everything glTF cannot carry: the framed
 * camera, the sun/sky state, every fixture light in world space, the window
 * apertures (light portals), and the semantic identity of every material in
 * the GLB (render/worker consumes it; render/manifest/manifest.schema.json is
 * the JSON Schema twin).
 *
 * Pure model code. Everything derived from the Design (sky, lights, portals,
 * rooms) is computed here, mirroring View3D's transforms exactly; everything
 * only the view layer knows (camera pose, canonicalized material list, output
 * size) arrives as `ManifestInput`. All vectors are in the glTF/three world
 * frame — x right, y UP, z toward the viewer; the worker converts to
 * Blender's Z-up (`(x, y, z) → (x, −z, y)`).
 */

import { defOfDesign } from './attach';
import { itemBaseY, lightLocalY, SPOT_AIM } from './catalog';
import { polygonCentroid } from './geometry';
import { allWalls, openingsOfWall, roomArea } from './rooms';
import { AMBIENT_DAY, skyState } from './sky';
import type { Design } from './types';

export const MANIFEST_VERSION = 1;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ManifestCamera {
  /** glTF/three world frame: x right, y UP, z toward the viewer. */
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** VERTICAL fov in degrees (three PerspectiveCamera.fov). */
  fovYDeg: number;
  /** Aspect (w/h) of the viewport the pose was captured from. */
  viewportAspect: number;
  nearM: number;
  farM: number;
}

export interface ManifestSky {
  /** Scene.sunAzimuth — degrees, 0 = +z, increasing toward +x. */
  azimuthDeg: number;
  /** Scene.sunElevation — degrees above the horizon. */
  elevationDeg: number;
  night: boolean;
  /** Scene.brightness, 0..2 — the single master level. */
  brightness: number;
  /** Unit vector FROM the scene TOWARD the sun, world frame. */
  sunDirection: Vec3;
  /** 1 at full day → 0 at night: min(1, ambientIntensity / AMBIENT_DAY). */
  daylight: number;
  /** Fixture-lamp gate the viewport applies: 1.44 × (1 − daylight). */
  lampBoost: number;
  /** What the viewport shows — parity diagnostics only; the worker derives
   *  its own physical sky from azimuth/elevation. */
  viewport: {
    sunColor: string;
    sunIntensity: number;
    ambientColor: string;
    ambientIntensity: number;
    background: string;
  };
}

export type LightKind = 'point' | 'spot' | 'bar';

export interface ManifestLight {
  itemId: string;
  defId: string;
  kind: LightKind;
  on: boolean;
  /** 0..1 UI slider (LightProps.intensity). */
  intensity: number;
  /** 0 = cool white, 1 = warm candle. */
  warmth: number;
  /** Explicit hex; wins over warmth-derived colour. */
  colorHex?: string;
  /** Emitter position, world frame: itemBaseY + lightLocalY, item yaw applied. */
  position: Vec3;
  /** Unit aim direction, world frame ((0,−1,0) for point/bar). */
  direction: Vec3;
  /** Spot only: FULL cone angle (rad), mirroring the viewport SpotLight. */
  coneAngleRad?: number;
  /** Spot only: penumbra blend 0..1. */
  coneBlend?: number;
  /** Bar only: emitter rectangle (m); x = the item's width axis. */
  sizeX?: number;
  sizeY?: number;
  /** World yaw of the item group (= −item.rotation), for rectangle emitters. */
  yawRad: number;
}

export interface ManifestPortal {
  openingId: string;
  wallId: string;
  roomId: string;
  type: 'door' | 'window';
  /** Aperture centre on the wall mid-thickness plane, world frame. */
  center: Vec3;
  /** Raw aperture size (m) — frames NOT subtracted; the worker insets. */
  width: number;
  height: number;
  /** Room-inward unit normal (y = 0). */
  normal: Vec3;
  /** Unit vector along the wall a→b (y = 0). */
  tangent: Vec3;
  wallThickness: number;
  sill: number;
  /** True on a shared partition (interior opening — no daylight portal). */
  interior: boolean;
}

export type ManifestMaterialKind = 'library' | 'plain' | 'shell' | 'product';

export interface ManifestMaterial {
  /** Exact glTF material name; Blender may append ".001". */
  name: string;
  kind: ManifestMaterialKind;
  /** kind 'library' / 'shell': src/model/materials.ts id. */
  matId?: string;
  /** Final sRGB hex shown in the viewport (tint already folded in). */
  baseColorHex: string;
  rot: boolean;
  /** kind 'plain': which flat finish it stood in for. */
  fallback?: 'matte' | 'wood';
  /** kind 'shell'. */
  surface?: 'wall' | 'floor' | 'ceiling';
  /** kind 'product'. */
  product?: string;
  /** Meshes in the GLB carrying it (diagnostics). */
  meshCount: number;
}

export type RenderTier = 'preview' | 'final';

export interface ManifestRender {
  widthPx: number;
  heightPx: number;
  tier: RenderTier;
  /** The worker fits the sensor VERTICALLY, so fovYDeg survives any aspect. */
  sensorFit: 'vertical';
}

export interface ManifestRoom {
  id: string;
  name: string;
  wallHeight: number;
  wallThickness: number;
  floorAreaM2: number;
  /** Plan centroid in world frame, y = 0 — an "aim here" hint. */
  centroid: Vec3;
}

export interface RenderManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  /** Design.version at export time (6 today). */
  designVersion: number;
  /** package.json version of the app that wrote it. */
  appVersion: string;
  exportedAt: string; // ISO-8601
  units: 'm';
  /** The frame EVERY vector in this file is expressed in. */
  axis: 'gltf-y-up';
  files: { glb: string; design: string };
  camera: ManifestCamera;
  sky: ManifestSky;
  lights: ManifestLight[];
  portals: ManifestPortal[];
  materials: ManifestMaterial[];
  render: ManifestRender;
  rooms: ManifestRoom[];
}

export interface ManifestInput {
  camera: ManifestCamera;
  materials: ManifestMaterial[];
  render: ManifestRender;
  appVersion: string;
  /** Injectable for deterministic golden tests. */
  now?: Date;
}

/* ---------------- viewport constants mirrored from View3D ---------------- */

/** Package-relative file names; the zip writer uses the same two. */
const GLB_FILE = 'scene.glb';
const DESIGN_FILE = 'design.json';

/**
 * FULL cone angle of a ceiling spot. `View3D.buildItem` constructs
 * `new THREE.SpotLight(color, 0, 8, 0.75, 0.45, 1.4)` and three's `angle` is
 * the HALF angle from the axis, so the full aperture is twice it.
 */
const SPOT_CONE_RAD = 0.75 * 2;
/** SpotLight penumbra from the same constructor call. */
const SPOT_BLEND = 0.45;
/** RectAreaLight height of the LED strip (`new RectAreaLight(c, 0, item.w, 0.06)`). */
const BAR_SIZE_Y = 0.06;

/* ---------------- numeric helpers ---------------- */

/**
 * Micron / microradian resolution. Enough for any geometry the worker cares
 * about, and it makes the checked-in golden manifest byte-stable across
 * platforms and JS engines. Folding −0 to 0 matters too: `JSON.stringify`
 * prints `0` for it while `Object.is` (and therefore vitest's deep equality)
 * treats the two as different, so an unfolded −0 would fail its own golden.
 */
function round6(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

const vec3 = (x: number, y: number, z: number): Vec3 => ({
  x: round6(x),
  y: round6(y),
  z: round6(z),
});

/* ---------------- sky ---------------- */

/**
 * Mirrors `View3D.relight()`: `skyState` drives everything, the sun direction
 * is the same spherical formula that positions the DirectionalLight (there
 * scaled by SUN_RADIUS around the plan centroid — here the unit vector, which
 * is all a physical sky lamp needs), and `daylight` / the 1.44 lamp gate are
 * copied expression for expression.
 */
function manifestSky(design: Design): ManifestSky {
  const scene = design.scene;
  const sky = skyState(scene.sunAzimuth, scene.sunElevation, scene.night);
  const daylight = Math.min(1, sky.ambientIntensity / AMBIENT_DAY);
  return {
    azimuthDeg: scene.sunAzimuth,
    elevationDeg: scene.sunElevation,
    night: scene.night,
    brightness: scene.brightness,
    sunDirection: vec3(
      Math.sin(sky.azimuth) * Math.cos(sky.elevation),
      Math.sin(sky.elevation),
      Math.cos(sky.azimuth) * Math.cos(sky.elevation)
    ),
    daylight: round6(daylight),
    // relight: `const boost = 1.44 * nightness` with `nightness = 1 - daylight`
    lampBoost: round6(1.44 * (1 - daylight)),
    viewport: {
      sunColor: sky.sunColor,
      sunIntensity: sky.sunIntensity,
      ambientColor: sky.ambientColor,
      ambientIntensity: sky.ambientIntensity,
      background: sky.background,
    },
  };
}

/* ---------------- lights ---------------- */

/**
 * `SPOT_AIM` normalized and turned by the item's world yaw. The rotation is
 * three's own Y convention (`Object3D.rotation.y = yaw` ⇒
 * `x' = x·cos + z·sin`, `z' = −x·sin + z·cos`), and `View3D.placeItem` sets
 * `group.rotation.y = -item.rotation`, so passing `yaw = −item.rotation` here
 * reproduces exactly where the viewport's spot target ends up.
 */
function spotDirection(yaw: number): Vec3 {
  const len = Math.hypot(SPOT_AIM.x, SPOT_AIM.y, SPOT_AIM.z);
  const x = SPOT_AIM.x / len;
  const y = SPOT_AIM.y / len;
  const z = SPOT_AIM.z / len;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return vec3(x * c + z * s, y, -x * s + z * c);
}

/**
 * Every fixture the viewport lights the scene with — the same gate
 * `View3D.buildItem` / `relight` apply: a resolvable def carrying
 * `def.light`, on an item carrying `item.light`. A lamp switched off is still
 * listed (with `on: false`) so the worker can report it; an item whose def has
 * no light, or a light def placed without `item.light`, emits nothing.
 *
 * The emitter sits at item-local `(0, lightLocalY, 0)`, so the item's yaw
 * never moves it — only the spot's aim turns.
 */
function manifestLights(design: Design): ManifestLight[] {
  const out: ManifestLight[] = [];
  for (const item of design.items) {
    const def = defOfDesign(design, item.defId);
    const lp = item.light;
    if (!def?.light || !lp) continue;
    const kind: LightKind = def.light.kind;
    const yaw = -item.rotation;
    out.push({
      itemId: item.id,
      defId: item.defId,
      kind,
      on: lp.on,
      intensity: lp.intensity,
      warmth: lp.warmth,
      ...(lp.color ? { colorHex: lp.color } : {}),
      position: vec3(item.x, itemBaseY(design, item, def) + lightLocalY(def, item), item.y),
      direction: kind === 'spot' ? spotDirection(yaw) : { x: 0, y: -1, z: 0 },
      ...(kind === 'spot' ? { coneAngleRad: SPOT_CONE_RAD, coneBlend: SPOT_BLEND } : {}),
      ...(kind === 'bar' ? { sizeX: item.w, sizeY: BAR_SIZE_Y } : {}),
      yawRad: round6(yaw),
    });
  }
  return out;
}

/* ---------------- portals ---------------- */

/**
 * One entry per aperture, in wall order then along each wall.
 *
 * A partition is described ONCE, by the twin that owns it — the same
 * `w.shared && !w.shared.owner` skip `View3D.buildRooms` uses — and
 * `openingsOfWall` folds the other side's openings in mirrored, so a door
 * stored against the non-owner wall still emits exactly once, in the owner's
 * frame.
 *
 * `zc` is the wall-local mid-thickness offset `buildRooms` computes and
 * `buildOpening` positions its group at: `g.position.set(o.offset, 0, zc)`,
 * inside a group at `wall.a` rotated by `-wall.angle`. Room corners are the
 * room-side wall FACE, so for an exterior wall (`faceOffset` 0) the slab —
 * and the aperture centre with it — hangs `thickness / 2` OUTSIDE the
 * polygon, while a shared partition (`faceOffset = thickness / 2`) straddles
 * it and lands `zc = 0`.
 */
function manifestPortals(design: Design): ManifestPortal[] {
  const out: ManifestPortal[] = [];
  for (const wall of allWalls(design.rooms)) {
    if (wall.shared && !wall.shared.owner) continue;
    const zc = wall.faceOffset - wall.thickness / 2;
    const openings = openingsOfWall(design, wall).sort((a, b) => a.offset - b.offset);
    for (const o of openings) {
      // plan (x, y) → world (x, z); the wall group's rotation makes local +x
      // the wall direction and local +z the inward normal
      const cx = wall.a.x + wall.dir.x * o.offset + wall.inward.x * zc;
      const cy = wall.a.y + wall.dir.y * o.offset + wall.inward.y * zc;
      out.push({
        openingId: o.id,
        wallId: wall.id,
        roomId: wall.roomId,
        type: o.type,
        center: vec3(cx, o.sill + o.height / 2, cy),
        width: o.width,
        height: o.height,
        normal: vec3(wall.inward.x, 0, wall.inward.y),
        tangent: vec3(wall.dir.x, 0, wall.dir.y),
        wallThickness: wall.thickness,
        sill: o.sill,
        interior: wall.shared !== null,
      });
    }
  }
  return out;
}

/* ---------------- rooms ---------------- */

/** Degenerate rings are skipped, exactly as `View3D.buildRooms` skips them. */
function manifestRooms(design: Design): ManifestRoom[] {
  const out: ManifestRoom[] = [];
  for (const room of design.rooms) {
    if (room.corners.length < 3) continue;
    const c = polygonCentroid(room.corners);
    out.push({
      id: room.id,
      name: room.name,
      wallHeight: room.style.wallHeight,
      wallThickness: room.style.wallThickness,
      floorAreaM2: round6(roomArea(room)),
      centroid: vec3(c.x, 0, c.y),
    });
  }
  return out;
}

/* ---------------- entry point ---------------- */

/**
 * The whole manifest. Everything the Design determines is derived here;
 * `camera`, `materials` and `render` are the view layer's to know and pass
 * through untouched. `input.now` exists so the golden test can pin
 * `exportedAt` — with it, this function is a pure function of its arguments.
 */
export function buildRenderManifest(design: Design, input: ManifestInput): RenderManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    designVersion: design.version,
    appVersion: input.appVersion,
    exportedAt: (input.now ?? new Date()).toISOString(),
    units: 'm',
    axis: 'gltf-y-up',
    files: { glb: GLB_FILE, design: DESIGN_FILE },
    camera: input.camera,
    sky: manifestSky(design),
    lights: manifestLights(design),
    portals: manifestPortals(design),
    materials: input.materials,
    render: input.render,
    rooms: manifestRooms(design),
  };
}
