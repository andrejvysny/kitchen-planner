import { describe, expect, it } from 'vitest';
import { skyState, mixHex } from '../../src/model/sky';

const DEG = Math.PI / 180;

describe('skyState', () => {
  it('converts the input angles to radians', () => {
    const s = skyState(180, 35, false);
    expect(s.azimuth).toBeCloseTo(Math.PI, 5);
    expect(s.elevation).toBeCloseTo(35 * DEG, 5);
  });

  it('wraps azimuth outside 0..360', () => {
    expect(skyState(370, 35, false)).toEqual(skyState(10, 35, false));
    expect(skyState(-90, 35, false)).toEqual(skyState(270, 35, false));
  });

  it('is bright and neutral with a high sun', () => {
    const s = skyState(215, 60, false);
    expect(s.sunIntensity).toBeCloseTo(2.2, 5);
    expect(s.sunColor).toBe('#fff4e0');
    expect(s.ambientIntensity).toBeCloseTo(0.5, 5);
    expect(s.ambientColor).toBe('#ffffff');
    // key stays well above fill so daylight models the room instead of washing it out
    expect(s.sunIntensity).toBeGreaterThan(s.ambientIntensity * 3);
  });

  it('warms the sun near the horizon (golden hour)', () => {
    const low = skyState(215, 12, false).sunColor;
    const high = skyState(215, 60, false).sunColor;
    const rb = (hex: string) => parseInt(hex.slice(1, 3), 16) - parseInt(hex.slice(5, 7), 16);
    // both warm-ish, but the low sun is redder relative to its blue channel
    expect(rb(low)).toBeGreaterThan(rb(high));
  });

  it('dims the ambient with a low sun, but never to black', () => {
    const s = skyState(215, 5, false);
    expect(s.ambientIntensity).toBeLessThan(0.5);
    expect(s.ambientIntensity).toBeGreaterThan(0.1);
    expect(s.background).not.toBe('#e6e4df'); // not the full-day sky
  });

  it('night reproduces the original moonlight look and ignores elevation', () => {
    const s = skyState(215, 60, true);
    expect(s.sunColor).toBe('#8fa3c4');
    expect(s.sunIntensity).toBe(0.04);
    expect(s.ambientIntensity).toBeCloseTo(0.1, 5);
    expect(s.background).toBe('#171a20');
    expect(s.elevation).toBeLessThan(0); // parked below horizon regardless of the slider
    expect(skyState(215, 10, true)).toEqual(s);
  });

  it('tolerates elevation beyond the UI range', () => {
    expect(skyState(0, 120, false)).toEqual(skyState(0, 90, false));
    expect(skyState(0, -10, false)).toEqual(skyState(0, 0, false));
  });
});

describe('mixHex', () => {
  it('returns the endpoints and midpoint', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});
