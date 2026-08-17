import {
  CATALOG,
  COUNTER_COLORS,
  FLOOR_COLORS,
  FRONT_COLORS,
  LIGHT_COLORS,
  WALL_COLORS,
  type CatalogDef,
} from '../model/catalog';
import { polygonBounds } from '../model/geometry';
import { footprintPolygon, toCatalogDef } from '../model/parts';
import {
  initialUnderlay,
  UNDERLAY_JPEG_Q,
  UNDERLAY_MAX_PX,
  underlayScaleFrom,
} from '../model/underlay';
import { hasPreset, PRESETS } from '../model/presets';
import {
  COUNTER_MATERIALS,
  FLOOR_MATERIALS,
  hasPattern,
  ITEM_MATERIALS,
  overridesColor,
  WALL_MATERIALS,
  type MaterialDef,
} from '../model/materials';
import type { Warning } from '../model/checks';
import { SUN_ELEV_MAX, SUN_ELEV_MIN } from '../model/sky';
import { demoDesign, Store } from '../model/store';
import type { Item, Selection, Underlay, WallVisMode } from '../model/types';
import { isVarRef, refId, resolveColor, toVarRef } from '../model/variables';
import { renderThumbnail } from '../plan2d/symbols';
import type { Plan2D } from '../plan2d/plan2d';
import type { EditorState } from '../editor/editorState';
import { materialSwatch } from '../view3d/textures';
import { setHint } from './shellState';
import { PartStudio } from './partstudio';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/** defId → catalog section title, so placed items list under the same type group they were placed from. */
const CATALOG_GROUP = new Map<string, string>();
for (const s of CATALOG) for (const d of s.items) CATALOG_GROUP.set(d.id, s.title);
for (const e of PRESETS) CATALOG_GROUP.set(e.part.id, e.section);

/** Display order of the components-outline groups. */
const OUTLINE_ORDER = ['Doors & windows', ...CATALOG.map((s) => s.title), 'My parts'];

/** radians → whole degrees in [0, 360) for display; the model keeps radians unbounded */
function displayDeg(rad: number): number {
  return ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;
}

export class UI {
  private store: Store;
  private plan: Plan2D;
  private editor: EditorState;
  private studio: PartStudio;

  // The 3D view left this class in step B2 with the topbar buttons that drove
  // it (snapshot / GLB / camera presets / pane visibility); B3 took the tool
  // buttons, the 2D/elev toggle, the wall nav and the catalog drawer, and T3
  // the sidebar tabs plus the whole Variables panel. What is left is the
  // catalog, the outline, the props panel and the keyboard map.
  constructor(store: Store, plan: Plan2D, editor: EditorState) {
    this.store = store;
    this.plan = plan;
    this.editor = editor;
    this.studio = new PartStudio(store, () => this.renderCatalogIfPartsChanged());

    this.renderCatalog();
    this.renderOutline();
    this.renderProps();
    this.wireUnderlay();
    this.wireKeyboard();

    // TRANSITIONAL (dies with T3/T4): two bits of legacy DOM still mirror tool
    // state by hand — the armed catalog tile and the calibrate button inside
    // the props panel. Both become components once the catalog and the props
    // panel are React's; until then this is the one subscription that keeps
    // them honest, in place of the onArmedChange/onCalibrateChange callbacks.
    editor.subscribe(() => {
      this.markArmedTile();
      document
        .querySelector('#props-inner .underlay-calibrate')
        ?.classList.toggle('active', editor.isTool('calibrate'));
    });

    store.on('selection', () => {
      this.renderProps();
      this.renderOutline();
    });
    store.on('history', () => {
      // skip the full panel rebuild while the user is interacting inside it —
      // steppers, choice rows and inputs keep themselves current
      const active = document.activeElement;
      if (!active || !$('#props').contains(active)) this.renderProps();
      this.renderCatalogIfPartsChanged();
      this.renderOutline();
    });
    store.on('change', (info) => {
      if (info.transient) this.refreshTransientInputs();
    });
    // ephemeral, but it retargets every room-scoped panel and the elevation
    store.on('activeRoom', () => {
      if (!this.isEditingRoomName(document.activeElement)) this.renderProps();
      this.renderOutline();
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
      const tilePart = this.store.partOf(def.id);
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
      const arm = () => this.plan.setArmed(this.editor.armedDefId === def.id ? null : def);
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
      // built-in cabinet presets lead their sections; legacy defs follow
      for (const e of PRESETS) {
        if (e.section === section.title) addTile(grid, toCatalogDef(e.part));
      }
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
        const parts = [...this.store.design.customParts].sort(
          (a, b) => order[a.type] - order[b.type]
        );
        for (const part of parts) {
          addTile(grid2, toCatalogDef(part), true);
        }
      }
    }
    this.markArmedTile();
  }

  private markArmedTile(): void {
    const armedId = this.editor.armedDefId;
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
      // preset ids group under their catalog section, not "My parts" —
      // checked first because presets also read as kind 'custom'
      const group = CATALOG_GROUP.get(it.defId) ?? (def.kind === 'custom' ? 'My parts' : 'Other');
      add(group, {
        label: def.label,
        sel: { kind: 'item', id: it.id },
        active: sel.kind === 'item' && sel.id === it.id,
      });
    }

    // the total counts placed components; rooms are the container, not content
    const total = this.store.design.items.length + this.store.design.openings.length;
    const head = this.el(
      `<div class="ol-head">Components<span class="ol-total">${total}</span></div>`
    );
    root.appendChild(head);

    // Rooms lead the outline: it is the primary room switcher
    const activeRoomId = this.store.activeRoomId;
    const roomsGroup = this.el(
      `<div class="ol-group"><div class="ol-group-title"><span class="ol-label">Rooms</span><span class="ol-count">${this.store.design.rooms.length}</span></div></div>`
    );
    for (const r of this.store.design.rooms) {
      const row = this.el(
        `<div class="ol-row room-row${r.id === activeRoomId ? ' active' : ''}"><span class="room-row-name"></span><span class="room-row-area"></span></div>`
      );
      row.role = 'button';
      row.tabIndex = 0;
      (row.querySelector('.room-row-name') as HTMLElement).textContent = r.name;
      (row.querySelector('.room-row-area') as HTMLElement).textContent =
        `${this.store.floorArea(r.id).toFixed(1)} m²`;
      const pick = () => this.activateRoom(r.id);
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      roomsGroup.appendChild(row);
    }
    root.appendChild(roomsGroup);

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
    const s = this.el(
      `<div class="prop-section"><div class="prop-section-title">${title}</div></div>`
    );
    root.appendChild(s);
    return s;
  }

  /**
   * The advisory findings, as a list of rows. Nothing is rendered when there is
   * nothing to say, so a clean design's panel is untouched. Clicking a row jumps
   * to the other item involved (or the first one, from the room panel), which is
   * the fastest way to see what a clash is with.
   */
  private checksSection(
    root: HTMLElement,
    list: Warning[],
    opts: { exceptId?: string; cap?: number } = {}
  ): void {
    if (!list.length) return;
    const sec = this.section(root, 'Checks');
    const shown = opts.cap ? list.slice(0, opts.cap) : list;
    for (const w of shown) {
      const row = this.el(
        `<div class="ol-row check-row"><span class="check-dot sev-${w.severity}"></span>
          <span class="check-text"><span class="check-title"></span><span class="check-detail"></span></span></div>`
      );
      (row.querySelector('.check-title') as HTMLElement).textContent = w.title;
      (row.querySelector('.check-detail') as HTMLElement).textContent = w.detail;
      const target = w.itemIds.find((id) => id !== opts.exceptId) ?? w.itemIds[0];
      if (target && this.store.itemById(target)) {
        row.role = 'button';
        row.tabIndex = 0;
        const pick = () => this.store.select({ kind: 'item', id: target });
        row.addEventListener('click', pick);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      }
      sec.appendChild(row);
    }
    if (shown.length < list.length) {
      sec.appendChild(this.el(`<div class="ol-empty">+${list.length - shown.length} more</div>`));
    }
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
      const chip = this.el(
        `<button class="var-chip${active ? ' active' : ''}"><span class="dot"></span></button>`
      );
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

  /** True while the caret sits in the room-name field — re-rendering then would
   * drop the user's edit, so the activeRoom handler skips the rebuild. */
  private isEditingRoomName(active: Element | null): boolean {
    return (
      !!active &&
      active instanceof HTMLInputElement &&
      active.classList.contains('room-name') &&
      $('#props').contains(active)
    );
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
      const b = this.el(
        `<button class="btn${value === current ? ' active' : ''}">${label}</button>`
      );
      b.addEventListener('click', () => {
        onPick(value);
        row.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        this.store.commit();
      });
      row.appendChild(b);
    }
    parent.appendChild(row);
  }

  private toggleRow(
    parent: HTMLElement,
    label: string,
    value: boolean,
    onChange: (v: boolean) => void
  ): void {
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

  /** Room rows (panel + outline) switch rooms and drop back to the room panel. */
  private activateRoom(id: string): void {
    this.store.setActiveRoom(id);
    this.store.select({ kind: 'none' });
  }

  private renderRoomProps(root: HTMLElement): void {
    const room = this.store.activeRoom();
    const style = this.store.activeStyle();
    const rooms = this.store.design.rooms;

    // the title IS the room name — renaming is the most common room-level edit
    const name = this.el(
      '<input class="room-name" type="text" spellcheck="false">'
    ) as HTMLInputElement;
    name.value = room.name;
    name.title = 'Rename this room';
    name.addEventListener('change', () => {
      this.store.renameRoom(room.id, name.value);
      this.store.commit();
      const applied = this.store.roomById(room.id)?.name ?? room.name; // renameRoom rejects blanks
      name.value = applied;
      // the panel is deliberately not rebuilt while the caret is in this field,
      // so the room list right below it has to be corrected by hand
      const row = $('#props-inner').querySelector<HTMLElement>('.room-row.active .room-row-name');
      if (row) row.textContent = applied;
    });
    root.appendChild(name);
    root.appendChild(
      this.el(
        `<p class="props-sub">${this.store.floorArea().toFixed(1)} m² · ${room.corners.length} corners</p>`
      )
    );

    const list = this.section(root, 'Rooms');
    for (const r of rooms) {
      const row = this.el(
        `<div class="ol-row room-row${r.id === room.id ? ' active' : ''}"><span class="room-row-name"></span><span class="room-row-area"></span></div>`
      );
      row.role = 'button';
      row.tabIndex = 0;
      (row.querySelector('.room-row-name') as HTMLElement).textContent = r.name;
      (row.querySelector('.room-row-area') as HTMLElement).textContent =
        `${this.store.floorArea(r.id).toFixed(1)} m²`;
      const pick = () => this.activateRoom(r.id);
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      list.appendChild(row);
    }
    const addRow = this.el(
      '<div class="btn-row"><button class="btn">＋ Add room</button><button class="btn">✎ Draw room</button></div>'
    );
    const addBtns = addRow.querySelectorAll('button');
    addBtns[0].addEventListener('click', () => this.plan.setRoomTool(true));
    addBtns[1].addEventListener('click', () => this.plan.setDrawRoom(true));
    list.appendChild(addRow);

    this.underlaySection(root);
    this.checksSection(root, this.store.warnings(), { cap: 12 });

    const rect = this.store.rectangleSize();
    const size = this.section(root, 'Size');
    if (rect) {
      this.numberRow(
        size,
        'Width',
        Math.round(rect.w * 100),
        'cm',
        (v) => this.store.setRectangleSize(v / 100, rect.d),
        { min: 100, max: 2000 }
      );
      this.numberRow(
        size,
        'Depth',
        Math.round(rect.d * 100),
        'cm',
        (v) => this.store.setRectangleSize(rect.w, v / 100),
        { min: 100, max: 2000 }
      );
    } else {
      size.appendChild(
        this.el(
          `<p class="props-sub">Select a wall to edit its length, or drag corners in the plan.</p>`
        )
      );
    }
    this.numberRow(
      size,
      'Ceiling',
      Math.round(style.wallHeight * 100),
      'cm',
      (v) => this.store.setRoomStyle({ wallHeight: Math.min(4, Math.max(2, v / 100)) }),
      { min: 200, max: 400 }
    );

    const shape = this.section(root, 'Room shape');
    const btns = this.el(
      `<div class="btn-row"><button class="btn">Rectangle</button><button class="btn">L-shape</button></div>`
    );
    const [rectBtn, lBtn] = Array.from(btns.querySelectorAll('button'));
    const applyPreset = (preset: 'rect' | 'lshape') => {
      this.store.setShapePreset(preset);
      this.store.commit();
    };
    rectBtn.addEventListener('click', () => applyPreset('rect'));
    lBtn.addEventListener('click', () => applyPreset('lshape'));
    // a preset rewrites the whole corner ring, which would orphan a partition
    if (this.store.wallsOf(room.id).some((w) => w.shared)) {
      for (const b of [rectBtn, lBtn]) {
        b.disabled = true;
        b.title = 'This room shares a wall with another — reshaping it would break the partition';
      }
    }
    shape.appendChild(btns);
    shape.appendChild(
      this.el(
        `<p class="props-sub" style="margin-top:8px">Drag ■ corners to reshape · drag ◆ to bend a wall</p>`
      )
    );

    const ceiling = this.section(root, 'Ceiling');
    this.choiceRow(
      ceiling,
      [
        ['auto', 'Auto'],
        ['show', 'Show'],
        ['hide', 'Hide'],
      ],
      this.store.ceilingVisibility(),
      (v) => this.store.setCeilingVisibility(v as WallVisMode)
    );
    ceiling.appendChild(
      this.el(
        `<p class="props-sub" style="margin-top:8px">Auto shows the ceiling only when the camera is below it</p>`
      )
    );

    const design = this.store.design;
    const colors = this.section(root, 'Walls');
    this.varChips(colors, style.wallColor, (ref) => this.store.setRoomStyle({ wallColor: ref }));
    this.swatchRow(colors, WALL_COLORS, resolveColor(design, style.wallColor), (c) =>
      this.store.setRoomStyle(
        overridesColor(style.wallMaterial)
          ? { wallColor: c, wallMaterial: undefined, wallMaterialRot: undefined }
          : { wallColor: c }
      )
    );
    this.materialRow(colors, WALL_MATERIALS, style.wallMaterial, (id) =>
      this.store.setRoomStyle({ wallMaterial: id })
    );
    this.rotToggle(colors, style.wallMaterial, style.wallMaterialRot === true, (v) =>
      this.store.setRoomStyle({ wallMaterialRot: v || undefined })
    );
    const visRow = this.el(`<div class="btn-row">
      <button class="btn" data-m="auto">Auto all</button>
      <button class="btn" data-m="show">Show all</button>
      <button class="btn" data-m="hide">Hide all</button></div>`);
    visRow.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        this.store.setAllWallVisibility(b.getAttribute('data-m') as WallVisMode);
        this.store.commit();
      })
    );
    colors.appendChild(visRow);
    colors.appendChild(
      this.el(
        `<p class="props-sub" style="margin-top:8px">Or select a single wall to override it</p>`
      )
    );
    const floor = this.section(root, 'Floor');
    this.varChips(floor, style.floorColor, (ref) => this.store.setRoomStyle({ floorColor: ref }));
    this.swatchRow(floor, FLOOR_COLORS, resolveColor(design, style.floorColor), (c) =>
      this.store.setRoomStyle(
        overridesColor(style.floorMaterial)
          ? { floorColor: c, floorMaterial: undefined, floorMaterialRot: undefined }
          : { floorColor: c }
      )
    );
    this.materialRow(floor, FLOOR_MATERIALS, style.floorMaterial, (id) =>
      this.store.setRoomStyle({ floorMaterial: id })
    );
    this.rotToggle(floor, style.floorMaterial, style.floorMaterialRot === true, (v) =>
      this.store.setRoomStyle({ floorMaterialRot: v || undefined })
    );
    const counter = this.section(root, 'Worktops');
    this.varChips(counter, style.counterColor, (ref) =>
      this.store.setRoomStyle({ counterColor: ref })
    );
    this.swatchRow(counter, COUNTER_COLORS, resolveColor(design, style.counterColor), (c) =>
      this.store.setRoomStyle(
        overridesColor(style.counterMaterial)
          ? { counterColor: c, counterMaterial: undefined, counterMaterialRot: undefined }
          : { counterColor: c }
      )
    );
    this.materialRow(counter, COUNTER_MATERIALS, style.counterMaterial, (id) =>
      this.store.setRoomStyle({ counterMaterial: id })
    );
    this.rotToggle(counter, style.counterMaterial, style.counterMaterialRot === true, (v) =>
      this.store.setRoomStyle({ counterMaterialRot: v || undefined })
    );

    this.renderLightingProps(root);

    const actions = this.section(root, 'Actions');
    const delRow = this.el(
      '<div class="btn-row"><button class="btn danger">Delete room</button></div>'
    );
    const delBtn = delRow.querySelector('button') as HTMLButtonElement;
    if (rooms.length === 1) {
      delBtn.disabled = true;
      delBtn.title = 'A design always has at least one room';
    }
    delBtn.addEventListener('click', () => {
      if (!confirm(`Delete "${room.name}" and everything in it?`)) return;
      this.store.deleteRoom(room.id);
      this.store.commit();
    });
    actions.appendChild(delRow);

    root.appendChild(
      this.el(`<div class="props-empty-tip">
        <b>How to design your space</b><br>
        1 · Sketch rooms — size, corners, and <b>＋ Add room</b> for more<br>
        2 · Place doors, windows & utilities on the walls<br>
        3 · Furnish along the walls — cabinets and furniture snap into place<br>
        4 · Place lights, then set the mood in <b>Lighting</b> (sun direction & height, brightness)<br>
        Create your own parametric furniture with <b>＋ New part</b></div>`)
    );
  }

  /* ---------- reference underlay ---------- */

  /**
   * Tracing-photo controls. The photo itself lives outside the design (see
   * types.ts `Underlay`), so this section keys off `underlayRef()` — both
   * halves present — not off the transform alone.
   */
  private underlaySection(root: HTMLElement): void {
    const sec = this.section(root, 'Reference photo');
    const ref = this.store.underlayRef();
    if (!ref) {
      const row = this.el('<div class="btn-row"><button class="btn">Import photo…</button></div>');
      (row.querySelector('button') as HTMLButtonElement).addEventListener('click', () =>
        this.pickUnderlay()
      );
      sec.appendChild(row);
      sec.appendChild(
        this.el(
          `<p class="props-sub" style="margin-top:8px">Trace an existing floor plan: import it, drag it under the room, then calibrate its scale.</p>`
        )
      );
      return;
    }

    const u = ref.u;
    this.sliderRow(
      sec,
      'Opacity',
      Math.round(u.opacity * 100),
      (v) => this.store.updateUnderlay({ opacity: v / 100 }),
      { min: 0, max: 100, step: 1, fmt: (v) => `${Math.round(v)}%` }
    );

    const calRow = this.el(
      '<div class="btn-row"><button class="btn underlay-calibrate">Calibrate scale</button></div>'
    );
    const calBtn = calRow.querySelector('button') as HTMLButtonElement;
    calBtn.classList.toggle('active', this.editor.isTool('calibrate'));
    calBtn.addEventListener('click', () =>
      this.plan.setCalibrate(!this.editor.isTool('calibrate'))
    );
    sec.appendChild(calRow);

    this.underlayToggles(sec, u);

    const manage = this.el(
      '<div class="btn-row"><button class="btn">Replace…</button><button class="btn danger">Remove</button></div>'
    );
    const [replaceBtn, removeBtn] = Array.from(manage.querySelectorAll('button'));
    replaceBtn.addEventListener('click', () => this.pickUnderlay());
    removeBtn.addEventListener('click', () => {
      this.store.setUnderlay(null);
      this.store.commit();
      this.renderProps();
    });
    sec.appendChild(manage);
    sec.appendChild(
      this.el(
        `<p class="props-sub" style="margin-top:8px">1 photo pixel = ${(u.scale * 100).toFixed(2)} cm · drag the photo in the plan to move it</p>`
      )
    );
  }

  /** Show/hide + lock, relabelling in place so neither needs a panel rebuild. */
  private underlayToggles(sec: HTMLElement, u: Underlay): void {
    const row = this.el(
      '<div class="btn-row"><button class="btn"></button><button class="btn"></button></div>'
    );
    const [visBtn, lockBtn] = Array.from(row.querySelectorAll('button'));
    const relabel = () => {
      visBtn.textContent = u.visible ? 'Hide' : 'Show';
      lockBtn.textContent = u.locked ? '🔒 Locked' : '🔓 Unlocked';
      lockBtn.classList.toggle('active', u.locked);
    };
    const flip = (patch: Partial<Underlay>) => {
      this.store.updateUnderlay(patch);
      this.store.commit();
      relabel();
    };
    visBtn.addEventListener('click', () => flip({ visible: !u.visible }));
    lockBtn.addEventListener('click', () => flip({ locked: !u.locked }));
    relabel();
    sec.appendChild(row);
  }

  private pickUnderlay(): void {
    ($('#underlay-input') as HTMLInputElement).click();
  }

  /**
   * Import + calibration wiring; the file input itself is React's markup. The
   * calibrate button's `.active` class rides the editor subscription in the
   * constructor — only the completed span still comes back through Plan2D,
   * because answering it needs a blocking prompt this class owns.
   */
  private wireUnderlay(): void {
    const input = $('#underlay-input') as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) await this.importUnderlay(f);
    });
    this.plan.onCalibrateDone = (d) => this.applyCalibration(d);
  }

  private async importUnderlay(f: File): Promise<void> {
    let img: { src: string; w: number; h: number };
    try {
      img = await this.downscaleImage(f);
    } catch {
      setHint('Could not read that image — try a JPEG or PNG');
      return;
    }
    const b = polygonBounds(this.store.activeRoom().corners);
    const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    if (!this.store.setUnderlay(img.src, initialUnderlay(img.w, img.h, center))) {
      setHint('Could not store the reference photo — browser storage is full or blocked');
      return;
    }
    this.store.commit();
    this.renderProps();
    setHint('Reference photo placed — drag it into position, then Calibrate scale');
  }

  /**
   * Decode, cap the long edge and re-encode as JPEG. Photos go into a
   * localStorage key, so the raw megapixels of a phone shot are both useless
   * for tracing and a quota hazard.
   */
  private async downscaleImage(f: File): Promise<{ src: string; w: number; h: number }> {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(new Error('read'));
      r.readAsDataURL(f);
    });
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode'));
      i.src = dataUrl;
    });
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    if (!long) throw new Error('empty');
    const k = Math.min(1, UNDERLAY_MAX_PX / long);
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cnv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cnv.getContext('2d')!.drawImage(img, 0, 0, cnv.width, cnv.height);
    return { src: cnv.toDataURL('image/jpeg', UNDERLAY_JPEG_Q), w: cnv.width, h: cnv.height };
  }

  /** The two calibration clicks spanned `dWorld` m — ask what that really is. */
  private applyCalibration(dWorld: number): void {
    const u = this.store.design.underlay;
    if (!u) return;
    const answer = prompt('How long is that distance in reality? (cm)');
    const cm = Number(answer);
    if (answer === null || !Number.isFinite(cm) || cm <= 0) {
      setHint('Scale calibration cancelled');
      return;
    }
    const scale = underlayScaleFrom(dWorld, u.scale, cm / 100);
    this.store.updateUnderlay({ scale });
    this.store.commit();
    this.renderProps();
    setHint(
      `Reference scaled: that span is ${Math.round(cm)} cm · 1 photo pixel = ${(scale * 100).toFixed(2)} cm`
    );
  }

  /** Global lighting controls (shown in the no-selection panel). */
  private renderLightingProps(root: HTMLElement): void {
    const scene = this.store.design.scene;
    const deg = (v: number) => `${Math.round(v)}°`;
    const pct = (v: number) => `${Math.round(v * 100)}%`;

    const light = this.section(root, 'Lighting');
    this.sliderRow(
      light,
      'Sun direction',
      scene.sunAzimuth,
      (v) => this.store.setScene({ sunAzimuth: v }),
      {
        min: 0,
        max: 360,
        step: 5,
        fmt: deg,
      }
    );
    this.sliderRow(
      light,
      'Sun height',
      scene.sunElevation,
      (v) => this.store.setScene({ sunElevation: v }),
      {
        min: SUN_ELEV_MIN,
        max: SUN_ELEV_MAX,
        step: 1,
        fmt: deg,
      }
    );
    this.sliderRow(
      light,
      'Brightness',
      scene.brightness,
      (v) => this.store.setScene({ brightness: v }),
      {
        min: 0,
        max: 2,
        step: 0.05,
        fmt: pct,
      }
    );
  }

  /* ---------- item ---------- */

  private renderItemProps(root: HTMLElement, item: Item): void {
    const def = this.store.defOf(item.defId);
    // presets are parts too, but read as built-ins to the user
    const isOwnPart = !!this.store.customPartById(item.defId);
    root.appendChild(this.el(`<h2 class="props-title">${def.label}</h2>`));
    root.appendChild(
      this.el(`<p class="props-sub">${isOwnPart ? 'Custom part' : 'Catalog item'}</p>`)
    );

    this.checksSection(
      root,
      this.store.warnings().filter((w) => w.itemIds.includes(item.id)),
      { exceptId: item.id }
    );

    // mounted appliances: pose is derived from the host — say so, offer Detach
    if (item.attach) {
      const host = this.store.itemById(item.attach.hostId);
      const hostLabel = host ? this.store.defOf(host.defId).label : '?';
      const mount = this.section(root, 'Mounting');
      mount.appendChild(
        this.el(
          `<p class="props-sub">Mounted ${item.attach.kind === 'zone' ? 'in a niche of' : 'on'} <b>${hostLabel}</b> — moves with it</p>`
        )
      );
      const row = this.el(`<div class="btn-row"><button class="btn">Detach</button></div>`);
      row.querySelector('button')!.addEventListener('click', () => {
        this.store.setAttachment(item.id, undefined);
        this.store.commit();
      });
      mount.appendChild(row);
    }

    // dimensions — freeform, no catalog limits (KITCHENP-7). Every dimension is
    // always editable; only a small positive floor guards against degenerate geometry.
    const dims = this.section(root, 'Dimensions');
    const MIN_DIM = 0.01; // 1 cm
    const dimRow = (label: string, key: 'w' | 'd' | 'h') => {
      this.numberRow(
        dims,
        label,
        Math.round(item[key] * 100),
        'cm',
        (v) => {
          this.store.updateItem(item.id, { [key]: Math.max(MIN_DIM, v / 100) } as Partial<Item>);
        },
        { min: 1 }
      );
    };
    dimRow('Width', 'w');
    dimRow('Depth', 'd');
    dimRow('Height', 'h');
    if (!item.attach) {
      // Off-floor placement is likewise freeform for every item (floor at 0, no ceiling cap).
      this.numberRow(
        dims,
        'Off floor',
        Math.round(item.elevation * 100),
        'cm',
        (v) => this.store.updateItem(item.id, { elevation: Math.max(0, v / 100) }),
        { min: 0 }
      );

      // position
      const pos = this.section(root, 'Position');
      this.numberRow(
        pos,
        'X',
        Math.round(item.x * 100),
        'cm',
        (v) => this.store.updateItem(item.id, { x: v / 100 }),
        { cls: 'pos-x' }
      );
      this.numberRow(
        pos,
        'Y',
        Math.round(item.y * 100),
        'cm',
        (v) => this.store.updateItem(item.id, { y: v / 100 }),
        { cls: 'pos-y' }
      );
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
    }

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
        minus.addEventListener('click', () =>
          apply((this.store.itemById(item.id)?.params?.[p.key] ?? p.def) - 1)
        );
        plus.addEventListener('click', () =>
          apply((this.store.itemById(item.id)?.params?.[p.key] ?? p.def) + 1)
        );
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
        this.store.updateItem(
          item.id,
          overridesColor(item.material)
            ? { color: c, material: undefined, materialRot: undefined }
            : { color: c }
        )
      );
      if (!isVarRef(item.color)) {
        this.materialRow(colors, ITEM_MATERIALS, item.material, (id) =>
          this.store.updateItem(item.id, { material: id })
        );
        this.rotToggle(colors, item.material, item.materialRot === true, (v) =>
          this.store.updateItem(item.id, { materialRot: v || undefined })
        );
      } else {
        colors.appendChild(
          this.el(
            `<p class="props-sub" style="margin-top:8px">Texture follows the bound variable</p>`
          )
        );
      }

      // per-item worktop finish for anything topped with a counter slab
      const part = this.store.partOf(item.defId);

      // custom parts expose an accent (wood-tone) slot — bindable per instance
      if (part) {
        const accent = this.section(root, 'Accent');
        this.varChips(accent, item.accentColor ?? '', (ref) =>
          this.store.updateItem(item.id, { accentColor: ref })
        );
        this.swatchRow(
          accent,
          COUNTER_COLORS,
          resolveColor(this.store.design, item.accentColor ?? part.accentColor),
          (c) => this.store.updateItem(item.id, { accentColor: c })
        );
      }
      // worktops live on cabinet parts now — nothing else carries one
      const withWorktop = part ? part.type === 'cabinet' && part.worktop : false;
      if (withWorktop) {
        const counter = this.section(root, 'Worktop');
        this.materialRow(
          counter,
          COUNTER_MATERIALS,
          item.counterMaterial,
          (id) => this.store.updateItem(item.id, { counterMaterial: id }),
          'Room default'
        );
        this.rotToggle(counter, item.counterMaterial, item.counterMaterialRot === true, (v) =>
          this.store.updateItem(item.id, { counterMaterialRot: v || undefined })
        );
        counter.appendChild(
          this.el(
            `<p class="props-sub" style="margin-top:8px">First chip follows the room's worktop setting</p>`
          )
        );
      }
    }

    // light
    if (item.light) {
      const light = this.section(root, 'Light');
      this.toggleRow(light, 'On', item.light.on, (v) =>
        this.store.updateItemLight(item.id, { on: v })
      );
      this.sliderRow(light, 'Brightness', item.light.intensity, (v) =>
        this.store.updateItemLight(item.id, { intensity: v })
      );
      this.sliderRow(light, 'Warmth', item.light.warmth, (v) =>
        this.store.updateItemLight(item.id, { warmth: v })
      );
      // explicit colour wins over warmth when set
      this.swatchRow(light, LIGHT_COLORS, item.light.color ?? '#fff4e0', (c) =>
        this.store.updateItemLight(item.id, { color: c })
      );
    }

    // actions
    const actions = this.section(root, 'Actions');
    const row = this.el(
      `<div class="btn-row"><button class="btn">Duplicate</button><button class="btn danger">Delete</button></div>`
    );
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

    if (this.store.customPartById(item.defId)) {
      const editRow = this.el(
        `<div class="btn-row"><button class="btn">Edit part template…</button></div>`
      );
      editRow.querySelector('button')!.addEventListener('click', () => {
        const part = this.store.customPartById(item.defId);
        if (part) this.studio.open(part);
      });
      actions.appendChild(editRow);
    } else if (hasPreset(item.defId)) {
      // fork the preset into "My parts" so just this instance becomes editable
      const custRow = this.el(
        `<div class="btn-row"><button class="btn">Customize part…</button></div>`
      );
      custRow.querySelector('button')!.addEventListener('click', () => {
        const fork = this.store.forkPartForItem(item.id);
        if (!fork) return;
        this.store.commit();
        this.studio.open(fork);
      });
      actions.appendChild(custRow);
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
    // a partition belongs to two rooms — say which, so its edits are no surprise
    const twinRoom = g.shared ? this.store.roomById(g.shared.roomId) : undefined;
    if (twinRoom) {
      const line = this.el('<p class="props-sub room-shared">Shared with </p>');
      const who = document.createElement('b');
      who.textContent = twinRoom.name; // user text — never interpolated into HTML
      line.appendChild(who);
      root.appendChild(line);
    }
    const s = this.section(root, 'Size');
    this.numberRow(
      s,
      'Length',
      Math.round(g.len * 100),
      'cm',
      (v) => this.store.setWallLength(wallId, Math.max(30, v) / 100),
      { min: 30, max: 3000 }
    );
    // thickness is a property of the wall's OWN room, not the active one
    const wallRoom = this.store.roomOfWall(wallId) ?? this.store.activeRoom();
    this.numberRow(
      s,
      'Thickness',
      Math.round(wallRoom.style.wallThickness * 100),
      'cm',
      (v) =>
        this.store.setRoomStyle(
          { wallThickness: Math.min(0.4, Math.max(0.05, v / 100)) },
          wallRoom.id
        ),
      { min: 5, max: 40 }
    );
    const vis = this.section(root, 'Visibility');
    this.choiceRow(
      vis,
      [
        ['auto', 'Auto'],
        ['show', 'Show'],
        ['hide', 'Hide'],
      ],
      this.store.wallVisibility(wallId),
      (v) => this.store.setWallVisibility(wallId, v as WallVisMode)
    );
    vis.appendChild(
      this.el(
        `<p class="props-sub" style="margin-top:8px">Auto hides this wall when the camera looks past it</p>`
      )
    );

    const a = this.section(root, 'Shape');
    const btn = this.el(
      `<div class="btn-row"><button class="btn">Add corner in the middle</button></div>`
    );
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
    root.appendChild(
      this.el(`<h2 class="props-title">${o.type === 'door' ? 'Door' : 'Window'}</h2>`)
    );
    root.appendChild(
      this.el(`<p class="props-sub">Slides along its wall — drag it in the plan</p>`)
    );
    const s = this.section(root, 'Size');
    this.numberRow(
      s,
      'Width',
      Math.round(o.width * 100),
      'cm',
      (v) => this.store.updateOpening(id, { width: v / 100 }),
      { min: 30, max: 400 }
    );
    this.numberRow(
      s,
      'Height',
      Math.round(o.height * 100),
      'cm',
      (v) => this.store.updateOpening(id, { height: v / 100 }),
      { min: 30, max: 300 }
    );
    if (o.type === 'window') {
      this.numberRow(
        s,
        'Sill height',
        Math.round(o.sill * 100),
        'cm',
        (v) => this.store.updateOpening(id, { sill: v / 100 }),
        { min: 0, max: 250 }
      );
    }
    if (g) {
      this.numberRow(
        s,
        'From corner',
        Math.round(o.offset * 100),
        'cm',
        (v) => this.store.updateOpening(id, { offset: v / 100 }),
        { min: 0, max: Math.round(g.len * 100), cls: 'opening-off' }
      );
    }
    if (o.type === 'door') {
      const swing = this.section(root, 'Swing');
      this.choiceRow(
        swing,
        [
          ['left', 'Hinge left'],
          ['right', 'Hinge right'],
        ],
        o.hinge ?? 'left',
        (v) => this.store.updateOpening(id, { hinge: v as 'left' | 'right' })
      );
      this.choiceRow(
        swing,
        [
          ['in', 'Opens in'],
          ['out', 'Opens out'],
        ],
        o.swing ?? 'in',
        (v) => this.store.updateOpening(id, { swing: v as 'in' | 'out' })
      );
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
    root.appendChild(
      this.el(`<p class="props-sub">Drag it in the plan, or set exact coordinates</p>`)
    );
    const s = this.section(root, 'Position');
    this.numberRow(
      s,
      'X',
      Math.round(c.x * 100),
      'cm',
      (v) => this.store.moveCorner(id, v / 100, c.y, false),
      { cls: 'corner-x' }
    );
    this.numberRow(
      s,
      'Y',
      Math.round(c.y * 100),
      'cm',
      (v) => this.store.moveCorner(id, c.x, v / 100, false),
      { cls: 'corner-y' }
    );
    const a = this.section(root, 'Actions');
    const del = this.el(
      `<div class="btn-row"><button class="btn danger">Remove corner</button></div>`
    );
    const delBtn = del.querySelector('button') as HTMLButtonElement;
    if ((this.store.roomOfCorner(id)?.corners.length ?? 0) <= 3) {
      delBtn.disabled = true;
      delBtn.title = 'A room needs at least 3 corners';
    }
    delBtn.addEventListener('click', () => {
      this.store.deleteCorner(id);
      this.store.commit();
    });
    a.appendChild(del);
  }

  /* ================= keyboard shortcuts ================= */

  private wireKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;

      // one tool is live at a time, so the order below is really a priority
      // list for the studio-vs-tool-vs-selection question, not a cascade
      if (e.key === 'Escape') {
        const tool = this.editor.tool;
        if (this.studio.isOpen()) this.studio.handleEscape();
        else if (tool === 'place') this.plan.setArmed(null);
        else if (tool === 'calibrate') this.plan.setCalibrate(false);
        else if (tool === 'measure') this.plan.setMeasure(false);
        else if (tool === 'room') this.plan.setRoomTool(false);
        // two-stage: the ring in progress goes first, the tool only when empty
        else if (tool === 'drawRoom') this.plan.cancelDrawRoom();
        else this.store.select({ kind: 'none' });
        return;
      }
      if (typing || this.studio.isOpen()) return;

      // Enter closes the ring the draw-room tool is building
      if (e.key === 'Enter' && this.editor.isTool('drawRoom')) {
        e.preventDefault();
        this.plan.closeDrawRoom();
        return;
      }

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
