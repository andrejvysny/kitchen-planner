import { sheetBounds, type SheetBounds } from './drawings';
import type { DrawingSheet, DrawPrim, ManufacturePack, SheetTable } from './types';

/**
 * Multi-page PDF assembly for the manufacturing pack. Each `DrawingSheet` becomes
 * one A4-landscape page (table sheets paginate onto continuation pages) with a
 * margin frame and a bottom-right title block. Geometric sheets are fitted into
 * the content area preserving aspect at a standard 1:n scale; prim layers map to
 * line styles (hidden → dashed), dimension prims render as offset dimension lines
 * with end ticks and centred text.
 *
 * jsPDF is imported DYNAMICALLY (`await import('jspdf')`) so it code-splits into
 * its own lazy chunk — mirroring how View3D lazy-loads GLTFExporter — and never
 * weighs on the main bundle. This is the ONLY module under manufacture/ that
 * touches jsPDF or any non-pure dependency.
 */

// A4 landscape, millimetres.
const PAGE_W = 297;
const PAGE_H = 210;
const MARGIN = 8;
const TITLE_TOP = 6; // room reserved at the top of the content area for the sheet title
const TB_W = 78; // title block width
const TB_H = 20; // title block height
const ROWS_PER_PAGE = 24; // table rows per page (matches drawings.ts chunking → no forced continuation)

const STD_DENOM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
const MM_PER_PT = 25.4 / 72;

interface Doc {
  addPage(): void;
  setLineWidth(w: number): void;
  setDrawColor(r: number, g?: number, b?: number): void;
  setFillColor(r: number, g?: number, b?: number): void;
  setTextColor(r: number, g?: number, b?: number): void;
  setFont(name: string, style?: string): void;
  setFontSize(pt: number): void;
  setLineDashPattern(pattern: number[], phase: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  circle(x: number, y: number, r: number, style?: string): void;
  text(text: string, x: number, y: number, options?: { align?: string; angle?: number; baseline?: string }): void;
  output(type: 'arraybuffer'): ArrayBuffer;
}

/** Smallest standard denominator whose 1:n scale still fits (drawing → page). */
function pickDenom(need: number): number {
  for (const d of STD_DENOM) if (d >= need - 1e-9) return d;
  return STD_DENOM[STD_DENOM.length - 1];
}

function frame(doc: Doc): void {
  doc.setDrawColor(40);
  doc.setLineWidth(0.3);
  doc.setLineDashPattern([], 0);
  doc.rect(MARGIN / 2, MARGIN / 2, PAGE_W - MARGIN, PAGE_H - MARGIN, 'S');
}

function titleBlock(doc: Doc, sheet: DrawingSheet, page: number, total: number, scaleNote: string): void {
  const x = PAGE_W - MARGIN / 2 - TB_W;
  const y = PAGE_H - MARGIN / 2 - TB_H;
  doc.setFillColor(255);
  doc.setDrawColor(40);
  doc.setLineWidth(0.3);
  doc.rect(x, y, TB_W, TB_H, 'FD');
  doc.setTextColor(20);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(clip(sheet.title, 44), x + 2, y + 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.text('kitchen-planner manufacturing pack', x + 2, y + 10);
  doc.text(`Sheet ${page}/${total}`, x + 2, y + 15);
  doc.text(`Scale ${scaleNote}`, x + TB_W - 2, y + 15, { align: 'right' });
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/* ── layer styling ─────────────────────────────────────────────────────────── */

function strokeFor(doc: Doc, layer: string): void {
  doc.setLineDashPattern(layer === 'hidden' ? [0.8, 0.8] : [], 0);
  if (layer === 'wall' || layer === 'outline') {
    doc.setDrawColor(20);
    doc.setLineWidth(layer === 'wall' ? 0.5 : 0.35);
  } else if (layer === 'drill') {
    doc.setDrawColor(200, 40, 40);
    doc.setLineWidth(0.25);
  } else if (layer === 'hidden') {
    doc.setDrawColor(120);
    doc.setLineWidth(0.25);
  } else {
    doc.setDrawColor(60);
    doc.setLineWidth(0.3);
  }
}

type Xf = (p: { x: number; y: number }) => { x: number; y: number };

/* ── geometric sheet ───────────────────────────────────────────────────────── */

/** Fit + render one geometric sheet's prims; returns the printed scale note. */
function renderGeometry(doc: Doc, sheet: DrawingSheet): string {
  const b: SheetBounds = sheetBounds(sheet.prims);
  const ew = Math.max(1e-6, b.maxX - b.minX);
  const eh = Math.max(1e-6, b.maxY - b.minY);
  const cw = PAGE_W - 2 * MARGIN;
  const ch = PAGE_H - 2 * MARGIN - TITLE_TOP;
  const raw = Math.min(cw / ew, ch / eh); // page mm per drawing mm
  const denom = pickDenom(1 / raw);
  const scale = 1 / denom;
  const usedW = ew * scale;
  const usedH = eh * scale;
  const ox = MARGIN + (cw - usedW) / 2;
  const oyTop = MARGIN + TITLE_TOP + (ch - usedH) / 2;
  // sheet frame y is UP; page y is DOWN → flip through (maxY - y)
  const xf: Xf = (p) => ({ x: ox + (p.x - b.minX) * scale, y: oyTop + (b.maxY - p.y) * scale });

  // sheet title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text(sheet.title, MARGIN, MARGIN + 4);

  for (const p of sheet.prims) renderPrim(doc, p, xf, scale);
  return `1:${denom}`;
}

function renderPrim(doc: Doc, p: DrawPrim, xf: Xf, scale: number): void {
  if (p.t === 'poly') {
    strokeFor(doc, p.layer);
    const pts = p.pts.map(xf);
    for (let i = 0; i + 1 < pts.length; i++) doc.line(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (p.closed && pts.length > 2) doc.line(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y);
    doc.setLineDashPattern([], 0);
  } else if (p.t === 'circle') {
    strokeFor(doc, p.layer);
    const c = xf(p.c);
    doc.circle(c.x, c.y, Math.max(0.2, p.r * scale), 'S');
    doc.setLineDashPattern([], 0);
  } else if (p.t === 'text') {
    const printed = Math.max(1.8, p.size * scale); // clamp printed height
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(printed / MM_PER_PT);
    doc.setTextColor(p.layer === 'drill' ? 180 : 30, p.layer === 'drill' ? 40 : 30, p.layer === 'drill' ? 40 : 30);
    const t = xf(p.p);
    doc.text(p.s, t.x, t.y, { align: p.anchor === 'c' ? 'center' : p.anchor === 'r' ? 'right' : 'left' });
  } else {
    renderDim(doc, p, xf, scale);
  }
}

function renderDim(doc: Doc, p: Extract<DrawPrim, { t: 'dim' }>, xf: Xf, scale: number): void {
  // offset the dimension line perpendicular to a→b in the sheet's (y-up) frame
  const dx = p.b.x - p.a.x;
  const dy = p.b.y - p.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const a2 = { x: p.a.x + px * p.off, y: p.a.y + py * p.off };
  const b2 = { x: p.b.x + px * p.off, y: p.b.y + py * p.off };
  const A = xf(a2);
  const B = xf(b2);
  const A0 = xf(p.a);
  const B0 = xf(p.b);

  doc.setLineDashPattern([], 0);
  doc.setDrawColor(120, 120, 150);
  doc.setLineWidth(0.2);
  // extension lines from the geometry to the dimension line
  doc.line(A0.x, A0.y, A.x, A.y);
  doc.line(B0.x, B0.y, B.x, B.y);
  // dimension line
  doc.line(A.x, A.y, B.x, B.y);
  // end ticks (short 45° strokes)
  const tick = 1.2;
  const tx = (ux + px) * tick;
  const ty = (uy + py) * tick;
  doc.line(A.x - tx, A.y + ty, A.x + tx, A.y - ty);
  doc.line(B.x - tx, B.y + ty, B.x + tx, B.y - ty);

  // text centred on the line, nudged to the outer side; rotate for vertical dims
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const vertical = Math.abs(uy) > Math.abs(ux);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(Math.max(1.8, 55 * scale) / MM_PER_PT);
  doc.setTextColor(60, 60, 90);
  const nudge = 1.4;
  doc.text(p.text, mid.x + px * 0 + (vertical ? -nudge : 0), mid.y - (vertical ? 0 : nudge), {
    align: 'center',
    angle: vertical ? 90 : 0,
    baseline: 'bottom',
  });
}

/* ── table sheet ───────────────────────────────────────────────────────────── */

function colWidths(table: SheetTable, totalW: number): number[] {
  const n = table.headers.length;
  const weights = new Array(n).fill(1);
  const sample = [table.headers, ...table.rows.slice(0, 40)];
  for (let c = 0; c < n; c++) {
    let mx = 1;
    for (const r of sample) mx = Math.max(mx, (r[c] ?? '').length);
    weights[c] = Math.min(mx, 40);
  }
  const sum = weights.reduce((s: number, v: number) => s + v, 0) || 1;
  return weights.map((w: number) => (w / sum) * totalW);
}

function renderTable(doc: Doc, sheet: DrawingSheet, rows: string[][]): void {
  const table = sheet.table!;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(20);
  doc.text(sheet.title, MARGIN, MARGIN + 5);

  const x0 = MARGIN;
  const totalW = PAGE_W - 2 * MARGIN;
  const widths = colWidths(table, totalW);
  const rowH = 6.5;
  let y = MARGIN + 9;

  // header
  doc.setFillColor(225, 225, 220);
  doc.setDrawColor(120);
  doc.setLineWidth(0.2);
  doc.rect(x0, y, totalW, rowH, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(20);
  drawRow(doc, table.headers, x0, y, widths, rowH);
  y += rowH;

  doc.setFont('helvetica', 'normal');
  for (const r of rows) {
    doc.setDrawColor(210);
    doc.line(x0, y + rowH, x0 + totalW, y + rowH);
    drawRow(doc, r, x0, y, widths, rowH);
    y += rowH;
  }
}

function drawRow(doc: Doc, cells: string[], x0: number, y: number, widths: number[], rowH: number): void {
  let x = x0;
  for (let c = 0; c < widths.length; c++) {
    const maxChars = Math.max(2, Math.floor(widths[c] / 1.6));
    doc.text(clip(cells[c] ?? '', maxChars), x + 1, y + rowH - 2);
    x += widths[c];
  }
}

/* ── driver ────────────────────────────────────────────────────────────────── */

function pagesFor(s: DrawingSheet): number {
  if ((s.kind === 'table' || s.kind === 'cover') && s.table) {
    return Math.max(1, Math.ceil(s.table.rows.length / ROWS_PER_PAGE));
  }
  return 1;
}

export async function buildPdfBlob(pack: ManufacturePack): Promise<Blob> {
  const mod = (await import('jspdf')) as unknown as { jsPDF: new (o: unknown) => Doc };
  const jsPDF = mod.jsPDF;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const sheets = pack.sheets;
  const total = sheets.reduce((n, s) => n + pagesFor(s), 0);
  let page = 0;
  let started = false;
  const newPage = (): void => {
    if (started) doc.addPage();
    started = true;
    page++;
  };

  for (const s of sheets) {
    if ((s.kind === 'table' || s.kind === 'cover') && s.table) {
      const chunks: string[][][] = [];
      for (let i = 0; i < s.table.rows.length; i += ROWS_PER_PAGE) chunks.push(s.table.rows.slice(i, i + ROWS_PER_PAGE));
      if (chunks.length === 0) chunks.push([]);
      for (const rows of chunks) {
        newPage();
        frame(doc);
        renderTable(doc, s, rows);
        titleBlock(doc, s, page, total, '—');
      }
    } else {
      newPage();
      frame(doc);
      const scaleNote = renderGeometry(doc, s);
      titleBlock(doc, s, page, total, scaleNote);
    }
  }

  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
}
