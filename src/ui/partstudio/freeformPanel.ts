import { COUNTER_COLORS, FRONT_COLORS, OAK, WALNUT } from '../../model/catalog';
import { freeformBounds } from '../../model/parts';
import type { Board, FreeformPartDef } from '../../model/types';
import { uid } from '../../model/types';
import { choiceRow, numRow, section, swatchRow } from './controls';

/**
 * Free-boards mode: a list of boards composing arbitrary furniture. Boards
 * are edited numerically (cm), nudged with arrow keys, and picked by
 * clicking them in the 3D preview.
 */
export class FreeformPanel {
  private part: FreeformPartDef;
  private rail: HTMLElement;
  private onChange: () => void;
  private listEl: HTMLElement | null = null;
  private inspectorEl: HTMLElement | null = null;
  private captionEl: HTMLElement | null = null;
  selectedId: string | null = null;

  constructor(rail: HTMLElement, part: FreeformPartDef, onChange: () => void) {
    this.part = part;
    this.rail = rail;
    this.onChange = onChange;
    this.render();
  }

  private boardLabel(b: Board): string {
    const cm = (v: number) => Math.round(v * 100);
    const kind = b.shape === 'cyl' ? '⌀' : '▭';
    return `${kind} ${cm(b.w)}×${cm(b.h)}×${cm(b.d)}`;
  }

  private newBoard(): Board {
    const top = this.part.boards.reduce((m, b) => Math.max(m, b.y + b.h), 0);
    return {
      id: uid('b'),
      x: 0,
      y: top,
      z: 0,
      w: 0.6,
      h: 0.018,
      d: 0.4,
      rotY: 0,
      shape: 'box',
      slot: 'front',
      style: 'plain',
    };
  }

  private selected(): Board | undefined {
    return this.part.boards.find((b) => b.id === this.selectedId);
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.renderList();
    this.renderInspector();
    this.onChange();
  }

  /** Arrow-key nudge for the selected board. Returns true when consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const b = this.selected();
    if (!b || !e.key.startsWith('Arrow')) return false;
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.altKey) {
      if (e.key === 'ArrowUp') b.y += step;
      else if (e.key === 'ArrowDown') b.y = Math.max(0, b.y - step);
      else return false;
    } else {
      if (e.key === 'ArrowLeft') b.x -= step;
      else if (e.key === 'ArrowRight') b.x += step;
      else if (e.key === 'ArrowUp') b.z -= step;
      else if (e.key === 'ArrowDown') b.z += step;
    }
    this.refreshCaption();
    this.renderInspector();
    this.onChange();
    return true;
  }

  handleEscape(): boolean {
    if (this.selectedId) {
      this.select(null);
      return true;
    }
    return false;
  }

  handleDelete(): boolean {
    const b = this.selected();
    if (!b) return false;
    this.part.boards = this.part.boards.filter((x) => x.id !== b.id);
    this.select(null);
    return true;
  }

  validate(): string | null {
    return this.part.boards.length ? null : 'Add at least one board.';
  }

  private refreshCaption(): void {
    if (!this.captionEl) return;
    if (!this.part.boards.length) {
      this.captionEl.textContent = 'No boards yet — add one below.';
      return;
    }
    const cm = (v: number) => Math.round(v * 100);
    const bb = freeformBounds(this.part.boards);
    this.captionEl.textContent = `≈ ${cm(bb.maxX - bb.minX)} × ${cm(bb.maxZ - bb.minZ)} × ${cm(bb.maxY)} cm — from boards`;
  }

  private render(): void {
    this.rail.innerHTML = '';
    const info = section(this.rail, 'Size');
    this.captionEl = document.createElement('div');
    this.captionEl.className = 'studio-caption';
    info.appendChild(this.captionEl);

    const colors = section(this.rail, 'Front colour');
    swatchRow(colors, FRONT_COLORS, () => this.part.color, (c) => {
      this.part.color = c;
      this.onChange();
    });
    const accent = section(this.rail, 'Wood accent');
    swatchRow(accent, [OAK, WALNUT, ...COUNTER_COLORS.slice(1, 3)], () => this.part.accentColor, (c) => {
      this.part.accentColor = c;
      this.onChange();
    });

    const boards = section(this.rail, 'Boards');
    this.listEl = document.createElement('div');
    this.listEl.className = 'board-list';
    boards.appendChild(this.listEl);
    const add = document.createElement('button');
    add.className = 'btn board-add';
    add.textContent = '＋ Add board';
    add.addEventListener('click', () => {
      const b = this.newBoard();
      this.part.boards.push(b);
      this.select(b.id);
    });
    boards.appendChild(add);
    const hint = document.createElement('div');
    hint.className = 'studio-caption';
    hint.textContent = 'Click a board in the preview to select it. Arrows nudge, ⇧ = 10 cm, ⌥↑↓ = height.';
    boards.appendChild(hint);

    this.inspectorEl = document.createElement('div');
    this.rail.appendChild(this.inspectorEl);

    this.renderList();
    this.renderInspector();
    this.refreshCaption();
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    for (const b of this.part.boards) {
      const row = document.createElement('div');
      row.className = `board-row${b.id === this.selectedId ? ' active' : ''}`;
      row.innerHTML = `<span class="board-label">${this.boardLabel(b)}</span>
        <button title="Duplicate board">⧉</button><button title="Remove board">✕</button>`;
      row.addEventListener('click', () => this.select(b.id));
      const [dup, del] = Array.from(row.querySelectorAll('button'));
      dup.addEventListener('click', (e) => {
        e.stopPropagation();
        const copy: Board = { ...b, id: uid('b'), y: b.y + b.h };
        this.part.boards.push(copy);
        this.select(copy.id);
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.part.boards = this.part.boards.filter((x) => x.id !== b.id);
        if (this.selectedId === b.id) this.selectedId = null;
        this.select(this.selectedId);
      });
      this.listEl.appendChild(row);
    }
    this.refreshCaption();
  }

  private renderInspector(): void {
    if (!this.inspectorEl) return;
    this.inspectorEl.innerHTML = '';
    const b = this.selected();
    if (!b) return;
    const ins = section(this.inspectorEl, 'Selected board (cm)');
    const sync: Array<() => void> = [];
    const change = () => {
      this.renderList();
      this.refreshCaption();
      this.onChange();
    };
    sync.push(numRow(ins, 'X (center)', () => b.x, (v) => { b.x = v; change(); }));
    sync.push(numRow(ins, 'Y (bottom)', () => b.y, (v) => { b.y = Math.max(0, v); change(); }));
    sync.push(numRow(ins, 'Z (center)', () => b.z, (v) => { b.z = v; change(); }));
    sync.push(numRow(ins, 'Width', () => b.w, (v) => { b.w = v; change(); }, { min: 0.005, max: 4 }));
    sync.push(numRow(ins, 'Height', () => b.h, (v) => { b.h = v; change(); }, { min: 0.005, max: 2.6 }));
    sync.push(numRow(ins, 'Depth', () => b.d, (v) => { b.d = v; change(); }, { min: 0.005, max: 2 }));

    const rot = document.createElement('div');
    rot.className = 'prop-row';
    const deg = () => Math.round((b.rotY * 180) / Math.PI);
    rot.innerHTML = `<label>Rotation</label>
      <div class="stepper"><button>−</button><span>${deg()}°</span><button>+</button></div>`;
    const [minus, plus] = Array.from(rot.querySelectorAll('button'));
    const span = rot.querySelector('span') as HTMLElement;
    const turn = (dir: number) => {
      b.rotY += (dir * 15 * Math.PI) / 180;
      span.textContent = `${deg()}°`;
      change();
    };
    minus.addEventListener('click', () => turn(-1));
    plus.addEventListener('click', () => turn(1));
    ins.appendChild(rot);

    choiceRow(ins, 'Colour', [['front', 'Front'], ['accent', 'Accent']], () => b.slot, (v) => {
      b.slot = v as Board['slot'];
      change();
    });
    choiceRow(ins, 'Style', [['plain', 'Plain'], ['front', 'Groove']], () => b.style, (v) => {
      b.style = v as Board['style'];
      change();
    });
    choiceRow(ins, 'Shape', [['box', 'Board'], ['cyl', 'Cylinder']], () => b.shape, (v) => {
      b.shape = v as Board['shape'];
      change();
    });
  }
}
