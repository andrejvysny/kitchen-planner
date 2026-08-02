// All localStorage keys in one place. The app was renamed from "kitchen
// planner" to a general interior planner; writes always target the new keys,
// reads fall back to the legacy kitchen-planner-* keys so existing users keep
// their design, parts library and preferences. Legacy keys are never deleted —
// reverting to an older build must still find them.

export const DESIGN_KEY = 'interior-planner-design-v1';
export const PARTS_KEY = 'interior-planner-parts-v1';
export const NAV_KEY = 'interior-planner-nav-v1';

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
