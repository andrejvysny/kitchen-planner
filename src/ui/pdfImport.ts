import { UNDERLAY_JPEG_Q, UNDERLAY_MAX_PX } from '../model/underlay';

/**
 * PDF → tracing photo. A floor plan usually arrives as a PDF, often a
 * multi-page one where only a single sheet is the plan, so the import is two
 * steps: open the document, let the user pick the page, then rasterize just
 * that page into the SAME `{src, w, h}` bitmap `importUnderlay` already takes.
 *
 * pdf.js is loaded through a DYNAMIC import so it lands in its own chunk and
 * costs nothing until someone actually picks a PDF — it is by far the largest
 * dependency in the app and the overwhelming majority of sessions never touch
 * it. Everything below therefore returns promises and nothing here is imported
 * at module scope by the shell.
 *
 * Nothing in this file knows about the Store: it turns a File into pixels, and
 * src/ui/underlayImport.ts places them. Keeping that seam is what lets the
 * page picker be a plain component with no model access.
 */

/** What the page picker needs to render one page as a choice. */
export interface PdfPage {
  /** 1-based, as PDF numbers its pages and as the picker labels them */
  number: number;
  /** thumbnail data URL */
  thumb: string;
  /** page size in CSS px at scale 1 — the aspect the thumbnail was drawn at */
  w: number;
  h: number;
}

/** An opened document, kept alive so a page can be re-rendered at full size. */
export interface PdfDoc {
  pageCount: number;
  /** Small preview for the picker grid. */
  thumbnail(pageNumber: number, maxPx: number): Promise<PdfPage>;
  /** The chosen page, rasterized for tracing — same shape as `downscaleImage`. */
  render(pageNumber: number): Promise<{ src: string; w: number; h: number }>;
  /** Release the worker; safe to call twice. */
  close(): void;
}

/** Longest edge of a picker thumbnail, in px. */
export const PDF_THUMB_PX = 220;

/**
 * Beyond this a PDF is a document, not a plan set, and rendering every
 * thumbnail would lock the tab. The picker shows the first `PDF_MAX_PAGES` and
 * says so; a page past that is still reachable by re-exporting from the source.
 */
export const PDF_MAX_PAGES = 60;

type PdfJs = typeof import('pdfjs-dist');
let pdfjs: PdfJs | null = null;

/**
 * Load pdf.js once and point it at its worker. The worker URL is resolved
 * through `import.meta.url` so Vite fingerprints and serves it like any other
 * asset — a CDN string would break the app's no-external-requests property.
 */
async function lib(): Promise<PdfJs> {
  if (pdfjs) return pdfjs;
  const mod = await import('pdfjs-dist');
  mod.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).href;
  pdfjs = mod;
  return mod;
}

export function isPdf(f: File): boolean {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

/**
 * Open `f` and hand back a handle over its pages. Rejects on anything pdf.js
 * refuses — an encrypted file, a truncated download, something that is not a
 * PDF at all — and the caller turns that into a status hint.
 */
export async function openPdf(f: File): Promise<PdfDoc> {
  const pdf = await lib();
  const data = new Uint8Array(await f.arrayBuffer());
  // the loading TASK owns the worker; the document proxy has no destroy()
  const task = pdf.getDocument({ data });
  const doc = await task.promise;

  /** Rasterize one page with its long edge at `maxPx`. */
  const draw = async (
    pageNumber: number,
    maxPx: number
  ): Promise<{ canvas: HTMLCanvasElement; w: number; h: number }> => {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxPx / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    // `background` rather than a manual fillRect: a PDF page is transparent
    // where nothing is drawn and JPEG has no alpha, so an unpainted sheet
    // encodes as black. pdf.js paints this under the page content itself.
    await page.render({ canvas, viewport, background: '#fff' }).promise;
    page.cleanup();
    return { canvas, w: base.width, h: base.height };
  };

  return {
    pageCount: doc.numPages,
    async thumbnail(pageNumber, maxPx) {
      const { canvas, w, h } = await draw(pageNumber, maxPx);
      return { number: pageNumber, thumb: canvas.toDataURL('image/jpeg', 0.7), w, h };
    },
    async render(pageNumber) {
      // the same cap the photo path uses, so a traced PDF and a traced photo
      // cost the same storage and calibrate the same way
      const { canvas } = await draw(pageNumber, UNDERLAY_MAX_PX);
      return {
        src: canvas.toDataURL('image/jpeg', UNDERLAY_JPEG_Q),
        w: canvas.width,
        h: canvas.height,
      };
    },
    close() {
      void task.destroy();
    },
  };
}
