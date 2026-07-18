import {
  buildPack,
  buildPdfBlob,
  cutListCsv,
  cutPartsDxf,
  validateDesignFit,
} from '../../model/manufacture';
import { sheetBounds } from '../../model/manufacture/drawings';
import type { ManufactureSettings } from '../../model/manufacture/settings';
import type { DrawingSheet, DrawPrim, ManufacturePack, SheetTable } from '../../model/manufacture/types';
import type { Store } from '../../model/store';

type Point = { x: number; y: number };

/**
 * Manufacturing export dialog. A PartStudio-shaped modal (reuses the
 * `.studio-overlay` chrome via the `.studio.mfg` variant): a settings rail on
 * the left, a live sheet preview in the centre, download buttons in the foot.
 *
 * The whole pure manufacturing pipeline lives in src/model/manufacture; this
 * class only edits `design.manufacture` (through `store.setManufacture`, which
 * rebuilds the 3D view behind the dialog) and renders the resulting
 * `ManufacturePack` to a canvas + three download formats. Settings edits are
 * atomic — each is one undo step. The status chip reflects the fit validator.
 */
export class ManufactureDialog {
  private store: Store;
  private overlay: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private pack: ManufacturePack | null = null;
  private page = 0;
  private ro: ResizeObserver | null = null;
  private regenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  isOpen(): boolean {
    return !!this.overlay;
  }

  private settings(): ManufactureSettings {
    return this.store.design.manufacture;
  }

  /* ---------------- lifecycle ---------------- */

  open(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'studio-overlay';
    overlay.innerHTML = `
      <div class="studio mfg">
        <div class="mfg-head">
          <span class="mfg-title">Manufacturing export</span>
          <span class="mfg-status" title=""></span>
          <button class="studio-x mfg-x" title="Close">✕</button>
        </div>
        <div class="mfg-body">
          <div class="mfg-rail"></div>
          <div class="mfg-center">
            <div class="mfg-nav">
              <button class="mfg-prev" title="Previous sheet">‹</button>
              <span class="mfg-page"></span>
              <span class="mfg-sheet-title"></span>
              <button class="mfg-next" title="Next sheet">›</button>
            </div>
            <div class="mfg-stage">
              <canvas class="mfg-canvas"></canvas>
              <div class="mfg-empty" hidden>
                <b>Nothing to manufacture yet</b><br>
                Add cabinets, worktops or custom parts to the plan, then export
                cut lists, CNC drawings and a PDF pack.
              </div>
            </div>
          </div>
        </div>
        <div class="mfg-foot">
          <span class="mfg-summary"></span>
          <span style="flex:1"></span>
          <button class="btn mfg-csv">Cut list CSV</button>
          <button class="btn mfg-dxf">DXF (CNC)</button>
          <button class="btn primary mfg-pdf">PDF pack</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.canvas = overlay.querySelector('.mfg-canvas') as HTMLCanvasElement;

    (overlay.querySelector('.mfg-x') as HTMLElement).addEventListener('click', () => this.close());
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) this.close();
    });
    (overlay.querySelector('.mfg-prev') as HTMLElement).addEventListener('click', () => this.step(-1));
    (overlay.querySelector('.mfg-next') as HTMLElement).addEventListener('click', () => this.step(1));
    (overlay.querySelector('.mfg-csv') as HTMLElement).addEventListener('click', () => this.downloadCsv());
    (overlay.querySelector('.mfg-dxf') as HTMLElement).addEventListener('click', () => this.downloadDxf());
    (overlay.querySelector('.mfg-pdf') as HTMLElement).addEventListener('click', () => this.downloadPdf());

    this.ro = new ResizeObserver(() => this.renderSheet());
    this.ro.observe(this.canvas);

    this.renderRail();
    this.regen(); // synchronous initial pack build
    this.updateStatus();
  }

  handleEscape(): void {
    this.close();
  }

  close(): void {
    if (this.regenTimer) clearTimeout(this.regenTimer);
    this.regenTimer = null;
    this.ro?.disconnect();
    this.ro = null;
    this.overlay?.remove();
    this.overlay = null;
    this.canvas = null;
    this.pack = null;
  }

  /* ---------------- settings rail ---------------- */

  private renderRail(): void {
    const rail = this.overlay!.querySelector('.mfg-rail') as HTMLElement;
    rail.innerHTML = '';
    const m = this.settings();

    const carcass = this.section(rail, 'Carcass');
    this.numberRow(carcass, 'Board thickness', 'carcassT', m.carcassT, 12, 30, 0);
    this.selectRow(carcass, 'Back', 'backMode', m.backMode, [
      ['groove', 'Grooved-in'],
      ['screwed', 'Screwed on'],
    ]);
    this.numberRow(carcass, 'Back thickness', 'backT', m.backT, 3, 19, 0);
    this.numberRow(carcass, 'Groove depth', 'grooveDepth', m.grooveDepth, 4, 12, 0);
    this.selectRow(carcass, 'Joinery', 'joinery', m.joinery, [
      ['confirmat', 'Confirmat'],
      ['camlock', 'Cam-lock'],
    ]);

    const fronts = this.section(rail, 'Fronts');
    this.numberRow(fronts, 'Reveal gap', 'frontReveal', m.frontReveal, 1, 8, 0);
    this.numberRow(fronts, 'Edge band — front', 'edgeFrontT', m.edgeFrontT, 0, 3, 1);
    this.numberRow(fronts, 'Edge band — carcass', 'edgeCarcassT', m.edgeCarcassT, 0, 3, 1);

    const pw = this.section(rail, 'Plinth & worktop');
    this.numberRow(pw, 'Plinth height', 'plinthH', m.plinthH, 40, 200, 0);
    this.numberRow(pw, 'Worktop thickness', 'worktopT', m.worktopT, 12, 80, 0);

    const dr = this.section(rail, 'Drawers');
    this.textRow(dr, 'System', 'drawer.system', m.drawer.system);
    this.numberRow(dr, 'Width deduction', 'drawer.widthDeduction', m.drawer.widthDeduction, 0, 200, 0);
    this.numberRow(dr, 'Bottom thickness', 'drawer.bottomT', m.drawer.bottomT, 3, 19, 0);
  }

  private section(root: HTMLElement, title: string): HTMLElement {
    const s = this.el(`<div class="prop-section"><div class="prop-section-title">${title}</div></div>`);
    root.appendChild(s);
    return s;
  }

  /**
   * A metres-valued number input, edited in millimetres. `key` is the settings
   * path (dotted for the nested drawer group); `decimals` 0 for whole mm, 1 for
   * the sub-millimetre edge-banding fields.
   */
  private numberRow(
    parent: HTMLElement,
    label: string,
    key: string,
    valueM: number,
    minMm: number,
    maxMm: number,
    decimals: number
  ): void {
    const mm = decimals ? Math.round(valueM * 1000 * 10) / 10 : Math.round(valueM * 1000);
    const step = decimals ? 0.1 : 1;
    const row = this.el(`<div class="prop-row"><label>${label}</label>
      <input type="number" data-key="${key}" value="${mm}" min="${minMm}" max="${maxMm}" step="${step}">
      <span class="unit">mm</span></div>`);
    const input = row.querySelector('input') as HTMLInputElement;
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      this.apply(key, v / 1000);
      // reflect the sanitized/clamped value back into the field
      const cur = this.pathValue(key);
      if (typeof cur === 'number') {
        input.value = String(decimals ? Math.round(cur * 1000 * 10) / 10 : Math.round(cur * 1000));
      }
    });
    parent.appendChild(row);
  }

  private selectRow(
    parent: HTMLElement,
    label: string,
    key: string,
    current: string,
    options: [string, string][]
  ): void {
    const row = this.el(`<div class="prop-row"><label>${label}</label></div>`);
    const select = document.createElement('select');
    select.className = 'mfg-select';
    select.dataset.key = key;
    for (const [value, text] of options) {
      const opt = new Option(text, value);
      opt.selected = value === current;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => this.apply(key, select.value));
    row.appendChild(select);
    parent.appendChild(row);
  }

  private textRow(parent: HTMLElement, label: string, key: string, current: string): void {
    const row = this.el(`<div class="prop-row"><label>${label}</label>
      <input type="text" class="mfg-text" data-key="${key}" value="${current.replace(/"/g, '&quot;')}"></div>`);
    const input = row.querySelector('input') as HTMLInputElement;
    input.addEventListener('change', () => this.apply(key, input.value));
    parent.appendChild(row);
  }

  /** Current value at a (possibly dotted) settings path. */
  private pathValue(key: string): unknown {
    const m = this.settings();
    if (key.startsWith('drawer.')) return (m.drawer as unknown as Record<string, unknown>)[key.slice(7)];
    return (m as unknown as Record<string, unknown>)[key];
  }

  /** Write one settings value (dotted key → nested group), then refresh. */
  private apply(key: string, value: number | string): void {
    if (key.startsWith('drawer.')) {
      this.store.setManufacture({ drawer: { [key.slice(7)]: value } });
    } else {
      this.store.setManufacture({ [key]: value });
    }
    this.updateStatus();
    this.scheduleRegen();
  }

  /* ---------------- pack + preview ---------------- */

  private scheduleRegen(): void {
    if (this.regenTimer) clearTimeout(this.regenTimer);
    this.regenTimer = setTimeout(() => {
      this.regenTimer = null;
      this.regen();
    }, 200);
  }

  private regen(): void {
    if (!this.overlay) return;
    this.pack = buildPack(this.store.design);
    this.page = Math.max(0, Math.min(this.page, this.pack.sheets.length - 1));
    this.updateContent();
  }

  /** Toggle preview vs. empty hint, refresh nav / summary / buttons / canvas. */
  private updateContent(): void {
    if (!this.overlay || !this.pack) return;
    const has = this.pack.cutParts.length > 0;
    const canvas = this.overlay.querySelector('.mfg-canvas') as HTMLElement;
    const empty = this.overlay.querySelector('.mfg-empty') as HTMLElement;
    const nav = this.overlay.querySelector('.mfg-nav') as HTMLElement;
    canvas.hidden = !has;
    empty.hidden = has;
    nav.style.visibility = has ? '' : 'hidden';

    for (const cls of ['.mfg-csv', '.mfg-dxf', '.mfg-pdf']) {
      (this.overlay.querySelector(cls) as HTMLButtonElement).disabled = !has;
    }

    this.updateNav();
    this.updateSummary();
    if (has) this.renderSheet();
  }

  private step(dir: number): void {
    if (!this.pack) return;
    const n = this.pack.sheets.length;
    this.page = Math.max(0, Math.min(this.page + dir, n - 1));
    this.updateNav();
    this.renderSheet();
  }

  private updateNav(): void {
    if (!this.overlay || !this.pack) return;
    const n = this.pack.sheets.length;
    const sheet = this.pack.sheets[this.page];
    (this.overlay.querySelector('.mfg-page') as HTMLElement).textContent = `${this.page + 1}/${n}`;
    (this.overlay.querySelector('.mfg-sheet-title') as HTMLElement).textContent = sheet ? sheet.title : '';
    (this.overlay.querySelector('.mfg-prev') as HTMLButtonElement).disabled = this.page <= 0;
    (this.overlay.querySelector('.mfg-next') as HTMLButtonElement).disabled = this.page >= n - 1;
  }

  private updateSummary(): void {
    if (!this.overlay || !this.pack) return;
    const p = this.pack;
    const cabinets = p.sheets.filter((s) => s.kind === 'cabinet').length;
    const cutParts = p.cutParts.length;
    const boards = p.cutParts.reduce((n, c) => n + c.qty, 0);
    const hardware = p.hardware.length;
    const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;
    (this.overlay.querySelector('.mfg-summary') as HTMLElement).textContent =
      `${plural(cabinets, 'cabinet')} · ${plural(cutParts, 'cut part')} · ${plural(boards, 'board')} · ${plural(hardware, 'hardware line')}`;
  }

  private updateStatus(): void {
    if (!this.overlay) return;
    const chip = this.overlay.querySelector('.mfg-status') as HTMLElement;
    const violations = validateDesignFit(this.store.design);
    if (violations.length === 0) {
      chip.textContent = '✓ parts fit';
      chip.className = 'mfg-status ok';
      chip.title = 'Every part assembles from its cut list';
    } else {
      chip.textContent = `${violations.length} fit ${violations.length === 1 ? 'issue' : 'issues'}`;
      chip.className = 'mfg-status bad';
      const rules = [...new Set(violations.map((v) => v.rule))].slice(0, 3).join(', ');
      chip.title = `First issues: ${rules}`;
    }
  }

  /* ---------------- canvas renderer ---------------- */

  private renderSheet(): void {
    if (!this.pack || !this.canvas || this.canvas.hidden) return;
    const sheet = this.pack.sheets[this.page];
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.floor(rect.width));
    const H = Math.max(1, Math.floor(rect.height));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    if (!sheet) return;
    if (sheet.table) this.drawTable(ctx, W, H, sheet.table);
    else this.drawGeometry(ctx, W, H, sheet);
  }

  private drawGeometry(ctx: CanvasRenderingContext2D, W: number, H: number, sheet: DrawingSheet): void {
    const b = sheetBounds(sheet.prims);
    const ew = Math.max(1e-6, b.maxX - b.minX);
    const eh = Math.max(1e-6, b.maxY - b.minY);
    const pad = 26;
    const scale = Math.min((W - 2 * pad) / ew, (H - 2 * pad) / eh);
    const usedW = ew * scale;
    const usedH = eh * scale;
    const ox = (W - usedW) / 2;
    const oyTop = (H - usedH) / 2;
    // drawing frame is y-up; canvas y-down → flip through (maxY - y)
    const xf = (p: Point): Point => ({ x: ox + (p.x - b.minX) * scale, y: oyTop + (b.maxY - p.y) * scale });

    const fam = 'Inter, "Segoe UI", system-ui, sans-serif';
    for (const p of sheet.prims) this.drawPrim(ctx, p, xf, scale, fam);
  }

  private drawPrim(
    ctx: CanvasRenderingContext2D,
    p: DrawPrim,
    xf: (q: Point) => Point,
    scale: number,
    fam: string
  ): void {
    if (p.t === 'poly') {
      this.stroke(ctx, p.layer);
      const pts = p.pts.map(xf);
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (p.closed && pts.length > 2) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (p.t === 'circle') {
      this.stroke(ctx, p.layer);
      const c = xf(p.c);
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(0.6, p.r * scale), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (p.t === 'text') {
      const px = Math.max(6, Math.min(15, p.size * scale));
      ctx.font = `${px}px ${fam}`;
      ctx.fillStyle = p.layer === 'drill' ? '#c0281e' : '#2b2a27';
      ctx.textAlign = p.anchor === 'c' ? 'center' : p.anchor === 'r' ? 'right' : 'left';
      const t = xf(p.p);
      ctx.fillText(p.s, t.x, t.y);
      ctx.textAlign = 'left';
    } else {
      this.drawDim(ctx, p, xf, fam);
    }
  }

  private drawDim(
    ctx: CanvasRenderingContext2D,
    p: Extract<DrawPrim, { t: 'dim' }>,
    xf: (q: Point) => Point,
    fam: string
  ): void {
    const dx = p.b.x - p.a.x;
    const dy = p.b.y - p.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const a2 = { x: p.a.x + nx * p.off, y: p.a.y + ny * p.off };
    const b2 = { x: p.b.x + nx * p.off, y: p.b.y + ny * p.off };
    const A = xf(a2);
    const B = xf(b2);
    const A0 = xf(p.a);
    const B0 = xf(p.b);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#9a9ab0';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(A0.x, A0.y);
    ctx.lineTo(A.x, A.y);
    ctx.moveTo(B0.x, B0.y);
    ctx.lineTo(B.x, B.y);
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
    ctx.font = `9px ${fam}`;
    ctx.fillStyle = '#5c5c78';
    ctx.textAlign = 'center';
    ctx.fillText(p.text, (A.x + B.x) / 2, (A.y + B.y) / 2 - 1.5);
    ctx.textAlign = 'left';
  }

  private stroke(ctx: CanvasRenderingContext2D, layer: string): void {
    ctx.setLineDash([]);
    if (layer === 'wall') {
      ctx.strokeStyle = '#20201e';
      ctx.lineWidth = 1.6;
    } else if (layer === 'outline') {
      ctx.strokeStyle = '#20201e';
      ctx.lineWidth = 1.1;
    } else if (layer === 'drill') {
      ctx.strokeStyle = '#c8281e';
      ctx.lineWidth = 1;
    } else if (layer === 'hidden') {
      ctx.strokeStyle = '#a8a29a';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([4, 3]);
    } else {
      ctx.strokeStyle = '#5a5852';
      ctx.lineWidth = 1;
    }
  }

  private drawTable(ctx: CanvasRenderingContext2D, W: number, H: number, table: SheetTable): void {
    const fam = 'Inter, "Segoe UI", system-ui, sans-serif';
    const pad = 18;
    const totalW = W - 2 * pad;
    const n = table.headers.length;
    const weights = table.headers.map((h, c) => {
      let mx = h.length;
      for (const r of table.rows.slice(0, 40)) mx = Math.max(mx, (r[c] ?? '').length);
      return Math.min(mx, 40);
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const widths = weights.map((w) => (w / sum) * totalW);
    const rowH = Math.max(15, Math.min(22, (H - 2 * pad) / (table.rows.length + 2)));
    let y = pad;
    ctx.textBaseline = 'middle';

    const drawRow = (cells: string[], yy: number): void => {
      let x = pad;
      for (let c = 0; c < widths.length; c++) {
        const maxChars = Math.max(2, Math.floor(widths[c] / 6.5));
        const s = cells[c] ?? '';
        const clipped = s.length <= maxChars ? s : s.slice(0, maxChars - 1) + '…';
        ctx.fillText(clipped, x + 3, yy + rowH / 2);
        x += widths[c];
      }
    };

    ctx.fillStyle = '#ece9e2';
    ctx.fillRect(pad, y, totalW, rowH);
    ctx.fillStyle = '#2b2a27';
    ctx.font = `600 12px ${fam}`;
    drawRow(table.headers, y);
    y += rowH;

    ctx.font = `11.5px ${fam}`;
    for (const r of table.rows) {
      if (y + rowH > H - pad) break;
      ctx.strokeStyle = '#e3e1dc';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(pad, y + rowH);
      ctx.lineTo(pad + totalW, y + rowH);
      ctx.stroke();
      ctx.fillStyle = '#3a3833';
      drawRow(r, y);
      y += rowH;
    }
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- downloads ---------------- */

  private download(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private downloadCsv(): void {
    if (!this.pack) return;
    const blob = new Blob([cutListCsv(this.pack.cutParts)], { type: 'text/csv' });
    this.download(blob, 'kitchen-cutlist.csv');
  }

  private downloadDxf(): void {
    if (!this.pack) return;
    const blob = new Blob([cutPartsDxf(this.pack.cutParts)], { type: 'application/dxf' });
    this.download(blob, 'kitchen-panels.dxf');
  }

  private async downloadPdf(): Promise<void> {
    if (!this.pack) return;
    const btn = this.overlay?.querySelector('.mfg-pdf') as HTMLButtonElement | null;
    if (!btn) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const blob = await buildPdfBlob(this.pack);
      this.download(blob, 'kitchen-pack.pdf');
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  /* ---------------- utils ---------------- */

  private el(html: string): HTMLElement {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstElementChild as HTMLElement;
  }
}
