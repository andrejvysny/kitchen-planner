import { setDialog, type DialogRequest } from './shellState';

/**
 * The promise side of the app's own confirm/prompt (src/ui/react/ConfirmHost.tsx
 * is the view). `confirm()` and `prompt()` block the whole page, cannot be
 * styled, and are suppressed outright by some embedders — but they are also the
 * only browser API that answers synchronously, so replacing them means every
 * caller becomes async. That is the entire cost of this module.
 *
 * ONE dialog at a time: a second opener while one is up resolves the first as
 * CANCELLED. There is no queue on purpose — two questions racing for the same
 * modal slot is a bug in the caller, and answering the stale one first would be
 * worse than dropping it.
 */

type Pending = (accepted: boolean, value?: number) => void;

let pending: Pending | null = null;

/** A yes/no question. Resolves true only when the user accepted. */
export function confirmDialog(req: Omit<DialogRequest, 'input'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    cancelPending();
    pending = (accepted) => resolve(accepted);
    setDialog(req);
  });
}

/** A question with a value. Resolves null on cancel; the parsed number otherwise. */
export function promptValue(
  req: DialogRequest & { input: NonNullable<DialogRequest['input']> }
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    cancelPending();
    pending = (accepted, value) => resolve(accepted && value !== undefined ? value : null);
    setDialog(req);
  });
}

/**
 * The host's answer. `accepted` false is Cancel / Escape / a backdrop click;
 * `value` is the input's PARSED result, so the host runs `req.input.parse`
 * before calling this and keeps the dialog open when it fails.
 */
export function resolveDialog(accepted: boolean, value?: number): void {
  const done = pending;
  pending = null;
  setDialog(null);
  done?.(accepted, value);
}

/** Whether a dialog is waiting for an answer — the test seam. */
export function dialogPending(): boolean {
  return pending !== null;
}

function cancelPending(): void {
  const done = pending;
  pending = null;
  done?.(false, undefined);
}
