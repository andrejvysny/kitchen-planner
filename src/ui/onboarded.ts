/**
 * Onboarded flag — whether this device has already seen the first-run tour
 * (WS-SPEC §5.5, WP 2.5).
 *
 * Shape is src/model/navPref.ts's, minus the detector: a load-at-import
 * singleton over one localStorage key, no listener set. There is nothing to
 * subscribe to — the flag is read exactly once, in `createServices()`, to
 * decide `firstRun`, and written exactly once, when the tour ends. A component
 * that re-rendered on it would be reacting to a decision already taken.
 *
 * It is a per-device preference, NEVER design data: it stays out of the
 * Design, out of DESIGN_VERSION and out of every export, like the workspace
 * and unit preferences.
 */

import { ONBOARDED_KEY } from '../model/storageKeys';

let seen = load();

function load(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) !== null;
  } catch {
    // private mode / storage disabled: treat as onboarded rather than replay
    // the tour on every single boot for someone who can never dismiss it
    return true;
  }
}

/** True once the first-run tour has been shown (or storage is unavailable). */
export function onboarded(): boolean {
  return seen;
}

/** Mark the tour as done. Idempotent, and best-effort like every preference. */
export function setOnboarded(): void {
  seen = true;
  try {
    localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    /* preference is best-effort */
  }
}
