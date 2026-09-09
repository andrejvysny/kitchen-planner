/**
 * The print / PDF plan sheet: a dimensioned floor plan at TRUE SCALE plus the
 * item schedule, composed as one self-contained HTML document and handed to
 * the browser's own print dialog. No PDF library — `@page size: A4 landscape`
 * and an `<img>` sized in millimetres are all a browser needs to put 1:50 on
 * paper.
 *
 * Two things are reused rather than rebuilt:
 *  - the plan comes from `renderPlan` (src/plan2d/renderPlan.ts), the same
 *    renderer the on-screen editor uses, called with every interactive layer
 *    off and every room in full ink;
 *  - the schedule comes from `buildBom(design).buy` (src/model/export.ts) —
 *    the M1 shopping list, minus hardware — so there is exactly one place
 *    where "what is in this design" is computed.
 */

import { buildBom, HARDWARE_CATEGORY, type BuyRow } from '../model/export';
import { esc } from '../model/exportFormats';
import { polygonBounds } from '../model/geometry';
import type { Store } from '../model/store';
import type { Design } from '../model/types';
import { renderPlan, type PlanRenderOpts, type PlanViewport } from '../plan2d/renderPlan';

/* ---------------- scale + layout (pure) ---------------- */

/** CSS reference resolution. `dpr` bridges it to the real output density. */
export const CSS_DPI = 96;
export const DEFAULT_SCALE = 50;
export const DEFAULT_DPI = 150;

/**
 * Clear space around the room polygons, in metres of DRAWING space: the wall
 * slabs sit outside the corner ring and the wall dimension labels hang 0.32 m
 * further out. Labels are drawn at a fixed pixel size, so at small scales the
 * margin is widened to keep at least `MIN_MARGIN_PX` of room for them.
 */
export const PLAN_MARGIN_M = 0.6;
const MIN_MARGIN_PX = 26;

/** A4 landscape minus the 12 mm `@page` margin — what the plan has to fit in. */
export const PAGE_W_MM = 297 - 24;
export const PAGE_H_MM = 210 - 24;

/** Denominators tried in order; the first that fits the page wins. */
const SCALE_LADDER: readonly number[] = [50, 100, 200, 500];

/** Nothing interactive on paper — and every room in full ink, not just the active one. */
export const PRINT_OPTS: PlanRenderOpts = {
  // the tracing photo is a reference, never part of the drawing
  underlay: false,
  handles: false,
  guides: false,
  ghosts: false,
  measure: false,
  checks: false,
  roomEmphasis: false,
  // a printed plan is a build document; a printed mug is noise
  decor: false,
};

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlanLayout {
  /** viewport for `renderPlan`, in CSS px (i.e. at CSS_DPI) */
  view: PlanViewport;
  /** device-pixel ratio the caller must apply to the canvas transform */
  dpr: number;
  /** output canvas size in device px */
  wPx: number;
  hPx: number;
  /** true printed size in millimetres at `scale` */
  wMm: number;
  hMm: number;
}

/** Device pixels per drawing metre — 1:50 at 150 dpi = 118.11 px/m. */
export const pxPerMeter = (scale: number, dpi: number): number => (dpi / 25.4) * (1000 / scale);

/** The bounding box of every room's corner ring (empty designs get a 1 m stub). */
export function designBounds(design: Design): Bounds {
  const pts = design.rooms.flatMap((r) => r.corners);
  if (!pts.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return polygonBounds(pts);
}

/**
 * Canvas size, view transform and printed millimetres for one plan at one
 * scale. Pure — the offscreen render and the unit tests share it.
 */
export function planLayout(b: Bounds, scale: number, dpi: number): PlanLayout {
  const dpr = dpi / CSS_DPI;
  const cssPerM = pxPerMeter(scale, dpi) / dpr; // == CSS_DPI / 25.4 × 1000/scale
  const margin = Math.max(PLAN_MARGIN_M, MIN_MARGIN_PX / cssPerM);
  const worldW = b.maxX - b.minX + margin * 2;
  const worldH = b.maxY - b.minY + margin * 2;
  const cssW = worldW * cssPerM;
  const cssH = worldH * cssPerM;
  return {
    view: {
      zoom: cssPerM,
      panX: (margin - b.minX) * cssPerM,
      panY: (margin - b.minY) * cssPerM,
      cssW,
      cssH,
    },
    dpr,
    wPx: Math.round(cssW * dpr),
    hPx: Math.round(cssH * dpr),
    wMm: (worldW * 1000) / scale,
    hMm: (worldH * 1000) / scale,
  };
}

/**
 * The largest scale (smallest denominator) whose plan still fits an A4
 * landscape page. A studio flat prints 1:50; a whole apartment steps down
 * rather than being silently squeezed off the paper.
 */
export function fitScale(b: Bounds, dpi: number = DEFAULT_DPI): number {
  for (const scale of SCALE_LADDER) {
    const l = planLayout(b, scale, dpi);
    if (l.wMm <= PAGE_W_MM && l.hMm <= PAGE_H_MM) return scale;
  }
  return SCALE_LADDER[SCALE_LADDER.length - 1];
}

/* ---------------- offscreen render ---------------- */

export interface PlanImage {
  /** PNG data URL, ready to drop into an <img> */
  dataUrl: string;
  /** printed size — set on the <img> so the paper output is exactly `scale` */
  wMm: number;
  hMm: number;
  scale: number;
}

/**
 * Render the whole design to an offscreen canvas at true scale. `scale` is a
 * denominator (50 = 1:50); `dpi` is the output density the millimetre sizes
 * are honoured at.
 */
export function planImage(
  store: Store,
  scale: number = DEFAULT_SCALE,
  dpi: number = DEFAULT_DPI
): PlanImage {
  const layout = planLayout(designBounds(store.design), scale, dpi);
  const canvas = document.createElement('canvas');
  canvas.width = layout.wPx;
  canvas.height = layout.hPx;
  const ctx = canvas.getContext('2d')!;
  // renderPlan works in the caller's transform units; dpr turns the 96 dpi
  // layout into a `dpi`-dense bitmap without changing a single drawing call
  ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
  renderPlan(ctx, store, layout.view, PRINT_OPTS);
  return { dataUrl: canvas.toDataURL('image/png'), wMm: layout.wMm, hMm: layout.hMm, scale };
}

/* ---------------- sheet composition ---------------- */

const STYLE = `
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; color: #24221e; background: #fff;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 2px solid #24221e; padding-bottom: 3px; }
header { margin-bottom: 16px; }
.meta { color: #6b675f; font-size: 11px; }
.rooms { margin-top: 6px; font-size: 12px; }
.rooms b { font-size: 14px; }
section { margin-bottom: 20px; break-inside: avoid; page-break-inside: avoid; }
figure { margin: 0; }
img.plan { display: block; max-width: 100%; height: auto; border: 1px solid #e2ded4; }
figcaption { margin-top: 5px; color: #6b675f; font-size: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 11px; }
th, td { border-bottom: 1px solid #e2ded4; padding: 3px 6px; text-align: left; vertical-align: top; }
th { background: #f2f1ec; font-weight: 600; white-space: nowrap; }
.num { text-align: right; }
.sw { display: inline-block; width: 9px; height: 9px; margin-right: 4px;
  border: 1px solid #0002; vertical-align: -1px; }
footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #e2ded4;
  color: #6b675f; font-size: 10px; }
button.noprint { font: inherit; padding: 6px 14px; margin-top: 10px; cursor: pointer;
  border: 1px solid #24221e; background: #24221e; color: #fff; border-radius: 4px; }
@media print { .noprint { display: none } body { padding: 0 } }
`;

const CAVEAT =
  'Printed at the scale stated above on A4 landscape at 100% (no "fit to page"). ' +
  'Verify all dimensions on site.';

const th = (label: string, num = false): string =>
  `<th${num ? ' class="num"' : ''}>${esc(label)}</th>`;
const td = (v: string, num = false): string => `<td${num ? ' class="num"' : ''}>${v}</td>`;

/**
 * A colour chip before the product name. Only a plain hex is safe to drop into
 * a style attribute; unlike the BOM sheet the hex itself is not spelled out —
 * a schedule is read for what and how many, not for the finish code.
 */
const isHex = (s: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(s);
const chip = (hex: string): string =>
  isHex(hex) ? `<i class="sw" style="background:${hex}"></i>` : '';

/** Room / Category / Product / Qty / Size — the shopping list's own labels. */
const SCHEDULE_COLS =
  th('Room') + th('Category') + th('Product') + th('Qty', true) + th('Size (mm)');

function scheduleTable(rows: BuyRow[]): string {
  const body = rows
    .map(
      (r) =>
        '<tr>' +
        td(esc(r.room)) +
        td(esc(r.category)) +
        td(chip(r.colorHex) + esc(r.label)) +
        td(String(r.qty), true) +
        td(esc(`${r.wMm} × ${r.dMm} × ${r.hMm}`)) +
        '</tr>'
    )
    .join('');
  return `<table><thead><tr>${SCHEDULE_COLS}</tr></thead><tbody>${body}</tbody></table>`;
}

const mm1 = (v: number): string => v.toFixed(0);

/**
 * The whole sheet as one HTML document string. Everything interpolated goes
 * through `esc` — room names, product labels and options are user text; the
 * plan is a data: URL this module produced itself.
 */
export function planSheetHtml(store: Store, image: PlanImage, now: Date = new Date()): string {
  const design = store.design;
  const bom = buildBom(design, now);
  const schedule = bom.buy.filter((r) => r.category !== HARDWARE_CATEGORY);
  const rooms = design.rooms
    .map((r) => `${esc(r.name)} ${store.floorArea(r.id).toFixed(1)} m²`)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Interior plan</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Interior plan</h1>
<div class="meta">Generated ${esc(now.toISOString())} · Scale 1:${image.scale} · A4 landscape</div>
<div class="rooms"><b>${store.totalFloorArea().toFixed(1)}</b> m² total${
    rooms ? ` · ${rooms}` : ''
  }</div>
<button class="noprint" onclick="print()">Print / save as PDF</button>
</header>
<section>
<h2>Floor plan · 1:${image.scale}</h2>
<figure>
<img class="plan" src="${image.dataUrl}" style="width:${mm1(
    image.wMm
  )}mm" alt="Dimensioned floor plan at 1:${image.scale}">
<figcaption>Wall dimensions in cm. Printed size ${mm1(image.wMm)} × ${mm1(
    image.hMm
  )} mm at 1:${image.scale}.</figcaption>
</figure>
</section>
<section>
<h2>Item schedule</h2>
${schedule.length ? scheduleTable(schedule) : '<p>Nothing placed yet.</p>'}
<div class="meta">Manufactured parts: <b>${bom.totals.panels}</b> boards · <b>${bom.totals.boardAreaM2.toFixed(
    2
  )}</b> m² — full cut list under Export ▾ → Cut list.</div>
</section>
<footer>${esc(CAVEAT)}</footer>
</body>
</html>`;
}

/**
 * Build the sheet and hand it to the browser. Returns whether it opened in a
 * tab — pop-up blockers get the same download fallback as the M1 BOM sheet.
 */
export function openPrintSheet(store: Store): boolean {
  const scale = fitScale(designBounds(store.design));
  const html = planSheetHtml(store, planImage(store, scale));
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (w) {
    // the opened tab keeps reading the URL while it loads — outlive that, then free it
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = 'interior-plan-sheet.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return false;
}
