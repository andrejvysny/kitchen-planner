import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCatalogDef } from '../../model/parts';
import type { CustomPartDef, Item, RoomStyle } from '../../model/types';
import { buildItemGroup } from '../../view3d/itemMeshes';

const PREVIEW_ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

/**
 * The studio's live, orbitable 3D preview. Optionally reports clicks on
 * meshes tagged with `userData.boardId` (freeform board picking).
 */
export class StudioPreview {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private meshGroup: THREE.Group | null = null;
  private raf = 0;
  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private downAt: { x: number; y: number } | null = null;

  onPick: ((boardId: string | null) => void) | null = null;

  constructor(container: HTMLElement) {
    container.innerHTML = `<canvas></canvas><div class="studio-preview-hint">drag to orbit</div>`;
    this.canvas = container.querySelector('canvas') as HTMLCanvasElement;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eceae5');

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.1;

    this.canvas.addEventListener('pointerdown', (e) => {
      this.controls.autoRotate = false;
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this.downAt || !this.onPick) return;
      const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
      this.downAt = null;
      if (moved > 5) return;
      this.onPick(this.pick(e));
    });

    const hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a8', 0.9);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight('#fff2dd', 2.4);
    key.position.set(2.5, 3.5, 2.8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: '#dbd9d3', roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth || 300;
      const h = parent.clientHeight || 300;
      if (this.canvas.width !== w * (window.devicePixelRatio || 1)) {
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private pick(e: PointerEvent): string | null {
    if (!this.meshGroup) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    for (const hit of this.raycaster.intersectObjects(this.meshGroup.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        if (o.userData.boardId) return o.userData.boardId as string;
        o = o.parent;
      }
    }
    return null;
  }

  refresh(part: CustomPartDef, selectedBoardId?: string | null): void {
    if (this.meshGroup) {
      this.scene.remove(this.meshGroup);
      this.meshGroup.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    const fake: Item = {
      id: 'preview',
      defId: part.id,
      x: 0,
      y: 0,
      rotation: 0,
      w: part.w,
      d: part.d,
      h: part.h,
      elevation: part.elevation,
      color: part.color,
    };
    this.meshGroup = buildItemGroup(fake, toCatalogDef(part), PREVIEW_ROOM, part);
    this.meshGroup.position.y = part.elevation > 0.3 ? 0.6 : 0;
    if (selectedBoardId) {
      this.meshGroup.traverse((o) => {
        let owner: THREE.Object3D | null = o;
        while (owner && !owner.userData.boardId) owner = owner.parent;
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (owner?.userData.boardId === selectedBoardId && mat?.emissive) {
          mat.emissive.set('#2b8a78');
          mat.emissiveIntensity = 0.35;
        }
      });
    }
    this.scene.add(this.meshGroup);

    const focusY = this.meshGroup.position.y + part.h / 2;
    const r = Math.max(part.w, part.h, part.d) * 1.9 + 0.4;
    this.controls.target.set(0, focusY, 0);
    if (this.camera.position.length() < 0.1) {
      this.camera.position.set(r, focusY + r * 0.35, r);
    } else {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target.clone().add(dir.multiplyScalar(r)));
    }
    this.controls.update();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.controls.dispose();
    this.renderer.dispose();
  }
}
