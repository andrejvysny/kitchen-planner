import { describe, expect, it } from 'vitest';
import { skyState, mixHex } from '../../src/model/sky';

const DEG = Math.PI / 180;

describe('skyState', () => {
  it('sun climbs to its peak at solar noon and drops below the horizon at night', () => {
    const noon = skyState(13);
    const dawn = skyState(6.5);
    const night = skyState(2);
    expect(noon.elevation).toBeGreaterThan(dawn.elevation);
    expect(noon.elevation).toBeGreaterThan(50 * DEG);
    expect(night.elevation).toBeLessThan(0); // parked below horizon
  });

  it('is bright and neutral by day, dim and cool at night', () => {
    const noon = skyState(13);
    const night = skyState(22);
    expect(noon.sunIntensity).toBeGreaterThan(1.5);
    expect(noon.ambientIntensity).toBeGreaterThan(0.6);
    expect(night.sunIntensity).toBeLessThan(0.1);
    expect(night.ambientIntensity).toBeLessThan(0.2);
    expect(night.sunColor).toBe('#8fa3c4'); // moonlight
  });

  it('reproduces the original day / night endpoints', () => {
    // t=13 and t=22 must match the app's previous hardcoded look
    const day = skyState(13);
    expect(day.ambientIntensity).toBeCloseTo(0.72, 5);
    expect(day.ambientColor).toBe('#ffffff');
    const night = skyState(22);
    expect(night.ambientIntensity).toBeCloseTo(0.1, 5);
    expect(night.background).toBe('#171a20');
  });

  it('warms the sun near the horizon (golden hour)', () => {
    const goldenR = parseInt(skyState(7).sunColor.slice(1, 3), 16);
    const noonR = parseInt(skyState(13).sunColor.slice(1, 3), 16);
    // both warm-ish, but golden hour is redder relative to its blue channel
    const goldenB = parseInt(skyState(7).sunColor.slice(5, 7), 16);
    const noonB = parseInt(skyState(13).sunColor.slice(5, 7), 16);
    expect(goldenR - goldenB).toBeGreaterThan(noonR - noonB);
  });

  it('wraps time outside 0..24', () => {
    expect(skyState(25)).toEqual(skyState(1));
    expect(skyState(-1)).toEqual(skyState(23));
  });
});

describe('mixHex', () => {
  it('returns the endpoints and midpoint', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
