/**
 * Time-of-day sky model — pure, no three.js, unit-testable.
 *
 * `timeOfDay` (0..24h) is the single master driver of the outdoor light: sun
 * direction, colour temperature, intensity and the sky/background. View3D reads
 * this every relight; manual scene adjustments (sunStrength, sunColor, …) layer
 * on top. Endpoints reproduce the app's original hardcoded look at t=13 (day)
 * and t=22 (night).
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
const SUNRISE = 6;
const SUNSET = 20;

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

export function skyState(timeOfDay: number): SkyState {
  const t = ((timeOfDay % 24) + 24) % 24; // wrap into [0,24)
  const up = t >= SUNRISE && t <= SUNSET;
  const p = (t - SUNRISE) / (SUNSET - SUNRISE); // 0..1 across daytime (outside range when night)

  // direction: sine arc peaking at solar noon; parked just below horizon at night
  const elevation = up ? Math.sin(p * Math.PI) * (60 * DEG) : -8 * DEG;
  const azimuth = lerp(95, 265, clamp01(p)) * DEG; // east→west sweep

  // h = sun-above-horizon strength (0 at rise/set & night, 1 at noon)
  const h = up ? Math.max(0, Math.sin(p * Math.PI)) : 0;
  // civil = ambient/twilight light, saturates well before noon so dusk isn't black
  const civil = clamp01((elevation / DEG + 8) / 24);

  const sunColor = up ? mixHex(SUN_WARM, SUN_NOON, smoothstep(0.12, 0.55, h)) : SUN_MOON;
  const sunIntensity = up ? lerp(0.25, 1.75, h) : 0.04;

  const ambientColor = mixHex(SKY_NIGHT, SKY_DAY, civil);
  const ambientIntensity = lerp(0.1, 0.72, civil);

  const background =
    civil < 0.5
      ? mixHex(BG_NIGHT, BG_DUSK, civil / 0.5)
      : mixHex(BG_DUSK, BG_DAY, (civil - 0.5) / 0.5);

  return { azimuth, elevation, sunColor, sunIntensity, ambientColor, ambientIntensity, background };
}
