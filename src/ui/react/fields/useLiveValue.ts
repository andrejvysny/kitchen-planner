import { useEffect, useRef, type RefObject } from 'react';
import { useAppServices } from '../services';

type Field = HTMLInputElement | HTMLSelectElement;

/**
 * Write into an UNCONTROLLED field, unless the user is in it.
 *
 * The skip is the whole point: src/ui/ui.ts guarded its rebuilds with
 * isEditingVariableName/isEditingRoomName for the same reason — a value pushed
 * into the focused field drops the edit in progress and the caret with it.
 */
function write(el: Field | null, value: string): void {
  if (!el || document.activeElement === el) return;
  if (el.value !== value) el.value = value;
}

/**
 * Mid-gesture refresh: while a drag runs, the Store fires 'change' with
 * `transient: true` at pointer rate and the panels deliberately do NOT
 * re-render (CLAUDE.md: transient notifies skip the props-panel rebuild). A
 * field that shows a dragged value opts into this instead — the replacement
 * for ui.ts's refreshTransientInputs, which reached across the document by
 * `input[data-cls=…]`.
 *
 * `read` may be null (this field is not live): the subscription is made either
 * way, so the hook order never changes, and the callback then does nothing.
 * Consumed by the numeric fields in T4.
 */
export function useLiveValue(ref: RefObject<Field | null>, read: (() => string) | null): void {
  const { bridge } = useAppServices();
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });

  useEffect(() => {
    return bridge.subscribe('transient', () => {
      const fn = latest.current;
      if (fn) write(ref.current, fn());
    });
  }, [bridge, ref]);
}

/**
 * Post-render refresh: keep an uncontrolled field showing the model's value.
 *
 * React sets `defaultValue` on mount only, so without this an undo (or any
 * other outside edit) would leave a stale string in the box — ui.ts got that
 * for free by rebuilding the whole panel's DOM on every 'history'. The effect
 * runs after EVERY render on purpose: the value it mirrors is read live off
 * the design, which is mutated in place and so cannot be a dependency.
 */
export function useSyncedValue(ref: RefObject<Field | null>, value: string): void {
  useEffect(() => {
    write(ref.current, value);
  });
}
