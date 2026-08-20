import { beforeEach, describe, expect, it } from 'vitest';
import {
  confirmDialog,
  dialogPending,
  promptValue,
  resolveDialog,
} from '../../src/ui/dialogService';
import { appDialog, onShellChange } from '../../src/ui/shellState';

/**
 * The state machine behind the app's confirm/prompt (src/ui/dialogService.ts).
 * Runs in node like prefs.test.ts — the service is DOM-free on purpose, so the
 * open/answer contract every caller now awaits is testable without a renderer.
 */

// module singleton: leave no dialog standing for the next test
beforeEach(() => {
  if (dialogPending()) resolveDialog(false);
});

describe('confirmDialog', () => {
  it('publishes the request on the shell and resolves true when accepted', async () => {
    const p = confirmDialog({ title: 'Delete room?', confirmLabel: 'Delete', danger: true });
    expect(appDialog()).toMatchObject({ title: 'Delete room?', danger: true });
    expect(dialogPending()).toBe(true);

    resolveDialog(true);
    await expect(p).resolves.toBe(true);
    expect(appDialog()).toBe(null);
    expect(dialogPending()).toBe(false);
  });

  it('resolves false when cancelled', async () => {
    const p = confirmDialog({ title: 'Start a new design?' });
    resolveDialog(false);
    await expect(p).resolves.toBe(false);
    expect(appDialog()).toBe(null);
  });

  it('notifies shell subscribers on open and on close', () => {
    let n = 0;
    const off = onShellChange(() => n++);
    void confirmDialog({ title: 'x' });
    expect(n).toBe(1);
    resolveDialog(false);
    expect(n).toBe(2);
    off();
  });
});

describe('promptValue', () => {
  const req = {
    title: 'Set the real-world length',
    input: { parse: (raw: string) => ({ ok: true, value: Number(raw) }) as const },
  };

  it('resolves the value the host parsed', async () => {
    const p = promptValue(req);
    expect(appDialog()?.input).toBeTruthy();
    resolveDialog(true, 2.4);
    await expect(p).resolves.toBe(2.4);
  });

  it('resolves null on cancel', async () => {
    const p = promptValue(req);
    resolveDialog(false);
    await expect(p).resolves.toBe(null);
  });

  it('resolves null on an accept with no value — a parse that never ran cannot be a length', async () => {
    const p = promptValue(req);
    resolveDialog(true);
    await expect(p).resolves.toBe(null);
  });
});

describe('one dialog at a time', () => {
  it('a second opener cancels the first, and the second stays live', async () => {
    const first = confirmDialog({ title: 'first' });
    const second = confirmDialog({ title: 'second' });

    await expect(first).resolves.toBe(false);
    expect(appDialog()).toMatchObject({ title: 'second' });

    resolveDialog(true);
    await expect(second).resolves.toBe(true);
  });

  it('resolveDialog with nothing pending is a no-op', () => {
    expect(() => resolveDialog(true)).not.toThrow();
    expect(appDialog()).toBe(null);
  });
});
