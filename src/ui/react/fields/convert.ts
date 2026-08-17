/**
 * Display-unit conversions for the numeric fields. Pure, DOM-free, so
 * test/unit/fields.test.ts pins them directly.
 *
 * The model is metres and radians everywhere (CLAUDE.md); the UI shows whole
 * centimetres and whole degrees. These four functions are that edge, and they
 * reproduce src/ui/ui.ts's numberRow call sites EXACTLY — `Math.round(m * 100)`
 * out, `cm / 100` back in — so T3 changes no pixel and no stored number.
 *
 * T4 replaces the length pair with src/model/units.ts (mm/cm/m prefs and the
 * expression parser). That switch is a sanctioned, visible change; this file is
 * deliberately the only place it has to happen.
 */

/** metres → the whole centimetres the field shows. */
export function toCm(m: number): number {
  return Math.round(m * 100);
}

/** centimetres typed into a field → metres for the model. */
export function fromCm(cm: number): number {
  return cm / 100;
}

/** radians → whole degrees in [0, 360) for display; the model keeps radians unbounded. */
export function toDeg(rad: number): number {
  return ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;
}

/** degrees typed into a field → radians for the model. */
export function fromDeg(deg: number): number {
  return (deg * Math.PI) / 180;
}
