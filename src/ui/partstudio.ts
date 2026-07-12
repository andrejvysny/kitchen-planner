import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COUNTER_COLORS, FRONT_COLORS, OAK, WALNUT } from '../model/catalog';
import { newCustomPart, templateParams, toCatalogDef, TEMPLATE_LABELS } from '../model/parts';
import type { Store } from '../model/store';
import type { CustomPartDef, Item, RoomStyle } from '../model/types';
import { buildItemGroup } from '../view3d/itemMeshes';

const PREVIEW_ROOM: RoomStyle = {
  wallColor: '#f4f1ea',
  floorColor: '#cfccc6',
  counterColor: '#c9a87c',
  wallHeight: 2.6,
  wallThickness: 0.1,
};

/**
 * Part Studio: a small modal editor where users create and edit their own
 * parametric parts (cabinets, drawer units, shelving, desks) with a live
 * 3D preview. Saved parts appear in the "My parts" catalog section.
 */
export class PartStudio {
  private store: Store;
  private onClose: () => void;
  private overlay: HTMLElement | null = null;
  private part!: CustomPartDef;
  private isNew = true;
  private originalJson = '';

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private meshGroup: THREE.Group | null = null;
  private raf = 0;
  private formEl: HTMLElement | null = null;

  constructor(store: Store, onClose: () => void) {
    this.store = store;
    this.onClose = onClose;
  }

  isOpen(): boolean {
    return !!this.overlay;
  }

  open(existing?: CustomPartDef): void {
    if (!this.close()) return;
    this.part = existing ? JSON.parse(JSON.stringify(existing)) : newCustomPart();
    this.isNew = !existing;
    this.originalJson = JSON.stringify(this.part);

    const overlay = document.createElement('div');
    overlay.className = 'studio-overlay';
    overlay.innerHTML = `
      <div class="studio">
        <div class="studio-head">
          <input class="studio-name" type="text" maxlength="32" />
          <div class="studio-templates"></div>
          <button class="studio-x" title="Close">✕</button>
        </div>
        <div class="studio-body">
          <div class="studio-form"></div>
          <div class="studio-preview"><canvas></canvas><div class="studio-preview-hint">drag to orbit</div></div>
        </div>
        <div class="studio-foot">
          <button class="btn danger studio-delete">Delete part</button>
          <span style="flex:1"></span>
          <button class="btn studio-cancel">Cancel</button>
          <button class="btn primary studio-save">${existing ? 'Save changes' : 'Add to my parts'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const name = overlay.querySelector('.studio-name') as HTMLInputElement;
    name.value = this.part.name;
    name.addEventListener('input', () => (this.part.name = name.value || 'Part'));

    const templates = overlay.querySelector('.studio-templates') as HTMLElement;
    for (const key of ['cabinet', 'desk'] as const) {
      const b = document.createElement('button');
      b.textContent = TEMPLATE_LABELS[key];
      b.className = this.part.template === key ? 'active' : '';
      b.addEventListener('click', () => {
        if (this.part.template !== key) {
          const preserved = { id: this.part.id, name: this.part.name, color: this.part.color, accentColor: this.part.accentColor };
          this.part = { ...newCustomPart(key), ...preserved, template: key };
          templates.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          this.renderForm();
          this.refreshPreview();
        }
      });
      templates.appendChild(b);
    }

    (overlay.querySelector('.studio-x') as HTMLElement).addEventListener('click', () => this.close());
    (overlay.querySelector('.studio-cancel') as HTMLElement).addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();
    });

    const del = overlay.querySelector('.studio-delete') as HTMLButtonElement;
    if (this.isNew || !this.store.customPartById(this.part.id)) del.style.display = 'none';
    del.addEventListener('click', () => {
      const used = this.store.design.items.filter((i) => i.defId === this.part.id).length;
      const msg = used
        ? `Delete this part and its ${used} placed ${used === 1 ? 'copy' : 'copies'}?`
        : 'Delete this part?';
      if (!confirm(msg)) return;
      this.store.deleteCustomPart(this.part.id);
      this.store.commit();
      this.close(true);
    });

    (overlay.querySelector('.studio-save') as HTMLElement).addEventListener('click', () => {
      this.store.upsertCustomPart(JSON.parse(JSON.stringify(this.part)));
      this.store.commit();
      this.close(true);
    });

    this.formEl = overlay.querySelector('.studio-form') as HTMLElement;
    this.renderForm();
    this.initPreview(overlay.querySelector('canvas') as HTMLCanvasElement);
  }

  /** Close the studio. Unsaved edits ask for confirmation unless `force`. Returns false if kept open. */
  close(force = false): boolean {
    if (this.overlay && !force && JSON.stringify(this.part) !== this.originalJson) {
      if (!confirm('Discard your changes to this part?')) return false;
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene = null;
    this.overlay?.remove();
    this.overlay = null;
    this.onClose();
    return true;
  }

  /* ---------------- form ---------------- */

  private renderForm(): void {
    const form = this.formEl!;
    form.innerHTML = '';

    const section = (title: string): HTMLElement => {
      const s = document.createElement('div');
      s.className = 'prop-section';
      s.innerHTML = `<div class="prop-section-title">${title}</div>`;
      form.appendChild(s);
      return s;
    };

    const dims = section('Dimensions (cm)');
    const dimRow = (label: string, key: 'w' | 'd' | 'h', min: number, max: number) => {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.innerHTML = `<label>${label}</label>
        <input type="range" min="${min * 100}" max="${max * 100}" step="1" value="${Math.round(this.part[key] * 100)}">
        <input type="number" min="${min * 100}" max="${max * 100}" step="1" value="${Math.round(this.part[key] * 100)}">`;
      const range = row.querySelector('input[type=range]') as HTMLInputElement;
      const num = row.querySelector('input[type=number]') as HTMLInputElement;
      const apply = (v: number) => {
        this.part[key] = Math.min(max, Math.max(min, v / 100));
        range.value = num.value = String(Math.round(this.part[key] * 100));
        this.refreshPreview();
      };
      range.addEventListener('input', () => apply(Number(range.value)));
      num.addEventListener('change', () => apply(Number(num.value)));
      dims.appendChild(row);
    };
    dimRow('Width', 'w', 0.2, 3.0);
    dimRow('Depth', 'd', 0.2, 1.2);
    dimRow('Height', 'h', 0.2, 2.5);

    if (this.part.template === 'cabinet') {
      const row = document.createElement('div');
      row.className = 'prop-row';
      row.innerHTML = `<label>Wall-mounted</label><label class="switch"><input type="checkbox" ${this.part.elevation > 0.3 ? 'checked' : ''}><span class="track"></span></label>`;
      const cb = row.querySelector('input') as HTMLInputElement;
      cb.addEventListener('change', () => {
        this.part.elevation = cb.checked ? 1.45 : 0;
        this.refreshPreview();
      });
      dims.appendChild(row);
    }

    const opts = section('Configuration');
    for (const p of templateParams(this.part.template)) {
      const val = this.part.options[p.key] ?? p.def;
      if (p.min === 0 && p.max === 1) {
        const row = document.createElement('div');
        row.className = 'prop-row';
        row.innerHTML = `<label>${p.label}</label><label class="switch"><input type="checkbox" ${val ? 'checked' : ''}><span class="track"></span></label>`;
        const cb = row.querySelector('input') as HTMLInputElement;
        cb.addEventListener('change', () => {
          this.part.options[p.key] = cb.checked ? 1 : 0;
          this.refreshPreview();
        });
        opts.appendChild(row);
      } else {
        const row = document.createElement('div');
        row.className = 'prop-row';
        row.innerHTML = `<label>${p.label}</label>
          <div class="stepper"><button>−</button><span>${val}</span><button>+</button></div>`;
        const [minus, plus] = Array.from(row.querySelectorAll('button'));
        const span = row.querySelector('span') as HTMLElement;
        const apply = (v: number) => {
          this.part.options[p.key] = Math.min(p.max, Math.max(p.min, v));
          span.textContent = String(this.part.options[p.key]);
          this.refreshPreview();
        };
        minus.addEventListener('click', () => apply((this.part.options[p.key] ?? p.def) - 1));
        plus.addEventListener('click', () => apply((this.part.options[p.key] ?? p.def) + 1));
        opts.appendChild(row);
      }
    }

    const colors = section('Front colour');
    const sw = document.createElement('div');
    sw.className = 'swatches';
    for (const c of FRONT_COLORS) {
      const b = document.createElement('button');
      b.className = `swatch${this.part.color === c ? ' active' : ''}`;
      b.style.background = c;
      b.addEventListener('click', () => {
        this.part.color = c;
        sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.refreshPreview();
      });
      sw.appendChild(b);
    }
    colors.appendChild(sw);

    const accent = section('Wood accent (top / niches)');
    const sw2 = document.createElement('div');
    sw2.className = 'swatches';
    for (const c of [OAK, WALNUT, ...COUNTER_COLORS.slice(1, 3)]) {
      const b = document.createElement('button');
      b.className = `swatch${this.part.accentColor === c ? ' active' : ''}`;
      b.style.background = c;
      b.addEventListener('click', () => {
        this.part.accentColor = c;
        sw2.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.refreshPreview();
      });
      sw2.appendChild(b);
    }
    accent.appendChild(sw2);
  }

  /* ---------------- live preview ---------------- */

  private initPreview(canvas: HTMLCanvasElement): void {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eceae5');

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 40);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.1;
    canvas.addEventListener('pointerdown', () => {
      if (this.controls) this.controls.autoRotate = false;
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

    this.refreshPreview();

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.renderer || !this.scene || !this.camera) return;
      const parent = canvas.parentElement!;
      const w = parent.clientWidth || 300;
      const h = parent.clientHeight || 300;
      if (canvas.width !== w * (window.devicePixelRatio || 1)) {
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  private refreshPreview(): void {
    if (!this.scene || !this.camera || !this.controls) return;
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
      defId: this.part.id,
      x: 0,
      y: 0,
      rotation: 0,
      w: this.part.w,
      d: this.part.d,
      h: this.part.h,
      elevation: this.part.elevation,
      color: this.part.color,
      params: { ...this.part.options },
    };
    this.meshGroup = buildItemGroup(fake, toCatalogDef(this.part), PREVIEW_ROOM, this.part);
    this.meshGroup.position.y = this.part.elevation > 0.3 ? 0.6 : 0;
    this.scene.add(this.meshGroup);

    const focusY = this.meshGroup.position.y + this.part.h / 2;
    const r = Math.max(this.part.w, this.part.h, this.part.d) * 1.9 + 0.4;
    this.controls.target.set(0, focusY, 0);
    if (this.camera.position.length() < 0.1) this.camera.position.set(r, focusY + r * 0.35, r);
    else {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target.clone().add(dir.multiplyScalar(r)));
    }
    this.controls.update();
  }
}
