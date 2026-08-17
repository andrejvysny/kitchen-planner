/**
 * The last display-space helper the numeric fields need, kept pure and DOM-free
 * so test/unit/fields.test.ts can pin it.
 *
 * Everything else that used to live here — metres↔centimetres, radians↔degrees
 * — is gone: src/model/units.ts is the single conversion authority now
 * (parseLength / parseAngle / formatLength / formatAngle), and the fields call
 * it directly. What units.ts deliberately does NOT do is wrap: `formatAngle`
 * reports the radians it is given, and the model keeps rotation unbounded
 * (four right turns is 4π, not 0). The rotation BOX has always shown [0, 360),
 * which is a display decision, so it lives here.
 */

const TAU = 2 * Math.PI;

/** Radians → the same direction, in [0, 2π). Negative and multi-turn values fold in. */
export function wrapAngle(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  const wrapped = rad - Math.floor(rad / TAU) * TAU;
  // a hair under TAU can round up to TAU itself; 360° must read as 0°
  return wrapped >= TAU || wrapped < 0 ? 0 : wrapped;
}
