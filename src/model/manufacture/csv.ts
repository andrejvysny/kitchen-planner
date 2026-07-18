import type { CutPart } from './types';

/**
 * Cut list → CSV (RFC 4180). Fields containing a comma, double-quote, CR or LF
 * are wrapped in double quotes and embedded quotes are doubled; rows end with
 * CRLF. `grain` serializes as `L` when the grain runs along the length, else ''.
 *
 * Pure model code — no Three.js, no Store.
 */

const HEADER = [
  'id',
  'cabinet',
  'name',
  'length_mm',
  'width_mm',
  'thickness_mm',
  'qty',
  'material',
  'grain',
  'edge_L1',
  'edge_L2',
  'edge_W1',
  'edge_W2',
  'notes',
];

/** Quote a field per RFC 4180 when it contains a comma, quote or line break. */
function csvField(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function row(cells: (string | number)[]): string {
  return cells.map((c) => csvField(String(c))).join(',');
}

export function cutListCsv(parts: CutPart[]): string {
  const lines = [row(HEADER)];
  for (const p of parts) {
    lines.push(
      row([
        p.refId,
        p.cabinet,
        p.name,
        p.lengthMm,
        p.widthMm,
        p.thicknessMm,
        p.qty,
        p.material,
        p.grain ? 'L' : '',
        p.edge.L1,
        p.edge.L2,
        p.edge.W1,
        p.edge.W2,
        p.notes,
      ])
    );
  }
  return lines.join('\r\n') + '\r\n';
}
