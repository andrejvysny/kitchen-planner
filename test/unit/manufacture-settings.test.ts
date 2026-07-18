import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MANUFACTURE,
  panelParamsFrom,
  sanitizeManufacture,
} from '../../src/model/manufacture/settings';
import { DEFAULT_PANEL_PARAMS } from '../../src/model/panels';
import { sanitizeDesign } from '../../src/model/store';

const CORNERS = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 4, y: 0 },
  { id: 'c', x: 4, y: 3 },
  { id: 'd', x: 0, y: 3 },
];

describe('sanitizeManufacture', () => {
  it('round-trips DEFAULT_MANUFACTURE unchanged', () => {
    expect(sanitizeManufacture(DEFAULT_MANUFACTURE)).toEqual(DEFAULT_MANUFACTURE);
  });

  it('falls back to defaults for non-object / junk input', () => {
    expect(sanitizeManufacture(undefined)).toEqual(DEFAULT_MANUFACTURE);
    expect(sanitizeManufacture(null)).toEqual(DEFAULT_MANUFACTURE);
    expect(sanitizeManufacture('junk')).toEqual(DEFAULT_MANUFACTURE);
    expect(sanitizeManufacture({})).toEqual(DEFAULT_MANUFACTURE);
  });

  it('clamps out-of-range numbers to their sane bounds', () => {
    expect(sanitizeManufacture({ carcassT: 5 }).carcassT).toBe(0.03);
    expect(sanitizeManufacture({ carcassT: -1 }).carcassT).toBe(0.012);
    expect(sanitizeManufacture({ backT: 1 }).backT).toBe(0.019);
    expect(sanitizeManufacture({ plinthH: 10 }).plinthH).toBe(0.2);
    expect(sanitizeManufacture({ plinthH: -1 }).plinthH).toBe(0.04);
    expect(
      sanitizeManufacture({ system32: { pitch: 99 } }).system32.pitch
    ).toBe(0.05);
    expect(
      sanitizeManufacture({ drawer: { boxHeight: 99 } }).drawer.boxHeight
    ).toBe(0.3);
  });

  it('falls back to the default for an invalid enum', () => {
    expect(sanitizeManufacture({ joinery: 'nails' }).joinery).toBe('confirmat');
    expect(sanitizeManufacture({ backMode: 'stapled' }).backMode).toBe('groove');
  });

  it('never aliases raw input or the frozen defaults', () => {
    const result = sanitizeManufacture(DEFAULT_MANUFACTURE);
    expect(result).not.toBe(DEFAULT_MANUFACTURE);
    expect(result.system32).not.toBe(DEFAULT_MANUFACTURE.system32);
    expect(result.drawer).not.toBe(DEFAULT_MANUFACTURE.drawer);
    result.carcassT = 999;
    result.system32.pitch = 999;
    expect(DEFAULT_MANUFACTURE.carcassT).toBe(0.018);
    expect(DEFAULT_MANUFACTURE.system32.pitch).toBe(0.032);
  });

  it('panelParamsFrom(DEFAULT_MANUFACTURE) reproduces today\'s exact panel geometry constants', () => {
    expect(panelParamsFrom(DEFAULT_MANUFACTURE)).toEqual(DEFAULT_PANEL_PARAMS);
  });
});

describe('sanitizeDesign — manufacture settings (v4 → v5)', () => {
  it('adds default manufacture settings to a minimal v4 design', () => {
    const d = sanitizeDesign({ version: 4, corners: CORNERS })!;
    expect(d).not.toBeNull();
    expect(d.version).toBe(5);
    expect(d.manufacture).toEqual(DEFAULT_MANUFACTURE);
  });
});
