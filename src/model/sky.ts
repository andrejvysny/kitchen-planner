/**
 * Sun/sky model — pure, no three.js, unit-testable.
 *
 * Driven directly by the user's sun angles: colour temperature, intensity,
 * ambient and the sky/background all derive from elevation (low sun = warm
 * golden, high = neutral). `night` overrides everything with the fixed
 * moonlight look. View3D reads this every relight and scales the result by
 * `scene.brightness`.
 */

export interface SkyState {
  /** sun direction, radians. azimuth 0 = +z, increasing toward +x; elevation up from horizon */
  azimuth: number;
  elevation: number;
  sunColor: string;
  sunIntensity: number;
  ambientColor: string;
  ambientIntensity: number;
  background: string;
}

const DEG = Math.PI / 180;

/** UI/sanitize range for the sun-height slider (degrees above horizon). */
export const SUN_ELEV_MIN = 5;
export const SUN_ELEV_MAX = 85;

/**
 * Full-day ambient ceiling. Kept LOW relative to the sun so daylight models
 * the room instead of washing it out; view3d normalizes its daylight factor
 * by this value.
 */
export const AMBIENT_DAY = 0.5;

// palette endpoints (match the original day/night constants)
const SUN_WARM = '#ff9a52'; // low sun, golden hour
const SUN_NOON = '#fff4e0'; // high sun, neutral
const SUN_MOON = '#8fa3c4'; // below horizon, moonlight
const SKY_NIGHT = '#5a6b8c';
const SKY_DAY = '#ffffff';
const BG_NIGHT = '#171a20';
const BG_DUSK = '#e8c7a8';
const BG_DAY = '#e6e4df';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear RGB-ish lerp between two hex colours (good enough for smooth UI ramps). */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}

export function skyState(azimuthDeg: number, elevationDeg: number, night: boolean): SkyState {
  const azimuth = (((azimuthDeg % 360) + 360) % 360) * DEG; // wrap into [0,360)

  // moonlight: azimuth passes through so the (shadowless) direction stays stable
  if (night) {
    return {
      azimuth,
      elevation: -8 * DEG, // parked just below the horizon
      sunColor: SUN_MOON,
      sunIntensity: 0.04,
      ambientColor: SKY_NIGHT,
      ambientIntensity: 0.1,
      background: BG_NIGHT,
    };
  }

  const elevDeg = Math.min(90, Math.max(0, elevationDeg)); // tolerant beyond the UI range
  // h = sun strength: 0 at the horizon, saturates at 60°+
  const h = clamp01(elevDeg / 60);
  // civil = ambient/twilight light, saturates by ~16° so low sun isn't black
  const civil = clamp01((elevDeg + 8) / 24);

  const sunColor = mixHex(SUN_WARM, SUN_NOON, smoothstep(0.12, 0.55, h));
  // strong key, restrained fill: the sun carries the modelling, the ambient
  // only keeps shadows from going black
  const sunIntensity = lerp(0.3, 2.2, h);

  const ambientColor = mixHex(SKY_NIGHT, SKY_DAY, civil);
  const ambientIntensity = lerp(0.1, AMBIENT_DAY, civil);

  const background =
    civil < 0.5
      ? mixHex(BG_NIGHT, BG_DUSK, civil / 0.5)
      : mixHex(BG_DUSK, BG_DAY, (civil - 0.5) / 0.5);

  return {
    azimuth,
    elevation: elevDeg * DEG,
    sunColor,
    sunIntensity,
    ambientColor,
    ambientIntensity,
    background,
  };
}
