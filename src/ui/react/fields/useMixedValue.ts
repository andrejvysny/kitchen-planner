/**
 * Multi-selection support for the numeric fields: what ONE field shows when it
 * stands for several items at once.
 *
 * The core is pure and lives here on its own so test/unit/fields.test.ts can
 * pin it without a DOM (the field components themselves import the app
 * singletons). `value === null` means "nothing to show": either there is no
 * selection at all, or the items disagree — `mixed` tells the two apart, and a
 * field renders the disagreement as an empty box with a '—' placeholder rather
 * than by picking a winner.
 */

export interface MixedValue {
  /** The shared value, or null when there is none (empty selection or mixed). */
  value: number | null;
  /** True only when items disagree — an empty selection is not "mixed". */
  mixed: boolean;
}

/**
 * Object.is, not `===`: two NaN reads are the same non-answer, and calling
 * them "mixed" would flag a field the user cannot fix.
 */
export function mixedValue<T>(items: readonly T[], read: (it: T) => number): MixedValue {
  if (items.length === 0) return { value: null, mixed: false };
  const first = read(items[0]);
  for (let i = 1; i < items.length; i++) {
    if (!Object.is(read(items[i]), first)) return { value: null, mixed: true };
  }
  return { value: first, mixed: false };
}

/**
 * Hook form. A thin wrapper on purpose — the computation is a loop over the
 * current selection, which is cheaper than the memo bookkeeping would be, and
 * memoizing it would need a stable `items` identity the Store deliberately
 * does not provide (the design is mutated in place).
 */
export function useMixedValue<T>(items: readonly T[], read: (it: T) => number): MixedValue {
  return mixedValue(items, read);
}
