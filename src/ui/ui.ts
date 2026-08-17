import { demoDesign, Store } from '../model/store';
import type { WallVisMode } from '../model/types';
import type { Plan2D } from '../plan2d/plan2d';
import type { EditorState } from '../editor/editorState';
import { studio } from '../app/bootstrap';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export class UI {
  private store: Store;
  private plan: Plan2D;
  private editor: EditorState;

  // The 3D view left this class in step B2 with the topbar buttons that drove
  // it (snapshot / GLB / camera presets / pane visibility); B3 took the tool
  // buttons, the 2D/elev toggle, the wall nav and the catalog drawer, T3 the
  // sidebar tabs plus the whole Variables panel, T4 the catalog and the
  // components outline, T5a the room panel with the reference photo and T5b
  // the item panel. What is left is wall / opening / corner and the keyboard
  // map.
  constructor(store: Store, plan: Plan2D, editor: EditorState) {
    this.store = store;
    this.plan = plan;
    this.editor = editor;

    this.renderProps();
    this.wireKeyboard();

    store.on('selection', () => this.renderProps());
    store.on('history', () => {
      // skip the full panel rebuild while the user is interacting inside it —
      // steppers, choice rows and inputs keep themselves current
      const active = document.activeElement;
      if (!active || !$('#props').contains(active)) this.renderProps();
    });
    store.on('change', (info) => {
      if (info.transient) this.refreshTransientInputs();
    });
  }

  /* ================= properties panel ================= */

  /**
   * The panels React has not taken yet, drawn into `#props-legacy` — the div
   * <PropsPanel/> renders for exactly this purpose and never gives children of
   * its own (see the two-writer note there). The no-selection room panel, and
   * any selection whose id no longer resolves, are React's: this method leaves
   * the container empty and <PropsBody/> renders over it.
   */
  private renderProps(): void {
    const root = $('#props-legacy');
    root.innerHTML = '';
    const sel = this.store.selection;

    if (sel.kind === 'wall') {
      const wall = this.store.wallById(sel.id);
      if (wall) return this.renderWallProps(root, sel.id);
    } else if (sel.kind === 'opening') {
      const o = this.store.openingById(sel.id);
      if (o) return this.renderOpeningProps(root, sel.id);
    } else if (sel.kind === 'corner') {
      const c = this.store.cornerById(sel.id);
      if (c) return this.renderCornerProps(root, sel.id);
    }
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

  /** Keep panel fields in sync mid-gesture without a full re-render. */
  private refreshTransientInputs(): void {
    const set = (cls: string, value: number) => {
      const input = document.querySelector<HTMLInputElement>(`input[data-cls="${cls}"]`);
      if (input && document.activeElement !== input) input.value = String(value);
    };
    const sel = this.store.selection;
    // the item panel's own three fields are React's now, and follow the drag
    // through useLiveValue instead — see src/ui/react/fields/useLiveValue.ts
    if (sel.kind === 'corner') {
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
        if (studio.isOpen()) studio.handleEscape();
        else if (tool === 'place') this.plan.setArmed(null);
        else if (tool === 'calibrate') this.plan.setCalibrate(false);
        else if (tool === 'measure') this.plan.setMeasure(false);
        else if (tool === 'room') this.plan.setRoomTool(false);
        // two-stage: the ring in progress goes first, the tool only when empty
        else if (tool === 'drawRoom') this.plan.cancelDrawRoom();
        else this.store.select({ kind: 'none' });
        return;
      }
      if (typing || studio.isOpen()) return;

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
