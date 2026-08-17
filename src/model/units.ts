// Pure length/angle expression parser + formatter. This is the single unit-
// conversion authority for the app: everything downstream (props panel
// inputs, wall-length edits, room dimensions, …) is meant to route through
// here instead of hand-rolling cm↔m math. Design data itself stays meters
// internally (see CLAUDE.md) — this module only translates at the UI edge.
//
// No DOM, no three.js, no eval/new Function, no backtracking regex: a
// hand-written tokenizer + recursive-descent parser over
//
//   expr    := term (('+' | '-') term)*
//   term    := factor (('*' | '/') factor)*
//   factor  := ('-')? primary
//   primary := NUMBER UNIT? | '(' expr ')'
//   UNIT    := 'mm' | 'cm' | 'm'
//
// Dimensional discipline (every literal carries a `hasUnit` flag; pin any
// change to this contract with a units.test.ts case):
//
//   - A literal is a *scalar* (unitless) unless it carries an explicit mm/cm/m
//     suffix. A suffixed literal is a *length*, held internally in meters.
//     (Bare literals are NOT pre-interpreted in prefs.unit while parsing —
//     only the final whole-expression result is, see below. This is what
//     makes '600-18*2' behave like ordinary arithmetic on 600, 18, 2 rather
//     than converting each literal separately.)
//   - '+'/'-' : scalar±scalar = scalar. length±length = length. scalar±length
//     (either order) = length — the scalar is interpreted AS prefs.unit and
//     converted to meters before combining.
//   - '*'     : scalar×scalar = scalar. length×scalar (either order) = length,
//     with the scalar used as a pure multiplier (never unit-converted).
//     length×length = null — no area type, deliberately unsupported.
//   - '/'     : scalar÷scalar = scalar. length÷scalar = length. length÷length
//     = scalar (a dimensionless ratio). scalar÷length = null — no sensible
//     unit for the result, so rejected (asymmetric with length÷length on
//     purpose: a ratio is meaningful, an inverse-length is not).
//   - Whole-expression result: if it carries a unit, that IS the length, in
//     meters, done. If it's still a bare scalar (e.g. '600-18*2', or the
//     length÷length ratio case above), the number is interpreted as
//     prefs.unit and converted to meters. This last rule is what makes a
//     length÷length result re-enter as a length if it's the outermost node —
//     an accepted, tested edge case, not an oversight.
//   - Unary minus binds once per factor (grammar has no chained unary
//     outside parentheses: '--5' is invalid, '-(-5)' is fine).
//   - Division by zero / any non-finite intermediate → null. In practice the
//     char/token caps below make true multiplicative *overflow* to Infinity
//     essentially unreachable (the achievable digit budget tops out well
//     under the ~308-digit exponent doubles need) — division by zero is the
//     realistic way to hit this path — but the finiteness check stays as
//     defense in depth regardless of how a non-finite value is reached.
//   - Negative final lengths are returned as-is (negative meters); callers
//     clamp if they need to, this parser stays honest.
//
// Caps (exceeding any of these → null, checked cheaply before/while
// tokenizing so a hostile input never reaches the parser):
const MAX_INPUT_CHARS = 128;
const MAX_TOKENS = 64;
const MAX_PAREN_DEPTH = 8;

export type Unit = 'mm' | 'cm' | 'm';

export interface UnitPrefs {
  unit: Unit;
  /** Digits after the decimal point that `formatLength` renders. */
  decimals: number;
}

const UNIT_TO_M: Record<Unit, number> = { mm: 0.001, cm: 0.01, m: 1 };

/** `-0 -> 0`; every other finite number passes through unchanged. */
function dezero(n: number): number {
  return n === 0 ? 0 : n;
}

/* ---------------- tokenizer ---------------- */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'unit'; unit: Unit }
  | { kind: '+' | '-' | '*' | '/' | '(' | ')' };

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Single-pass lexer. Returns null on any unrecognised character, an unknown
 * unit word, or a cap violation — the parser never has to distinguish "bad
 * syntax" from "bad tokens", both are just null.
 */
function tokenize(src: string): Token[] | null {
  if (src.length > MAX_INPUT_CHARS) return null;
  const tokens: Token[] = [];
  let depth = 0;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(src[j])) j++;
      // A '.' or ',' only joins the number if a digit actually follows it —
      // otherwise it's left for the next token (and will fail there), which
      // is how '5,,5' and '5..5' end up rejected rather than silently
      // truncated.
      if (j < n && (src[j] === '.' || src[j] === ',') && j + 1 < n && isDigit(src[j + 1])) {
        j++;
        while (j < n && isDigit(src[j])) j++;
      }
      const value = Number(src.slice(i, j).replace(',', '.'));
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: 'num', value });
      i = j;
    } else if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && isAlpha(src[j])) j++;
      const word = src.slice(i, j);
      if (word !== 'mm' && word !== 'cm' && word !== 'm') return null; // e.g. 'e' notation, stray words
      tokens.push({ kind: 'unit', unit: word });
      i = j;
    } else if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: c });
      i++;
    } else if (c === '(') {
      depth++;
      if (depth > MAX_PAREN_DEPTH) return null;
      tokens.push({ kind: '(' });
      i++;
    } else if (c === ')') {
      depth--;
      if (depth < 0) return null; // unmatched close — fail fast rather than let the parser untangle it
      tokens.push({ kind: ')' });
      i++;
    } else {
      return null; // unrecognised character (stray '.', ',', letters outside a-zA-Z, etc.)
    }
    if (tokens.length > MAX_TOKENS) return null;
  }
  return tokens;
}

/* ---------------- parser ---------------- */

interface Val {
  /** Meters if `hasUnit`, otherwise a raw (unitless) number. */
  n: number;
  hasUnit: boolean;
}

function addSub(a: Val, b: Val, op: '+' | '-', scalarUnitFactor: number): Val {
  if (a.hasUnit === b.hasUnit) {
    return { n: op === '+' ? a.n + b.n : a.n - b.n, hasUnit: a.hasUnit };
  }
  // Mixed: the scalar side is read AS prefs.unit and converted to meters
  // before combining with the length side (documented contract above).
  const aM = a.hasUnit ? a.n : a.n * scalarUnitFactor;
  const bM = b.hasUnit ? b.n : b.n * scalarUnitFactor;
  return { n: op === '+' ? aM + bM : aM - bM, hasUnit: true };
}

function mul(a: Val, b: Val): Val | null {
  if (a.hasUnit && b.hasUnit) return null; // length*length has no unit — reject
  if (!a.hasUnit && !b.hasUnit) return { n: a.n * b.n, hasUnit: false };
  const length = a.hasUnit ? a : b;
  const scalar = a.hasUnit ? b : a;
  return { n: length.n * scalar.n, hasUnit: true }; // scalar is a pure multiplier
}

function div(a: Val, b: Val): Val | null {
  if (a.hasUnit && b.hasUnit) return { n: a.n / b.n, hasUnit: false }; // ratio
  if (!a.hasUnit && !b.hasUnit) return { n: a.n / b.n, hasUnit: false };
  if (a.hasUnit && !b.hasUnit) return { n: a.n / b.n, hasUnit: true };
  return null; // scalar / length: no sensible result unit — reject
}

/**
 * Recursive-descent evaluator shared by parseLength and parseAngle.
 * `allowUnits=false` (angle mode) simply never consumes a `unit` token in
 * `primary`, so `hasUnit` can never become true and a stray suffix is left
 * dangling — which then fails the "fully consumed" check in `run()`, giving
 * exactly the "suffix -> null" behaviour parseAngle needs for free.
 */
class Parser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly allowUnits: boolean,
    private readonly scalarUnitFactor: number
  ) {}

  run(): Val | null {
    const v = this.expr();
    if (v === null) return null;
    return this.i === this.tokens.length ? v : null; // trailing tokens = syntax error
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private expr(): Val | null {
    let v = this.term();
    if (v === null) return null;
    for (;;) {
      const t = this.peek();
      if (!t || (t.kind !== '+' && t.kind !== '-')) return v;
      this.i++;
      const rhs = this.term();
      if (rhs === null) return null;
      v = addSub(v, rhs, t.kind, this.scalarUnitFactor);
    }
  }

  private term(): Val | null {
    let v = this.factor();
    if (v === null) return null;
    for (;;) {
      const t = this.peek();
      if (!t || (t.kind !== '*' && t.kind !== '/')) return v;
      this.i++;
      const rhs = this.factor();
      if (rhs === null) return null;
      // Explicit annotation: without it, tsc's loop-carried narrowing of `v`
      // (reassigned below from `combined`) makes `combined`'s own inferred
      // type depend on itself and fails with TS7022.
      const combined: Val | null = t.kind === '*' ? mul(v, rhs) : div(v, rhs);
      if (combined === null) return null;
      v = combined;
    }
  }

  private factor(): Val | null {
    const neg = this.peek()?.kind === '-';
    if (neg) this.i++;
    const v = this.primary();
    if (v === null) return null;
    return neg ? { n: -v.n, hasUnit: v.hasUnit } : v;
  }

  private primary(): Val | null {
    const t = this.peek();
    if (!t) return null;
    if (t.kind === '(') {
      this.i++;
      const v = this.expr();
      if (v === null) return null;
      if (this.peek()?.kind !== ')') return null;
      this.i++;
      return v;
    }
    if (t.kind === 'num') {
      this.i++;
      const u = this.peek();
      if (this.allowUnits && u?.kind === 'unit') {
        this.i++;
        return { n: t.value * UNIT_TO_M[u.unit], hasUnit: true };
      }
      return { n: t.value, hasUnit: false };
    }
    return null; // stray operator/unit/close-paren where a value was expected
  }
}

/* ---------------- public API ---------------- */

/** User input -> meters, honouring prefs.unit for bare (unsuffixed) numbers. Never throws. */
export function parseLength(src: string, prefs: UnitPrefs): number | null {
  const tokens = tokenize(src);
  if (!tokens) return null;
  const scalarUnitFactor = UNIT_TO_M[prefs.unit] ?? UNIT_TO_M.mm;
  const v = new Parser(tokens, true, scalarUnitFactor).run();
  if (v === null) return null;
  const meters = v.hasUnit ? v.n : v.n * scalarUnitFactor;
  return Number.isFinite(meters) ? dezero(meters) : null;
}

/** Degrees-in expression -> radians. Same engine as parseLength, but no unit suffixes at all. */
export function parseAngle(src: string): number | null {
  const tokens = tokenize(src);
  if (!tokens) return null;
  const v = new Parser(tokens, false, 1).run();
  if (v === null) return null;
  const rad = (v.n * Math.PI) / 180;
  return Number.isFinite(rad) ? dezero(rad) : null;
}

/** decimals is clamped defensively; canonical UnitPrefs are already sanitized by prefs.ts. */
function clampDecimals(d: number): number {
  if (!Number.isFinite(d)) return 0;
  return Math.min(10, Math.max(0, Math.trunc(d)));
}

/** Rounds to `decimals`, strips trailing zeros and a trailing '.', and normalizes '-0' to '0'. */
function trimNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '0';
  const text = value.toFixed(decimals);
  if (Number(text) === 0) return '0'; // covers '-0', '-0.00', '0.000', …
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** Meters -> display string in prefs.unit, no suffix. */
export function formatLength(m: number, prefs: UnitPrefs): string {
  const factor = UNIT_TO_M[prefs.unit] ?? UNIT_TO_M.mm;
  return trimNumber(m / factor, clampDecimals(prefs.decimals));
}

/** Same as formatLength, with the unit suffix appended (e.g. "1245 mm"). */
export function formatLengthLabel(m: number, prefs: UnitPrefs): string {
  return `${formatLength(m, prefs)} ${prefs.unit}`;
}

/** Radians -> degrees string, no suffix, rounded to 1 decimal with trailing zeros stripped. */
export function formatAngle(rad: number): string {
  return trimNumber((rad * 180) / Math.PI, 1);
}
