import type { Store } from '../../model/store';
import type { EditorState } from '../../editor/editorState';
import { onUnitPrefsChange } from '../../model/prefs';
import { onDrawHudChange } from '../drawHud';
import { onPlaceHudChange } from '../placeHud';
import { onShellChange } from '../shellState';
import { onWorkspaceChange } from '../workspaceState';

/**
 * StoreBridge — the one adapter between the mutable app state (Store +
 * EditorState) and React's `useSyncExternalStore`.
 *
 * THE RULE: a `getSnapshot` fed to useSyncExternalStore must return the NUMBER
 * from `getVersion(channel)` — never an object, never a derived selector. The
 * Design is mutated IN PLACE, so object identity is meaningless here: a
 * selector would either compare equal after a real change (stale UI) or build a
 * fresh object every call (infinite render loop). Read the version to decide
 * WHETHER to re-render, then read `store.design` directly during render.
 *
 * Channels are split so a drag (which fires `change` at ~60 Hz with
 * `transient: true`) only wakes the components that opted into 'transient',
 * while the panels that cost real work stay on 'design'.
 *
 * Five upstreams feed them: the Store (design + selection + history…), the
 * EditorState ('editor'), the shell singleton ('shell' — hint text and the
 * catalog drawer), the length-unit preference ('units' — which unit every
 * length field shows and parses) and the workspace singleton ('workspace' —
 * which of the four task workspaces is showing, and the Workshop's target).
 * The last three are module state rather than instances, so they take no
 * constructor argument; their disposers are held like the others.
 */

export type Channel =
  | 'design'
  | 'transient'
  | 'selection'
  | 'history'
  | 'pose'
  | 'activeRoom'
  | 'savefail'
  | 'editor'
  | 'shell'
  | 'units'
  | 'workspace'
  | 'draw';

const CHANNELS: readonly Channel[] = [
  'design',
  'transient',
  'selection',
  'history',
  'pose',
  'activeRoom',
  'savefail',
  'editor',
  'shell',
  'units',
  'workspace',
  'draw',
];

export class StoreBridge {
  private subs = new Map<Channel, Set<() => void>>();
  private versions = new Map<Channel, number>();
  private disposers: (() => void)[] = [];

  constructor(store: Store, editor: EditorState) {
    for (const ch of CHANNELS) {
      this.subs.set(ch, new Set());
      this.versions.set(ch, 0);
    }

    this.disposers.push(
      store.on('change', (info) => {
        // a mid-gesture change is transient-only; a settled one is both, so a
        // component watching 'transient' never misses the final state
        if (info.transient) this.bump('transient');
        else {
          this.bump('design');
          this.bump('transient');
        }
      }),
      editor.subscribeSelection(() => this.bump('selection')),
      store.on('history', () => this.bump('history')),
      store.on('pose', () => this.bump('pose')),
      store.on('activeRoom', () => this.bump('activeRoom')),
      store.on('savefail', () => this.bump('savefail')),
      editor.subscribe(() => this.bump('editor')),
      onShellChange(() => this.bump('shell')),
      onUnitPrefsChange(() => this.bump('units')),
      onWorkspaceChange(() => this.bump('workspace')),
      // pointer-rate, hence its own channel: only <DrawHud/> may re-render on it
      onDrawHudChange(() => this.bump('draw')),
      // <PlaceHud/>'s sibling producer — see src/ui/placeHud.ts — shares it:
      // the two are mutually exclusive by construction, never live at once
      onPlaceHudChange(() => this.bump('draw'))
    );
  }

  /** Returns a disposer that unsubscribes `fn` — same contract as `Store.on`. */
  subscribe(ch: Channel, fn: () => void): () => void {
    const set = this.subs.get(ch)!;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Monotonic per channel. This — and only this — is a valid getSnapshot. */
  getVersion(ch: Channel): number {
    return this.versions.get(ch)!;
  }

  /** Drop every upstream subscription. Subscribers are dropped too: a disposed bridge is inert. */
  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    for (const set of this.subs.values()) set.clear();
  }

  private bump(ch: Channel): void {
    this.versions.set(ch, this.versions.get(ch)! + 1);
    // snapshot: a subscriber that unsubscribes mid-dispatch must not skip a sibling
    for (const fn of [...this.subs.get(ch)!]) fn();
  }
}
