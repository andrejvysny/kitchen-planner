import {
  CATALOG,
  COUNTER_COLORS,
  FLOOR_COLORS,
  FRONT_COLORS,
  WALL_COLORS,
  type CatalogDef,
} from '../model/catalog';
import { toCatalogDef } from '../model/parts';
import { demoDesign, emptyDesign, Store } from '../model/store';
import type { Item } from '../model/types';
import { renderThumbnail } from '../plan2d/symbols';
import type { Plan2D } from '../plan2d/plan2d';
import type { View3D, CamPreset } from '../view3d/view3d';
import { PartStudio } from './partstudio';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

export class UI {
  private store: Store;
  private plan: Plan2D;
  private view: View3D;
  private studio: PartStudio;

  constructor(store: Store, plan: Plan2D, view: View3D) {
    this.store = store;
    this.plan = plan;
    this.view = view;
    this.studio = new PartStudio(store, () => this.renderCatalog());

    this.renderCatalog();
    this.renderProps();
    this.wireTopbar();
    this.wireKeyboard();

    plan.onArmedChange = () => this.markArmedTile();
    store.on('selection', () => this.renderProps());
    store.on('history', () => {
      this.renderProps();
      this.renderCatalog();
      this.updateUndoButtons();
      this.updateInfo();
    });
    store.on('change', (info) => {
      this.updateInfo();
      if (info.transient) this.refreshPositionInputs();
    });
    this.updateUndoButtons();
    this.updateInfo();
  }

  /* ================= catalog ================= */

  private renderCatalog(): void {
    const root = $('#catalog-inner');
    root.innerHTML = '';

    const addSection = (title: string): HTMLElement => {
      const s = document.createElement('div');
      s.className = 'cat-section';
      s.innerHTML = `<div class="cat-title">${title}</div><div class="cat-grid"></div>`;
      root.appendChild(s);
      return s.querySelector('.cat-grid') as HTMLElement;
    };

    const addTile = (grid: HTMLElement, def: CatalogDef, editable = false): void => {
      const wrap = document.createElement('div');
      wrap.className = 'cat-item-wrap';
      const tile = document.createElement('div');
      tile.className = 'cat-item';
      tile.dataset.defId = def.id;
      const canvas = document.createElement('canvas');
      renderThumbnail(canvas, def.kind, def.w, def.d, def.color);
      tile.appendChild(canvas);
      const label = document.createElement('span');
      label.textContent = def.label;
      tile.appendChild(label);
      tile.addEventListener('click', () => {
        this.plan.setArmed(this.plan.armedDef?.id === def.id ? null : def);
      });
      wrap.appendChild(tile);
      if (editable) {
        const edit = document.createElement('button');
        edit.className = 'cat-edit';
        edit.textContent = '✎';
        edit.title = 'Edit this part';
        edit.addEventListener('click', (e) => {
          e.stopPropagation();
          this.plan.setArmed(null);
          this.studio.open(this.store.customPartById(def.id));
        });
        wrap.appendChild(edit);
      }
      grid.appendChild(wrap);
    };

    let first = true;
    for (const section of CATALOG) {
      const grid = addSection(section.title);
      for (const def of section.items) addTile(grid, def);
      if (first) {
        first = false;
        // "My parts" right after the room tools: create → sketch → furnish
        const grid2 = addSection('My parts');
        const newTile = document.createElement('div');
        newTile.className = 'cat-item cat-new';
        newTile.innerHTML = `<span style="font-size:20px">＋</span><span>New part</span>`;
        newTile.addEventListener('click', () => {
          this.plan.setArmed(null);
          this.studio.open();
        });
        grid2.appendChild(newTile);
        for (const part of this.store.design.customParts) {
          addTile(grid2, toCatalogDef(part), true);
        }
      }
    }
    this.markArmedTile();
  }

  private markArmedTile(): void {
    const armedId = this.plan.armedDef?.id;
    document.querySelectorAll<HTMLElement>('.cat-item').forEach((el) => {
      el.classList.toggle('armed', !!armedId && el.dataset.defId === armedId);
    });
  }

  /* ================= properties panel ================= */

  private renderProps(): void {
    const root = $('#props-inner');
    root.innerHTML = '';
    const sel = this.store.selection;

    if (sel.kind === 'item') {
      const item = this.store.itemById(sel.id);
      if (item) return this.renderItemProps(root, item);
    } else if (sel.kind === 'wall') {
      const wall = this.store.wallById(sel.id);
      if (wall) return this.renderWallProps(root, sel.id);
    } else if (sel.kind === 'opening') {
      const o = this.store.openingById(sel.id);
      if (o) return this.renderOpeningProps(root, sel.id);
    } else if (sel.kind === 'corner') {
      const c = this.store.cornerById(sel.id);
      if (c) return this.renderCornerProps(root, sel.id);
    }
    this.renderRoomProps(root);
  }

  private el(html: string): HTMLElement {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild as HTMLElement;
  }

  private section(root: HTMLElement, title: string): HTMLElement {
    const s = this.el(`<div class="prop-section"><div class="prop-section-title">${title}</div></div>`);
    root.appendChild(s);
    return s;
  }

  private numberRow(
    parent: HTMLElement,
    label: string,
    value: number,
    unit: string,
    onChange: (v: number) => void,
    opts: { min?: number; max?: number; step?: number; cls?: string } = {}
  ): HTMLInputElement {
    const row = this.el(`<div class="prop-row"><label>${label}</label>
      <input type="number" value="${value}" ${opts.min !== undefined ? `min="${opts.min}"` : ''}
        ${opts.max !== undefined ? `max="${opts.max}"` : ''} step="${opts.step ?? 1}"
        ${opts.cls ? `data-cls="${opts.cls}"` : ''}>
      <span class="unit">${unit}</span></div>`);
    const input = row.querySelector('input') as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      onChange(v);
      this.store.commit();
    });
    parent.appendChild(row);
    return input;
  }

  private swatchRow(
    parent: HTMLElement,
    colors: string[],
    current: string,
    onPick: (c: string) => void
  ): void {
    const sw = this.el('<div class="swatches"></div>');
    for (const c of colors) {
      const b = this.el(
        `<button class="swatch${current.toLowerCase() === c.toLowerCase() ? ' active' : ''}" style="background:${c}" title="${c}"></button>`
      );
      b.addEventListener('click', () => {
        onPick(c);
        this.store.commit();
      });
      sw.appendChild(b);
    }
    // free colour picker
    const pick = this.el(
      `<input type="color" value="${current}" title="Custom colour" style="width:26px;height:26px;border:none;border-radius:50%;padding:0;background:none;cursor:pointer">`
    ) as HTMLInputElement;
    pick.addEventListener('change', () => {
      onPick(pick.value);
      this.store.commit();
    });
    sw.appendChild(pick);
    parent.appendChild(sw);
  }

  private toggleRow(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
    const row = this.el(`<div class="toggle-row"><label>${label}</label>
      <label class="switch"><input type="checkbox" ${value ? 'checked' : ''}><span class="track"></span></label></div>`);
    const cb = row.querySelector('input') as HTMLInputElement;
    cb.addEventListener('change', () => {
      onChange(cb.checked);
      this.store.commit();
    });
    parent.appendChild(row);
  }

  private sliderRow(
    parent: HTMLElement,
    label: string,
    value: number,
    onInput: (v: number) => void
  ): void {
    const row = this.el(`<div class="prop-row"><label>${label}</label>
      <input type="range" min="0" max="1" step="0.01" value="${value}"></div>`);
    const r = row.querySelector('input') as HTMLInputElement;
    r.addEventListener('input', () => onInput(Number(r.value)));
    r.addEventListener('change', () => this.store.commit());
    parent.appendChild(row);
  }

  /* ---------- room ---------- */

  private renderRoomProps(root: HTMLElement): void {
    root.appendChild(this.el(`<h2 class="props-title">Room</h2>`));
    root.appendChild(
      this.el(`<p class="props-sub">${this.store.floorArea().toFixed(1)} m² · ${this.store.design.corners.length} corners</p>`)
    );

    const rect = this.store.rectangleSize();
    const size = this.section(root, 'Size');
    if (rect) {
      this.numberRow(size, 'Width', Math.round(rect.w * 100), 'cm', (v) =>
        this.store.setRectangleSize(v / 100, rect.d), { min: 100, max: 2000 });
      this.numberRow(size, 'Depth', Math.round(rect.d * 100), 'cm', (v) =>
        this.store.setRectangleSize(rect.w, v / 100), { min: 100, max: 2000 });
    } else {
      size.appendChild(this.el(`<p class="props-sub">Select a wall to edit its length, or drag corners in the plan.</p>`));
    }
    this.numberRow(size, 'Ceiling', Math.round(this.store.design.room.wallHeight * 100), 'cm', (v) =>
      this.store.setRoomStyle({ wallHeight: Math.min(4, Math.max(2, v / 100)) }), { min: 200, max: 400 });

    const shape = this.section(root, 'Room shape');
    const btns = this.el(`<div class="btn-row"><button class="btn">Rectangle</button><button class="btn">L-shape</button></div>`);
    const [rectBtn, lBtn] = Array.from(btns.querySelectorAll('button'));
    rectBtn.addEventListener('click', () => this.store.setShapePreset('rect'));
    lBtn.addEventListener('click', () => this.store.setShapePreset('lshape'));
    shape.appendChild(btns);
    shape.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Drag ■ corners to reshape · drag ◆ to bend a wall</p>`));

    const colors = this.section(root, 'Walls');
    this.swatchRow(colors, WALL_COLORS, this.store.design.room.wallColor, (c) =>
      this.store.setRoomStyle({ wallColor: c }));
    const floor = this.section(root, 'Floor');
    this.swatchRow(floor, FLOOR_COLORS, this.store.design.room.floorColor, (c) =>
      this.store.setRoomStyle({ floorColor: c }));
    const counter = this.section(root, 'Worktops');
    this.swatchRow(counter, COUNTER_COLORS, this.store.design.room.counterColor, (c) =>
      this.store.setRoomStyle({ counterColor: c }));

    root.appendChild(
      this.el(`<div class="props-empty-tip">
        <b>How to design your kitchen</b><br>
        1 · Sketch the room — size, corners, then place <b>doors, windows, water & outlets</b><br>
        2 · Add base units along the walls (they snap into runs)<br>
        3 · Stack wall cabinets & shelves above<br>
        4 · Place lights and try <b>☾ Night</b> to tune the mood<br>
        Create your own parametric furniture with <b>＋ New part</b></div>`)
    );
  }

  /* ---------- item ---------- */

  private renderItemProps(root: HTMLElement, item: Item): void {
    const def = this.store.defOf(item.defId);
    root.appendChild(this.el(`<h2 class="props-title">${def.label}</h2>`));
    root.appendChild(this.el(`<p class="props-sub">${def.kind === 'custom' ? 'Custom part' : 'Catalog item'}</p>`));

    // dimensions
    const dims = this.section(root, 'Dimensions');
    const dimRow = (label: string, key: 'w' | 'd' | 'h', range?: [number, number]) => {
      const input = this.numberRow(dims, label, Math.round(item[key] * 100), 'cm', (v) => {
        const clamped = range ? Math.min(range[1], Math.max(range[0], v / 100)) : v / 100;
        this.store.updateItem(item.id, { [key]: clamped } as Partial<Item>);
      }, range ? { min: range[0] * 100, max: range[1] * 100 } : {});
      if (!range) input.disabled = true;
    };
    dimRow('Width', 'w', def.resize.w);
    dimRow('Depth', 'd', def.resize.d);
    dimRow('Height', 'h', def.resize.h);
    if (def.elevAdjust) {
      this.numberRow(dims, 'Off floor', Math.round(item.elevation * 100), 'cm', (v) =>
        this.store.updateItem(item.id, {
          elevation: Math.min(def.elevAdjust![1], Math.max(def.elevAdjust![0], v / 100)),
        }), { min: def.elevAdjust[0] * 100, max: def.elevAdjust[1] * 100 });
    }

    // position
    const pos = this.section(root, 'Position');
    this.numberRow(pos, 'X', Math.round(item.x * 100), 'cm', (v) =>
      this.store.updateItem(item.id, { x: v / 100 }), { cls: 'pos-x' });
    this.numberRow(pos, 'Y', Math.round(item.y * 100), 'cm', (v) =>
      this.store.updateItem(item.id, { y: v / 100 }), { cls: 'pos-y' });
    const rotRow = this.el(`<div class="prop-row"><label>Rotate</label>
      <div class="stepper"><button title="Rotate left">⟲</button><span>${Math.round(((item.rotation * 180) / Math.PI) % 360)}°</span><button title="Rotate right">⟳</button></div></div>`);
    const [ccw, cw] = Array.from(rotRow.querySelectorAll('button'));
    ccw.addEventListener('click', () => {
      this.store.updateItem(item.id, { rotation: item.rotation - Math.PI / 2 }, { structural: false });
      this.store.commit();
    });
    cw.addEventListener('click', () => {
      this.store.updateItem(item.id, { rotation: item.rotation + Math.PI / 2 }, { structural: false });
      this.store.commit();
    });
    pos.appendChild(rotRow);

    // parametric options
    if (def.params?.length) {
      const opts = this.section(root, 'Configuration');
      for (const p of def.params) {
        const val = item.params?.[p.key] ?? p.def;
        const row = this.el(`<div class="prop-row"><label>${p.label}</label>
          <div class="stepper"><button>−</button><span>${val}</span><button>+</button></div></div>`);
        const [minus, plus] = Array.from(row.querySelectorAll('button'));
        const span = row.querySelector('span') as HTMLElement;
        const apply = (v: number) => {
          const nv = Math.min(p.max, Math.max(p.min, v));
          this.store.setItemParam(item.id, p.key, nv);
          span.textContent = String(nv);
          this.store.commit();
        };
        minus.addEventListener('click', () => apply((this.store.itemById(item.id)?.params?.[p.key] ?? p.def) - 1));
        plus.addEventListener('click', () => apply((this.store.itemById(item.id)?.params?.[p.key] ?? p.def) + 1));
        opts.appendChild(row);
      }
    }

    // colour
    if (!def.opening && !def.marker) {
      const colors = this.section(root, 'Colour');
      this.swatchRow(colors, FRONT_COLORS, item.color, (c) =>
        this.store.updateItem(item.id, { color: c }));
    }

    // light
    if (item.light) {
      const light = this.section(root, 'Light');
      this.toggleRow(light, 'On', item.light.on, (v) => this.store.updateItemLight(item.id, { on: v }));
      this.sliderRow(light, 'Brightness', item.light.intensity, (v) =>
        this.store.updateItemLight(item.id, { intensity: v }));
      this.sliderRow(light, 'Warmth', item.light.warmth, (v) =>
        this.store.updateItemLight(item.id, { warmth: v }));
    }

    // actions
    const actions = this.section(root, 'Actions');
    const row = this.el(`<div class="btn-row"><button class="btn">Duplicate</button><button class="btn danger">Delete</button></div>`);
    const [dup, del] = Array.from(row.querySelectorAll('button'));
    dup.addEventListener('click', () => {
      const copy = this.store.duplicateItem(item.id);
      if (copy) this.store.select({ kind: 'item', id: copy.id });
      this.store.commit();
    });
    del.addEventListener('click', () => {
      this.store.deleteItem(item.id);
      this.store.commit();
    });
    actions.appendChild(row);

    if (def.kind === 'custom') {
      const editRow = this.el(`<div class="btn-row"><button class="btn">Edit part template…</button></div>`);
      editRow.querySelector('button')!.addEventListener('click', () => {
        const part = this.store.customPartById(item.defId);
        if (part) this.studio.open(part);
      });
      actions.appendChild(editRow);
    }
  }

  private refreshPositionInputs(): void {
    const sel = this.store.selection;
    if (sel.kind !== 'item') return;
    const item = this.store.itemById(sel.id);
    if (!item) return;
    const x = document.querySelector<HTMLInputElement>('input[data-cls="pos-x"]');
    const y = document.querySelector<HTMLInputElement>('input[data-cls="pos-y"]');
    if (x && document.activeElement !== x) x.value = String(Math.round(item.x * 100));
    if (y && document.activeElement !== y) y.value = String(Math.round(item.y * 100));
  }

  /* ---------- wall / opening / corner ---------- */

  private renderWallProps(root: HTMLElement, wallId: string): void {
    const g = this.store.wallById(wallId)!;
    root.appendChild(this.el(`<h2 class="props-title">Wall</h2>`));
    root.appendChild(this.el(`<p class="props-sub">Interior length along this wall</p>`));
    const s = this.section(root, 'Size');
    this.numberRow(s, 'Length', Math.round(g.len * 100), 'cm', (v) =>
      this.store.setWallLength(wallId, Math.max(30, v) / 100), { min: 30, max: 3000 });
    this.numberRow(s, 'Thickness', Math.round(this.store.design.room.wallThickness * 100), 'cm', (v) =>
      this.store.setRoomStyle({ wallThickness: Math.min(0.4, Math.max(0.05, v / 100)) }), { min: 5, max: 40 });
    const a = this.section(root, 'Shape');
    const btn = this.el(`<div class="btn-row"><button class="btn">Add corner in the middle</button></div>`);
    btn.querySelector('button')!.addEventListener('click', () => {
      const nc = this.store.splitWall(wallId, g.len / 2);
      if (nc) {
        this.store.select({ kind: 'corner', id: nc.id });
        this.store.commit();
      }
    });
    a.appendChild(btn);
  }

  private renderOpeningProps(root: HTMLElement, id: string): void {
    const o = this.store.openingById(id)!;
    const g = this.store.wallById(o.wallId);
    root.appendChild(this.el(`<h2 class="props-title">${o.type === 'door' ? 'Door' : 'Window'}</h2>`));
    root.appendChild(this.el(`<p class="props-sub">Slides along its wall — drag it in the plan</p>`));
    const s = this.section(root, 'Size');
    this.numberRow(s, 'Width', Math.round(o.width * 100), 'cm', (v) =>
      this.store.updateOpening(id, { width: v / 100 }), { min: 30, max: 400 });
    this.numberRow(s, 'Height', Math.round(o.height * 100), 'cm', (v) =>
      this.store.updateOpening(id, { height: v / 100 }), { min: 30, max: 300 });
    if (o.type === 'window') {
      this.numberRow(s, 'Sill height', Math.round(o.sill * 100), 'cm', (v) =>
        this.store.updateOpening(id, { sill: v / 100 }), { min: 0, max: 250 });
    }
    if (g) {
      this.numberRow(s, 'From corner', Math.round(o.offset * 100), 'cm', (v) =>
        this.store.updateOpening(id, { offset: v / 100 }), { min: 0, max: Math.round(g.len * 100) });
    }
    const a = this.section(root, 'Actions');
    const del = this.el(`<div class="btn-row"><button class="btn danger">Delete</button></div>`);
    del.querySelector('button')!.addEventListener('click', () => {
      this.store.deleteOpening(id);
      this.store.commit();
    });
    a.appendChild(del);
  }

  private renderCornerProps(root: HTMLElement, id: string): void {
    const c = this.store.cornerById(id)!;
    root.appendChild(this.el(`<h2 class="props-title">Corner</h2>`));
    root.appendChild(this.el(`<p class="props-sub">Drag it in the plan, or set exact coordinates</p>`));
    const s = this.section(root, 'Position');
    this.numberRow(s, 'X', Math.round(c.x * 100), 'cm', (v) =>
      this.store.moveCorner(id, v / 100, c.y, false));
    this.numberRow(s, 'Y', Math.round(c.y * 100), 'cm', (v) =>
      this.store.moveCorner(id, c.x, v / 100, false));
    const a = this.section(root, 'Actions');
    const del = this.el(`<div class="btn-row"><button class="btn danger">Remove corner</button></div>`);
    del.querySelector('button')!.addEventListener('click', () => {
      this.store.deleteCorner(id);
      this.store.commit();
    });
    a.appendChild(del);
  }

  /* ================= topbar & shortcuts ================= */

  private wireTopbar(): void {
    // view toggle
    const setView = (mode: '2d' | 'split' | '3d') => {
      $('#pane2d').classList.toggle('hidden', mode === '3d');
      $('#pane3d').classList.toggle('hidden', mode === '2d');
      document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) =>
        b.classList.toggle('active', b.dataset.view === mode));
      if (mode !== '3d') requestAnimationFrame(() => this.plan.zoomFit());
    };
    document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) =>
      b.addEventListener('click', () => setView(b.dataset.view as '2d' | 'split' | '3d')));

    $('#btn-undo').addEventListener('click', () => this.store.undo());
    $('#btn-redo').addEventListener('click', () => this.store.redo());

    const dayBtn = $('#btn-daynight');
    const refreshDay = () => {
      dayBtn.textContent = this.store.design.scene.night ? '☾ Night' : '☀ Day';
    };
    dayBtn.addEventListener('click', () => {
      this.store.setNight(!this.store.design.scene.night);
      refreshDay();
    });
    this.store.on('history', refreshDay);
    refreshDay();

    $('#btn-new').addEventListener('click', () => {
      this.plan.setArmed(null);
      this.store.replaceDesign(emptyDesign());
      this.plan.zoomFit();
    });

    $('#btn-save').addEventListener('click', () => {
      const blob = new Blob([this.store.exportJson()], { type: 'application/json' });
      this.download(URL.createObjectURL(blob), 'kitchen-design.json');
    });

    const fileInput = $('#file-input') as HTMLInputElement;
    $('#btn-load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (d?.version !== 1 || !Array.isArray(d.corners)) throw new Error('bad file');
        this.store.replaceDesign(d);
        this.plan.zoomFit();
      } catch {
        $('#status-hint').textContent = 'Could not read that file — is it a kitchen-design.json?';
      }
    });

    $('#btn-png').addEventListener('click', () => {
      this.download(this.view.snapshotPNG(), 'kitchen-3d.png');
    });

    $('#btn-glb').addEventListener('click', async () => {
      const btn = $('#btn-glb') as HTMLButtonElement;
      btn.disabled = true;
      try {
        const blob = await this.view.exportGLB();
        this.download(URL.createObjectURL(blob), 'kitchen.glb');
        $('#status-hint').textContent =
          'kitchen.glb exported — in Blender: File → Import → glTF 2.0';
      } finally {
        btn.disabled = false;
      }
    });

    // pane controls
    $('#btn-zoom-in').addEventListener('click', () => this.plan.zoomBy(1.25));
    $('#btn-zoom-out').addEventListener('click', () => this.plan.zoomBy(0.8));
    $('#btn-zoom-fit').addEventListener('click', () => this.plan.zoomFit());
    document.querySelectorAll<HTMLElement>('#cam-controls button').forEach((b) =>
      b.addEventListener('click', () => {
        this.view.setPreset(b.dataset.cam as CamPreset);
        document.querySelectorAll<HTMLElement>('#cam-controls button').forEach((x) =>
          x.classList.toggle('active', x === b));
      }));
  }

  private download(url: string, name: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }

  private updateUndoButtons(): void {
    ($('#btn-undo') as HTMLButtonElement).disabled = !this.store.canUndo();
    ($('#btn-redo') as HTMLButtonElement).disabled = !this.store.canRedo();
  }

  private updateInfo(): void {
    $('#status-info').textContent =
      `${this.store.design.items.length} items · ${this.store.floorArea().toFixed(1)} m²`;
  }

  private wireKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;

      if (e.key === 'Escape') {
        if (this.studio.isOpen()) this.studio.close();
        else if (this.plan.armedDef) this.plan.setArmed(null);
        else this.store.select({ kind: 'none' });
        return;
      }
      if (typing || this.studio.isOpen()) return;

      const sel = this.store.selection;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.store.redo();
        else this.store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.store.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && sel.kind === 'item') {
        e.preventDefault();
        const copy = this.store.duplicateItem(sel.id);
        if (copy) this.store.select({ kind: 'item', id: copy.id });
        this.store.commit();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.kind !== 'none') {
        e.preventDefault();
        if (sel.kind === 'item') this.store.deleteItem(sel.id);
        else if (sel.kind === 'opening') this.store.deleteOpening(sel.id);
        else if (sel.kind === 'corner') this.store.deleteCorner(sel.id);
        this.store.commit();
        return;
      }
      if (e.key.toLowerCase() === 'r' && sel.kind === 'item') {
        e.preventDefault();
        const it = this.store.itemById(sel.id);
        if (it) {
          const step = e.shiftKey ? Math.PI / 12 : Math.PI / 2;
          this.store.updateItem(sel.id, { rotation: it.rotation + step }, { structural: false });
          this.store.commit();
        }
        return;
      }
      if (e.key.startsWith('Arrow') && sel.kind === 'item') {
        e.preventDefault();
        const it = this.store.itemById(sel.id);
        if (!it) return;
        const step = e.shiftKey ? 0.1 : 0.01;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.store.updateItem(sel.id, { x: it.x + dx, y: it.y + dy }, { structural: false });
        this.store.commit();
      }
    });
  }
}

export { demoDesign, Store };
