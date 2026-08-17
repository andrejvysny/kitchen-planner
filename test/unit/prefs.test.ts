import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// A plain string constant with no load-time side effects — safe to import
// statically even though the rest of the module is a load-at-import
// singleton the tests below reload via vi.resetModules() + dynamic import.
import { UNIT_PREFS_KEY } from '../../src/model/storageKeys';

// This suite runs in node (no jsdom), like storageKeys.test.ts and
// model.test.ts's "persistence" describe block — stub a minimal Map-backed
// Storage rather than pull in a jsdom dependency.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = fake;
  // prefs.ts is a module-level singleton (like navPref.ts): it reads
  // localStorage once, at import time, into `current`. Reset the module
  // registry so each test gets a fresh singleton that re-reads whichever
  // FakeStorage this test just installed above.
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: FakeStorage }).localStorage;
});

async function loadPrefs() {
  return import('../../src/model/prefs');
}

describe('unitPrefs', () => {
  it('defaults to mm / 0 decimals when nothing is stored', async () => {
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 0 });
  });

  it('defaults when storage is entirely absent (private mode / storage disabled)', async () => {
    delete (globalThis as unknown as { localStorage?: FakeStorage }).localStorage;
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 0 });
  });
});

describe('setUnitPrefs', () => {
  it('updates the in-memory value immediately', async () => {
    const { unitPrefs, setUnitPrefs } = await loadPrefs();
    setUnitPrefs({ unit: 'cm' });
    expect(unitPrefs()).toEqual({ unit: 'cm', decimals: 0 });
  });

  it('patches partially, leaving untouched fields alone', async () => {
    const { unitPrefs, setUnitPrefs } = await loadPrefs();
    setUnitPrefs({ unit: 'm' });
    setUnitPrefs({ decimals: 2 });
    expect(unitPrefs()).toEqual({ unit: 'm', decimals: 2 });
  });

  it('persists across a fresh module load (round-trip through storage)', async () => {
    const { setUnitPrefs } = await loadPrefs();
    setUnitPrefs({ unit: 'cm', decimals: 2 });
    expect(fake.getItem(UNIT_PREFS_KEY)).toBe(JSON.stringify({ unit: 'cm', decimals: 2 }));

    vi.resetModules();
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'cm', decimals: 2 });
  });

  it('ignores storage write failures (quota exceeded, private mode, …)', async () => {
    const { unitPrefs, setUnitPrefs } = await loadPrefs();
    fake.setItem = () => {
      throw new Error('quota exceeded');
    };
    expect(() => setUnitPrefs({ unit: 'm' })).not.toThrow();
    expect(unitPrefs()).toEqual({ unit: 'm', decimals: 0 }); // in-memory value still updates
  });
});

describe('sanitize on read', () => {
  it('falls back to defaults for non-JSON garbage', async () => {
    fake.setItem(UNIT_PREFS_KEY, 'not json{{{');
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 0 });
  });

  it('falls back to defaults for a JSON value that is not an object', async () => {
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify('mm'));
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 0 });
  });

  it('falls back to defaults for null', async () => {
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify(null));
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 0 });
  });

  it('replaces an unknown unit with mm, keeping a valid decimals field', async () => {
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify({ unit: 'furlong', decimals: 2 }));
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'mm', decimals: 2 });
  });

  it('clamps decimals into [0, 3] and truncates non-integers', async () => {
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify({ unit: 'cm', decimals: 99 }));
    const { unitPrefs: highDecimals } = await loadPrefs();
    expect(highDecimals()).toEqual({ unit: 'cm', decimals: 3 });

    vi.resetModules();
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify({ unit: 'cm', decimals: -5 }));
    const { unitPrefs: negDecimals } = await loadPrefs();
    expect(negDecimals()).toEqual({ unit: 'cm', decimals: 0 });

    vi.resetModules();
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify({ unit: 'cm', decimals: 1.9 }));
    const { unitPrefs: fracDecimals } = await loadPrefs();
    expect(fracDecimals()).toEqual({ unit: 'cm', decimals: 1 });
  });

  it('falls back to default decimals when the field is missing or non-numeric', async () => {
    fake.setItem(UNIT_PREFS_KEY, JSON.stringify({ unit: 'm', decimals: 'lots' }));
    const { unitPrefs } = await loadPrefs();
    expect(unitPrefs()).toEqual({ unit: 'm', decimals: 0 });
  });
});

describe('onUnitPrefsChange', () => {
  it('notifies every listener on each change', async () => {
    const { setUnitPrefs, onUnitPrefsChange } = await loadPrefs();
    let a = 0;
    let b = 0;
    onUnitPrefsChange(() => a++);
    onUnitPrefsChange(() => b++);
    setUnitPrefs({ unit: 'cm' });
    expect(a).toBe(1);
    expect(b).toBe(1);
    setUnitPrefs({ decimals: 1 });
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('the returned disposer stops further notifications, and is a no-op if called twice', async () => {
    const { setUnitPrefs, onUnitPrefsChange } = await loadPrefs();
    let calls = 0;
    const off = onUnitPrefsChange(() => calls++);
    setUnitPrefs({ unit: 'cm' });
    expect(calls).toBe(1);
    off();
    setUnitPrefs({ unit: 'm' });
    expect(calls).toBe(1);
    expect(() => off()).not.toThrow();
  });
});
