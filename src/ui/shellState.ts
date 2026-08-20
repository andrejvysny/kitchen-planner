/**
 * ShellState — the chrome's own ephemeral state: the status-bar hint text,
 * whether the catalog drawer is open, the elevation view's wall label, whether
 * the shortcut sheet is up, the PDF waiting for a page to be chosen, and the
 * confirm/prompt dialog waiting for an answer.
 *
 * None of them belongs to the Design (never serialized, never in an undo step)
 * nor to EditorState (they are not tools — a hint is a message, the drawer is a
 * narrow-screen affordance, the label is a caption, the sheet is help). Shape
 * mirrors src/model/prefs.ts and src/model/navPref.ts: a module singleton plus
 * one listener set, minus the persistence — there is nothing here worth
 * remembering across a reload.
 *
 * One listener set covers ALL fields: they change at human speed and the
 * components reading them are two `<span>`s and a class toggle, so splitting
 * them would only buy a spurious render.
 */

/** Severity for the status-bar hint — drives StatusHint's class, nothing else. */
export type HintKind = 'info' | 'success' | 'error';

let hintState: { text: string; kind: HintKind } = { text: '', kind: 'info' };
let drawerOpen = false;
let wallLabelText = 'Wall';
let sheetOpen = false;
let pdfFile: File | null = null;
let underlayFailed = false;
let dialogReq: DialogRequest | null = null;

const listeners = new Set<() => void>();

export function hint(): { text: string; kind: HintKind } {
  return hintState;
}

/** Identical text+kind is a no-op: no emit, so a repeated hint costs no render. */
export function setHint(text: string, kind: HintKind = 'info'): void {
  if (hintState.text === text && hintState.kind === kind) return;
  hintState = { text, kind };
  emit();
}

export function catalogOpen(): boolean {
  return drawerOpen;
}

export function setCatalogOpen(open: boolean): void {
  if (drawerOpen === open) return;
  drawerOpen = open;
  emit();
}

export function wallLabel(): string {
  return wallLabelText;
}

/**
 * Caption for the elevation view's wall stepper. ElevationView reports it
 * through its onWallChange callback; `<WallNav/>` renders it. The initial
 * 'Wall' is what index.html shipped, so the first paint is unchanged.
 */
export function setWallLabel(text: string): void {
  if (wallLabelText === text) return;
  wallLabelText = text;
  emit();
}

export function cheatsheetOpen(): boolean {
  return sheetOpen;
}

/**
 * The keyboard/mouse cheatsheet's visibility (WS-SPEC §5.5). It lives here for
 * the same reason the catalog drawer does: it is CHROME — neither Design data
 * nor a tool — and its two callers sit on opposite sides of the component tree
 * (the `help.shortcuts` command behind `?`, and the settings menu's
 * `Shortcuts…`), which is exactly what a shell singleton is for. Idempotent:
 * an identical value costs no render.
 */
export function setCheatsheetOpen(open: boolean): void {
  if (sheetOpen === open) return;
  sheetOpen = open;
  emit();
}

export function pdfImport(): File | null {
  return pdfFile;
}

/**
 * The PDF awaiting a page choice, or null when no picker is up (WS-SPEC §5.4's
 * reference-photo flow, extended to plan sets).
 *
 * A File, not a page number: the picker is the thing that opens the document,
 * so the shell only has to say WHICH file is being imported and the component
 * owns everything expensive. Chrome, like the cheatsheet — never Design data,
 * never undone — and set from the file input, which sits in the topbar, far
 * from the overlay that renders the thumbnails.
 */
export function setPdfImport(f: File | null): void {
  if (pdfFile === f) return;
  pdfFile = f;
  emit();
}

export function underlayStoreFailed(): boolean {
  return underlayFailed;
}

/**
 * Persistent twin of `SaveFailWarning` (StatusBar.tsx) for the ONE other thing
 * that lives outside the Design snapshot: the reference photo, in its own
 * localStorage key (CLAUDE.md's underlay note). A transient hint is not enough
 * — the failure happened on import/calibration, long before whatever status
 * text is showing now — so src/ui/underlayImport.ts sets this at the same
 * `store.setUnderlay()` refusal that produces the error hint, and clears it on
 * the next successful store.
 */
export function setUnderlayStoreFailed(failed: boolean): void {
  if (underlayFailed === failed) return;
  underlayFailed = failed;
  emit();
}

/**
 * A question the app is asking — the in-app replacement for `confirm()` and
 * `prompt()`. An `input` makes it a prompt: its `parse` both validates the raw
 * string and maps it to the number the caller wanted, so the dialog can hold
 * itself open on a bad answer instead of resolving with a wrong one.
 */
export interface DialogRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: {
    placeholder?: string;
    initial?: string;
    /** validate+map; return {ok:true,value}|{ok:false,error} */
    parse: (raw: string) => { ok: true; value: number } | { ok: false; error: string };
  };
}

export function appDialog(): DialogRequest | null {
  return dialogReq;
}

/**
 * Chrome like the cheatsheet — never Design data, never undone. Set it through
 * src/ui/dialogService.ts rather than directly: the service owns the promise
 * the opener is waiting on, and a request raised behind its back would never be
 * answered.
 */
export function setDialog(req: DialogRequest | null): void {
  if (dialogReq === req) return;
  dialogReq = req;
  emit();
}

/** Returns a disposer that unsubscribes `fn`; calling it twice is a no-op. */
export function onShellChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  // snapshot: a subscriber that unsubscribes mid-dispatch must not skip a sibling
  for (const fn of [...listeners]) fn();
}
