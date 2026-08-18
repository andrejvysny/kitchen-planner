import { buildBom } from '../../model/export';
import { bomHtml, cutListCsv, shoppingListCsv } from '../../model/exportFormats';
import type { Store } from '../../model/store';
import { openPrintSheet } from '../../print/sheet';
import type { View3D } from '../../view3d/view3d';
import { setHint } from '../shellState';

/**
 * Every "produce a file" action the shell offers, as plain functions.
 *
 * WS-SPEC §4.7 gives the Output workspace its own pane of export controls, so
 * these bodies stopped being closures inside <ExportMenu/>: the topbar menu and
 * that pane must run the SAME code, produce the same filenames and set the same
 * status hints. Dependencies come in as arguments — no context, no bootstrap
 * import, no React — which is also what makes them callable from a test or a
 * future command.
 *
 * Everything here is a leaf: the caller owns its own menu/busy state, and only
 * `exportGlb` is async (it is the one that has to await the renderer).
 */

/** Moved verbatim from ui.ts: click a synthetic <a download>, then free the blob. */
export function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // the click consumed the URL synchronously; hand the blob's memory back
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(text: string, name: string, type: string): void {
  const blob = new Blob([text], { type });
  download(URL.createObjectURL(blob), name);
}

export function exportCutCsv(store: Store): void {
  const bom = buildBom(store.design);
  downloadText(cutListCsv(bom), 'interior-cutlist.csv', 'text/csv;charset=utf-8');
  setHint('interior-cutlist.csv exported');
}

export function exportBuyCsv(store: Store): void {
  const bom = buildBom(store.design);
  downloadText(shoppingListCsv(bom), 'interior-shopping-list.csv', 'text/csv;charset=utf-8');
  setHint('interior-shopping-list.csv exported');
}

export function exportBomSheet(store: Store): void {
  const bom = buildBom(store.design);
  const url = URL.createObjectURL(new Blob([bomHtml(bom)], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) download(url, 'interior-bom.html');
  // the opened tab keeps reading the URL while it loads — outlive that, then free it
  else setTimeout(() => URL.revokeObjectURL(url), 60_000);
  setHint(
    w
      ? 'Printable sheet opened in a new tab'
      : 'Pop-ups are blocked — interior-bom.html downloaded instead'
  );
}

export function exportPlanSheet(store: Store): void {
  const opened = openPrintSheet(store);
  setHint(
    opened
      ? 'Plan sheet opened in a new tab — print it at 100% on A4 landscape'
      : 'Pop-ups are blocked — interior-plan-sheet.html downloaded instead'
  );
}

export function exportSnapshotPng(view3d: View3D): void {
  download(view3d.snapshotPNG(), 'interior-3d.png');
  setHint('interior-3d.png exported');
}

/** Resolves once the file is handed to the browser; the caller owns the busy flag. */
export async function exportGlb(view3d: View3D): Promise<void> {
  try {
    const blob = await view3d.exportGLB();
    download(URL.createObjectURL(blob), 'interior.glb');
    setHint('interior.glb exported — in Blender: File → Import → glTF 2.0');
  } catch {
    setHint('GLB export failed — try again after a reload.');
  }
}
