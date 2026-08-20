import { describe, expect, it, vi } from 'vitest';

/**
 * src/ui/partstudio/studioTab.ts — the Part Studio's Simple/Advanced flag
 * (WS-SPEC WP 3.3). The panel it filters is imperative DOM and belongs to the
 * e2e suite (e2e/studio-tabs.spec.ts); what is testable in plain node is the
 * one property that makes it a SESSION flag and not a preference: it survives
 * every switch inside a module's life and starts over with a fresh one.
 *
 * `vi.resetModules()` + dynamic import is the reload, exactly as in
 * prefs.test.ts / onboarded.test.ts. Note there is no FakeStorage here, and
 * that is the assertion: a tab is not persisted, so the module must never
 * reach for `localStorage` — under node it would throw if it did.
 */

const load = (): Promise<typeof import('../../src/ui/partstudio/studioTab')> =>
  import('../../src/ui/partstudio/studioTab');

describe('studioTab', () => {
  it('starts on Simple — the novice view is the default', async () => {
    vi.resetModules();
    const { studioTab } = await load();
    expect(studioTab()).toBe('simple');
  });

  it('holds the choice for the rest of the session', async () => {
    vi.resetModules();
    const { studioTab, setStudioTab } = await load();
    setStudioTab('advanced');
    expect(studioTab()).toBe('advanced');
    // …and a second reader of the same module sees it: this is what lets the
    // studio be torn down and rebuilt on the next part without losing the tab
    const again = await load();
    expect(again.studioTab()).toBe('advanced');
    setStudioTab('simple');
    expect(again.studioTab()).toBe('simple');
  });

  it('is back on Simple after a reload — nothing was persisted', async () => {
    vi.resetModules();
    const first = await load();
    first.setStudioTab('advanced');
    expect(first.studioTab()).toBe('advanced');

    vi.resetModules();
    const second = await load();
    expect(second.studioTab()).toBe('simple');
  });
});
