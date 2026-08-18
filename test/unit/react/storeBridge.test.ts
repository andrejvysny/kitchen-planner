import { afterEach, describe, expect, it } from 'vitest';
import { makeRoom } from '../../../src/model/rooms';
import { emptyDesign, Store } from '../../../src/model/store';
import { EditorState } from '../../../src/editor/editorState';
import { StoreBridge, type Channel } from '../../../src/ui/react/storeBridge';
import { setCatalogOpen, setHint } from '../../../src/ui/shellState';

// src/ui/react/storeBridge.ts — the Store/EditorState/shell → React adapter.
// Pure plumbing: no DOM, no React, so it runs in plain node like the rest of
// test/unit. What is pinned here is the version bookkeeping every
// useSyncExternalStore subscription depends on.

const ALL: readonly Channel[] = [
  'design',
  'transient',
  'selection',
  'history',
  'pose',
  'activeRoom',
  'savefail',
  'editor',
  'shell',
];

function setup(): { store: Store; editor: EditorState; bridge: StoreBridge } {
  const store = new Store(emptyDesign());
  const editor = new EditorState();
  return { store, editor, bridge: new StoreBridge(store, editor) };
}

/** Snapshot of every channel's version, for asserting what did NOT move. */
function versions(bridge: StoreBridge): Record<Channel, number> {
  return Object.fromEntries(ALL.map((ch) => [ch, bridge.getVersion(ch)])) as Record<
    Channel,
    number
  >;
}

/** Channels whose version differs between two snapshots. */
function moved(a: Record<Channel, number>, b: Record<Channel, number>): Channel[] {
  return ALL.filter((ch) => a[ch] !== b[ch]);
}

let restoreStorage: (() => void) | null = null;
afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
});

/** Make every localStorage write throw, so autosave() flips the savefail flag. */
function breakStorage(): void {
  const g = globalThis as unknown as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const prev = g.localStorage;
  g.localStorage = {
    setItem() {
      throw new Error('quota');
    },
    getItem() {
      return null;
    },
    removeItem() {},
  };
  restoreStorage = () => {
    if (had) g.localStorage = prev;
    else delete g.localStorage;
  };
}

describe('StoreBridge', () => {
  it('every channel starts at 0', () => {
    const { bridge } = setup();
    for (const ch of ALL) expect(bridge.getVersion(ch)).toBe(0);
  });

  it('a settled change bumps design AND transient', () => {
    const { store, bridge } = setup();
    const before = versions(bridge);

    store.notify({ structural: true, transient: false });

    expect(moved(before, versions(bridge)).sort()).toEqual(['design', 'transient']);
    expect(bridge.getVersion('design')).toBe(1);
    expect(bridge.getVersion('transient')).toBe(1);
  });

  it('a transient change never bumps design', () => {
    const { store, bridge } = setup();
    const before = versions(bridge);

    store.notify({ structural: false, transient: true });
    store.notify({ structural: false, transient: true });
    store.notify({ structural: false, transient: true });

    expect(moved(before, versions(bridge))).toEqual(['transient']);
    expect(bridge.getVersion('transient')).toBe(3);
    expect(bridge.getVersion('design')).toBe(0);
  });

  it('selection / history / pose / activeRoom / savefail each bump only their own channel', () => {
    const { store, bridge } = setup();

    let before = versions(bridge);
    store.select({ kind: 'none' });
    expect(moved(before, versions(bridge))).toEqual(['selection']);

    // savefail goes first: the store only emits it on an ok↔fail TRANSITION,
    // and commit() below autosaves, which would otherwise flip it mid-test
    before = versions(bridge);
    breakStorage();
    store.autosave(); // ok → failing: exactly one savefail emit
    store.autosave(); // still failing: no transition, no emit
    expect(moved(before, versions(bridge))).toEqual(['savefail']);
    expect(bridge.getVersion('savefail')).toBe(1);

    before = versions(bridge);
    store.design.scene.brightness = 1.5; // commit() no-ops unless something really changed
    store.commit();
    expect(moved(before, versions(bridge))).toEqual(['history']);

    before = versions(bridge);
    store.openFronts.toggle('item_x', 'door-1');
    expect(moved(before, versions(bridge))).toEqual(['pose']);

    // a direct push (not store.addRoom) — this test isolates setActiveRoom's
    // own emit, and addRoom would activate the new room itself first
    store.design.rooms.push(makeRoom({ name: 'R', x: 0, y: 0, w: 4, d: 3 }));

    before = versions(bridge);
    store.setActiveRoom(store.design.rooms[0].id);
    expect(moved(before, versions(bridge))).toEqual(['activeRoom']);
  });

  it('an editor change bumps the editor channel only', () => {
    const { editor, bridge } = setup();
    const before = versions(bridge);

    editor.setTool('place', 'base-cabinet');
    editor.setChecks(true);
    editor.setChecks(true); // no-op upstream, so no bump here either

    expect(moved(before, versions(bridge))).toEqual(['editor']);
    expect(bridge.getVersion('editor')).toBe(2);
  });

  it('a shell change bumps the shell channel only', () => {
    const { bridge } = setup();
    const before = versions(bridge);

    setHint('placed — drag to fine-tune');
    setHint('placed — drag to fine-tune'); // no-op upstream, so no bump here either
    setCatalogOpen(true);
    setCatalogOpen(false);

    expect(moved(before, versions(bridge))).toEqual(['shell']);
    expect(bridge.getVersion('shell')).toBe(3);
  });

  it('notifies subscribers of the bumped channel only', () => {
    const { store, editor, bridge } = setup();
    const seen: Channel[] = [];
    for (const ch of ALL) bridge.subscribe(ch, () => seen.push(ch));

    store.notify({ structural: false, transient: true });
    expect(seen).toEqual(['transient']);

    seen.length = 0;
    editor.setTool('measure');
    expect(seen).toEqual(['editor']);
  });

  it('subscribe returns a disposer that drops exactly its own listener', () => {
    const { store, bridge } = setup();
    const seen: string[] = [];
    const off = bridge.subscribe('selection', () => seen.push('a'));
    bridge.subscribe('selection', () => seen.push('b'));

    off();
    off(); // double-dispose is a no-op
    store.select({ kind: 'none' });

    expect(seen).toEqual(['b']);
    expect(bridge.getVersion('selection')).toBe(1); // the version still moved
  });

  it('dispose() unhooks the store, the editor and the shell, and leaves versions frozen', () => {
    const { store, editor, bridge } = setup();
    let calls = 0;
    bridge.subscribe('design', () => calls++);
    bridge.subscribe('editor', () => calls++);
    bridge.subscribe('shell', () => calls++);

    store.notify({ structural: true, transient: false });
    editor.setTool('room');
    setHint('dispose test');
    expect(calls).toBe(3);

    const before = versions(bridge);
    bridge.dispose();

    store.notify({ structural: true, transient: false });
    store.select({ kind: 'none' });
    editor.setTool('select');
    setHint('after dispose');

    expect(calls).toBe(3);
    expect(versions(bridge)).toEqual(before);
  });

  it('dispose() releases the store subscriptions it took', () => {
    const store = new Store(emptyDesign());
    const editor = new EditorState();
    const base = {
      change: store.handlerCount('change'),
      selection: store.handlerCount('selection'),
      history: store.handlerCount('history'),
      pose: store.handlerCount('pose'),
      activeRoom: store.handlerCount('activeRoom'),
      savefail: store.handlerCount('savefail'),
    };

    const bridge = new StoreBridge(store, editor);
    expect(store.handlerCount('change')).toBe(base.change + 1);

    bridge.dispose();
    bridge.dispose(); // idempotent — must not remove a stranger's handler

    expect({
      change: store.handlerCount('change'),
      selection: store.handlerCount('selection'),
      history: store.handlerCount('history'),
      pose: store.handlerCount('pose'),
      activeRoom: store.handlerCount('activeRoom'),
      savefail: store.handlerCount('savefail'),
    }).toEqual(base);
  });
});
