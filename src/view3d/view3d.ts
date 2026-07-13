import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { CatalogDef } from '../model/catalog';
import { polygonCentroid, wallPoint } from '../model/geometry';
import { snapItem } from '../model/snapping';
import type { Store } from '../model/store';
import type { EnvPreset, Item, Opening } from '../model/types';
import { skyState } from '../model/sky';
import { buildItemGroup, lightLocalY, shade } from './itemMeshes';

export type CamPreset = 'corner' | 'top' | 'front' | 'inside';

type FixtureLight = THREE.PointLight | THREE.SpotLight | THREE.RectAreaLight;

interface ItemEntry {
  group: THREE.Group;
  light: FixtureLight | null;
  bulbs: THREE.Mesh[];
}

interface WallEntry {
  id: string; // wall id = start corner id; keys wallVisibility overrides
  group: THREE.Group;
  inward: THREE.Vector3;
  mid: THREE.Vector3;
}

const SHADOW_LIGHT_BUDGET = 4;
/** how far from the room centroid the directional "sun" sits */
const SUN_RADIUS = 10;

const LIGHT_COOL = new THREE.Color('#dfeaff');
const LIGHT_WARM = new THREE.Color('#ffb46b');
const scratchColor = new THREE.Color();

/** Shared scratch — consumers must copy() the result, never keep the reference. */
function lightColor(warmth: number): THREE.Color {
  return scratchColor.copy(LIGHT_COOL).lerp(LIGHT_WARM, warmth);
}

/**
 * Procedural environment scenes for image-based lighting — no external HDR
 * assets (keeps the project's "all procedural" rule). `studio` reuses three's
 * neutral RoomEnvironment; the others are simple vertical gradient domes.
 */
function makeEnvScene(preset: EnvPreset): THREE.Scene {
  if (preset === 'studio') return new RoomEnvironment();
  const [top, bottom] = preset === 'dusk' ? ['#6a4a63', '#c98a5a'] : ['#eef1f5', '#d6d4cd'];
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 24, 16);
  const topC = new THREE.Color(top);
  const botC = new THREE.Color(bottom);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) / 10 + 1) / 2; // -radius..+radius → 0..1
    c.copy(botC).lerp(topC, t);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
  scene.add(new THREE.Mesh(geo, mat));
  return scene;
}

export class View3D {
  private store: Store;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();

  private roomGroup = new THREE.Group();
  private itemsGroup = new THREE.Group();
  private walls: WallEntry[] = [];
  private ceiling: THREE.Mesh | null = null;
  private items = new Map<string, ItemEntry>();

  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envKey: EnvPreset | null = null;
  private bg = new THREE.Color();
  private sunDir = new THREE.Vector3();

  private dragItemId: string | null = null;
  private dragOffset = new THREE.Vector2();
  private dragMoved = false;
  private downPos = new THREE.Vector2();
  private lastTintedId: string | null = null;
  private scratchToCam = new THREE.Vector3();

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
    this.renderer.toneMappingExposure = 1.05; // overridden per-frame by relight()
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // area lights (LED strip) need their LTC lookup tables initialised once
    RectAreaLightUniformsLib.init();
    // procedural image-based environment for reflections + soft fill (no asset files)
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 120);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.35;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 30;

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

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.endDrag());

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
    this.renderer.render(this.scene, this.camera);
  };

  private updateWallVisibility(): void {
    const camPos = this.camera.position;
    const modes = this.store.design.wallVisibility;
    for (const w of this.walls) {
      const mode = modes?.[w.id] ?? 'auto';
      if (mode === 'show' || mode === 'hide') {
        w.group.visible = mode === 'show';
        continue;
      }
      const toCam = this.scratchToCam.subVectors(camPos, w.mid);
      toCam.y = 0;
      toCam.normalize();
      w.group.visible = w.inward.dot(toCam) > -0.25;
    }
    const H = this.store.design.room.wallHeight;
    if (this.ceiling) this.ceiling.visible = camPos.y < H - 0.05;
  }

  /* ---------------- camera presets ---------------- */

  setPreset(p: CamPreset): void {
    const c = polygonCentroid(this.store.design.corners);
    const xs = this.store.design.corners.map((k) => k.x);
    const ys = this.store.design.corners.map((k) => k.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const span = Math.max(spanX, spanY, 3);
    const H = this.store.design.room.wallHeight;

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
      case 'inside':
        set(c.x + 0.4, 1.55, c.y + spanY * 0.28, c.x, 1.25, c.y - spanY * 0.6);
        break;
    }
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
    this.ceiling = null;

    this.buildRoom();
    for (const item of this.store.design.items) this.buildItem(item);
    this.relight();
    this.applySelectionTint();
  }

  private buildRoom(): void {
    const design = this.store.design;
    const corners = design.corners;
    if (corners.length < 3) return;
    const room = design.room;
    const t = room.wallThickness;
    const H = room.wallHeight;

    // ground catches shadows around the room
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: '#c8c9c4', roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.012;
    ground.receiveShadow = true;
    this.roomGroup.add(ground);

    // floor
    const shape = new THREE.Shape(corners.map((p) => new THREE.Vector2(p.x, p.y)));
    const floor = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({ color: room.floorColor, roughness: 0.88, side: THREE.DoubleSide })
    );
    floor.rotation.x = Math.PI / 2;
    floor.receiveShadow = true;
    this.roomGroup.add(floor);

    // ceiling (only visible from below)
    const ceil = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshStandardMaterial({ color: '#f6f5f1', roughness: 0.95 })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = H;
    this.roomGroup.add(ceil);
    this.ceiling = ceil;

    ground.name = 'Ground';
    floor.name = 'Floor';
    ceil.name = 'Ceiling';

    // walls
    let wallIdx = 0;
    for (const g of this.store.walls()) {
      const group = new THREE.Group();
      group.name = `Wall_${++wallIdx}`;
      group.position.set(g.a.x, 0, g.a.y);
      group.rotation.y = -g.angle;

      const wallMat = new THREE.MeshStandardMaterial({ color: room.wallColor, roughness: 0.94 });
      const openings = design.openings
        .filter((o) => o.wallId === g.id)
        .sort((a, b) => a.offset - b.offset);

      const addSeg = (x0: number, x1: number, y0: number, y1: number) => {
        if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, t), wallMat);
        m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      };

      let cursor = -t / 2; // extend into corners so joints close
      for (const o of openings) {
        const oL = o.offset - o.width / 2;
        const oR = o.offset + o.width / 2;
        addSeg(cursor, oL, 0, H);
        if (o.sill > 0.01) addSeg(oL, oR, 0, o.sill);
        addSeg(oL, oR, o.sill + o.height, H);
        this.buildOpening(group, o, t);
        cursor = oR;
      }
      addSeg(cursor, g.len + t / 2, 0, H);

      this.roomGroup.add(group);
      const mid = wallPoint(g, g.len / 2);
      this.walls.push({
        id: g.id,
        group,
        inward: new THREE.Vector3(g.inward.x, 0, g.inward.y),
        mid: new THREE.Vector3(mid.x, H / 2, mid.y),
      });
    }
  }

  private buildOpening(wallGroup: THREE.Group, o: Opening, t: number): void {
    const frameMat = new THREE.MeshStandardMaterial({ color: '#e7e0d2', roughness: 0.7 });
    const g = new THREE.Group();
    g.position.set(o.offset, 0, 0);

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

  private buildItem(item: Item): void {
    const def = this.store.defOf(item.defId);
    const part = this.store.customPartById(item.defId);
    const group = buildItemGroup(item, def, this.store.design.room, part);
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

    this.itemsGroup.add(group);
    this.items.set(item.id, { group, light, bulbs });
    this.placeItem(item);
  }

  private placeItem(item: Item): void {
    const entry = this.items.get(item.id);
    if (!entry) return;
    const def = this.store.defOf(item.defId);
    const H = this.store.design.room.wallHeight;
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
    const sky = skyState(scene.timeOfDay);
    // daylight level (1 at day → ~0.14 at night); nightness lifts lamp glow after dark
    const daylight = Math.min(1, sky.ambientIntensity / 0.72);
    const nightness = 1 - daylight;

    this.renderer.toneMappingExposure = scene.exposure;
    this.scene.background = this.bg.set(sky.background);
    // fade the environment fill with daylight so night actually goes dark
    this.scene.environmentIntensity = scene.envIntensity * daylight;
    if (scene.envPreset !== this.envKey) this.updateEnvironment(scene.envPreset);

    // sun (key light): time drives direction + base colour/intensity; manual adjusts layer on top
    this.sun.color.set(scene.sunColor ?? sky.sunColor);
    this.sun.intensity = sky.sunIntensity * scene.sunStrength;
    this.hemi.color.set(scene.ambientColor ?? sky.ambientColor);
    this.hemi.intensity = sky.ambientIntensity * scene.ambientStrength;

    const c = polygonCentroid(this.store.design.corners);
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
    const span = 8;
    const cam = this.sun.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.updateProjectionMatrix();

    // fixture lights, shadow budget on the first few point/spot lamps
    const boost = 0.75 + 0.5 * nightness; // 0.75 day → 1.25 night, as before
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
          m.emissiveIntensity = on ? (1.5 + 1.1 * nightness) * (0.4 + lp.intensity) : 0.04;
        }
      }
    }
  }

  /** (Re)build the procedural PMREM environment map. Cheap and rare — only on preset change. */
  private updateEnvironment(preset: EnvPreset): void {
    const envScene = makeEnvScene(preset);
    const target = this.pmrem.fromScene(envScene, 0.04);
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.disposeGroup(envScene); // frees the throwaway env geometry/materials
    this.envKey = preset;
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
    if (e.button !== 0 || this.dragItemId) return;
    this.downPos.set(e.clientX, e.clientY);
    this.dragMoved = false;

    const armed = this.getArmed();
    if (armed && !armed.opening) {
      const p = this.floorPoint(e);
      if (p) {
        const snapped = snapItem(this.store, armed, null, p.x, p.z, 0);
        const item = this.store.addItem(armed, snapped.x, snapped.y, snapped.rotation);
        this.store.select({ kind: 'item', id: item.id });
        this.store.commit();
        if (!e.shiftKey) this.clearArmed();
      }
      return;
    }

    const item = this.pickItem(e);
    if (item) {
      this.store.select({ kind: 'item', id: item.id });
      const p = this.floorPoint(e);
      if (p) this.dragOffset.set(p.x - item.x, p.z - item.y);
      this.dragItemId = item.id;
      this.controls.enabled = false;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragItemId) return;
    if (this.downPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 3) this.dragMoved = true;
    if (!this.dragMoved) return;
    const it = this.store.itemById(this.dragItemId);
    const p = this.floorPoint(e);
    if (!it || !p) return;
    const def = this.store.defOf(it.defId);
    const res = snapItem(this.store, def, it.id, p.x - this.dragOffset.x, p.z - this.dragOffset.y, it.rotation);
    this.store.updateItem(it.id, { x: res.x, y: res.y, rotation: res.rotation }, { structural: false, transient: true });
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.dragItemId) {
      this.endDrag();
    } else if (e.button === 0 && this.downPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) < 4) {
      if (!this.pickItem(e)) this.store.select({ kind: 'none' });
    }
  }

  /** Shared teardown for pointerup and pointercancel — commits an in-flight drag. */
  private endDrag(): void {
    if (!this.dragItemId) return;
    this.controls.enabled = true;
    if (this.dragMoved) this.store.commit();
    this.dragItemId = null;
  }

  /** Project a world point to canvas CSS pixels (used by the E2E suite). */
  worldToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
  }

  /* ---------------- export ---------------- */

  snapshotPNG(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * Export the fully modelled kitchen (room shell + every item) as binary
   * glTF for Blender. Light sources and the helper ground disc are stripped —
   * materials and lighting are meant to be authored in Blender.
   */
  async exportGLB(): Promise<Blob> {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

    // clear the selection tint so it does not bake into exported materials
    const tinted = this.lastTintedId;
    if (tinted) this.setTint(tinted, false);

    const root = new THREE.Group();
    root.name = 'Kitchen';
    const roomClone = this.roomGroup.clone(true);
    roomClone.name = 'Room';
    const itemsClone = this.itemsGroup.clone(true);
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
