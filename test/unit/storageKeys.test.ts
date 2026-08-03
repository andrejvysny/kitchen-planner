import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESIGN_KEY, LEGACY_DESIGN_KEYS, readKey } from '../../src/model/storageKeys';

// This suite runs in node (no jsdom), so `localStorage` is not a global —
// stub a minimal Map-backed Storage for readKey to read/write, and remove it
// afterwards so other suites see the same environment they always have.
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = fake;
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: FakeStorage }).localStorage;
});

describe('readKey', () => {
  it('prefers the primary key when it is present', () => {
    fake.setItem('primary', 'p');
    fake.setItem('legacy-a', 'a');
    expect(readKey('primary', ['legacy-a'])).toBe('p');
  });

  it('consults legacy keys in declared order when the primary is absent', () => {
    fake.setItem('legacy-b', 'b');
    // only the second legacy key has a value — the first is checked and misses
    expect(readKey('primary', ['legacy-a', 'legacy-b'])).toBe('b');
    fake.setItem('legacy-a', 'a');
    // now the first legacy key wins over the second, per declared order
    expect(readKey('primary', ['legacy-a', 'legacy-b'])).toBe('a');
  });

  it('returns null when nothing is stored under any key', () => {
    expect(readKey('primary', ['legacy-a', 'legacy-b'])).toBeNull();
  });

  it('round-trips a write through the primary key', () => {
    const payload = JSON.stringify({ version: 6 });
    fake.setItem('primary', payload);
    expect(readKey('primary', [])).toBe(payload);
  });

  it('works with the real design key + its legacy fallback', () => {
    fake.setItem(LEGACY_DESIGN_KEYS[0], 'legacy-design');
    expect(readKey(DESIGN_KEY, LEGACY_DESIGN_KEYS)).toBe('legacy-design');
    fake.setItem(DESIGN_KEY, 'current-design');
    expect(readKey(DESIGN_KEY, LEGACY_DESIGN_KEYS)).toBe('current-design');
  });
});
