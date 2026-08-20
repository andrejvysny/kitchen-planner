import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { resolveDialog } from '../dialogService';
import { appDialog, type DialogRequest } from '../shellState';
import { useChannel } from './hooks/useStore';

/**
 * The app's own confirm/prompt — what replaced `confirm()` and `prompt()`.
 *
 * Self-gating on the 'shell' channel like <Cheatsheet/>: the shell holds no
 * state and never re-renders, so anything that appears and disappears carries
 * its own subscription. The request is data (shellState.DialogRequest) and the
 * promise lives in src/ui/dialogService.ts, so this file only draws and reports.
 *
 * Escape and Enter are handled in the CAPTURE phase, for the reason spelled out
 * in <Cheatsheet/>: the global key map sits on `window` and its Escape cancels
 * the LIVE TOOL even while typing. A user answering a question means to answer
 * it, not to throw away the wall they were drawing underneath.
 */
export function ConfirmHost(): ReactElement | null {
  useChannel('shell');
  const req = appDialog();
  if (!req) return null;
  return <DialogBody req={req} />;
}

function DialogBody({ req }: { req: DialogRequest }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const accept = useRef<HTMLButtonElement>(null);

  // `req` is a fresh object per opener call, so this runs on every OPEN — which
  // is what resets a previous answer's error and text when the component was
  // not remounted between two dialogs.
  useEffect(() => {
    setError(null);
    if (input.current) {
      input.current.value = req.input?.initial ?? '';
      input.current.focus();
      input.current.select();
    } else accept.current?.focus();
  }, [req]);

  const onAccept = useCallback((): void => {
    const spec = req.input;
    if (!spec) {
      resolveDialog(true);
      return;
    }
    const res = spec.parse(input.current?.value ?? '');
    if (!res.ok) {
      setError(res.error);
      input.current?.select();
      return;
    }
    resolveDialog(true, res.value);
  }, [req]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resolveDialog(false);
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      onAccept();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onAccept]);

  return (
    <div
      id="app-dialog"
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={req.title}
      // only a press that landed on the backdrop ITSELF cancels, never one that
      // bubbled out of the card
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) resolveDialog(false);
      }}
    >
      <div className="modal-card dialog-card">
        <div className="modal-head">
          <div>
            <h2>{req.title}</h2>
            {req.body ? <p className="props-sub">{req.body}</p> : null}
          </div>
        </div>

        {req.input ? (
          <>
            <input
              id="dialog-input"
              type="text"
              inputMode="decimal"
              ref={input}
              defaultValue={req.input.initial ?? ''}
              placeholder={req.input.placeholder}
            />
            {error ? <p className="dialog-error">{error}</p> : null}
          </>
        ) : null}

        <div className="dialog-actions">
          <button id="dialog-cancel" className="btn" onClick={() => resolveDialog(false)}>
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button
            id="dialog-accept"
            className={req.danger ? 'btn danger' : 'btn'}
            ref={accept}
            onClick={onAccept}
          >
            {req.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
