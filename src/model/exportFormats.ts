/**
 * BOM serializers: rows (src/model/export.ts) → CSV and a printable A4 sheet.
 * Pure string building — no DOM, no three.js; the UI only hands the result to
 * a Blob download or a new window.
 *
 * The CSV header arrays are a CONTRACT: spreadsheet templates and the E2E
 * suite match on them, so they are exported and only ever appended to.
 */

import type { Bom, BuyRow, CutRow } from './export';
import { HARDWARE_CATEGORY } from './export';
import type { Point } from './types';

/* ---------------- CSV ---------------- */

/** Excel only detects UTF-8 (and so renders m², Ø, ×) when the file leads with a BOM. */
const UTF8_BOM = '﻿';
const CRLF = '\r\n';

export const CUT_HEADER: readonly string[] = [
  'Room',
  'Part',
  'Panel',
  'Role',
  'Qty',
  'Length (mm)',
  'Width (mm)',
  'Thickness (mm)',
  'Material',
  'Colour',
  'Finish',
  'Shape',
  'Area (m²)',
  'Notes',
  'Outline (mm)',
  'Holes (mm)',
];

export const BUY_HEADER: readonly string[] = [
  'Room',
  'Category',
  'Product',
  'Qty',
  'Width (mm)',
  'Depth (mm)',
  'Height (mm)',
  'Options',
  'Colour',
  'Material',
  'Notes',
];

type Cell = string | number;

/** RFC 4180: quote only when the value could break the field, doubling quotes. */
function cell(v: Cell): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header: readonly string[], rows: Cell[][]): string {
  return UTF8_BOM + [header, ...rows].map((r) => r.map(cell).join(',')).join(CRLF) + CRLF;
}

/**
 * `x y;x y` in millimetres — space between a point's coordinates, `;` between
 * points, `|` between hole rings. Deliberately comma-free so a polygon never
 * needs quoting and stays greppable in a spreadsheet cell.
 */
function polyMm(poly: Point[]): string {
  return poly.map((p) => `${Math.round(p.x * 1000)} ${Math.round(p.y * 1000)}`).join(';');
}

const holesMm = (holes: Point[][] | undefined): string => (holes ?? []).map(polyMm).join('|');

const area = (m2: number): string => m2.toFixed(3);

export function cutListCsv(bom: Bom): string {
  return csv(
    CUT_HEADER,
    bom.cut.map((r) => [
      r.room,
      r.part,
      r.panelId,
      r.role,
      r.qty,
      r.lengthMm,
      r.widthMm,
      r.thicknessMm,
      r.materialLabel,
      r.colorHex,
      r.finish,
      r.shape,
      area(r.areaM2),
      r.notes,
      r.outline ? polyMm(r.outline) : '',
      holesMm(r.holes),
    ])
  );
}

export function shoppingListCsv(bom: Bom): string {
  return csv(
    BUY_HEADER,
    bom.buy.map((r) => [
      r.room,
      r.category,
      r.label,
      r.qty,
      r.wMm,
      r.dMm,
      r.hMm,
      r.options,
      r.colorHex,
      r.materialLabel,
      r.notes,
    ])
  );
}

/* ---------------- printable sheet ---------------- */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only a plain hex is safe to drop into a style attribute as a swatch. */
const isHex = (s: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(s);

function swatch(hex: string): string {
  return isHex(hex) ? `<i class="sw" style="background:${hex}"></i>${esc(hex)}` : esc(hex);
}

const th = (label: string, num = false): string => `<th${num ? ' class="num"' : ''}>${esc(label)}</th>`;
const td = (v: string, num = false): string => `<td${num ? ' class="num"' : ''}>${v}</td>`;

function table(head: string, body: string[]): string {
  return `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}

const STYLE = `
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; color: #24221e; background: #fff;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 2px solid #24221e; padding-bottom: 3px; }
h3 { font-size: 13px; margin: 12px 0 4px; font-weight: 600; }
header { margin-bottom: 18px; }
.meta { color: #6b675f; font-size: 11px; }
.totals { margin-top: 6px; font-size: 12px; }
.totals b { font-size: 14px; }
section { margin-bottom: 20px; break-inside: avoid; page-break-inside: avoid; }
table { border-collapse: collapse; width: 100%; font-size: 11px; }
th, td { border-bottom: 1px solid #e2ded4; padding: 3px 6px; text-align: left; vertical-align: top; }
th { background: #f2f1ec; font-weight: 600; white-space: nowrap; }
.num { text-align: right; }
.sw { display: inline-block; width: 9px; height: 9px; margin-right: 4px;
  border: 1px solid #0002; vertical-align: -1px; }
footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #e2ded4;
  color: #6b675f; font-size: 10px; }
button.noprint { font: inherit; padding: 6px 14px; margin-top: 10px; cursor: pointer;
  border: 1px solid #24221e; background: #24221e; color: #fff; border-radius: 4px; }
@media print { .noprint { display: none } body { padding: 0 } }
`;

const CAVEAT =
  'Worktops are exported per unit — continuous runs are not merged. ' +
  'Verify all dimensions before cutting.';

/** Group rows by room, in the design's room order, unassigned rows last. */
function byRoom<T extends { roomId: string; room: string }>(
  bom: Bom,
  rows: T[]
): { name: string; rows: T[] }[] {
  const out: { name: string; rows: T[] }[] = [];
  const seen = new Set<string>();
  for (const room of bom.rooms) {
    const hits = rows.filter((r) => r.roomId === room.id);
    seen.add(room.id);
    if (hits.length) out.push({ name: room.name, rows: hits });
  }
  const rest = rows.filter((r) => !seen.has(r.roomId));
  if (rest.length) out.push({ name: 'Unassigned', rows: rest });
  return out;
}

/** Stable part order within a room, first appearance wins. */
function byPart(rows: CutRow[]): { name: string; rows: CutRow[] }[] {
  const out: { name: string; rows: CutRow[] }[] = [];
  const index = new Map<string, number>();
  for (const r of rows) {
    let i = index.get(r.part);
    if (i === undefined) {
      i = out.length;
      index.set(r.part, i);
      out.push({ name: r.part, rows: [] });
    }
    out[i].rows.push(r);
  }
  return out;
}

const CUT_COLS =
  th('Panel') + th('Role') + th('Qty', true) + th('L (mm)', true) + th('W (mm)', true) +
  th('T (mm)', true) + th('Material') + th('Colour') + th('Area (m²)', true) + th('Notes');

function cutTable(rows: CutRow[]): string {
  return table(
    CUT_COLS,
    rows.map(
      (r) =>
        '<tr>' +
        td(esc(r.panelId)) +
        td(esc(r.role)) +
        td(String(r.qty), true) +
        td(String(r.lengthMm), true) +
        td(String(r.widthMm), true) +
        td(String(r.thicknessMm), true) +
        td(esc(r.materialLabel)) +
        td(swatch(r.colorHex)) +
        td(area(r.areaM2), true) +
        td(esc(r.notes)) +
        '</tr>'
    )
  );
}

const BUY_COLS =
  th('Room') + th('Category') + th('Product') + th('Qty', true) + th('Size (mm)') +
  th('Options') + th('Colour') + th('Notes');

function buyTable(rows: BuyRow[]): string {
  return table(
    BUY_COLS,
    rows.map(
      (r) =>
        '<tr>' +
        td(esc(r.room)) +
        td(esc(r.category)) +
        td(esc(r.label)) +
        td(String(r.qty), true) +
        td(esc(`${r.wMm} × ${r.dMm} × ${r.hMm}`)) +
        td(esc(r.options)) +
        td(r.colorHex ? swatch(r.colorHex) : '') +
        td(esc(r.notes)) +
        '</tr>'
    )
  );
}

const HARDWARE_COLS = th('Room') + th('Item') + th('Qty', true) + th('Size');

function hardwareTable(rows: BuyRow[]): string {
  return table(
    HARDWARE_COLS,
    rows.map(
      (r) =>
        '<tr>' +
        td(esc(r.room)) +
        td(esc(r.label)) +
        td(String(r.qty), true) +
        td(esc(r.options)) +
        '</tr>'
    )
  );
}

/**
 * A self-contained printable sheet (A4). Everything interpolated goes through
 * `esc` — part names, room names and notes are user text.
 */
export function bomHtml(bom: Bom): string {
  const products = bom.buy.filter((r) => r.category !== HARDWARE_CATEGORY);
  const hardware = bom.buy.filter((r) => r.category === HARDWARE_CATEGORY);
  const sections: string[] = [];

  for (const room of byRoom(bom, bom.cut)) {
    const parts = byPart(room.rows)
      .map((p) => `<h3>${esc(p.name)}</h3>${cutTable(p.rows)}`)
      .join('');
    sections.push(`<section><h2>Cut list · ${esc(room.name)}</h2>${parts}</section>`);
  }
  if (!bom.cut.length) {
    sections.push('<section><h2>Cut list</h2><p>Nothing to manufacture.</p></section>');
  }
  sections.push(
    `<section><h2>Shopping list</h2>${
      products.length ? buyTable(products) : '<p>Nothing to buy.</p>'
    }</section>`
  );
  sections.push(
    `<section><h2>Hardware</h2>${
      hardware.length ? hardwareTable(hardware) : '<p>No moving fronts.</p>'
    }</section>`
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bill of materials</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Bill of materials</h1>
<div class="meta">Generated ${esc(bom.generatedAt)}</div>
<div class="totals"><b>${bom.totals.panels}</b> boards · <b>${area(
    bom.totals.boardAreaM2
  )}</b> m² · <b>${bom.totals.products}</b> purchased pieces</div>
<button class="noprint" onclick="print()">Print / save as PDF</button>
</header>
${sections.join('\n')}
<footer>${esc(CAVEAT)}</footer>
</body>
</html>`;
}
