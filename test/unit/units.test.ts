import { describe, expect, it } from 'vitest';
import {
  formatAngle,
  formatLength,
  formatLengthLabel,
  parseAngle,
  parseLength,
  type UnitPrefs,
} from '../../src/model/units';

const MM: UnitPrefs = { unit: 'mm', decimals: 0 };
const CM: UnitPrefs = { unit: 'cm', decimals: 1 };
const M: UnitPrefs = { unit: 'm', decimals: 3 };

/** A single '1'-char over the cap, built once so the table stays readable. */
const OVER_CHAR_CAP = '1'.repeat(129);
/** 10kB, per the spec's explicit length-cap adversarial case. */
const TEN_KB = '1'.repeat(10 * 1024);
/** '1+' * 40 + '1' = 81 tokens (81 chars, under the 128-char cap) — trips the token cap, not the char cap. */
const OVER_TOKEN_CAP = '1+'.repeat(40) + '1';
/** 10 nested parens — over the depth-8 cap. */
const OVER_PAREN_DEPTH = '('.repeat(10) + '1' + ')'.repeat(10);

describe('parseLength', () => {
  const cases: Array<[string, UnitPrefs, number | null]> = [
    // -- bare literal takes prefs.unit --
    ['600', MM, 0.6],
    ['600', CM, 6.0],
    ['600', M, 600],
    ['0', MM, 0],
    ['1', M, 1],

    // -- unit suffix binds to its own literal, overriding prefs.unit --
    ['1m - 50', MM, 0.95],
    ['1m - 50mm', MM, 0.95],
    ['60cm', MM, 0.6],
    ['0.6m', MM, 0.6],
    ['1000mm', CM, 1.0],
    ['100', CM, 1.0],
    ['100cm', M, 1],

    // -- precedence --
    ['600-18*2', MM, 0.564],
    ['(600-18)*2', MM, 1.164],
    ['2*3+4', MM, 0.01],
    ['2+3*4', MM, 0.014],
    ['(2+3)*4', MM, 0.02],
    ['10/2+3', MM, 0.008],
    ['10/(2+3)', MM, 0.002],

    // -- dimensional discipline: * --
    ['600mm * 2', MM, 1.2],
    ['2 * 600mm', MM, 1.2], // scalar*length commutes
    ['600mm * 2mm', MM, null], // length*length: no area type

    // -- dimensional discipline: / --
    ['1200/3', MM, 0.4], // scalar/scalar stays scalar, reinterpreted as prefs.unit at the end
    ['1m/50cm', MM, 0.002], // length/length -> scalar ratio (2), reinterpreted as prefs.unit (documented edge case)
    ['600mm/2', MM, 0.3], // length/scalar -> length
    ['2/600mm', MM, null], // scalar/length: no sensible result unit

    // -- dimensional discipline: +/- mixing --
    ['600mm+2', MM, 0.602], // bare 2 read as prefs.unit (mm) before combining
    ['2+600mm', MM, 0.602], // commutes
    ['600mm-2', MM, 0.598],
    ['600+2mm', MM, 0.602],

    // -- comma decimal separator, whitespace insensitivity --
    ['60,5cm', MM, 0.605],
    ['  600  ', MM, 0.6],
    [' 1 m - 50 mm ', MM, 0.95],
    ['0.6m', CM, 0.6],
    ['0,6m', CM, 0.6],

    // -- negative results: parser stays honest, no clamping --
    ['-600', MM, -0.6],
    ['0-600', MM, -0.6],
    ['-1m + 50mm', MM, -0.95],
    ['-0.6m', MM, -0.6],

    // -- adversarial: empty / whitespace-only / garbage --
    ['', MM, null],
    ['   ', MM, null],
    ['abc', MM, null],

    // -- adversarial: scientific notation rejected (tokenizer only reads digits/./,)  --
    ['1e999', MM, null],
    ['1e3', MM, null],

    // -- adversarial: caps --
    [OVER_CHAR_CAP, MM, null],
    [TEN_KB, MM, null],
    [OVER_TOKEN_CAP, MM, null],
    [OVER_PAREN_DEPTH, MM, null], // 10 nested parens > MAX_PAREN_DEPTH (8)
    ['(1+2)', MM, 0.003], // sanity: depth 1 is fine

    // -- adversarial: non-finite intermediate --
    ['1/0', MM, null],
    ['0/0', MM, null],
    ['600mm/0', MM, null],

    // -- adversarial: malformed unary / decimal separators --
    ['--5', MM, null],
    ['5..5', MM, null],
    ['5,,5', MM, null],
    ['.5', MM, null], // no digit before the separator: not a NUMBER token at all

    // -- adversarial: literal glued to junk / bare unit / unrecognised numeral formats --
    ['600mm2', MM, null], // 'mm' consumes only the letters; stray '2' left dangling -> unconsumed tokens
    ['mm', MM, null], // unit with no preceding NUMBER
    ['6 0 0', MM, null], // three bare numbers, no operators between them
    ['0x10', MM, null], // hex not supported: 'x' is not mm/cm/m
    ['1 mm mm', MM, null], // a unit can't follow a unit

    // -- adversarial: unbalanced / stray parens --
    ['(1+2', MM, null],
    ['1+2)', MM, null],
    [')(', MM, null],
  ];

  it.each(cases)('parseLength(%j, %j) -> %j', (src, prefs, expected) => {
    const got = parseLength(src, prefs);
    if (expected === null) {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(got as number).toBeCloseTo(expected, 9);
    }
  });

  it('never returns -0', () => {
    expect(Object.is(parseLength('0-0', MM), -0)).toBe(false);
    expect(Object.is(parseLength('-0', MM), -0)).toBe(false);
  });
});

describe('parseAngle', () => {
  const cases: Array<[string, number | null]> = [
    ['90', Math.PI / 2],
    ['-90', -Math.PI / 2],
    ['0', 0],
    ['180', Math.PI],
    ['45+45', Math.PI / 2],
    ['180/2', Math.PI / 2],
    ['(30+60)', Math.PI / 2],
    ['360-270', Math.PI / 2],
    ['', null],
    ['abc', null],
    ['90mm', null], // no unit suffixes allowed for angles
    ['90cm', null],
    ['90m', null],
    ['--5', null],
    ['1e999', null],
    [OVER_PAREN_DEPTH, null],
  ];

  it.each(cases)('parseAngle(%j) -> %j', (src, expected) => {
    const got = parseAngle(src);
    if (expected === null) {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(got as number).toBeCloseTo(expected, 9);
    }
  });
});

describe('formatLength', () => {
  it('uses prefs.unit and prefs.decimals, stripping trailing zeros', () => {
    expect(formatLength(0.6, MM)).toBe('600');
    expect(formatLength(0.6, CM)).toBe('60');
    expect(formatLength(0.6, M)).toBe('0.6');
    expect(formatLength(1.2, CM)).toBe('120');
  });

  it('rounds to the given decimals via standard toFixed rounding', () => {
    expect(formatLength(1.2345, M)).toBe('1.234');
  });

  it('normalizes -0 (and values that round to zero) to "0"', () => {
    expect(formatLength(0, MM)).toBe('0');
    expect(formatLength(-0.00001, MM)).toBe('0');
    expect(formatLength(-0.6, M)).toBe('-0.6');
  });

  it('obeys an explicit decimals count regardless of unit', () => {
    expect(formatLength(0.6005, { unit: 'm', decimals: 0 })).toBe('1');
    expect(formatLength(0.1, { unit: 'mm', decimals: 2 })).toBe('100');
  });
});

describe('formatLengthLabel', () => {
  it('appends the unit suffix with no other formatting change', () => {
    expect(formatLengthLabel(0.6, MM)).toBe('600 mm');
    expect(formatLengthLabel(0.6, CM)).toBe('60 cm');
    expect(formatLengthLabel(0.6, M)).toBe('0.6 m');
  });
});

describe('formatAngle', () => {
  it('renders degrees to 1 decimal, trailing zeros stripped', () => {
    expect(formatAngle(Math.PI / 2)).toBe('90');
    expect(formatAngle(0)).toBe('0');
    expect(formatAngle(Math.PI)).toBe('180');
    expect(formatAngle(-Math.PI / 2)).toBe('-90');
    expect(formatAngle(Math.PI / 4)).toBe('45');
  });
});

describe('round-trips', () => {
  it('format(parse(x)) reproduces the canonical display string', () => {
    expect(formatLength(parseLength('600', MM)!, MM)).toBe('600');
    expect(formatLength(parseLength('6', CM)!, CM)).toBe('6');
    expect(formatLength(parseLength('1', M)!, M)).toBe('1');
    expect(formatLength(parseLength('1245', MM)!, MM)).toBe('1245');
  });

  it("parse(format(x)) reproduces the meter value (within the unit's resolution)", () => {
    const m = 1.245;
    expect(parseLength(formatLength(m, MM), MM)).toBeCloseTo(m, 6);
  });
});

/** Deterministic xorshift-ish PRNG so a fuzz failure is reproducible from the fixed seed. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseLength fuzz', () => {
  it('never throws and always returns a finite number or null (10000 seeded random strings)', () => {
    const alphabet = '0123456789.,+-*/()mc m';
    const rand = mulberry32(20260816); // fixed seed: reproducible on failure
    for (let i = 0; i < 10000; i++) {
      const len = Math.floor(rand() * 40);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      let result: number | null = null;
      expect(() => {
        result = parseLength(s, MM);
      }).not.toThrow();
      expect(result === null || Number.isFinite(result)).toBe(true);
    }
  });

  it('parseAngle also never throws across the same generator (2000 seeded random strings)', () => {
    const alphabet = '0123456789.,+-*/()mc m';
    const rand = mulberry32(99);
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rand() * 40);
      let s = '';
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
      let result: number | null = null;
      expect(() => {
        result = parseAngle(s);
      }).not.toThrow();
      expect(result === null || Number.isFinite(result)).toBe(true);
    }
  });
});
