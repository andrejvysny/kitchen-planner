import { useEffect, useRef, useState, type ReactElement } from 'react';
import { pdfImport, setPdfImport, setHint } from '../shellState';
import { openPdf, PDF_MAX_PAGES, PDF_THUMB_PX, type PdfDoc, type PdfPage } from '../pdfImport';
import { placeUnderlay } from '../underlayImport';
import { useChannel } from './hooks/useStore';
import { useAppServices } from './services';

/**
 * "Which page is the plan?" — the step between picking a PDF and tracing it.
 *
 * A conditional in App.tsx like <CoachMarks/> and <RecoveryBanner/>: mounted
 * only while `shellState.pdfImport()` holds a file, so the expensive part
 * (pdf.js, a worker, one raster per page) is created on open and destroyed on
 * close rather than living for the session. A single-page PDF still shows the
 * picker — one card, one click — because silently deciding for the user would
 * make a two-page document behave differently from a one-page one for no
 * reason the user can see.
 *
 * Thumbnails stream in one at a time and out of the render path: `pages` grows
 * as each finishes, so a 40-page set paints progressively instead of blocking.
 * The effect's `alive` flag is what stops a late thumbnail from calling
 * setState after the picker closed — the render loop is the only thing here
 * that outlives a click.
 *
 * Escape closes it in the CAPTURE phase, like the cheatsheet: the wall tool may
 * be armed underneath and its Escape must not also fire.
 */
export function PdfPagePicker(): ReactElement | null {
  useChannel('shell');
  const file = pdfImport();
  if (!file) return null;
  // keyed by the file, so picking a DIFFERENT PDF rebuilds every bit of state
  return <PickerBody file={file} key={`${file.name}:${file.size}:${file.lastModified}`} />;
}

function PickerBody({ file }: { file: File }): ReactElement {
  const { store, plan } = useAppServices();
  const [pages, setPages] = useState<PdfPage[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const doc = useRef<PdfDoc | null>(null);

  const close = (): void => setPdfImport(null);

  useEffect(() => {
    let alive = true;
    let handle: PdfDoc | null = null;

    void (async () => {
      try {
        handle = await openPdf(file);
      } catch {
        if (alive) setError('Could not read that PDF — it may be encrypted or damaged');
        return;
      }
      if (!alive) {
        handle.close();
        return;
      }
      doc.current = handle;
      setTotal(handle.pageCount);
      const shown = Math.min(handle.pageCount, PDF_MAX_PAGES);
      for (let n = 1; n <= shown; n++) {
        let page: PdfPage;
        try {
          page = await handle.thumbnail(n, PDF_THUMB_PX);
        } catch {
          continue; // one unrenderable page must not sink the whole picker
        }
        if (!alive) return;
        setPages((prev) => [...prev, page]);
      }
    })();

    return () => {
      alive = false;
      doc.current?.close();
      handle?.close();
      doc.current = null;
    };
  }, [file]);

  // capture phase: the wall tool may be armed under this, and its Escape
  // (tool.cancel) must not fire as well
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const choose = async (n: number): Promise<void> => {
    const handle = doc.current;
    if (!handle || busy !== null) return;
    setBusy(n);
    try {
      const img = await handle.render(n);
      placeUnderlay(store, img, plan);
      close();
    } catch {
      setBusy(null);
      setHint('Could not render that page — try another one');
    }
  };

  return (
    <div id="pdf-picker" className="modal-backdrop" onClick={close}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Choose the page to trace</h2>
            <p className="props-sub">
              {error
                ? file.name
                : total
                  ? `${file.name} · ${total} page${total === 1 ? '' : 's'}`
                  : `${file.name} · opening…`}
            </p>
          </div>
          <button className="modal-close" aria-label="Cancel" onClick={close}>
            ✕
          </button>
        </div>

        {error ? (
          <p className="pdf-error">{error}</p>
        ) : (
          <>
            <div className="pdf-grid">
              {pages.map((p) => (
                <button
                  key={p.number}
                  className="pdf-page"
                  data-page={p.number}
                  disabled={busy !== null}
                  onClick={() => void choose(p.number)}
                >
                  <img src={p.thumb} alt={`Page ${p.number}`} />
                  <span>{busy === p.number ? 'Placing…' : `Page ${p.number}`}</span>
                </button>
              ))}
              {total > pages.length && !error ? <div className="pdf-page pdf-pending" /> : null}
            </div>
            {total > PDF_MAX_PAGES ? (
              <p className="props-sub">{`Showing the first ${PDF_MAX_PAGES} of ${total} pages.`}</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
