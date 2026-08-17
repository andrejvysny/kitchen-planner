/**
 * WorkspaceState — which of the four task-focused workspaces (plan / furnish
 * / workshop / output) the shell is showing, plus the target the Workshop
 * opens on.
 *
 * `workspace` is a device preference (persisted): re-opening the app lands
 * you back where you left off, like src/model/prefs.ts and navPref.ts.
 * `workshopTarget` is NOT: it names the part being edited and where "Back"
 * returns to, and belongs to one visit — it is never persisted and never
 * enters undo, the same way store.openFronts and the active room are
 * ephemeral view state rather than Design data. Shape mirrors
 * src/ui/shellState.ts (module singleton, one listener Set) plus the
 * load/persist half of src/model/prefs.ts.
 */

import type { WorkspaceId } from '../editor/commands/types';
import { WORKSPACE_KEY } from '../model/storageKeys';

export type { WorkspaceId };

export interface WorkshopTarget {
  /** part def to open — a custom part id or a preset id; null = the parts picker */
  defId: string | null;
  /** placed instance that initiated the edit, if any */
  itemId?: string;
  /** where "Back" returns to */
  returnTo: WorkspaceId;
}

const WORKSPACE_IDS: readonly WorkspaceId[] = ['plan', 'furnish', 'workshop', 'output'];

function isWorkspaceId(v: unknown): v is WorkspaceId {
  return typeof v === 'string' && (WORKSPACE_IDS as readonly string[]).includes(v);
}

function load(): WorkspaceId {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    return isWorkspaceId(raw) ? raw : 'furnish';
  } catch {
    return 'furnish'; // private mode / storage disabled
  }
}

let current: WorkspaceId = load();
let target: WorkshopTarget | null = null;

const listeners = new Set<() => void>();

export function workspace(): WorkspaceId {
  return current;
}

/** Identical id is a no-op: no emit, no persist. Leaving 'workshop' clears the target. */
export function setWorkspace(w: WorkspaceId): void {
  if (current === w) return;
  if (current === 'workshop') target = null;
  current = w;
  persist();
  emit();
}

export function workshopTarget(): WorkshopTarget | null {
  return target;
}

/**
 * Opens the Workshop on `defId` (null = the parts picker). Reuses the
 * existing target's returnTo when already in the Workshop, so drilling into
 * a second part from within the Workshop still returns to the ORIGINAL
 * workspace rather than to the Workshop itself; falls back to 'furnish' if
 * there was no prior target. One emit total, whether or not this also
 * switches `current`.
 */
export function openInWorkshop(defId: string | null, itemId?: string): void {
  const returnTo = current !== 'workshop' ? current : (target?.returnTo ?? 'furnish');
  target = { defId, itemId, returnTo };
  if (current !== 'workshop') {
    current = 'workshop';
    persist();
  }
  emit();
}

export function clearWorkshopTarget(): void {
  if (target === null) return;
  target = null;
  emit();
}

/** Returns a disposer that unsubscribes `fn`; calling it twice is a no-op. */
export function onWorkspaceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function persist(): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, current);
  } catch {
    /* preference is best-effort */
  }
}

function emit(): void {
  // snapshot: a subscriber that unsubscribes mid-dispatch must not skip a sibling
  for (const fn of [...listeners]) fn();
}
