import type { Design } from '../types';
import { buildCutList } from './cutlist';
import { buildHardware } from './hardware';
import { buildSheets } from './drawings';
import { collectDesign } from './collect';
import type { ManufacturePack } from './types';

/**
 * Public entry point for the manufacturing export. `buildPack` runs the whole
 * pure pipeline — collect → cut list → hardware schedule → appliance list →
 * drawing sheets — into one `ManufacturePack`. Rendering entry points
 * (`buildPdfBlob`, `cutListCsv`, `cutPartsDxf`) and the fit validator are
 * re-exported so a caller only needs this module.
 *
 * `buildPdfBlob` is async (it lazy-loads jsPDF); everything else is synchronous
 * and pure. Nothing here imports Store or Three.js.
 */
export function buildPack(design: Design): ManufacturePack {
  const { parts, appliances } = buildCutList(design);
  const hardware = buildHardware(design);
  const sheets = buildSheets(design, { parts, hardware, appliances });
  const itemCount = collectDesign(design).items.length;
  return { cutParts: parts, hardware, appliances, sheets, meta: { unit: 'mm', itemCount } };
}

export { buildPdfBlob } from './pdfPack';
export { cutListCsv } from './csv';
export { cutPartsDxf } from './dxf';
export { validateDesignFit } from './validate';
export { buildSheets } from './drawings';
