import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Plain string constant, no load-time side effects — safe to import statically
// even though onboarded.ts itself is a load-at-import singleton the tests below
// reload via vi.resetModules() + dynamic import.
import { ONBOARDED_KEY } from '../../src/model/storageKeys';
import { SHORTCUTS, SHORTCUT_GROUPS } from '../../src/ui/shortcuts';

// Runs in node (no jsdom), like workspaceState.test.ts / prefs.test.ts — stub a
// minimal Map-backed Storage rather than pull in a jsdom dependency.
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

/** Storage that throws on every access — private mode, or a blocked origin. */
class HostileStorage {
  getItem(): string | null {
    throw new Error('storage disabled');
  }
  setItem(): void {
    throw new Error('storage disabled');
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = fake;
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

async function loadOnboarded() {
  return import('../../src/ui/onboarded');
}

describe('onboarded flag', () => {
  it('is false on a profile that has never run the app', async () => {
    const { onboarded } = await loadOnboarded();
    expect(onboarded()).toBe(false);
  });

  it('setOnboarded flips it and persists under ONBOARDED_KEY', async () => {
    const { onboarded, setOnboarded } = await loadOnboarded();
    setOnboarded();
    expect(onboarded()).toBe(true);
    expect(fake.getItem(ONBOARDED_KEY)).toBe('1');
  });

  it('is idempotent — calling it twice changes nothing', async () => {
    const { onboarded, setOnboarded } = await loadOnboarded();
    setOnboarded();
    setOnboarded();
    expect(onboarded()).toBe(true);
    expect(fake.getItem(ONBOARDED_KEY)).toBe('1');
  });

  it('reads true from a stored value on the next boot', async () => {
    fake.setItem(ONBOARDED_KEY, '1');
    const { onboarded } = await loadOnboarded();
    expect(onboarded()).toBe(true);
  });

  it('any stored value counts — the KEY is the flag, not its contents', async () => {
    fake.setItem(ONBOARDED_KEY, '');
    const { onboarded } = await loadOnboarded();
    expect(onboarded()).toBe(true);
  });

  it('storage that throws reads as ONBOARDED, and writing is best-effort', async () => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = new HostileStorage();
    const { onboarded, setOnboarded } = await loadOnboarded();
    // never replay the tour on every boot for someone who can never dismiss it
    expect(onboarded()).toBe(true);
    expect(() => setOnboarded()).not.toThrow();
  });
});

// src/ui/shortcuts.ts — the cheatsheet's content. Nothing derives it, so these
// are the only guards against an entry that renders as a blank row or lands in
// a group the sheet never draws.
describe('SHORTCUTS', () => {
  it('is non-empty and every entry is fully filled in', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of SHORTCUTS) {
      expect(s.keys.trim()).not.toBe('');
      expect(s.does.trim()).not.toBe('');
    }
  });

  it('every entry lands in one of the four rendered groups', () => {
    for (const s of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(s.group);
  });

  it('every group has at least one entry — no empty heading', () => {
    for (const g of SHORTCUT_GROUPS) {
      expect(SHORTCUTS.some((s) => s.group === g)).toBe(true);
    }
  });

  it('rows are unique, so the sheet can key on keys+does', () => {
    const seen = SHORTCUTS.map((s) => `${s.keys}|${s.does}`);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
