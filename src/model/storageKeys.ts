// All localStorage keys in one place. The app was renamed from "kitchen
// planner" to a general interior planner; writes always target the new keys,
// reads fall back to the legacy kitchen-planner-* keys so existing users keep
// their design, parts library and preferences. Legacy keys are never deleted —
// reverting to an older build must still find them.

export const DESIGN_KEY = 'interior-planner-design-v1';
export const PARTS_KEY = 'interior-planner-parts-v1';
export const NAV_KEY = 'interior-planner-nav-v1';
/** Raw autosave text stashed the first time it fails to parse/sanitize on
 * load, so a corrupted save is never silently replaced by the demo design. */
export const RECOVERY_KEY = 'interior-planner-design-recovery-v1';
/**
 * The floor-plan tracing photo, as a data URL. Deliberately its own key: the
 * Design is JSON-cloned per undo step and per autosave, so image bytes must
 * never live in it (see types.ts `Underlay`). No legacy fallback — the feature
 * postdates the rename.
 */
export const UNDERLAY_KEY = 'interior-planner-underlay-v1';

/** Which of the four workspaces (plan/furnish/workshop/output) was last
 * open. A device preference like UNDERLAY_KEY above — new-name only, no
 * legacy fallback, since the feature postdates the rename. */
export const WORKSPACE_KEY = 'interior-planner-workspace-v1';
/** Length-display unit + decimals preference (src/model/prefs.ts). Same
 * new-name-only property as UNDERLAY_KEY and WORKSPACE_KEY above. */
export const UNIT_PREFS_KEY = 'interior-planner-units-v1';
/** Whether the first-run tour has been shown (src/ui/onboarded.ts). Written
 * once, never read by the model — a per-device flag like WORKSPACE_KEY and
 * UNIT_PREFS_KEY above, new-name only, since the feature postdates the
 * rename. Test suites SEED it so a cleared profile never boots the tour. */
export const ONBOARDED_KEY = 'interior-planner-onboarded-v1';
/**
 * Whether the Furnish "pick something from the library" nudge has been
 * dismissed (src/ui/react/EmptyState.tsx). The one key here that lives in
 * sessionStorage, not localStorage: dismissing it answers "not this visit",
 * not "never again", so a reload inside the same tab must keep it hidden while
 * a new tab starts over. New-name only, like the four keys above.
 */
export const NUDGE_KEY = 'interior-planner-nudge-v1';

export const LEGACY_DESIGN_KEYS = ['kitchen-planner-design-v1'] as const;
export const LEGACY_PARTS_KEYS = ['kitchen-planner-parts-v1'] as const;
export const LEGACY_NAV_KEYS = ['kitchen-planner-nav-v1'] as const;

/** First stored value found, preferring the current key over legacy ones. */
export function readKey(key: string, legacy: readonly string[]): string | null {
  for (const k of [key, ...legacy]) {
    const raw = localStorage.getItem(k);
    if (raw !== null) return raw;
  }
  return null;
}
