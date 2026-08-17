import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// A plain string constant with no load-time side effects — safe to import
// statically even though the rest of the module is a load-at-import
// singleton the tests below reload via vi.resetModules() + dynamic import.
import { WORKSPACE_KEY } from '../../src/model/storageKeys';

// This suite runs in node (no jsdom), like prefs.test.ts and
// storageKeys.test.ts — stub a minimal Map-backed Storage rather than pull
// in a jsdom dependency.
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
  keys(): string[] {
    return [...this.map.keys()];
  }
}

let fake: FakeStorage;

beforeEach(() => {
  fake = new FakeStorage();
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = fake;
  // workspaceState.ts is a module-level singleton (like prefs.ts): it reads
  // localStorage once, at import time, into `current`. Reset the module
  // registry so each test gets a fresh singleton that re-reads whichever
  // FakeStorage this test just installed above.
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: FakeStorage }).localStorage;
});

async function loadWorkspaceState() {
  return import('../../src/ui/workspaceState');
}

describe('workspace', () => {
  it('defaults to furnish when nothing is stored', async () => {
    const { workspace } = await loadWorkspaceState();
    expect(workspace()).toBe('furnish');
  });

  it('defaults to furnish for garbage values', async () => {
    fake.setItem(WORKSPACE_KEY, 'banana');
    const { workspace: withBanana } = await loadWorkspaceState();
    expect(withBanana()).toBe('furnish');

    vi.resetModules();
    fake.setItem(WORKSPACE_KEY, '{}');
    const { workspace: withObject } = await loadWorkspaceState();
    expect(withObject()).toBe('furnish');
  });

  it('defaults to furnish when getItem throws (private mode / storage disabled)', async () => {
    fake.getItem = () => {
      throw new Error('storage disabled');
    };
    const { workspace } = await loadWorkspaceState();
    expect(workspace()).toBe('furnish');
  });
});

describe('setWorkspace', () => {
  it('persists and round-trips through a fresh module import', async () => {
    const { setWorkspace } = await loadWorkspaceState();
    setWorkspace('plan');
    expect(fake.getItem(WORKSPACE_KEY)).toBe('plan');

    vi.resetModules();
    const { workspace } = await loadWorkspaceState();
    expect(workspace()).toBe('plan');
  });

  it('setting the same id is a no-op: no emit', async () => {
    const { workspace, setWorkspace, onWorkspaceChange } = await loadWorkspaceState();
    expect(workspace()).toBe('furnish');
    let calls = 0;
    onWorkspaceChange(() => calls++);
    setWorkspace('furnish');
    expect(calls).toBe(0);
  });

  it('ignores persistence failures and still updates the in-memory value', async () => {
    const { workspace, setWorkspace } = await loadWorkspaceState();
    fake.setItem = () => {
      throw new Error('quota exceeded');
    };
    expect(() => setWorkspace('output')).not.toThrow();
    expect(workspace()).toBe('output');
  });
});

describe('openInWorkshop', () => {
  it('from furnish: switches to workshop, sets target, one emit total', async () => {
    const { workspace, workshopTarget, openInWorkshop, onWorkspaceChange } =
      await loadWorkspaceState();
    let calls = 0;
    onWorkspaceChange(() => calls++);
    openInWorkshop('base-cabinet');
    expect(workspace()).toBe('workshop');
    expect(workshopTarget()).toEqual({
      defId: 'base-cabinet',
      itemId: undefined,
      returnTo: 'furnish',
    });
    expect(calls).toBe(1);
  });

  it('while already in workshop, keeps the previous returnTo', async () => {
    const { workspace, workshopTarget, setWorkspace, openInWorkshop } = await loadWorkspaceState();
    setWorkspace('plan');
    openInWorkshop('base-cabinet');
    expect(workshopTarget()?.returnTo).toBe('plan');

    openInWorkshop('wall-cabinet', 'item-1');
    expect(workspace()).toBe('workshop');
    expect(workshopTarget()).toEqual({ defId: 'wall-cabinet', itemId: 'item-1', returnTo: 'plan' });
  });

  it('with no previous target, returnTo falls back to furnish when already in workshop', async () => {
    const { workspace, setWorkspace, workshopTarget, clearWorkshopTarget, openInWorkshop } =
      await loadWorkspaceState();
    // Force into 'workshop' without a target set (simulating a stale state).
    setWorkspace('plan');
    openInWorkshop(null);
    clearWorkshopTarget();
    expect(workspace()).toBe('workshop');
    expect(workshopTarget()).toBeNull();

    openInWorkshop('pantry');
    expect(workshopTarget()).toEqual({ defId: 'pantry', itemId: undefined, returnTo: 'furnish' });
  });
});

describe('setWorkspace leaving workshop', () => {
  it('clears the target with a single emit', async () => {
    const { workshopTarget, setWorkspace, openInWorkshop, onWorkspaceChange } =
      await loadWorkspaceState();
    openInWorkshop('base-cabinet');
    let calls = 0;
    onWorkspaceChange(() => calls++);
    setWorkspace('plan');
    expect(workshopTarget()).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('clearWorkshopTarget', () => {
  it('emits only when a target was set', async () => {
    const { clearWorkshopTarget, openInWorkshop, onWorkspaceChange } = await loadWorkspaceState();
    let calls = 0;
    onWorkspaceChange(() => calls++);

    clearWorkshopTarget(); // no target yet
    expect(calls).toBe(0);

    openInWorkshop('base-cabinet');
    calls = 0;
    clearWorkshopTarget();
    expect(calls).toBe(1);

    clearWorkshopTarget(); // already null
    expect(calls).toBe(1);
  });
});

describe('onWorkspaceChange', () => {
  it('the returned disposer stops further notifications, and is a no-op if called twice', async () => {
    const { setWorkspace, onWorkspaceChange } = await loadWorkspaceState();
    let calls = 0;
    const off = onWorkspaceChange(() => calls++);
    setWorkspace('plan');
    expect(calls).toBe(1);
    off();
    setWorkspace('output');
    expect(calls).toBe(1);
    expect(() => off()).not.toThrow();
  });
});

describe('persistence scope', () => {
  it('workshopTarget is never written to localStorage', async () => {
    const { openInWorkshop, setWorkspace } = await loadWorkspaceState();
    openInWorkshop('base-cabinet', 'item-1');
    setWorkspace('plan');
    openInWorkshop('wall-cabinet');
    expect(fake.keys()).toEqual([WORKSPACE_KEY]);
  });
});
