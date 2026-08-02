import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { CatalogDef } from '../model/catalog';
import { polygonCentroid, wallPoint } from '../model/geometry';
import { applianceHosting, findHost } from '../model/attach';
import type { HostContext } from '../model/panels';
import { snapItem } from '../model/snapping';
import { openingsOfWall, styleOfItem } from '../model/rooms';
import type { Store } from '../model/store';
import type { Corner, Item, Opening, Point } from '../model/types';
import { AMBIENT_DAY, skyState } from '../model/sky';
import { resolveFinish } from '../model/variables';
import { buildItemGroup, lightLocalY, shade } from './itemMeshes';
import { collectMotionUnits, setFrontPoses, stepFrontPoses, withClosedPoses } from './partMeshes';
import { scaleBoxUV, surfMat } from './meshKit';
import { resolveDevice } from '../model/navPref';
import { isMac, wheelGesture, type WheelLike } from './wheelInput';

export type CamPreset = 'corner' | 'top' | 'front' | 'inside';

type FixtureLight = THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;

interface ItemEntry {
  group: THREE.Group;
  light: FixtureLight | null;
  bulbs: THREE.Mesh[];
  /** motion-unit pivot groups (doors/drawers) for the open-front pose pass */
  units: THREE.Group[];
}

interface WallEntry {
  id: string; // wall id = start corner id; keys wallVisibility overrides
  /** room whose wallVisibility map owns this wall (the owner side of a partition) */
  roomId: string;
  /** the room on the other side of a partition; null for exterior walls */
  twinRoomId: string | null;
  group: THREE.Group;
  inward: THREE.Vector3;
  mid: THREE.Vector3;
  height: number;
}

interface CeilingEntry {
  roomId: string;
  mesh: THREE.Mesh;
  height: number;
}

const SHADOW_LIGHT_BUDGET = 4;
/** how far from the room centroid the directional "sun" sits */
const SUN_RADIUS = 10;
/** fixed ACES tone-mapping exposure — no user control */
const EXPOSURE = 1.05;
/** IBL fill level at full day — low, so the flat env glow can't wash out the sun */
const ENV_FILL = 0.45;

const LIGHT_COOL = new THREE.Color('#dfeaff');
const LIGHT_WARM = new THREE.Color('#ffb46b');
const scratchColor = new THREE.Color();

// Trackpad-navigation tuning + scratch (see onWheel / wheelInput.ts).
const WHEEL_ZOOM_STEP = 1 / 0.95; // radius factor per mouse-wheel notch
const PINCH_ZOOM_RATE = 0.01; // radius = radius * exp(deltaY * rate) for pinch
const TRACKPAD_ORBIT_SPEED = 0.6; // damp two-finger orbit vs a mouse drag
const navOffset = new THREE.Vector3();
const navMove = new THREE.Vector3();
const navRight = new THREE.Vector3();
const navUp = new THREE.Vector3();
const navSpherical = new THREE.Spherical();

/** Shared scratch — consumers must copy() the result, never keep the reference. */
function lightColor(warmth: number): THREE.Color {
  return scratchColor.copy(LIGHT_COOL).lerp(LIGHT_WARM, warmth);
}

export class View3D {
  private store: Store;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private gizmo!: TransformControls;
  private raycaster = new THREE.Raycaster();

  private roomGroup = new THREE.Group();
  private itemsGroup = new THREE.Group();
  private walls: WallEntry[] = [];
  private ceilings: CeilingEntry[] = [];
  private camRoomAt: Point = { x: Infinity, y: Infinity };
  private camRoomId: string | null = null;
  private items = new Map<string, ItemEntry>();

  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private pmrem: THREE.PMREMGenerator;
  private bg = new THREE.Color();
  private sunDir = new THREE.Vector3();

  private downPos = new THREE.Vector2();
  private lastTintedId: string | null = null;
  private scratchToCam = new THREE.Vector3();
  private readonly isMac = isMac(navigator.platform, navigator.userAgent);

  private getArmed: () => CatalogDef | null;
  private clearArmed: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    store: Store,
    opts: { getArmed: () => CatalogDef | null; clearArmed: () => void }
  ) {
    this.store = store;
    this.getArmed = opts.getArmed;
    this.clearArmed = opts.clearArmed;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // area lights (LED strip) need their LTC lookup tables initialised once
    RectAreaLightUniformsLib.init();
    // procedural image-based environment for reflections + soft fill (no asset files)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.initEnvironment();

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 120);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.35;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 30;
    // Middle-drag orbits, Shift+middle-drag pans. OrbitControls' ROTATE action
    // already swaps to pan while Shift is held, so one mapping covers both; the
    // default (MIDDLE = DOLLY) also did nothing on macOS, where enableZoom is
    // off because onWheel() owns the dolly.
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;

    this.hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a8', 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.roomGroup);
    this.scene.add(this.itemsGroup);

    const parent = canvas.parentElement!;
    new ResizeObserver(() => this.resize()).observe(parent);
    this.resize();

    store.on('change', (info) => {
      if (info.structural) this.rebuild();
      else this.softUpdate();
    });
    store.on('selection', () => this.applySelectionTint());
    store.on('pose', () => this.applyFrontPoses());

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));

    // MacBook trackpad navigation: take over the wheel so two-finger swipe pans,
    // +Shift orbits, and pinch zooms. Mouse (drag + wheel) keeps OrbitControls'
    // defaults, so this is macOS-only to avoid touching other platforms.
    if (this.isMac) {
      this.controls.enableZoom = false; // wheel dolly handled in onWheel()
      canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    }

    this.initGizmo(canvas);

    this.rebuild();
    this.setPreset('corner');
    this.animate();
  }

  /* ---------------- sizing / loop ---------------- */

  private resize(): void {
    const parent = this.renderer.domElement.parentElement!;
    const w = parent.clientWidth || 100;
    const h = parent.clientHeight || 100;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.updateWallVisibility();
    for (const entry of this.items.values()) {
      if (entry.units.length) stepFrontPoses(entry.units);
    }
    this.renderer.render(this.scene, this.camera);
  };

  private updateWallVisibility(): void {
    const camPos = this.camera.position;
    // read the live Room objects: visibility edits are non-structural, so they
    // mutate in place without a rebuild
    const rooms = this.store.design.rooms;
    const camRoom = this.cameraRoomId();
    for (const w of this.walls) {
      const mode = rooms.find((r) => r.id === w.roomId)?.wallVisibility?.[w.id] ?? 'auto';
      if (mode === 'show' || mode === 'hide') {
        w.group.visible = mode === 'show';
        continue;
      }
      const toCam = this.scratchToCam.subVectors(camPos, w.mid);
      toCam.y = 0;
      toCam.normalize();
      const facing = w.inward.dot(toCam) > -0.25;
      // a partition stays up while the camera is in either of its rooms or
      // looking down from above — hiding it would merge the rooms visually
      w.group.visible = w.twinRoomId
        ? camRoom === w.roomId || camRoom === w.twinRoomId || camPos.y > w.height || facing
        : facing;
    }
    for (const c of this.ceilings) {
      const mode = rooms.find((r) => r.id === c.roomId)?.ceilingVisibility ?? 'auto';
      c.mesh.visible = mode === 'auto' ? camPos.y < c.height - 0.05 : mode === 'show';
    }
  }

  /** Which room the camera stands in (plan xz), re-resolved after >1 cm moves. */
  private cameraRoomId(): string | null {
    const p = this.camera.position;
    if (Math.abs(p.x - this.camRoomAt.x) > 0.01 || Math.abs(p.z - this.camRoomAt.y) > 0.01) {
      this.camRoomAt = { x: p.x, y: p.z };
      this.camRoomId = this.store.roomContaining(this.camRoomAt)?.id ?? null;
    }
    return this.camRoomId;
  }

  /* ---------------- camera presets ---------------- */

  setPreset(p: CamPreset): void {
    const corners = this.allCorners();
    const c = polygonCentroid(corners);
    const xs = corners.map((k) => k.x);
    const ys = corners.map((k) => k.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const span = Math.max(spanX, spanY, 3);
    const H = this.store.activeStyle().wallHeight;

    const set = (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
      this.camera.position.set(px, py, pz);
      this.controls.target.set(tx, ty, tz);
      this.controls.update();
    };
    switch (p) {
      case 'corner':
        set(c.x + span * 0.95, H * 1.25, c.y + span * 1.15, c.x, 0.7, c.y);
        break;
      case 'top':
        set(c.x, span * 2.1, c.y + 0.02, c.x, 0, c.y);
        break;
      case 'front':
        set(c.x, 1.35, Math.max(...ys) + span * 1.05, c.x, 1.0, c.y);
        break;
      case 'inside': {
        // step into the ACTIVE room, not the centroid of the whole design
        const rc = this.store.activeRoom().corners;
        const ci = polygonCentroid(rc);
        const ry = rc.map((k) => k.y);
        const rSpanY = Math.max(Math.max(...ry) - Math.min(...ry), 1.5);
        set(ci.x + 0.4, 1.55, ci.y + rSpanY * 0.28, ci.x, 1.25, ci.y - rSpanY * 0.6);
        break;
      }
    }
  }

  /** Every room's corner ring, flattened — camera framing and sun span. */
  private allCorners(): Corner[] {
    return this.store.design.rooms.flatMap((r) => r.corners);
  }

  /* ---------------- scene building ---------------- */

  private disposeGroup(root: THREE.Object3D): void {
    root.traverse((o) => {
      if ((o as THREE.Light).isLight) (o as THREE.Light).dispose(); // frees shadow-map render targets
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
  }

  rebuild(): void {
    this.disposeGroup(this.roomGroup);
    this.roomGroup.clear();
    this.disposeGroup(this.itemsGroup);
    this.itemsGroup.clear();
    this.items.clear();
    this.walls = [];
    this.ceilings = [];

    this.buildRooms();
    // one hosting pass per rebuild: cutouts/niches appliances impose on hosts
    const hosting = applianceHosting(this.store.design);
    for (const item of this.store.design.items) this.buildItem(item, hosting.get(item.id));
    this.relight();
    this.applySelectionTint();
  }

  private buildRooms(): void {
    const design = this.store.design;
    if (!design.rooms.length) return;

    // ground catches shadows around the rooms
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: '#c8c9c4', roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.012;
    ground.receiveShadow = true;
    ground.name = 'Ground';
    this.roomGroup.add(ground);

    const walls = this.store.allWalls();
    let wallIdx = 0;
    for (const room of design.rooms) {
      const corners = room.corners;
      if (corners.length < 3) continue;
      const style = room.style;
      const H = style.wallHeight;

      // floor — ShapeGeometry UVs are the plan coords in meters, so shared
      // material textures (repeat = 1/tile) land at real-world scale directly
      const shape = new THREE.Shape(corners.map((p) => new THREE.Vector2(p.x, p.y)));
      const floorFin = resolveFinish(design, style.floorColor, style.floorMaterial, style.floorMaterialRot);
      const floorMat = floorFin.material
        ? surfMat(floorFin)
        : new THREE.MeshStandardMaterial({ color: floorFin.color, roughness: 0.88 });
      floorMat.side = THREE.DoubleSide;
      const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMat);
      floor.rotation.x = Math.PI / 2;
      floor.receiveShadow = true;
      floor.name = 'Floor';
      this.roomGroup.add(floor);

      // ceiling (only visible from below)
      const ceil = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: '#f6f5f1', roughness: 0.95 })
      );
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = H;
      ceil.name = 'Ceiling';
      this.roomGroup.add(ceil);
      this.ceilings.push({ roomId: room.id, mesh: ceil, height: H });

      for (const g of walls) {
        // a partition is built once, under the room that owns it
        if (g.roomId !== room.id || (g.shared && !g.shared.owner)) continue;
        const t = g.thickness;
        // corners are the room-side wall FACE, so the slab hangs outside it
        const zc = g.faceOffset - t / 2;
        const ext = t - g.faceOffset;

        const group = new THREE.Group();
        group.name = `Wall_${++wallIdx}`;
        group.position.set(g.a.x, 0, g.a.y);
        group.rotation.y = -g.angle;

        const wallFin = resolveFinish(design, style.wallColor, style.wallMaterial, style.wallMaterialRot);
        const wallMat = wallFin.material
          ? surfMat(wallFin)
          : new THREE.MeshStandardMaterial({ color: wallFin.color, roughness: 0.94 });
        const openings = openingsOfWall(design, g).sort((a, b) => a.offset - b.offset);

        const addSeg = (x0: number, x1: number, y0: number, y1: number) => {
          if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return;
          const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, t);
          // meter-scaled UVs, offset so the pattern runs continuously across
          // the segments around openings (front/back faces are the visible ones)
          scaleBoxUV(geo, x1 - x0, y1 - y0, t);
          const uv = geo.attributes.uv as THREE.BufferAttribute;
          for (let i = 16; i < 24; i++) uv.setXY(i, uv.getX(i) + x0, uv.getY(i) + y0);
          const m = new THREE.Mesh(geo, wallMat);
          m.position.set((x0 + x1) / 2, (y0 + y1) / 2, zc);
          m.castShadow = true;
          m.receiveShadow = true;
          group.add(m);
        };

        let cursor = -ext; // extend into corners so joints close
        for (const o of openings) {
          const oL = o.offset - o.width / 2;
          const oR = o.offset + o.width / 2;
          addSeg(cursor, oL, 0, H);
          if (o.sill > 0.01) addSeg(oL, oR, 0, o.sill);
          addSeg(oL, oR, o.sill + o.height, H);
          this.buildOpening(group, o, t, zc);
          cursor = oR;
        }
        addSeg(cursor, g.len + ext, 0, H);

        this.roomGroup.add(group);
        const mid = wallPoint(g, g.len / 2);
        this.walls.push({
          id: g.id,
          roomId: room.id,
          twinRoomId: g.shared?.roomId ?? null,
          group,
          inward: new THREE.Vector3(g.inward.x, 0, g.inward.y),
          mid: new THREE.Vector3(mid.x, H / 2, mid.y),
          height: H,
        });
      }
    }
  }

  private buildOpening(wallGroup: THREE.Group, o: Opening, t: number, zc: number): void {
    const frameMat = new THREE.MeshStandardMaterial({ color: '#e7e0d2', roughness: 0.7 });
    const g = new THREE.Group();
    g.position.set(o.offset, 0, zc);

    const fw = 0.05; // frame width
    const frame = (w: number, h: number, x: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, t + 0.02), frameMat);
      m.position.set(x, y, 0);
      m.castShadow = true;
      g.add(m);
    };
    // jambs + head
    frame(fw, o.height, -o.width / 2 + fw / 2, o.sill + o.height / 2);
    frame(fw, o.height, o.width / 2 - fw / 2, o.sill + o.height / 2);
    frame(o.width, fw, 0, o.sill + o.height - fw / 2);

    if (o.type === 'window') {
      frame(o.width, fw, 0, o.sill + fw / 2);
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(o.width - fw * 2, o.height - fw * 2, 0.02),
        new THREE.MeshStandardMaterial({
          color: '#cfe4ef',
          roughness: 0.08,
          metalness: 0.1,
          transparent: true,
          opacity: 0.32,
        })
      );
      glass.position.set(0, o.sill + o.height / 2, 0);
      g.add(glass);
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.04, o.height - fw * 2, 0.035), frameMat);
      mullion.position.set(0, o.sill + o.height / 2, 0);
      g.add(mullion);
    } else {
      // door leaf, slightly ajar; mirrored for right hinges / outward swings
      const sign = o.hinge === 'right' ? -1 : 1;
      const out = o.swing === 'out';
      const leaf = new THREE.Group();
      leaf.position.set(sign * (-o.width / 2 + fw), 0, out ? -t / 2 : t / 2);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(o.width - fw * 2, o.height - fw - 0.02, 0.045),
        new THREE.MeshStandardMaterial({ color: '#ece7db', roughness: 0.6 })
      );
      slab.position.set((sign * (o.width - fw * 2)) / 2, (o.height - fw) / 2, 0);
      slab.castShadow = true;
      leaf.add(slab);
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 12, 10),
        new THREE.MeshStandardMaterial({ color: '#2b2b28', roughness: 0.3, metalness: 0.7 })
      );
      knob.position.set(sign * (o.width - fw * 2 - 0.06), 1.02, out ? -0.045 : 0.045);
      leaf.add(knob);
      leaf.rotation.y = (o.hinge === 'right') === out ? -0.5 : 0.5;
      g.add(leaf);
    }
    wallGroup.add(g);
  }

  private buildItem(item: Item, host?: HostContext): void {
    const def = this.store.defOf(item.defId);
    const part = this.store.partOf(item.defId);
    const group = buildItemGroup(item, def, this.store.design, part, host);
    group.userData.itemId = item.id;
    group.name = `${def.label.replace(/[^\w]+/g, '_')}_${item.id.slice(-4)}`;

    const bulbs: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (o.userData.bulb) bulbs.push(o as THREE.Mesh);
    });

    let light: FixtureLight | null = null;
    if (def.light && item.light) {
      if (def.light.kind === 'spot') {
        const s = new THREE.SpotLight('#ffffff', 0, 8, 0.75, 0.45, 1.4);
        s.position.y = lightLocalY(def, item);
        const target = new THREE.Object3D();
        target.position.set(0, -2.5, 0.35);
        s.target = target;
        group.add(target);
        light = s;
      } else if (def.light.kind === 'bar') {
        // area light spanning the whole strip → even wash instead of a point hotspot
        const r = new THREE.RectAreaLight('#ffffff', 0, item.w, 0.06);
        r.position.y = lightLocalY(def, item);
        r.rotation.x = -Math.PI / 2; // emit downward along the strip's length
        light = r;
      } else {
        const p = new THREE.PointLight('#ffffff', 0, 8, 1.8);
        p.position.y = lightLocalY(def, item);
        light = p;
      }
      group.add(light);
    }

    const units = collectMotionUnits(group);
    if (units.length) {
      // re-apply the ephemeral open state across rebuilds (unit ids are stable)
      setFrontPoses(units, (unit) => this.store.openFronts.isOpen(item.id, unit), true);
    }

    this.itemsGroup.add(group);
    this.items.set(item.id, { group, light, bulbs, units });
    this.placeItem(item);
  }

  /** Push the open-front view state to every unit; the RAF loop animates. */
  private applyFrontPoses(): void {
    for (const [id, entry] of this.items) {
      if (entry.units.length) {
        setFrontPoses(entry.units, (unit) => this.store.openFronts.isOpen(id, unit));
      }
    }
  }

  /** Double-click a door/drawer front: toggle its open preview. */
  private onDblClick(e: MouseEvent): void {
    // armed placement owns clicks — a dblclick would already have placed items
    if (this.getArmed()) return;
    const ray = this.pointerRay(e as PointerEvent);
    const hits = ray.intersectObjects(this.itemsGroup.children, true);
    for (const h of hits) {
      let unit: string | null = null;
      let itemId: string | null = null;
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (!unit && o.userData.motionUnit) unit = o.userData.motionUnit as string;
        if (o.userData.itemId) {
          itemId = o.userData.itemId as string;
          break;
        }
        o = o.parent;
      }
      if (unit && itemId) {
        this.store.openFronts.toggle(itemId, unit, () => this.allUnits());
        return;
      }
      if (itemId) return; // hit a non-moving panel of an item — swallow
    }
  }

  private *allUnits(): Iterable<{ itemId: string; unit: string }> {
    for (const [itemId, entry] of this.items) {
      for (const u of entry.units) {
        yield { itemId, unit: u.userData.motionUnit as string };
      }
    }
  }

  private placeItem(item: Item): void {
    const entry = this.items.get(item.id);
    if (!entry) return;
    const def = this.store.defOf(item.defId);
    const H = styleOfItem(this.store.design, item).wallHeight;
    const y = def.kind === 'spot' ? H - 0.02 : item.elevation;
    entry.group.position.set(item.x, y, item.y);
    entry.group.rotation.y = -item.rotation;
  }

  /** Non-structural refresh: transforms + light parameters + day/night. */
  private softUpdate(): void {
    for (const item of this.store.design.items) this.placeItem(item);
    this.relight();
  }

  private relight(): void {
    const scene = this.store.design.scene;
    const sky = skyState(scene.sunAzimuth, scene.sunElevation, scene.night);
    // daylight level (1 at day → 0.2 at night); nightness lifts lamp glow after dark
    const daylight = Math.min(1, sky.ambientIntensity / AMBIENT_DAY);
    const nightness = 1 - daylight;

    this.scene.background = this.bg.set(sky.background);
    // brightness is the one master level (sun + ambient + reflections);
    // the daylight fade still sends reflections dark at night
    this.scene.environmentIntensity = scene.brightness * daylight * ENV_FILL;

    this.sun.color.set(sky.sunColor);
    this.sun.intensity = sky.sunIntensity * scene.brightness;
    this.hemi.color.set(sky.ambientColor);
    this.hemi.intensity = sky.ambientIntensity * scene.brightness;

    const c = polygonCentroid(this.allCorners());
    this.sunDir.set(
      Math.sin(sky.azimuth) * Math.cos(sky.elevation),
      Math.sin(sky.elevation),
      Math.cos(sky.azimuth) * Math.cos(sky.elevation)
    );
    this.sun.position.set(
      c.x + this.sunDir.x * SUN_RADIUS,
      Math.max(1.5, this.sunDir.y * SUN_RADIUS), // keep it above the floor even at dusk
      c.y + this.sunDir.z * SUN_RADIUS
    );
    this.sun.target.position.set(c.x, 0, c.y);
    // shadow frustum wide enough for every room, not just the first
    const pts = this.allCorners();
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const span = Math.max(8, (Math.max(...xs) - Math.min(...xs)) / 2 + 2, (Math.max(...ys) - Math.min(...ys)) / 2 + 2);
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.updateProjectionMatrix();

    // fixture lights, shadow budget on the first few point/spot lamps.
    // Interior lights are OFF under full daylight (they'd only wash out the
    // sun), fade in through dusk and carry the room at night.
    const boost = 1.44 * nightness; // 0 day → 1.15 night
    let shadows = 0;
    for (const item of this.store.design.items) {
      const entry = this.items.get(item.id);
      if (!entry) continue;
      const def = this.store.defOf(item.defId);
      const lp = item.light;
      if (entry.light && lp && def.light) {
        const on = lp.on;
        const color = lp.color ? scratchColor.set(lp.color) : lightColor(lp.warmth);
        entry.light.color.copy(color);
        if (def.light.kind === 'spot') {
          entry.light.intensity = on ? (3 + lp.intensity * 26) * boost : 0;
        } else if (def.light.kind === 'bar') {
          // RectAreaLight is on a different (nit-like) scale than point/spot
          entry.light.intensity = on ? (2 + lp.intensity * 8) * boost : 0;
        } else {
          entry.light.intensity = on ? (2.5 + lp.intensity * 24) * boost : 0;
        }
        // only point/spot lamps have shadow maps; area lights (bar) never cast
        if (!(entry.light instanceof THREE.RectAreaLight)) {
          const wantShadow = on && shadows < SHADOW_LIGHT_BUDGET;
          if (entry.light.castShadow !== wantShadow) {
            entry.light.castShadow = wantShadow;
            if (wantShadow) {
              entry.light.shadow.mapSize.set(512, 512);
              entry.light.shadow.bias = -0.002;
            }
          }
          if (wantShadow) shadows++;
        }
        for (const b of entry.bulbs) {
          const m = b.material as THREE.MeshStandardMaterial;
          m.emissive.copy(color);
          // subtle at day (on-state feedback only), bright at night
          m.emissiveIntensity = on ? (0.6 + 2.0 * nightness) * (0.4 + lp.intensity) : 0.04;
        }
      }
    }
  }

  /** One-time procedural PMREM environment (neutral RoomEnvironment) for reflections + fill. */
  private initEnvironment(): void {
    const envScene = new RoomEnvironment();
    const target = this.pmrem.fromScene(envScene, 0.04);
    this.scene.environment = target.texture;
    this.disposeGroup(envScene); // frees the throwaway env geometry/materials
  }

  private setTint(id: string, on: boolean): void {
    const entry = this.items.get(id);
    if (!entry) return;
    entry.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const m = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!m || !('emissive' in m) || mesh.userData.bulb) return;
      m.emissive.set(on ? '#1e5a49' : '#000000');
      m.emissiveIntensity = on ? 0.45 : 1;
    });
  }

  private applySelectionTint(): void {
    const sel = this.store.selection;
    const selectedId = sel.kind === 'item' ? sel.id : null;
    if (this.lastTintedId && this.lastTintedId !== selectedId) this.setTint(this.lastTintedId, false);
    if (selectedId) this.setTint(selectedId, true);
    this.lastTintedId = selectedId;
    this.updateGizmo();
  }

  /* ---------------- CAD move gizmo ---------------- */

  /**
   * Translate gizmo on the selected item: three world-axis arrows plus the
   * planar pads between each axis pair, for precise per-axis moves. World axes
   * map to the model as X→item.x, Z→item.y (plan), Y→item.elevation.
   */
  private initGizmo(canvas: HTMLCanvasElement): void {
    const g = new TransformControls(this.camera, canvas);
    g.setMode('translate');
    g.setSpace('world');
    g.setTranslationSnap(0.01); // 1 cm — matches the UI's cm granularity
    this.scene.add(g);
    this.gizmo = g;

    // let OrbitControls (and the body-drag) resume only when no handle is held
    g.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) this.store.commit(); // gesture end → one undo step
    });
    // handle move → write the group's world position back to the model
    g.addEventListener('objectChange', () => this.onGizmoChange());
  }

  private onGizmoChange(): void {
    const obj = this.gizmo.object;
    if (!obj) return;
    const id = obj.userData.itemId as string | undefined;
    if (!id) return;
    const it = this.store.itemById(id);
    if (!it) return;
    const def = this.store.defOf(it.defId);
    const elevation = Math.max(0, obj.position.y); // never below the floor
    // Route the horizontal move through the same snapper the floor drag uses so
    // gizmo moves still hug walls and click to neighbouring cabinets.
    const res = snapItem(this.store, def, id, obj.position.x, obj.position.z, it.rotation);
    // glue the gizmo handle to the snapped pose so it doesn't drift from the item
    obj.position.set(res.x, elevation, res.y);
    this.store.updateItem(
      id,
      { x: res.x, y: res.y, rotation: res.rotation, elevation, roomId: res.roomId },
      { structural: false, transient: true }
    );
  }

  /** Attach the gizmo to the selected item's group, or detach when nothing is selected. */
  private updateGizmo(): void {
    if (!this.gizmo) return; // selection tint runs once before the gizmo exists
    const sel = this.store.selection;
    const entry = sel.kind === 'item' ? this.items.get(sel.id) : undefined;
    // attached appliances derive their pose from the host — no move gizmo
    const attached = sel.kind === 'item' && !!this.store.itemById(sel.id)?.attach;
    if (entry && !attached) this.gizmo.attach(entry.group);
    else this.gizmo.detach();
  }

  /* ---------------- picking & dragging ---------------- */

  private pointerRay(e: PointerEvent): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  private floorPoint(e: PointerEvent): THREE.Vector3 | null {
    const ray = this.pointerRay(e);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  private pickItem(e: PointerEvent): Item | null {
    const ray = this.pointerRay(e);
    const hits = ray.intersectObjects(this.itemsGroup.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.itemId) o = o.parent;
      if (o?.userData.itemId) return this.store.itemById(o.userData.itemId) ?? null;
    }
    return null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // a hovered/held gizmo handle owns this gesture — don't pick or place
    if (this.gizmo.axis || this.gizmo.dragging) return;
    this.downPos.set(e.clientX, e.clientY);

    const armed = this.getArmed();
    if (armed && !armed.opening) {
      const p = this.floorPoint(e);
      if (p) {
        const mount = armed.appliance?.mount;
        if (mount === 'counter' || mount === 'zone') {
          // hosted appliances need a host under the click, here too
          const hit = findHost(this.store.design, armed, { x: p.x, y: p.z }, null);
          if (!hit) return;
          const item = this.store.addItem(armed, p.x, p.z, 0);
          this.store.setAttachment(item.id, hit.attach);
          this.store.select({ kind: 'item', id: item.id });
          this.store.commit();
          if (!e.shiftKey) this.clearArmed();
          return;
        }
        const snapped = snapItem(this.store, armed, null, p.x, p.z, 0);
        const item = this.store.addItem(armed, snapped.x, snapped.y, snapped.rotation);
        item.roomId = snapped.roomId;
        this.store.select({ kind: 'item', id: item.id });
        this.store.commit();
        if (!e.shiftKey) this.clearArmed();
      }
      return;
    }

    // Selecting an item only arms the move gizmo; the body itself is not
    // draggable — a drag on the body falls through to OrbitControls (orbit).
    const item = this.pickItem(e);
    if (item) this.store.select({ kind: 'item', id: item.id });
  }

  private onPointerUp(e: PointerEvent): void {
    // gizmo drag/click resolves in its own handler — never treat it as a deselect
    if (this.gizmo.axis || this.gizmo.dragging) return;
    // a click (not a drag-orbit) on empty space clears the selection
    if (e.button === 0 && this.downPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) < 4) {
      if (!this.pickItem(e)) this.store.select({ kind: 'none' });
    }
  }

  /* ---------------- macOS trackpad navigation ---------------- */

  /** Route a wheel event to pan/orbit/zoom (macOS only; see wheelInput.ts). */
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const w = e as unknown as WheelLike;
    switch (wheelGesture(w, this.isMac, resolveDevice(w))) {
      case 'zoom-pinch':
        this.zoomCamera(Math.exp(e.deltaY * PINCH_ZOOM_RATE));
        break;
      case 'mouse-zoom':
        this.zoomCamera(Math.pow(WHEEL_ZOOM_STEP, Math.sign(e.deltaY)));
        break;
      case 'trackpad-pan':
        // Negate so the scene follows the fingers (two-finger swipe drags content).
        this.panCamera(-e.deltaX, -e.deltaY);
        break;
      case 'trackpad-orbit':
        this.orbitCamera(-e.deltaX, -e.deltaY);
        break;
    }
  }

  /** Dolly by scaling the camera→target distance; update() clamps to min/max. */
  private zoomCamera(factor: number): void {
    navOffset.copy(this.camera.position).sub(this.controls.target).multiplyScalar(factor);
    this.camera.position.copy(this.controls.target).add(navOffset);
  }

  /** Screen-space pan of both camera and target (mirrors OrbitControls' pan). */
  private panCamera(dx: number, dy: number): void {
    const el = this.renderer.domElement;
    const dist =
      this.camera.position.distanceTo(this.controls.target) *
      Math.tan((this.camera.fov / 2) * (Math.PI / 180));
    const kx = (2 * dx * dist) / el.clientHeight;
    const ky = (2 * dy * dist) / el.clientHeight;
    this.camera.updateMatrix();
    const m = this.camera.matrix.elements;
    navRight.set(m[0], m[1], m[2]);
    navUp.set(m[4], m[5], m[6]);
    navMove.copy(navRight).multiplyScalar(-kx).addScaledVector(navUp, ky);
    this.camera.position.add(navMove);
    this.controls.target.add(navMove);
  }

  /** Orbit around the target; update() clamps phi to maxPolarAngle. */
  private orbitCamera(dx: number, dy: number): void {
    const h = this.renderer.domElement.clientHeight;
    navOffset.copy(this.camera.position).sub(this.controls.target);
    navSpherical.setFromVector3(navOffset);
    navSpherical.theta -= ((2 * Math.PI * dx) / h) * TRACKPAD_ORBIT_SPEED;
    navSpherical.phi -= ((2 * Math.PI * dy) / h) * TRACKPAD_ORBIT_SPEED;
    navSpherical.makeSafe();
    navOffset.setFromSpherical(navSpherical);
    this.camera.position.copy(this.controls.target).add(navOffset);
  }

  /** Project a world point to canvas CSS pixels (used by the E2E suite). */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  /* ---------------- export ---------------- */

  snapshotPNG(): string {
    const gizmoVisible = this.gizmo.visible;
    this.gizmo.visible = false; // keep the move handles out of the exported image
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.gizmo.visible = gizmoVisible;
    return url;
  }

  /**
   * Export the fully modelled interior (room shells + every item) as binary
   * glTF for Blender. Light sources and the helper ground disc are stripped —
   * materials and lighting are meant to be authored in Blender.
   */
  async exportGLB(): Promise<Blob> {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

    // clear the selection tint so it does not bake into exported materials
    const tinted = this.lastTintedId;
    if (tinted) this.setTint(tinted, false);

    const root = new THREE.Group();
    root.name = 'Design';
    const roomClone = this.roomGroup.clone(true);
    roomClone.name = 'Rooms';
    // export closed geometry: open-preview poses are view state, not model
    const allUnits = [...this.items.values()].flatMap((e) => e.units);
    const itemsClone = withClosedPoses(allUnits, () => this.itemsGroup.clone(true));
    itemsClone.name = 'Furniture';
    root.add(roomClone, itemsClone);

    const toRemove: THREE.Object3D[] = [];
    root.traverse((o) => {
      if ((o as THREE.Light).isLight || o.name === 'Ground') toRemove.push(o);
    });
    for (const o of toRemove) o.parent?.remove(o);

    const exporter = new GLTFExporter();
    const buffer = (await exporter.parseAsync(root, { binary: true })) as ArrayBuffer;

    if (tinted) this.setTint(tinted, true);
    return new Blob([buffer], { type: 'model/gltf-binary' });
  }
}

export { shade };
