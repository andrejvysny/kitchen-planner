import { COUNTER_COLORS, OAK, WALNUT } from '../../model/catalog';
import type { BoardPartDef, Point } from '../../model/types';
import { choiceRow, dimRow, numRow, section, swatchRow } from './controls';
import type { PolygonCanvas } from './polygonCanvas';

/** Outline presets, sized around a typical worktop. */
function presetOutline(kind: 'rect' | 'l' | 'u'): Point[] {
  if (kind === 'rect') {
    return [
      { x: -1.2, y: -0.31 },
      { x: 1.2, y: -0.31 },
      { x: 1.2, y: 0.31 },
      { x: -1.2, y: 0.31 },
    ];
  }
  if (kind === 'l') {
    return [
      { x: -1.2, y: -0.75 },
      { x: 1.2, y: -0.75 },
      { x: 1.2, y: 0.75 },
      { x: 0.58, y: 0.75 },
      { x: 0.58, y: -0.13 },
      { x: -1.2, y: -0.13 },
    ];
  }
  return [
    { x: -1.2, y: -0.75 },
    { x: 1.2, y: -0.75 },
    { x: 1.2, y: 0.75 },
    { x: 0.58, y: 0.75 },
    { x: 0.58, y: -0.13 },
    { x: -0.58, y: -0.13 },
    { x: -0.58, y: 0.75 },
    { x: -1.2, y: 0.75 },
  ];
}

/** Worktop/board mode rail: thickness, elevation, material, presets, cutouts. */
export class BoardPanel {
  private part: BoardPartDef;
  private canvas: PolygonCanvas;
  private inspectorEl: HTMLElement | null = null;
  private topCaption: (() => void) | null = null;
  private onChange: () => void;

  constructor(rail: HTMLElement, part: BoardPartDef, canvas: PolygonCanvas, onChange: () => void) {
    this.part = part;
    this.canvas = canvas;
    this.onChange = onChange;
    canvas.onSelect = () => this.renderInspector();

    const slab = section(rail, 'Slab (cm)');
    dimRow(slab, 'Thickness', () => part.h, (v) => { part.h = v; onChange(); }, 0.012, 0.08);
    numRow(slab, 'Off floor', () => part.elevation, (v) => {
      part.elevation = v;
      caption();
      onChange();
    }, { min: 0, max: 2.2 });
    const capEl = document.createElement('div');
    capEl.className = 'studio-caption';
    slab.appendChild(capEl);
    const caption = () => {
      capEl.textContent = `Top surface at ${Math.round((part.elevation + part.h) * 100)} cm.`;
    };
    caption();
    this.topCaption = caption;

    const mat = section(rail, 'Material');
    choiceRow(mat, 'Finish', [['wood', 'Wood'], ['matte', 'Matte']], () => part.material, (v) => {
      part.material = v as BoardPartDef['material'];
      onChange();
    });
    swatchRow(mat, [OAK, WALNUT, ...COUNTER_COLORS.slice(1)], () => part.color, (c) => {
      part.color = c;
      onChange();
      canvas.draw();
    });

    const shape = section(rail, 'Outline');
    const presets = document.createElement('div');
    presets.className = 'choice';
    for (const [kind, label] of [['rect', 'Rectangle'], ['l', 'L-shape'], ['u', 'U-shape']] as const) {
      const b = document.createElement('button');
      b.className = 'btn choice-btn';
      b.textContent = label;
      b.addEventListener('click', () => {
        part.outline = presetOutline(kind);
        part.holes = [];
        this.canvas.clearSelection();
        onChange();
        this.canvas.draw();
      });
      presets.appendChild(b);
    }
    shape.appendChild(presets);
    const hint = document.createElement('div');
    hint.className = 'studio-caption';
    hint.textContent = 'Drag ■ corners; drag a ◆ edge midpoint to add a corner; Delete removes it. The bottom edge is the front.';
    shape.appendChild(hint);

    const cut = document.createElement('button');
    cut.className = 'btn board-add';
    cut.textContent = '＋ Add cutout (sink / hob)';
    cut.addEventListener('click', () => this.canvas.addHole());
    shape.appendChild(cut);

    this.inspectorEl = document.createElement('div');
    rail.appendChild(this.inspectorEl);
    this.renderInspector();
  }

  validate(): string | null {
    return this.canvas.valid();
  }

  handleEscape(): boolean {
    return this.canvas.clearSelection();
  }

  handleDelete(): boolean {
    return this.canvas.deleteSelected();
  }

  refresh(): void {
    this.topCaption?.();
  }

  private renderInspector(): void {
    if (!this.inspectorEl) return;
    this.inspectorEl.innerHTML = '';
    const sel = this.canvas.selection;
    if (sel.kind === 'corner') {
      const c = this.part.outline[sel.i];
      if (!c) return;
      const ins = section(this.inspectorEl, 'Selected corner (cm)');
      numRow(ins, 'X', () => c.x, (v) => { c.x = v; this.onChange(); this.canvas.draw(); });
      numRow(ins, 'Y', () => c.y, (v) => { c.y = v; this.onChange(); this.canvas.draw(); });
    } else if (sel.kind === 'hole') {
      const h = this.part.holes[sel.i];
      if (!h) return;
      const ins = section(this.inspectorEl, 'Selected cutout (cm)');
      numRow(ins, 'X (center)', () => h.x, (v) => { h.x = v; this.onChange(); this.canvas.draw(); });
      numRow(ins, 'Y (center)', () => h.y, (v) => { h.y = v; this.onChange(); this.canvas.draw(); });
      numRow(ins, 'Width', () => h.w, (v) => { h.w = Math.max(0.05, v); this.onChange(); this.canvas.draw(); });
      numRow(ins, 'Depth', () => h.d, (v) => { h.d = Math.max(0.05, v); this.onChange(); this.canvas.draw(); });
    }
  }
}
