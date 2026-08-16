// Length-display preference: which unit the UI shows/parses bare numbers as,
// and how many decimals to render. A per-device UI preference, NOT design
// data — its own localStorage key, never serialized into the design JSON,
// DESIGN_VERSION or export/undo. Shape mirrors src/model/navPref.ts exactly
// (module-level load + in-memory singleton + best-effort persistence).
//
// UNIT_PREFS_KEY belongs in src/model/storageKeys.ts alongside the other
// storage keys; it's declared here instead to avoid an out-of-turn edit to
// that file while another agent is touching neighbouring config — move it
// there the next time storageKeys.ts is touched.

import type { Unit, UnitPrefs } from './units';

export const UNIT_PREFS_KEY = 'interior-planner-units-v1';

const DEFAULT_PREFS: UnitPrefs = { unit: 'mm', decimals: 0 };

function isUnit(v: unknown): v is Unit {
  return v === 'mm' || v === 'cm' || v === 'm';
}

/** Unknown unit -> 'mm'; decimals clamped to an integer in [0, 3]. Applied on every read. */
function sanitize(raw: unknown): UnitPrefs {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PREFS };
  const r = raw as Record<string, unknown>;
  const unit = isUnit(r.unit) ? r.unit : DEFAULT_PREFS.unit;
  const decimals =
    typeof r.decimals === 'number' && Number.isFinite(r.decimals)
      ? Math.min(3, Math.max(0, Math.trunc(r.decimals)))
      : DEFAULT_PREFS.decimals;
  return { unit, decimals };
}

function load(): UnitPrefs {
  try {
    const raw = localStorage.getItem(UNIT_PREFS_KEY);
    return raw === null ? { ...DEFAULT_PREFS } : sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS }; // private mode / storage disabled / corrupt JSON
  }
}

let current: UnitPrefs = load();
const listeners = new Set<() => void>();

export function unitPrefs(): UnitPrefs {
  return current;
}

export function setUnitPrefs(patch: Partial<UnitPrefs>): void {
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(UNIT_PREFS_KEY, JSON.stringify(current));
  } catch {
    /* preference is best-effort */
  }
  for (const fn of listeners) fn();
}

/** Returns a disposer that unsubscribes `fn`; calling it twice is a no-op. */
export function onUnitPrefsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
