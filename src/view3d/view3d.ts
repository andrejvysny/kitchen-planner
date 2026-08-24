import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { EditorState } from '../editor/editorState';
import { withoutCarried } from '../editor/selectionOps';
import { itemBaseY, SPOT_AIM, type CatalogDef } from '../model/catalog';
import { polygonCentroid, wallPoint } from '../model/geometry';
import { findHost } from '../model/attach';
import { hostContexts } from '../model/worktops';
import type { HostContext } from '../model/panels';
import { snapItem, type SnapResult } from '../model/snapping';
import {
  defaultRoomStyle,
  openingsOfWall,
  roomById,
  wallJoints,
  type RoomWall,
} from '../model/rooms';
import type { Store } from '../model/store';
import type { Corner, Item, Opening, Point, RoomStyle } from '../model/types';
import { AMBIENT_DAY, skyState } from '../model/sky';
import { resolveFinish } from '../model/variables';
import { buildItemGroup, lightLocalY, shade } from './itemMeshes';
import {
  collectMotionUnits,
  setFrontPoses,
  snapFrontPoses,
  stepFrontPoses,
  withClosedPoses,
} from './partMeshes';
import { prism, scaleBoxUV, stampMaterial, surfMat } from './meshKit';
import { parseMaterialName, type MaterialDesc } from '../model/materialName';
import type { ManifestCamera, ManifestMaterial } from '../model/renderManifest';
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
  /**
   * Room whose wallVisibility map owns this wall (the owner side of a
   * partition), or null for a free-standing chain — which belongs to no room
   * and so has no per-room override to answer to.
   */
  roomId: string | null;
  /** the room on the other side of a partition; null for exterior walls */
  twinRoomId: string | null;
  group: THREE.Group;
  inward: THREE.Vector3;
  mid: THREE.Vector3;
  height: number;
}

/** A junction patch and the wall groups it closes — it shows while any is up. */
interface JointEntry {
  mesh: THREE.Mesh;
  walls: WallEntry[];
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

/**
 * Emissive tints, most important first: the selection always wins (the user is
 * looking at what they clicked), then an item named by an error, then a warn.
 * Info-severity findings never tint — they are hints, not defects.
 */
const TINT_SELECTED = '#1e5a49';
const TINT_ERROR = '#c0392b';
const TINT_WARN = '#d98324';

/**
 * Press-to-release travel under which a pointer gesture is still a CLICK, in
 * CSS px. Shared by the deselect test and the body-drag gesture, so a click
 * that selects can never also nudge the thing it selected (Plan2D calls the
 * same threshold RECT_DRAG_SLOP).
 */
const CLICK_SLOP_PX = 4;

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

/**
 * Name a room-shell surface. Wall/floor/ceiling roughness is its own curve, so
 * the shell identity WINS over whatever `surfMat` already stamped — but a
 * library material that resolved underneath keeps its id and rotation, which is
 * what lets a renderer rebuild the real oak floor instead of a flat brown one.
 */
function stampShell(
  mat: THREE.MeshStandardMaterial,
  surface: 'wall' | 'floor' | 'ceiling'
): THREE.MeshStandardMaterial {
  const prev = mat.userData.kp as MaterialDesc | undefined;
  const lib = prev?.kind === 'library' ? prev : undefined;
  return stampMaterial(mat, { kind: 'shell', surface, matId: lib?.matId, rot: lib?.rot ?? false });
}

/** How far down the forward axis a detached view's camera target is assumed to sit. */
const CAMERA_TARGET_FALLBACK_M = 3;

export class View3D {
  private store: Store;
  private editor: EditorState;
  /** the rest of a multi-selection during a 3D move, with the poses it started from */
  private followers: {
    ax: number;
    ay: number;
    rest: { id: string; x0: number; y0: number }[];
  } | null = null;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private gizmo!: TransformControls;
  private raycaster = new THREE.Raycaster();

  private roomGroup = new THREE.Group();
  private itemsGroup = new THREE.Group();
  private ground: THREE.Mesh;
  private walls: WallEntry[] = [];
  private joints: JointEntry[] = [];
  private ceilings: CeilingEntry[] = [];
  private camRoomAt: Point = { x: Infinity, y: Infinity };
  private camRoomId: string | null = null;
  private itemEntries = new Map<string, ItemEntry>();

  /** false while the 3D pane is hidden: no rendering, structural edits just queue */
  private active = true;
  /** starts dirty: a view constructed detached owes its first build to attach() */
  private rebuildQueued = true;
  private rebuildRaf = 0;
  private contextLost = false;
  /** rAF timestamp of the last rendered frame; 0 = the loop is (re)starting */
  private lastFrameMs = 0;

  /* ---------------- lifecycle ---------------- */

  /** Aborts every DOM listener registered by the CURRENT attach(); null while detached. */
  private ac: AbortController | null = null;
  private ro: ResizeObserver | null = null;
  /** store.on() disposers of the current attach(), run and cleared by detach(). */
  private subs: (() => void)[] = [];
  private attached = false;
  /** canvas the renderer/controls/gizmo are built on; they outlive detach() on it */
  private boundCanvas: HTMLCanvasElement | null = null;
  /** the animate() loop re-queues itself only while true — detach() stops it */
  private running = false;
  private animRaf = 0;
  /** false until the first attach() framed the design; later attaches keep the pose */
  private framed = false;
  /** reframes once on the 0→1 room transition — a fresh design has nothing to frame yet */
  private hadRooms = false;
  /** context-loss curtain of the bound canvas, removed with the renderer */
  private lostOverlay: HTMLElement | null = null;

  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private bg = new THREE.Color();
  private sunDir = new THREE.Vector3();

  private downPos = new THREE.Vector2();
  private curPos = new THREE.Vector2();
  /**
   * The live free-move gesture: a drag on the BODY of the item that was
   * already selected. `grabX/grabY` is the offset from the floor point under
   * the cursor to the item's pose, so the item never jumps to the cursor;
   * `moved` flips once the pointer passes CLICK_SLOP_PX, which is what keeps a
   * plain click a click. Null whenever the canvas is orbiting instead.
   */
  private moveDrag: {
    id: string;
    pointerId: number;
    grabX: number;
    grabY: number;
    /** OrbitControls' flag from before the gesture, restored when it ends */
    orbitWasEnabled: boolean;
    moved: boolean;
  } | null = null;
  /** item id → tint colour currently written into its materials */
  private appliedTints = new Map<string, string>();
  private scratchToCam = new THREE.Vector3();
  private readonly isMac = isMac(navigator.platform, navigator.userAgent);

  private getArmed: () => CatalogDef | null;
  private clearArmed: () => void;

  /**
   * Constructed DETACHED: the scene graph is assembled here, but the renderer,
   * the controls and the first framing all need a canvas, so they wait for
   * `attach()` — which is what a React ref effect calls once the element is in
   * the document.
   */
  constructor(
    store: Store,
    opts: {
      getArmed: () => CatalogDef | null;
      clearArmed: () => void;
      /** the selection lives here since M18 — the view reads and writes it */
      editor: EditorState;
    }
  ) {
    this.store = store;
    this.editor = opts.editor;
    this.getArmed = opts.getArmed;
    this.clearArmed = opts.clearArmed;

    // area lights (LED strip) need their LTC lookup tables initialised once
    RectAreaLightUniformsLib.init();

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.05, 120);

    this.hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a8', 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // the shadow-catching disc is identical after every rebuild, so it lives
    // outside the groups the rebuild disposes
    this.ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 40),
      stampMaterial(new THREE.MeshStandardMaterial({ color: '#c8c9c4', roughness: 0.95 }), {
        kind: 'product',
        product: 'ground',
      })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.012;
    this.ground.receiveShadow = true;
    this.ground.name = 'Ground';
    this.scene.add(this.ground);

    this.scene.add(this.roomGroup);
    this.scene.add(this.itemsGroup);
    // the scene starts empty and unframed; the first attach() pays both debts
    this.hadRooms = store.design.rooms.length > 0;
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Bind to `canvas`: DOM listeners, the parent ResizeObserver, the store
   * subscriptions and the render loop. Re-attaching the canvas already held is
   * a no-op, so a double-mount (React StrictMode) double-subscribes nothing.
   * The GL side (renderer, controls, gizmo) is built once PER CANVAS and
   * survives detach/attach cycles on it — only a different canvas rebuilds it.
   */
  attach(canvas: HTMLCanvasElement): void {
    if (this.attached && canvas === this.boundCanvas) return;
    if (this.attached) this.detach();
    if (canvas !== this.boundCanvas) this.bindCanvas(canvas);

    this.attached = true;
    this.ac = new AbortController();
    const { signal } = this.ac;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement!);
    this.resize();

    this.subs.push(
      this.store.on('change', (info) => {
        if (info.structural) this.queueRebuild();
        else this.softUpdate();
      }),
      this.editor.subscribeSelection(() => this.applySelectionTint()),
      this.store.on('pose', () => this.applyFrontPoses())
    );

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal });
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal });
    // a cancelled pointer (browser gesture takeover) must still hand orbit back
    canvas.addEventListener('pointercancel', (e) => this.onPointerCancel(e), { signal });
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e), { signal });

    // MacBook trackpad navigation: take over the wheel so two-finger swipe pans,
    // +Shift orbits, and pinch zooms. Mouse (drag + wheel) keeps OrbitControls'
    // defaults, so this is macOS-only to avoid touching other platforms.
    if (this.isMac)
      canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false, signal });

    this.initContextLoss(canvas, signal);

    // edits made while detached were never heard: detach() left the scene dirty
    if (this.active) this.flushRebuild();

    // the camera pose survives detach/attach, so only the FIRST canvas frames
    // the design — the preset needs controls, which is why it waits for one
    if (!this.framed) {
      this.framed = true;
      this.setPreset('corner');
    }

    this.running = true;
    this.lastFrameMs = 0; // the pose clock restarts with the loop
    if (!this.animRaf) this.animRaf = requestAnimationFrame(this.animate);
  }

  /**
   * Release everything attach() wired: listeners, observer, subscriptions, the
   * render loop and any queued rebuild. Idempotent. The scene, the camera pose
   * and the renderer all survive — this view can be attached again.
   */
  detach(): void {
    if (!this.attached) return;
    // no pointerup can arrive once the listeners are gone: end the gesture here
    // or the design keeps a moved item with no undo step and orbit stays off
    this.endMoveDrag();
    this.attached = false;
    this.running = false;
    if (this.animRaf) cancelAnimationFrame(this.animRaf);
    this.animRaf = 0;
    if (this.rebuildRaf) cancelAnimationFrame(this.rebuildRaf);
    this.rebuildRaf = 0;
    // nothing is listening to the store from here on, so whatever it holds when
    // attach() comes back is stale by definition
    this.rebuildQueued = true;
    this.ac?.abort();
    this.ac = null;
    this.ro?.disconnect();
    this.ro = null;
    for (const off of this.subs) off();
    this.subs = [];
  }

  /** detach() + permanent GPU teardown; the view is unusable afterwards. */
  dispose(): void {
    this.detach();
    this.releaseCanvas(true);
  }

  /** Build the GL side on `canvas`, replacing whatever the previous one owned. */
  private bindCanvas(canvas: HTMLCanvasElement): void {
    this.releaseCanvas();
    this.boundCanvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.initEnvironment(); // PMREM is baked by this renderer, so it is per-canvas

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
    if (this.isMac) this.controls.enableZoom = false; // wheel dolly handled in onWheel()

    this.initGizmo(canvas);

    const overlay = document.createElement('div');
    overlay.className = 'gl-lost';
    overlay.textContent = '3D view paused — restoring…';
    overlay.hidden = true;
    canvas.parentElement!.appendChild(overlay);
    this.lostOverlay = overlay;
  }

  /**
   * Drop the GL objects bound to the current canvas. `withScene` also frees the
   * scene graph's buffers (dispose()); a canvas SWAP keeps them — three
   * re-uploads geometry and materials to the new context on the next render.
   */
  private releaseCanvas(withScene = false): void {
    if (!this.boundCanvas) return;
    this.gizmo.detach();
    this.scene.remove(this.gizmo);
    this.gizmo.dispose();
    this.controls.dispose();
    if (withScene) this.disposeGroup(this.scene); // the gizmo has left the graph
    this.lostOverlay?.remove();
    this.lostOverlay = null;
    this.scene.environment?.dispose();
    this.scene.environment = null;
    this.renderer.dispose(); // last: everything above lived in its GL context
    this.boundCanvas = null;
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

  private animate = (nowMs?: number): void => {
    // detached: the loop ends here and attach() starts a new one
    if (!this.running) {
      this.animRaf = 0;
      return;
    }
    this.animRaf = requestAnimationFrame(this.animate);
    // hidden pane or a dead GL context: nothing on screen can change
    if (!this.active || this.contextLost) {
      this.lastFrameMs = 0; // the clock restarts when the loop does
      return;
    }
    const now = nowMs ?? performance.now();
    // frame-rate independent: the pose animation is driven by wall-clock
    // seconds, so a slow renderer opens a door in the same TIME, not the same
    // number of frames (0 on the first frame after a restart)
    const dt = this.lastFrameMs ? (now - this.lastFrameMs) / 1000 : 0;
    this.lastFrameMs = now;
    this.controls.update();
    this.updateWallVisibility();
    for (const entry of this.itemEntries.values()) {
      if (entry.units.length) stepFrontPoses(entry.units, dt);
    }
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Show/hide gate for the 3D pane. While inactive the loop renders nothing and
   * structural edits only mark the scene dirty, so a session spent in the 2D
   * pane costs no GPU work at all.
   */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) {
      // an in-flight frame would rebuild for nobody; the flag keeps the debt
      if (this.rebuildRaf) cancelAnimationFrame(this.rebuildRaf);
      this.rebuildRaf = 0;
      return;
    }
    this.resize(); // the pane had zero size while hidden
    this.flushRebuild();
    // fronts toggled while the pane was hidden owe no animation — the user
    // never saw them closed, so reveal them already in their target pose
    for (const entry of this.itemEntries.values()) {
      if (entry.units.length) snapFrontPoses(entry.units);
    }
  }

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
    // a patch belongs to no single wall, so it stays up while any wall it
    // closes is up — hiding it with only one neighbour gone would re-open the
    // corner of the wall still on screen
    for (const j of this.joints) j.mesh.visible = j.walls.some((w) => w.group.visible);
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
    // no room yet: an empty polygon centroid is NaN, so frame a placeholder
    // spot instead of pointing the camera at nothing
    const c = corners.length ? polygonCentroid(corners) : { x: 2, y: 1.5 };
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
        set(c.x, 1.35, (ys.length ? Math.max(...ys) : c.y) + span * 1.05, c.x, 1.0, c.y);
        break;
      case 'inside': {
        // step into the ACTIVE room, not the centroid of the whole design
        const room = this.store.activeRoom();
        if (!room) break;
        const rc = room.corners;
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

  /**
   * Item id → scene entry. Reading it settles any queued rebuild first, so a
   * synchronous caller never sees geometry from before the last mutation.
   */
  get items(): ReadonlyMap<string, ItemEntry> {
    this.flushRebuild();
    return this.itemEntries;
  }

  /**
   * Structural changes arrive in bursts (a drag emits one per pointermove), and
   * only the last one of a frame is visible — so they coalesce into a single
   * rebuild per frame instead of one per notify.
   */
  private queueRebuild(): void {
    this.rebuildQueued = true;
    // hidden pane: stay dirty until setActive(true) or a synchronous reader flushes
    if (!this.active || this.rebuildRaf) return;
    this.rebuildRaf = requestAnimationFrame(() => {
      this.rebuildRaf = 0;
      this.flushRebuild();
    });
  }

  /** Run a queued rebuild now — for consumers that read the scene synchronously. */
  flushRebuild(): void {
    if (!this.rebuildQueued) return;
    this.rebuildQueued = false;
    this.rebuild();
  }

  rebuild(): void {
    this.disposeGroup(this.roomGroup);
    this.roomGroup.clear();
    this.disposeGroup(this.itemsGroup);
    this.itemsGroup.clear();
    this.itemEntries.clear();
    // fresh materials come back untinted, so nothing is applied any more
    this.appliedTints.clear();
    this.walls = [];
    this.joints = [];
    this.ceilings = [];

    this.buildRooms();
    // one hosting pass per rebuild: appliance cutouts/niches + merged worktops
    const hosting = hostContexts(this.store.design);
    for (const item of this.store.design.items) this.buildItem(item, hosting.get(item.id));
    this.relight();
    this.applySelectionTint();

    // the very first room after a blank start has nothing framed yet — every
    // later rebuild keeps whatever pose the user left the camera in
    const hasRooms = this.store.design.rooms.length > 0;
    if (hasRooms && !this.hadRooms) this.setPreset('corner');
    this.hadRooms = hasRooms;
  }

  private buildRooms(): void {
    const design = this.store.design;
    const chains = design.walls ?? [];
    // the shared ground disc only shows once there is something standing on it
    this.ground.visible = design.rooms.length > 0 || chains.length > 0;
    if (!design.rooms.length && !chains.length) return;

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
      const floorFin = resolveFinish(
        design,
        style.floorColor,
        style.floorMaterial,
        style.floorMaterialRot
      );
      const floorMat = stampShell(
        floorFin.material
          ? surfMat(floorFin)
          : new THREE.MeshStandardMaterial({ color: floorFin.color, roughness: 0.88 }),
        'floor'
      );
      floorMat.side = THREE.DoubleSide;
      const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), floorMat);
      floor.rotation.x = Math.PI / 2;
      floor.receiveShadow = true;
      floor.name = 'Floor';
      this.roomGroup.add(floor);

      // ceiling (only visible from below)
      const ceil = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        stampShell(new THREE.MeshStandardMaterial({ color: '#f6f5f1', roughness: 0.95 }), 'ceiling')
      );
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = H;
      ceil.name = 'Ceiling';
      this.roomGroup.add(ceil);
      this.ceilings.push({ roomId: room.id, mesh: ceil, height: H });

      for (const g of walls) {
        // a partition is built once, under the room that owns it
        if (g.roomId !== room.id || (g.shared && !g.shared.owner)) continue;
        this.buildWallGroup(g, style, H, room.id, ++wallIdx);
      }
    }

    // ---- free-standing chains ----
    // They own no floor, no ceiling and no room finish, so they borrow the
    // active room's wall style (the design's first room otherwise) and their
    // own height. Same builder as a room wall — a divider is not special
    // geometry, only unowned geometry.
    if (chains.length) {
      const host = roomById(design.rooms, this.store.activeRoomId) ?? design.rooms[0];
      const style = host?.style ?? defaultRoomStyle();
      const byChain = new Map(chains.map((c) => [c.id, c]));
      for (const g of walls) {
        if (!g.freeWallId) continue;
        const H = byChain.get(g.freeWallId)?.height ?? style.wallHeight;
        this.buildWallGroup(g, style, H, null, ++wallIdx);
      }
    }

    this.buildJoints(walls);
  }

  /**
   * One wall's group: the slab in segments around its openings, plus the
   * openings themselves. Shared by ROOM walls and free-standing chains — a
   * divider is the same geometry with no room behind it, so the only things
   * the caller supplies are the finish, the height and the owning room id
   * (null for a chain).
   */
  private buildWallGroup(
    g: RoomWall,
    style: RoomStyle,
    H: number,
    roomId: string | null,
    idx: number
  ): void {
    const design = this.store.design;
    // a partition is built once, under the room that owns it
    const t = g.thickness;
    // corners are the room-side wall FACE, so the slab hangs outside it
    const zc = g.faceOffset - t / 2;

    const group = new THREE.Group();
    group.name = `Wall_${idx}`;
    group.position.set(g.a.x, 0, g.a.y);
    group.rotation.y = -g.angle;

    const wallFin = resolveFinish(
      design,
      style.wallColor,
      style.wallMaterial,
      style.wallMaterialRot
    );
    const wallMat = stampShell(
      wallFin.material
        ? surfMat(wallFin)
        : new THREE.MeshStandardMaterial({ color: wallFin.color, roughness: 0.94 }),
      'wall'
    );
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

    // butt ends: the slab spans exactly [0, len] and buildJoints fills the
    // corners, so opening offsets keep measuring from the true wall start
    let cursor = 0;
    for (const o of openings) {
      const oL = o.offset - o.width / 2;
      const oR = o.offset + o.width / 2;
      addSeg(cursor, oL, 0, H);
      if (o.sill > 0.01) addSeg(oL, oR, 0, o.sill);
      addSeg(oL, oR, o.sill + o.height, H);
      this.buildOpening(group, o, t, zc);
      cursor = oR;
    }
    addSeg(cursor, g.len, 0, H);

    this.roomGroup.add(group);
    const mid = wallPoint(g, g.len / 2);
    this.walls.push({
      id: g.id,
      roomId,
      twinRoomId: g.shared?.roomId ?? null,
      group,
      inward: new THREE.Vector3(g.inward.x, 0, g.inward.y),
      mid: new THREE.Vector3(mid.x, H / 2, mid.y),
      height: H,
    });
  }

  /**
   * One prism per welded junction, filling what the butt-ended slabs leave open
   * at partition tees, four-room crossings and oblique corners. The patch
   * outline is pure model geometry (`wallJoints`); here it only gains a height
   * — the tallest room meeting there — and a material. Junction rooms virtually
   * always share a style, so the first incident wall's room supplies the wall
   * finish rather than blending several. The material is polygon-offset because
   * a patch may sit flush inside a slab it also fills past.
   */
  private buildJoints(walls: RoomWall[]): void {
    const design = this.store.design;
    const byWallId = new Map(this.walls.map((w) => [w.id, w]));
    for (const j of wallJoints(walls)) {
      const styles = j.walls.flatMap((w) =>
        [w.roomId, w.shared?.roomId].flatMap((id) => {
          const style = id ? roomById(design.rooms, id)?.style : undefined;
          return style ? [style] : [];
        })
      );
      // a junction between free-standing chains has no room style to take —
      // fall back to the active room's, or the default, rather than leaving
      // the corner open
      if (!styles.length) {
        const host = roomById(design.rooms, this.store.activeRoomId) ?? design.rooms[0];
        styles.push(host?.style ?? defaultRoomStyle());
      }
      const h = Math.max(...styles.map((s) => s.wallHeight));
      const fin = resolveFinish(
        design,
        styles[0].wallColor,
        styles[0].wallMaterial,
        styles[0].wallMaterialRot
      );
      const mat = stampShell(
        fin.material
          ? surfMat(fin)
          : new THREE.MeshStandardMaterial({ color: fin.color, roughness: 0.94 }),
        'wall'
      );
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
      const mesh = prism(this.roomGroup, j.hull, h, mat, 0);
      mesh.name = 'WallJoint';
      const entries = j.walls.flatMap((w) => {
        const e = byWallId.get(w.id);
        return e ? [e] : [];
      });
      this.joints.push({ mesh, walls: entries });
    }
  }

  private buildOpening(wallGroup: THREE.Group, o: Opening, t: number, zc: number): void {
    // one frame material for jambs, head, sill and mullion, doors included
    const frameMat = stampMaterial(
      new THREE.MeshStandardMaterial({ color: '#e7e0d2', roughness: 0.7 }),
      { kind: 'product', product: 'window-frame' }
    );
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
        stampMaterial(
          new THREE.MeshStandardMaterial({
            color: '#cfe4ef',
            roughness: 0.08,
            metalness: 0.1,
            transparent: true,
            opacity: 0.32,
          }),
          { kind: 'product', product: 'window-glass' }
        )
      );
      glass.position.set(0, o.sill + o.height / 2, 0);
      g.add(glass);
      const mullion = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, o.height - fw * 2, 0.035),
        frameMat
      );
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
        stampMaterial(new THREE.MeshStandardMaterial({ color: '#ece7db', roughness: 0.6 }), {
          kind: 'product',
          product: 'door-leaf',
        })
      );
      slab.position.set((sign * (o.width - fw * 2)) / 2, (o.height - fw) / 2, 0);
      slab.castShadow = true;
      leaf.add(slab);
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 12, 10),
        stampMaterial(
          new THREE.MeshStandardMaterial({ color: '#2b2b28', roughness: 0.3, metalness: 0.7 }),
          { kind: 'product', product: 'door-knob' }
        )
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
        target.position.set(SPOT_AIM.x, SPOT_AIM.y, SPOT_AIM.z);
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
    this.itemEntries.set(item.id, { group, light, bulbs, units });
    this.placeItem(item);
  }

  /** Push the open-front view state to every unit; the RAF loop animates. */
  private applyFrontPoses(): void {
    for (const [id, entry] of this.itemEntries) {
      if (entry.units.length) {
        setFrontPoses(entry.units, (unit) => this.store.openFronts.isOpen(id, unit));
      }
    }
  }

  /** Double-click a door/drawer front: toggle its open preview. */
  private onDblClick(e: MouseEvent): void {
    // armed placement owns clicks — a dblclick would already have placed items
    if (this.getArmed()) return;
    const ray = this.pointerRay(e);
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
    for (const [itemId, entry] of this.itemEntries) {
      for (const u of entry.units) {
        yield { itemId, unit: u.userData.motionUnit as string };
      }
    }
  }

  private placeItem(item: Item): void {
    const entry = this.itemEntries.get(item.id);
    if (!entry) return;
    const def = this.store.defOf(item.defId);
    const y = itemBaseY(this.store.design, item, def);
    entry.group.position.set(item.x, y, item.y);
    entry.group.rotation.y = -item.rotation;
  }

  /** Non-structural refresh: transforms + light parameters + day/night. */
  private softUpdate(): void {
    for (const item of this.store.design.items) this.placeItem(item);
    this.relight();
    // dragging an item in or out of a clash changes nothing structural
    this.applyTints();
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
    const span = Math.max(
      8,
      (Math.max(...xs) - Math.min(...xs)) / 2 + 2,
      (Math.max(...ys) - Math.min(...ys)) / 2 + 2
    );
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
      const entry = this.itemEntries.get(item.id);
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
    // procedural image-based environment for reflections + soft fill (no asset files)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    const target = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = target.texture;
    this.disposeGroup(envScene); // frees the throwaway env geometry/materials
    pmrem.dispose(); // the baked texture outlives the generator's scratch targets
  }

  /**
   * A lost GPU context (driver reset, tab backgrounded too long) leaves every
   * buffer dead. preventDefault asks the browser to hand a new context back;
   * everything is rebuilt from the store on top of it. The curtain itself is
   * per-canvas (bindCanvas); only the listeners follow the attach cycle.
   */
  private initContextLoss(canvas: HTMLCanvasElement, signal: AbortSignal): void {
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        this.contextLost = true;
        if (this.lostOverlay) this.lostOverlay.hidden = false;
      },
      { signal }
    );
    canvas.addEventListener(
      'webglcontextrestored',
      () => {
        this.contextLost = false;
        if (this.lostOverlay) this.lostOverlay.hidden = true;
        this.rebuild(); // relights as part of the rebuild
      },
      { signal }
    );
  }

  /** Writes (or clears, with `null`) an item's emissive tint. Bulbs keep their glow. */
  private setTint(id: string, color: string | null): void {
    const entry = this.itemEntries.get(id);
    if (!entry) return;
    entry.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const m = mesh.material as THREE.MeshStandardMaterial | undefined;
      if (!m || !('emissive' in m) || mesh.userData.bulb) return;
      m.emissive.set(color ?? '#000000');
      m.emissiveIntensity = color ? 0.45 : 1;
    });
  }

  /**
   * The one place tints are decided: selection first, then the worst spatial
   * warning naming the item. Only the difference against what is already on the
   * materials is written, so this is cheap enough to run on every soft update.
   */
  private applyTints(): void {
    const want = new Map<string, string>();
    for (const w of this.store.warnings()) {
      if (w.severity === 'info') continue;
      const color = w.severity === 'error' ? TINT_ERROR : TINT_WARN;
      // an error outranks a warn on the same item, whatever order they arrive in
      for (const id of w.itemIds) if (color === TINT_ERROR || !want.has(id)) want.set(id, color);
    }
    // every member of the selection reads as selected; the gizmo below still
    // belongs to the primary alone
    for (const id of this.editor.selectedItemIds()) want.set(id, TINT_SELECTED);

    for (const id of this.appliedTints.keys()) if (!want.has(id)) this.setTint(id, null);
    for (const [id, color] of want) {
      if (this.appliedTints.get(id) !== color) this.setTint(id, color);
    }
    this.appliedTints = want;
  }

  private applySelectionTint(): void {
    this.applyTints();
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
      if (e.value) {
        const id = this.gizmo.object?.userData.itemId as string | undefined;
        if (id) this.beginFollowers(id);
      } else {
        this.followers = null;
        this.store.commit(); // gesture end → one undo step
      }
    });
    // handle move → write the group's world position back to the model
    g.addEventListener('objectChange', () => this.onGizmoChange());
  }

  /**
   * THE horizontal move path, shared by the gizmo handles and the body drag:
   * route (x, y) through the same snapper the plan uses — so both still hug
   * walls and click to neighbouring cabinets — and write the result
   * TRANSIENTLY. Transient is the contract: no rebuild, no undo step and no
   * inspector re-render until the gesture's pointerup commits.
   *
   * `glue` sees the snapped pose BEFORE the write, because the write re-places
   * the item group (softUpdate → placeItem) and must have the last word: a
   * spot's group sits at the ceiling, not at the elevation the caller passed.
   */
  private snapMoveItem(
    id: string,
    x: number,
    y: number,
    elevation: number,
    glue?: (res: SnapResult) => void
  ): void {
    const it = this.store.itemById(id);
    if (!it) return;
    const def = this.store.defOf(it.defId);
    const res = snapItem(this.store, def, id, x, y, it.rotation);
    glue?.(res);
    this.store.updateItem(
      id,
      { x: res.x, y: res.y, rotation: res.rotation, elevation, roomId: res.roomId },
      { structural: false, transient: true }
    );
    this.moveFollowers(res.x, res.y);
  }

  /**
   * Capture where the rest of the selection starts, so a 3D move can hand them
   * the lead item's delta — the same rule the plan applies, from the same
   * poses-at-press-time reasoning (the lead is re-snapped every frame).
   * `withoutCarried` drops an appliance its host is already carrying.
   */
  private beginFollowers(leadId: string): void {
    const lead = this.store.itemById(leadId);
    const held = this.editor
      .selectedItemIds()
      .map((id) => this.store.itemById(id))
      .filter((it): it is Item => !!it);
    if (!lead || held.length < 2) {
      this.followers = null;
      return;
    }
    const rest = withoutCarried(held).filter((it) => it.id !== leadId);
    this.followers = rest.length
      ? { ax: lead.x, ay: lead.y, rest: rest.map((it) => ({ id: it.id, x0: it.x, y0: it.y })) }
      : null;
  }

  private moveFollowers(x: number, y: number): void {
    const f = this.followers;
    if (!f) return;
    const dx = x - f.ax;
    const dy = y - f.ay;
    for (const r of f.rest) {
      this.store.updateItem(
        r.id,
        { x: r.x0 + dx, y: r.y0 + dy },
        { structural: false, transient: true }
      );
    }
  }

  private onGizmoChange(): void {
    const obj = this.gizmo.object;
    if (!obj) return;
    const id = obj.userData.itemId as string | undefined;
    if (!id) return;
    const elevation = Math.max(0, obj.position.y); // never below the floor
    this.snapMoveItem(id, obj.position.x, obj.position.z, elevation, (res) => {
      // glue the gizmo handle to the snapped pose so it doesn't drift from the item
      obj.position.set(res.x, elevation, res.y);
    });
  }

  /** Attach the gizmo to the selected item's group, or detach when nothing is selected. */
  private updateGizmo(): void {
    if (!this.gizmo) return; // selection tint runs once before the gizmo exists
    const sel = this.editor.selection;
    const entry = sel.kind === 'item' ? this.itemEntries.get(sel.id) : undefined;
    // attached appliances derive their pose from the host — no move gizmo
    const attached = sel.kind === 'item' && !!this.store.itemById(sel.id)?.attach;
    if (entry && !attached) this.gizmo.attach(entry.group);
    else this.gizmo.detach();
  }

  /* ---------------- picking & dragging ---------------- */

  // MouseEvent, not PointerEvent: only clientX/clientY are read, and the
  // dblclick / contextmenu paths hand it a plain MouseEvent.
  private pointerRay(e: MouseEvent): THREE.Raycaster {
    this.flushRebuild(); // picking must hit the geometry the user is looking at
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

  /**
   * The item under a pointer event, or null. Public because the context menu
   * (src/ui/react/ContextMenu.tsx) is the 3D counterpart of `Plan2D.hitAt`:
   * one raycast against the SAME item group the click path uses, so the menu
   * can never disagree with what a left-click would have selected.
   */
  pickItem(e: MouseEvent): Item | null {
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
          this.editor.select({ kind: 'item', id: item.id });
          this.store.commit();
          if (!e.shiftKey) this.clearArmed();
          return;
        }
        const snapped = snapItem(this.store, armed, null, p.x, p.z, 0);
        const item = this.store.addItem(armed, snapped.x, snapped.y, snapped.rotation);
        item.roomId = snapped.roomId;
        this.editor.select({ kind: 'item', id: item.id });
        this.store.commit();
        if (!e.shiftKey) this.clearArmed();
      }
      return;
    }

    const item = this.pickItem(e);
    if (!item) return; // empty space: OrbitControls orbits, pointerup deselects

    // Direct manipulation: dragging the body of the item that is ALREADY
    // selected moves it across the floor, the free-move complement of the
    // gizmo's axis-constrained handles. The FIRST click on an item only
    // selects (and arms the gizmo), so select-then-drag is a deliberate two
    // step and a click meant to select can never move anything. An attached
    // appliance derives its pose from its host and is refused here for the
    // same reason updateGizmo() refuses it a gizmo.
    const ref = { kind: 'item', id: item.id } as const;
    if (this.editor.isSelected(ref) && !item.attach) {
      const p = this.floorPoint(e);
      if (p) {
        // pressing a member of a group leads with it, so the gizmo and the
        // snapper act on the item actually under the pointer
        this.editor.setPrimary(ref);
        this.beginMoveDrag(e, item, p);
        return;
      }
    }
    this.editor.select({ kind: 'item', id: item.id });
  }

  /**
   * Take the gesture away from OrbitControls for a body drag.
   *
   * OrbitControls has ALREADY seen this pointerdown — it binds in bindCanvas(),
   * before attach() adds these listeners — but clearing `enabled` now still
   * stops the orbit, because its move handler re-checks the flag on every
   * event. That is the same trick the gizmo's 'dragging-changed' plays.
   */
  private beginMoveDrag(e: PointerEvent, item: Item, floor: THREE.Vector3): void {
    this.moveDrag = {
      id: item.id,
      pointerId: e.pointerId,
      grabX: item.x - floor.x,
      grabY: item.y - floor.z,
      orbitWasEnabled: this.controls.enabled,
      moved: false,
    };
    this.controls.enabled = false;
    this.beginFollowers(item.id);
    const canvas = this.boundCanvas;
    if (canvas && !canvas.hasPointerCapture(e.pointerId)) canvas.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.moveDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    // under the slop this is still a click: move nothing yet
    if (!drag.moved) {
      if (this.downPos.distanceTo(this.curPos.set(e.clientX, e.clientY)) < CLICK_SLOP_PX) return;
      drag.moved = true;
    }
    const p = this.floorPoint(e);
    const it = this.store.itemById(drag.id);
    if (!p || !it) return;
    // a floor drag is x/y only — the item keeps whatever elevation it had
    this.snapMoveItem(drag.id, p.x + drag.grabX, p.z + drag.grabY, it.elevation);
  }

  /**
   * End a body drag: one undo step for the whole gesture, then hand orbit
   * back. Returns whether the item actually moved — a gesture under the slop
   * is a click, and its pointerup still owes the click behaviour below.
   */
  private endMoveDrag(): boolean {
    const drag = this.moveDrag;
    if (!drag) return false;
    this.moveDrag = null;
    this.followers = null;
    this.controls.enabled = drag.orbitWasEnabled;
    const canvas = this.boundCanvas;
    if (canvas?.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    // the transient writes already changed the design; only a commit makes
    // them one undo step, so a cancelled drag commits exactly like a finished one
    if (drag.moved) this.store.commit();
    return drag.moved;
  }

  private onPointerCancel(e: PointerEvent): void {
    if (this.moveDrag?.pointerId === e.pointerId) this.endMoveDrag();
  }

  private onPointerUp(e: PointerEvent): void {
    // a body drag owns this gesture; only a sub-slop one falls through as a click
    if (this.moveDrag && this.endMoveDrag()) return;
    // gizmo drag/click resolves in its own handler — never treat it as a deselect
    if (this.gizmo.axis || this.gizmo.dragging) return;
    // a click (not a drag-orbit) on empty space clears the selection
    if (
      e.button === 0 &&
      this.downPos.distanceTo(this.curPos.set(e.clientX, e.clientY)) < CLICK_SLOP_PX
    ) {
      if (!this.pickItem(e)) this.editor.select({ kind: 'none' });
    }
  }

  /**
   * The item a body drag is currently moving, or null. Read-only test seam
   * (e2e/3d-move.spec.ts): a free move, an orbit and a gizmo drag are three
   * different gestures over the same pixels, and none of them is visible in
   * the DOM.
   */
  get movingItemId(): string | null {
    return this.moveDrag?.id ?? null;
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
    this.flushRebuild();
    const gizmoVisible = this.gizmo.visible;
    this.gizmo.visible = false; // keep the move handles out of the exported image
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.gizmo.visible = gizmoVisible;
    return url;
  }

  /**
   * The camera as the render worker needs it: plain numbers in the glTF/three
   * world frame, vertical fov, and the aspect the pose was framed at. Geometry
   * is irrelevant to a camera, so this deliberately does NOT flush a rebuild.
   * A view that never attached has no OrbitControls and therefore no target —
   * a point down the forward axis stands in for one.
   */
  cameraPose(): ManifestCamera {
    const cam = this.camera;
    const p = cam.position;
    const controls = this.controls as OrbitControls | undefined;
    const t =
      controls?.target ??
      cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(CAMERA_TARGET_FALLBACK_M).add(p);
    return {
      position: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      up: { x: 0, y: 1, z: 0 },
      fovYDeg: cam.fov,
      viewportAspect: cam.aspect,
      nearM: cam.near,
      farM: cam.far,
    };
  }

  /**
   * Hand `fn` an export-ready CLONE of the design: tints cleared (so none bakes
   * into the exported materials), doors and drawers snapped closed (an open
   * preview is view state, not model), light sources and the helper ground disc
   * stripped. The clone shares its materials and geometry with the live scene —
   * a caller may re-point `mesh.material`, but must never mutate one in place.
   * The tints are restored whatever `fn` does.
   */
  private async withExportRoot<T>(fn: (root: THREE.Group) => Promise<T>): Promise<T> {
    const tinted = new Map(this.appliedTints);
    for (const id of tinted.keys()) this.setTint(id, null);
    this.appliedTints.clear();
    try {
      const root = new THREE.Group();
      root.name = 'Design';
      const roomClone = this.roomGroup.clone(true);
      roomClone.name = 'Rooms';
      const allUnits = [...this.itemEntries.values()].flatMap((e) => e.units);
      const itemsClone = withClosedPoses(allUnits, () => this.itemsGroup.clone(true));
      itemsClone.name = 'Furniture';
      root.add(roomClone, itemsClone);

      const toRemove: THREE.Object3D[] = [];
      root.traverse((o) => {
        if ((o as THREE.Light).isLight || o.name === 'Ground') toRemove.push(o);
      });
      for (const o of toRemove) o.parent?.remove(o);

      return await fn(root);
    } finally {
      for (const [id, color] of tinted) this.setTint(id, color);
      this.appliedTints = tinted;
    }
  }

  /**
   * Export the fully modelled interior (room shells + every item) as binary
   * glTF for Blender. Light sources and the helper ground disc are stripped —
   * materials and lighting are meant to be authored in Blender.
   */
  async exportGLB(): Promise<Blob> {
    this.flushRebuild();
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    return this.withExportRoot(async (root) => {
      const buffer = (await new GLTFExporter().parseAsync(root, {
        binary: true,
      })) as ArrayBuffer;
      return new Blob([buffer], { type: 'model/gltf-binary' });
    });
  }

  /**
   * Fold every material of an export clone down to ONE instance per semantic
   * name. Materials are minted per surface, so the same oak reaches the
   * exporter a few hundred times and GLTFExporter — which dedupes by instance —
   * writes a glTF material for each; keyed by name instead, the demo design
   * collapses to a couple of dozen. With `stripMaps` the canonical instance is
   * a CLONE with its procedural canvas maps removed (they would embed as PNGs,
   * and the worker rebuilds the real texture set from the name anyway) — the
   * clone matters: the live scene shares these material objects.
   *
   * Materials with no `.name` (nothing in this codebase mints one, but a stray
   * three.js default would) are left exactly where they are, never merged with
   * each other, and only counted.
   */
  private canonicalizeMaterials(
    root: THREE.Object3D,
    stripMaps: boolean
  ): {
    canonical: { name: string; material: THREE.Material; meshCount: number }[];
    clones: THREE.Material[];
    unnamedMeshCount: number;
  } {
    const byName = new Map<string, { name: string; material: THREE.Material; meshCount: number }>();
    const clones: THREE.Material[] = [];
    let unnamedMeshCount = 0;

    const canon = (m: THREE.Material): THREE.Material => {
      if (!m.name) {
        unnamedMeshCount++;
        return m;
      }
      const hit = byName.get(m.name);
      if (hit) {
        hit.meshCount++;
        return hit.material;
      }
      let material = m;
      if (stripMaps) {
        const c = m.clone() as THREE.MeshStandardMaterial;
        c.map = null;
        c.bumpMap = null;
        clones.push(c);
        material = c;
      }
      byName.set(m.name, { name: m.name, material, meshCount: 1 });
      return material;
    };

    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(canon);
      else mesh.material = canon(mesh.material);
    });
    return { canonical: [...byName.values()], clones, unnamedMeshCount };
  }

  /**
   * The render-package GLB: the same geometry `exportGLB` writes, but with one
   * material per semantic name and no baked texture images, plus the material
   * table the render manifest carries. A name that does not parse stays on the
   * mesh in the GLB (the worker keeps its imported colour) but is left out of
   * the table — the manifest only describes materials it can speak for.
   */
  async exportRenderGLB(): Promise<{ blob: Blob; materials: ManifestMaterial[] }> {
    this.flushRebuild();
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    return this.withExportRoot(async (root) => {
      const { canonical, clones } = this.canonicalizeMaterials(root, true);
      let buffer: ArrayBuffer;
      try {
        buffer = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
      } finally {
        for (const c of clones) c.dispose();
      }

      const materials: ManifestMaterial[] = [];
      for (const entry of canonical) {
        const desc = parseMaterialName(entry.name);
        if (!desc) continue;
        const color = (entry.material as THREE.MeshStandardMaterial).color;
        materials.push({
          name: entry.name,
          kind: desc.kind,
          matId: desc.kind === 'library' || desc.kind === 'shell' ? desc.matId : undefined,
          // a product name carries no colour of its own, so it answers with the
          // one the viewport actually shows
          baseColorHex: desc.kind === 'product' ? (color?.getHexString() ?? '000000') : desc.hex6,
          rot:
            desc.kind === 'library'
              ? desc.rot
              : desc.kind === 'shell'
                ? (desc.rot ?? false)
                : false,
          fallback: desc.kind === 'plain' ? desc.fallback : undefined,
          surface: desc.kind === 'shell' ? desc.surface : undefined,
          product: desc.kind === 'product' ? desc.product : undefined,
          meshCount: entry.meshCount,
        });
      }
      return { blob: new Blob([buffer], { type: 'model/gltf-binary' }), materials };
    });
  }
}

export { shade };
