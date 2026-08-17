/**
 * ShellState — the chrome's own ephemeral state: the status-bar hint text,
 * whether the catalog drawer is open, and the elevation view's wall label.
 *
 * None of them belongs to the Design (never serialized, never in an undo step)
 * nor to EditorState (they are not tools — a hint is a message, the drawer is a
 * narrow-screen affordance, the label is a caption). Shape mirrors
 * src/model/prefs.ts and src/model/navPref.ts: a module singleton plus one
 * listener set, minus the persistence — there is nothing here worth remembering
 * across a reload.
 *
 * One listener set covers ALL fields: they change at human speed and the
 * components reading them are two `<span>`s and a class toggle, so splitting
 * them would only buy a spurious render.
 */

let hintText = '';
let drawerOpen = false;
let wallLabelText = 'Wall';

const listeners = new Set<() => void>();

export function hint(): string {
  return hintText;
}

/** Identical text is a no-op: no emit, so a repeated hint costs no render. */
export function setHint(text: string): void {
  if (hintText === text) return;
  hintText = text;
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
