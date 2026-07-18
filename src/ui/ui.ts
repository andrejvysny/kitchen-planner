import {
  CATALOG,
  COUNTER_COLORS,
  FLOOR_COLORS,
  FRONT_COLORS,
  hasWorktop,
  LIGHT_COLORS,
  WALL_COLORS,
  type CatalogDef,
} from '../model/catalog';
import { footprintPolygon, toCatalogDef } from '../model/parts';
import {
  COUNTER_MATERIALS,
  FLOOR_MATERIALS,
  hasPattern,
  ITEM_MATERIALS,
  overridesColor,
  WALL_MATERIALS,
  type MaterialDef,
} from '../model/materials';
import { SUN_ELEV_MAX, SUN_ELEV_MIN } from '../model/sky';
import { demoDesign, emptyDesign, sanitizeDesign, Store } from '../model/store';
import type { Item, Selection, WallVisMode } from '../model/types';
import { isVarRef, refId, resolveColor, toVarRef } from '../model/variables';
import { renderThumbnail } from '../plan2d/symbols';
import type { Plan2D } from '../plan2d/plan2d';
import type { ElevationView } from '../plan2d/elevation';
import { materialSwatch } from '../view3d/textures';
import type { View3D, CamPreset } from '../view3d/view3d';
import { PartStudio } from './partstudio';
import { ManufactureDialog } from './manufacture';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

/** defId → catalog section title, so placed items list under the same type group they were placed from. */
const CATALOG_GROUP = new Map<string, string>();
for (const s of CATALOG) for (const d of s.items) CATALOG_GROUP.set(d.id, s.title);

/** Display order of the components-outline groups. */
const OUTLINE_ORDER = ['Doors & windows', ...CATALOG.map((s) => s.title), 'My parts'];

/** radians → whole degrees in [0, 360) for display; the model keeps radians unbounded */
function displayDeg(rad: number): number {
  return ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;
}

export class UI {
  private store: Store;
  private plan: Plan2D;
  private view: View3D;
  private elev: ElevationView;
  private studio: PartStudio;
  private manufacture: ManufactureDialog;

  constructor(store: Store, plan: Plan2D, view: View3D, elev: ElevationView) {
    this.store = store;
    this.plan = plan;
    this.view = view;
    this.elev = elev;
    this.studio = new PartStudio(store, () => this.renderCatalogIfPartsChanged());
    this.manufacture = new ManufactureDialog(store);

    this.renderCatalog();
    this.renderOutline();
    this.renderVariables();
    this.renderProps();
    this.wireTabs();
    this.wireTopbar();
    this.wireKeyboard();

    store.on('selection', () => {
      this.renderProps();
      this.renderOutline();
    });
    store.on('history', () => {
      // skip the full panel rebuild while the user is interacting inside it —
      // steppers, choice rows and inputs keep themselves current
      const active = document.activeElement;
      if (!active || !$('#props').contains(active)) this.renderProps();
      // Variables tab lives in the left sidebar; rebuild it too, but don't yank
      // a variable's name field out from under the user mid-edit.
      if (!this.isEditingVariableName(active)) this.renderVariables();
      this.renderCatalogIfPartsChanged();
      this.renderOutline();
      this.updateUndoButtons();
      this.updateInfo();
    });
    store.on('change', (info) => {
      this.updateInfo();
      if (info.transient) this.refreshTransientInputs();
    });
    this.updateUndoButtons();
    this.updateInfo();
  }

  /* ================= sidebar tabs ================= */

  /** Left sidebar has two tabs: "library" (catalog) and "components" (outline). */
  private wireTabs(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs button');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => this.selectTab(btn.dataset.tab as string));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const list = [...buttons];
        const i = list.indexOf(btn);
        const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
        this.selectTab(next.dataset.tab as string);
        next.focus();
      });
    });
  }

  private selectTab(tab: string): void {
    document.querySelectorAll<HTMLButtonElement>('#sidebar-tabs button').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll<HTMLElement>('#catalog .tab-panel').forEach((panel) => {
      const on = panel.id === `tab-${tab}`;
      panel.classList.toggle('active', on);
      panel.hidden = !on;
    });
  }

  /* ================= catalog ================= */

  private lastPartsSig = '';

  /** The catalog only changes when the parts library does — skip pointless rebuilds. */
  private renderCatalogIfPartsChanged(): void {
    const sig = JSON.stringify(this.store.design.customParts);
    if (sig === this.lastPartsSig) return;
    this.renderCatalog();
  }

  private renderCatalog(): void {
    this.lastPartsSig = JSON.stringify(this.store.design.customParts);
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
      tile.role = 'button';
      tile.tabIndex = 0;
      tile.title = `Click, then click in the plan to place — ${def.label.toLowerCase()}`;
      const canvas = document.createElement('canvas');
      const tilePart = this.store.customPartById(def.id);
      renderThumbnail(
        canvas,
        def.kind,
        def.w,
        def.d,
        def.color,
        tilePart ? (footprintPolygon(tilePart, def.w, def.d) ?? undefined) : undefined
      );
      tile.appendChild(canvas);
      const label = document.createElement('span');
      label.textContent = def.label;
      tile.appendChild(label);
      const arm = () => this.plan.setArmed(this.plan.armedDef?.id === def.id ? null : def);
      tile.addEventListener('click', arm);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          arm();
        }
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
        newTile.role = 'button';
        newTile.tabIndex = 0;
        newTile.innerHTML = `<span style="font-size:20px">＋</span><span>New part</span>`;
        const openStudio = () => {
          this.plan.setArmed(null);
          this.studio.open();
        };
        newTile.addEventListener('click', openStudio);
        newTile.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openStudio();
          }
        });
        grid2.appendChild(newTile);
        // group tiles by part type: cabinets, then boards, then freeform
        const order = { cabinet: 0, board: 1, freeform: 2 };
        const parts = [...this.store.design.customParts].sort((a, b) => order[a.type] - order[b.type]);
        for (const part of parts) {
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

  /* ================= components outline ================= */

  /** Left-sidebar list of every placed object/opening, grouped by type; rows select. */
  private renderOutline(): void {
    const root = $('#outline');
    root.innerHTML = '';

    type Row = { label: string; sel: Selection; active: boolean };
    const groups = new Map<string, Row[]>();
    const add = (group: string, row: Row) => {
      const list = groups.get(group) ?? (groups.set(group, []).get(group) as Row[]);
      list.push(row);
    };
    const sel = this.store.selection;

    for (const o of this.store.design.openings) {
      add('Doors & windows', {
        label: o.type === 'door' ? 'Door' : 'Window',
        sel: { kind: 'opening', id: o.id },
        active: sel.kind === 'opening' && sel.id === o.id,
      });
    }
    for (const it of this.store.design.items) {
      const def = this.store.defOf(it.defId);
      const group = def.kind === 'custom' ? 'My parts' : (CATALOG_GROUP.get(it.defId) ?? 'Other');
      add(group, {
        label: def.label,
        sel: { kind: 'item', id: it.id },
        active: sel.kind === 'item' && sel.id === it.id,
      });
    }

    const total = this.store.design.items.length + this.store.design.openings.length;
    const head = this.el(`<div class="ol-head">Components<span class="ol-total">${total}</span></div>`);
    root.appendChild(head);

    if (total === 0) {
      root.appendChild(this.el(`<div class="ol-empty">Nothing placed yet</div>`));
      return;
    }

    // known groups in catalog order, then any leftover ('Other') alphabetically
    const known = OUTLINE_ORDER.filter((g) => groups.has(g));
    const extra = [...groups.keys()].filter((g) => !OUTLINE_ORDER.includes(g)).sort();
    for (const group of [...known, ...extra]) {
      const rows = groups.get(group);
      if (!rows?.length) continue;
      const section = this.el(
        `<div class="ol-group"><div class="ol-group-title"><span class="ol-label"></span><span class="ol-count">${rows.length}</span></div></div>`
      );
      (section.querySelector('.ol-label') as HTMLElement).textContent = group;
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = `ol-row${r.active ? ' active' : ''}`;
        row.role = 'button';
        row.tabIndex = 0;
        row.textContent = r.label;
        const pick = () => this.store.select(r.sel);
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
        section.appendChild(row);
      }
      root.appendChild(section);
    }
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

  /**
   * Design-variable binding chips, prepended to a colour swatch row. Picking a
   * chip binds the slot to that variable (`var:<id>`); picking a literal swatch
   * afterwards detaches it. No chips render when no variables exist.
   */
  private varChips(parent: HTMLElement, current: string, onBind: (ref: string) => void): void {
    const vars = this.store.design.variables;
    if (!vars.length) return;
    const row = this.el('<div class="swatches var-chips"></div>');
    for (const v of vars) {
      const active = isVarRef(current) && refId(current) === v.id;
      const chip = this.el(`<button class="var-chip${active ? ' active' : ''}"><span class="dot"></span></button>`);
      (chip.querySelector('.dot') as HTMLElement).style.background = v.color;
      chip.append(document.createTextNode(v.name));
      chip.title = `Bind to variable "${v.name}"`;
      chip.addEventListener('click', () => {
        onBind(toVarRef(v.id));
        this.store.commit();
      });
      row.appendChild(chip);
    }
    parent.appendChild(row);
  }

  /** True while the caret sits in a variable's name field — re-rendering then
   * would drop the user's edit, so the history handler skips the rebuild. */
  private isEditingVariableName(active: Element | null): boolean {
    return (
      !!active &&
      active instanceof HTMLInputElement &&
      active.classList.contains('var-name') &&
      $('#variables-panel').contains(active)
    );
  }

  /** Rebuild the left-sidebar Variables tab (self-contained; not part of #props). */
  private renderVariables(): void {
    const root = $('#variables-panel');
    root.innerHTML = '';
    this.renderVariablesSection(root);
  }

  /** The Variables manager: create / edit / delete design tokens + defaults. */
  private renderVariablesSection(root: HTMLElement): void {
    const design = this.store.design;
    const sec = this.section(root, 'Variables');
    sec.appendChild(
      this.el(`<p class="props-sub">Named colours &amp; textures — bind cabinets, walls, floor or worktops to one so a single edit re-themes them all.</p>`)
    );

    for (const v of design.variables) {
      const card = this.el('<div class="var-item"></div>');
      const name = this.el('<input class="var-name" type="text" spellcheck="false">') as HTMLInputElement;
      name.value = v.name;
      name.addEventListener('change', () => {
        this.store.updateVariable(v.id, { name: name.value.trim() || 'Variable' });
        this.store.commit();
      });
      card.appendChild(name);
      this.swatchRow(card, FRONT_COLORS, v.color, (c) => this.store.updateVariable(v.id, overridesColor(v.material)
        ? { color: c, material: undefined, materialRot: undefined }
        : { color: c }));
      this.materialRow(card, ITEM_MATERIALS, v.material, (id) => this.store.updateVariable(v.id, { material: id }));
      this.rotToggle(card, v.material, v.materialRot === true, (r) =>
        this.store.updateVariable(v.id, { materialRot: r || undefined }));
      const actions = this.el('<div class="btn-row"></div>');
      const apply = this.el('<button class="btn">Apply to all fronts</button>');
      apply.addEventListener('click', () => {
        const n = this.store.applyVarToItems(v.id, 'front');
        this.store.commit();
        $('#status-hint').textContent = `Bound ${n} item${n === 1 ? '' : 's'} to "${v.name}"`;
      });
      const del = this.el('<button class="btn danger">Delete</button>');
      del.addEventListener('click', () => {
        this.store.deleteVariable(v.id);
        this.store.commit();
      });
      actions.append(apply, del);
      card.appendChild(actions);
      sec.appendChild(card);
    }

    const add = this.el('<div class="btn-row"><button class="btn">＋ Add variable</button></div>');
    add.querySelector('button')!.addEventListener('click', () => {
      this.store.addVariable();
      this.store.commit();
    });
    sec.appendChild(add);

    if (design.variables.length) {
      const row = this.el('<div class="prop-row"><label>New items use</label></div>');
      const select = document.createElement('select');
      select.appendChild(new Option('None', ''));
      for (const v of design.variables) {
        const opt = new Option(v.name, v.id);
        opt.selected = design.defaultFrontVar === v.id;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        this.store.setDefaultVar('front', select.value || undefined);
        this.store.commit();
      });
      row.appendChild(select);
      sec.appendChild(row);
    }
  }

  /** Built-in PBR material chips (textured previews) + a "plain colour" chip. */
  private materialRow(
    parent: HTMLElement,
    mats: MaterialDef[],
    current: string | undefined,
    onPick: (id?: string) => void,
    plainTitle = 'Plain colour'
  ): void {
    const sw = this.el('<div class="swatches"></div>');
    const add = (id: string | undefined, title: string, bg: string) => {
      const b = this.el(
        `<button class="swatch${current === id ? ' active' : ''}" title="${title}"></button>`
      );
      b.style.background = bg;
      b.style.backgroundSize = 'cover';
      b.addEventListener('click', () => {
        onPick(id);
        this.store.commit();
      });
      sw.appendChild(b);
    };
    add(undefined, plainTitle, 'linear-gradient(135deg,#fff 44%,#b9bdc0 44%,#b9bdc0 56%,#fff 56%)');
    for (const m of mats) {
      const cnv = materialSwatch(m.id, 52);
      add(m.id, m.label, cnv ? `url(${cnv.toDataURL()})` : m.color);
    }
    parent.appendChild(sw);
  }

  /** "Rotate texture" toggle — only rendered when the active material has a pattern. */
  private rotToggle(
    parent: HTMLElement,
    matId: string | undefined,
    value: boolean,
    onChange: (v: boolean) => void
  ): void {
    if (!hasPattern(matId)) return;
    this.toggleRow(parent, 'Rotate texture 90°', value, onChange);
  }

  /** Segmented two-way choice; updates its own active state so no re-render is needed. */
  private choiceRow(
    parent: HTMLElement,
    options: [string, string][],
    current: string,
    onPick: (v: string) => void
  ): void {
    const row = this.el('<div class="btn-row"></div>');
    for (const [value, label] of options) {
      const b = this.el(`<button class="btn${value === current ? ' active' : ''}">${label}</button>`);
      b.addEventListener('click', () => {
        onPick(value);
        row.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        this.store.commit();
      });
      row.appendChild(b);
    }
    parent.appendChild(row);
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
    onInput: (v: number) => void,
    opts: { min?: number; max?: number; step?: number; fmt?: (v: number) => string } = {}
  ): void {
    const min = opts.min ?? 0;
    const max = opts.max ?? 1;
    const step = opts.step ?? 0.01;
    const { fmt } = opts;
    const row = this.el(`<div class="prop-row"><label>${label}</label>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}">
      ${fmt ? `<span class="unit slider-val">${fmt(value)}</span>` : ''}</div>`);
    const r = row.querySelector('input') as HTMLInputElement;
    const val = row.querySelector('.slider-val');
    r.addEventListener('input', () => {
      const v = Number(r.value);
      if (val && fmt) val.textContent = fmt(v);
      onInput(v);
    });
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
    const applyPreset = (preset: 'rect' | 'lshape') => {
      this.store.setShapePreset(preset);
      this.store.commit();
    };
    rectBtn.addEventListener('click', () => applyPreset('rect'));
    lBtn.addEventListener('click', () => applyPreset('lshape'));
    shape.appendChild(btns);
    shape.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Drag ■ corners to reshape · drag ◆ to bend a wall</p>`));

    const ceiling = this.section(root, 'Ceiling');
    this.choiceRow(ceiling, [['auto', 'Auto'], ['show', 'Show'], ['hide', 'Hide']],
      this.store.ceilingVisibility(), (v) =>
        this.store.setCeilingVisibility(v as WallVisMode));
    ceiling.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Auto shows the ceiling only when the camera is below it</p>`));

    const design = this.store.design;
    const colors = this.section(root, 'Walls');
    this.varChips(colors, design.room.wallColor, (ref) => this.store.setRoomStyle({ wallColor: ref }));
    this.swatchRow(colors, WALL_COLORS, resolveColor(design, design.room.wallColor), (c) =>
      this.store.setRoomStyle(overridesColor(design.room.wallMaterial)
        ? { wallColor: c, wallMaterial: undefined, wallMaterialRot: undefined }
        : { wallColor: c }));
    this.materialRow(colors, WALL_MATERIALS, this.store.design.room.wallMaterial, (id) =>
      this.store.setRoomStyle({ wallMaterial: id }));
    this.rotToggle(colors, this.store.design.room.wallMaterial,
      this.store.design.room.wallMaterialRot === true, (v) =>
        this.store.setRoomStyle({ wallMaterialRot: v || undefined }));
    const visRow = this.el(`<div class="btn-row">
      <button class="btn" data-m="auto">Auto all</button>
      <button class="btn" data-m="show">Show all</button>
      <button class="btn" data-m="hide">Hide all</button></div>`);
    visRow.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        this.store.setAllWallVisibility(b.getAttribute('data-m') as WallVisMode);
        this.store.commit();
      }));
    colors.appendChild(visRow);
    colors.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Or select a single wall to override it</p>`));
    const floor = this.section(root, 'Floor');
    this.varChips(floor, design.room.floorColor, (ref) => this.store.setRoomStyle({ floorColor: ref }));
    this.swatchRow(floor, FLOOR_COLORS, resolveColor(design, design.room.floorColor), (c) =>
      this.store.setRoomStyle(overridesColor(design.room.floorMaterial)
        ? { floorColor: c, floorMaterial: undefined, floorMaterialRot: undefined }
        : { floorColor: c }));
    this.materialRow(floor, FLOOR_MATERIALS, this.store.design.room.floorMaterial, (id) =>
      this.store.setRoomStyle({ floorMaterial: id }));
    this.rotToggle(floor, this.store.design.room.floorMaterial,
      this.store.design.room.floorMaterialRot === true, (v) =>
        this.store.setRoomStyle({ floorMaterialRot: v || undefined }));
    const counter = this.section(root, 'Worktops');
    this.varChips(counter, design.room.counterColor, (ref) => this.store.setRoomStyle({ counterColor: ref }));
    this.swatchRow(counter, COUNTER_COLORS, resolveColor(design, design.room.counterColor), (c) =>
      this.store.setRoomStyle(overridesColor(design.room.counterMaterial)
        ? { counterColor: c, counterMaterial: undefined, counterMaterialRot: undefined }
        : { counterColor: c }));
    this.materialRow(counter, COUNTER_MATERIALS, this.store.design.room.counterMaterial, (id) =>
      this.store.setRoomStyle({ counterMaterial: id }));
    this.rotToggle(counter, this.store.design.room.counterMaterial,
      this.store.design.room.counterMaterialRot === true, (v) =>
        this.store.setRoomStyle({ counterMaterialRot: v || undefined }));

    this.renderLightingProps(root);

    root.appendChild(
      this.el(`<div class="props-empty-tip">
        <b>How to design your kitchen</b><br>
        1 · Sketch the room — size, corners, then place <b>doors, windows, water & outlets</b><br>
        2 · Add base units along the walls (they snap into runs)<br>
        3 · Stack wall cabinets & shelves above<br>
        4 · Place lights, then set the mood in <b>Lighting</b> (sun direction & height, brightness)<br>
        Create your own parametric furniture with <b>＋ New part</b></div>`)
    );
  }

  /** Global lighting controls (shown in the no-selection panel). */
  private renderLightingProps(root: HTMLElement): void {
    const scene = this.store.design.scene;
    const deg = (v: number) => `${Math.round(v)}°`;
    const pct = (v: number) => `${Math.round(v * 100)}%`;

    const light = this.section(root, 'Lighting');
    this.sliderRow(light, 'Sun direction', scene.sunAzimuth, (v) => this.store.setScene({ sunAzimuth: v }), {
      min: 0, max: 360, step: 5, fmt: deg,
    });
    this.sliderRow(light, 'Sun height', scene.sunElevation, (v) => this.store.setScene({ sunElevation: v }), {
      min: SUN_ELEV_MIN, max: SUN_ELEV_MAX, step: 1, fmt: deg,
    });
    this.sliderRow(light, 'Brightness', scene.brightness, (v) => this.store.setScene({ brightness: v }), {
      min: 0, max: 2, step: 0.05, fmt: pct,
    });
  }

  /* ---------- item ---------- */

  private renderItemProps(root: HTMLElement, item: Item): void {
    const def = this.store.defOf(item.defId);
    root.appendChild(this.el(`<h2 class="props-title">${def.label}</h2>`));
    root.appendChild(this.el(`<p class="props-sub">${def.kind === 'custom' ? 'Custom part' : 'Catalog item'}</p>`));

    // dimensions — freeform, no catalog limits (KITCHENP-7). Every dimension is
    // always editable; only a small positive floor guards against degenerate geometry.
    const dims = this.section(root, 'Dimensions');
    const MIN_DIM = 0.01; // 1 cm
    const dimRow = (label: string, key: 'w' | 'd' | 'h') => {
      this.numberRow(dims, label, Math.round(item[key] * 100), 'cm', (v) => {
        this.store.updateItem(item.id, { [key]: Math.max(MIN_DIM, v / 100) } as Partial<Item>);
      }, { min: 1 });
    };
    dimRow('Width', 'w');
    dimRow('Depth', 'd');
    dimRow('Height', 'h');
    // Off-floor placement is likewise freeform for every item (floor at 0, no ceiling cap).
    this.numberRow(dims, 'Off floor', Math.round(item.elevation * 100), 'cm', (v) =>
      this.store.updateItem(item.id, { elevation: Math.max(0, v / 100) }), { min: 0 });

    // position
    const pos = this.section(root, 'Position');
    this.numberRow(pos, 'X', Math.round(item.x * 100), 'cm', (v) =>
      this.store.updateItem(item.id, { x: v / 100 }), { cls: 'pos-x' });
    this.numberRow(pos, 'Y', Math.round(item.y * 100), 'cm', (v) =>
      this.store.updateItem(item.id, { y: v / 100 }), { cls: 'pos-y' });
    const rotRow = this.el(`<div class="prop-row"><label>Rotate</label>
      <div class="stepper"><button title="Rotate left">⟲</button><input type="number" data-cls="rot" step="15" value="${displayDeg(item.rotation)}"><button title="Rotate right">⟳</button></div>
      <span class="unit">°</span></div>`);
    const [ccw, cw] = Array.from(rotRow.querySelectorAll('button'));
    const rotInput = rotRow.querySelector('input') as HTMLInputElement;
    const rotate = (rad: number) => {
      this.store.updateItem(item.id, { rotation: rad }, { structural: false });
      rotInput.value = String(displayDeg(rad));
      this.store.commit();
    };
    ccw.addEventListener('click', () => rotate(item.rotation - Math.PI / 2));
    cw.addEventListener('click', () => rotate(item.rotation + Math.PI / 2));
    rotInput.addEventListener('change', () => {
      const v = Number(rotInput.value);
      if (Number.isFinite(v)) rotate((v * Math.PI) / 180);
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

    // colour + material
    if (!def.opening && !def.marker) {
      const colors = this.section(root, 'Colour & material');
      // bind chips first — picking a literal swatch below detaches back to a hex
      this.varChips(colors, item.color, (ref) => this.store.updateItem(item.id, { color: ref }));
      // picking a plain colour drops a colour-hiding texture so the colour shows
      this.swatchRow(colors, FRONT_COLORS, resolveColor(this.store.design, item.color), (c) =>
        this.store.updateItem(item.id, overridesColor(item.material)
          ? { color: c, material: undefined, materialRot: undefined }
          : { color: c }));
      if (!isVarRef(item.color)) {
        this.materialRow(colors, ITEM_MATERIALS, item.material, (id) =>
          this.store.updateItem(item.id, { material: id }));
        this.rotToggle(colors, item.material, item.materialRot === true, (v) =>
          this.store.updateItem(item.id, { materialRot: v || undefined }));
      } else {
        colors.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Texture follows the bound variable</p>`));
      }

      // per-item worktop finish for anything topped with a counter slab
      const part = this.store.customPartById(item.defId);

      // custom parts expose an accent (wood-tone) slot — bindable per instance
      if (part) {
        const accent = this.section(root, 'Accent');
        this.varChips(accent, item.accentColor ?? '', (ref) =>
          this.store.updateItem(item.id, { accentColor: ref }));
        this.swatchRow(accent, COUNTER_COLORS, resolveColor(this.store.design, item.accentColor ?? part.accentColor), (c) =>
          this.store.updateItem(item.id, { accentColor: c }));
      }
      const withWorktop = part ? part.type === 'cabinet' && part.worktop : hasWorktop(def);
      if (withWorktop) {
        const counter = this.section(root, 'Worktop');
        this.materialRow(counter, COUNTER_MATERIALS, item.counterMaterial, (id) =>
          this.store.updateItem(item.id, { counterMaterial: id }), 'Room default');
        this.rotToggle(counter, item.counterMaterial, item.counterMaterialRot === true, (v) =>
          this.store.updateItem(item.id, { counterMaterialRot: v || undefined }));
        counter.appendChild(
          this.el(`<p class="props-sub" style="margin-top:8px">First chip follows the room's worktop setting</p>`)
        );
      }
    }

    // light
    if (item.light) {
      const light = this.section(root, 'Light');
      this.toggleRow(light, 'On', item.light.on, (v) => this.store.updateItemLight(item.id, { on: v }));
      this.sliderRow(light, 'Brightness', item.light.intensity, (v) =>
        this.store.updateItemLight(item.id, { intensity: v }));
      this.sliderRow(light, 'Warmth', item.light.warmth, (v) =>
        this.store.updateItemLight(item.id, { warmth: v }));
      // explicit colour wins over warmth when set
      this.swatchRow(light, LIGHT_COLORS, item.light.color ?? '#fff4e0', (c) =>
        this.store.updateItemLight(item.id, { color: c }));
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

  /** Keep panel fields in sync mid-gesture without a full re-render. */
  private refreshTransientInputs(): void {
    const set = (cls: string, value: number) => {
      const input = document.querySelector<HTMLInputElement>(`input[data-cls="${cls}"]`);
      if (input && document.activeElement !== input) input.value = String(value);
    };
    const sel = this.store.selection;
    if (sel.kind === 'item') {
      const item = this.store.itemById(sel.id);
      if (!item) return;
      set('pos-x', Math.round(item.x * 100));
      set('pos-y', Math.round(item.y * 100));
      set('rot', displayDeg(item.rotation));
    } else if (sel.kind === 'corner') {
      const c = this.store.cornerById(sel.id);
      if (!c) return;
      set('corner-x', Math.round(c.x * 100));
      set('corner-y', Math.round(c.y * 100));
    } else if (sel.kind === 'opening') {
      const o = this.store.openingById(sel.id);
      if (o) set('opening-off', Math.round(o.offset * 100));
    }
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
    const vis = this.section(root, 'Visibility');
    this.choiceRow(vis, [['auto', 'Auto'], ['show', 'Show'], ['hide', 'Hide']],
      this.store.wallVisibility(wallId), (v) =>
        this.store.setWallVisibility(wallId, v as WallVisMode));
    vis.appendChild(this.el(`<p class="props-sub" style="margin-top:8px">Auto hides this wall when the camera looks past it</p>`));

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
        this.store.updateOpening(id, { offset: v / 100 }), { min: 0, max: Math.round(g.len * 100), cls: 'opening-off' });
    }
    if (o.type === 'door') {
      const swing = this.section(root, 'Swing');
      this.choiceRow(swing, [['left', 'Hinge left'], ['right', 'Hinge right']], o.hinge ?? 'left', (v) =>
        this.store.updateOpening(id, { hinge: v as 'left' | 'right' }));
      this.choiceRow(swing, [['in', 'Opens in'], ['out', 'Opens out']], o.swing ?? 'in', (v) =>
        this.store.updateOpening(id, { swing: v as 'in' | 'out' }));
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
      this.store.moveCorner(id, v / 100, c.y, false), { cls: 'corner-x' });
    this.numberRow(s, 'Y', Math.round(c.y * 100), 'cm', (v) =>
      this.store.moveCorner(id, c.x, v / 100, false), { cls: 'corner-y' });
    const a = this.section(root, 'Actions');
    const del = this.el(`<div class="btn-row"><button class="btn danger">Remove corner</button></div>`);
    const delBtn = del.querySelector('button') as HTMLButtonElement;
    if (this.store.design.corners.length <= 3) {
      delBtn.disabled = true;
      delBtn.title = 'A room needs at least 3 corners';
    }
    delBtn.addEventListener('click', () => {
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
    };
    document.querySelectorAll<HTMLElement>('#view-toggle button').forEach((b) =>
      b.addEventListener('click', () => setView(b.dataset.view as '2d' | 'split' | '3d')));

    // 2D pane sub-mode: top-down plan vs. front-view wall elevation
    const setMode2d = (mode: 'plan' | 'elev') => {
      $('#pane2d').classList.toggle('elev-mode', mode === 'elev');
      document.querySelectorAll<HTMLElement>('#mode2d-toggle button').forEach((b) =>
        b.classList.toggle('active', b.dataset['2dmode'] === mode));
      this.elev.setActive(mode === 'elev');
      if (mode === 'plan') this.plan.requestDraw();
    };
    document.querySelectorAll<HTMLElement>('#mode2d-toggle button').forEach((b) =>
      b.addEventListener('click', () => setMode2d(b.dataset['2dmode'] as 'plan' | 'elev')));
    $('#btn-wall-prev').addEventListener('click', () => this.elev.stepWall(-1));
    $('#btn-wall-next').addEventListener('click', () => this.elev.stepWall(1));

    // narrow screens: the catalog is an off-canvas drawer; click-away closes it
    const catalogBtn = $('#btn-catalog');
    catalogBtn.addEventListener('click', () => $('#catalog').classList.toggle('open'));
    document.addEventListener('pointerdown', (e) => {
      const cat = $('#catalog');
      if (!cat.classList.contains('open')) return;
      const t = e.target as Node;
      if (!cat.contains(t) && !catalogBtn.contains(t)) cat.classList.remove('open');
    });
    this.plan.onArmedChange = () => {
      this.markArmedTile();
      if (this.plan.armedDef) $('#catalog').classList.remove('open');
    };

    $('#btn-undo').addEventListener('click', () => this.store.undo());
    $('#btn-redo').addEventListener('click', () => this.store.redo());

    const dayBtn = $('#btn-daynight');
    const isNight = () => this.store.design.scene.night;
    const refreshDay = () => {
      dayBtn.textContent = isNight() ? '☾ Night' : '☀ Day';
    };
    dayBtn.addEventListener('click', () => {
      this.store.setNight(!isNight());
      this.store.commit();
      refreshDay();
    });
    this.store.on('history', refreshDay);
    refreshDay();

    $('#btn-new').addEventListener('click', () => {
      if (!confirm('Start a new design? Your current design will be replaced (Undo can restore it).')) return;
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
        const d = sanitizeDesign(JSON.parse(await f.text()));
        if (!d) throw new Error('bad file');
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

    $('#btn-manufacture').addEventListener('click', () => this.manufacture.open());

    // pane controls
    $('#btn-zoom-in').addEventListener('click', () => this.plan.zoomBy(1.25));
    $('#btn-zoom-out').addEventListener('click', () => this.plan.zoomBy(0.8));
    $('#btn-zoom-fit').addEventListener('click', () => this.plan.zoomFit());

    const measureBtn = $('#btn-measure');
    measureBtn.addEventListener('click', () => this.plan.setMeasure(!this.plan.measureOn));
    this.plan.onMeasureChange = () =>
      measureBtn.classList.toggle('active', this.plan.measureOn);
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
        if (this.manufacture.isOpen()) this.manufacture.handleEscape();
        else if (this.studio.isOpen()) this.studio.handleEscape();
        else if (this.plan.armedDef) this.plan.setArmed(null);
        else if (this.plan.measureOn) this.plan.setMeasure(false);
        else this.store.select({ kind: 'none' });
        return;
      }
      if (typing || this.studio.isOpen() || this.manufacture.isOpen()) return;

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
