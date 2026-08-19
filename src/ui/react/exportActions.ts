import { APP_VERSION } from '../../app/version';
import { buildBom } from '../../model/export';
import { bomHtml, cutListCsv, shoppingListCsv } from '../../model/exportFormats';
import { buildRenderManifest } from '../../model/renderManifest';
import { buildRenderPackage, PACKAGE_FILENAME } from '../../model/renderPackage';
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

/** Resolves once the zip is handed to the browser; the caller owns the busy flag. */
export async function exportRenderPackage(store: Store, view3d: View3D): Promise<void> {
  try {
    const { blob, materials } = await view3d.exportRenderGLB();
    const manifest = buildRenderManifest(store.design, {
      camera: view3d.cameraPose(),
      materials,
      render: { widthPx: 1920, heightPx: 1080, tier: 'final', sensorFit: 'vertical' },
      appVersion: APP_VERSION,
    });
    const zip = buildRenderPackage({
      manifest,
      glb: new Uint8Array(await blob.arrayBuffer()),
      design: store.design,
    });
    download(
      // `.slice()` re-types the buffer as plain ArrayBuffer (Uint8Array's
      // default type param is ArrayBufferLike, which BlobPart rejects)
      URL.createObjectURL(new Blob([zip.slice()], { type: 'application/zip' })),
      PACKAGE_FILENAME
    );
    setHint('interior-render.zip exported — render it with render/render.sh');
  } catch (err) {
    console.error(err);
    setHint('Render package export failed — try again after a reload.', 'error');
  }
}

/** Resolves once the file is handed to the browser; the caller owns the busy flag. */
export async function exportGlb(view3d: View3D): Promise<void> {
  try {
    const blob = await view3d.exportGLB();
    download(URL.createObjectURL(blob), 'interior.glb');
    setHint('interior.glb exported — in Blender: File → Import → glTF 2.0');
  } catch (err) {
    console.error(err);
    setHint('GLB export failed — try again after a reload.', 'error');
  }
}

/**
 * One row per exportable document, in the ONE canonical order/label both
 * surfaces render from (WS-SPEC — the Topbar's Export ▾ menu and the Output
 * workspace's cards already shared every handler above; this is what stops
 * them drifting on COPY too). `run` takes whichever of store/view3d the
 * underlying handler needs; GLB and render stay async so a caller can await
 * them, but the busy-flag/disabled-state dance around those two is still the
 * CALLER's job (menu-close timing differs between the two surfaces).
 */
export interface ExportCtx {
  store: Store;
  view3d: View3D;
}

export interface ExportDoc {
  id: 'plan' | 'bom' | 'cut' | 'buy' | 'png' | 'glb' | 'render';
  /** Menu row text / card title — identical wording on both surfaces. */
  label: string;
  /** Output pane card body copy. */
  caption: string;
  /** Output pane card button text (idle state only — GLB/render own their busy text). */
  button: string;
  /** `data-export` value, where it differs from `id` (the printable sheet kept "sheet"). */
  dataExport?: string;
  run: (ctx: ExportCtx) => void | Promise<void>;
}

export const EXPORT_DOCS: readonly ExportDoc[] = [
  {
    id: 'plan',
    label: 'Plan sheet (PDF-ready)',
    caption: 'Print-ready A4 floor plan at 1:50',
    button: 'Open print sheet',
    run: ({ store }) => exportPlanSheet(store),
  },
  {
    id: 'bom',
    label: 'BOM sheet (print)',
    caption: "Item schedule and cut list for the browser's print dialog",
    button: 'Open BOM sheet',
    dataExport: 'sheet',
    run: ({ store }) => exportBomSheet(store),
  },
  {
    id: 'cut',
    label: 'Cut list (CSV)',
    caption: 'Every board with dimensions, for the saw',
    button: 'Download CSV',
    run: ({ store }) => exportCutCsv(store),
  },
  {
    id: 'buy',
    label: 'Shopping list (CSV)',
    caption: 'Bought products, grouped',
    button: 'Download CSV',
    run: ({ store }) => exportBuyCsv(store),
  },
  {
    id: 'png',
    label: '3D snapshot (PNG)',
    caption: 'The current 3D view as an image',
    button: 'Save PNG',
    run: ({ view3d }) => exportSnapshotPng(view3d),
  },
  {
    id: 'glb',
    label: 'Blender export (GLB)',
    caption: 'The whole scene for Blender or any 3D tool',
    button: 'Export GLB',
    run: ({ view3d }) => exportGlb(view3d),
  },
  {
    id: 'render',
    label: 'Render package (.zip)',
    caption: 'Manifest + canonical GLB + design, for render/render.sh',
    button: 'Export package',
    run: ({ store, view3d }) => exportRenderPackage(store, view3d),
  },
];
