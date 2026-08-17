/**
 * Commit counters for the React shell — a TEST SEAM, in the same spirit as
 * `Store.handlerCount()` and Plan2D's `debug().drawCount`.
 *
 * The invariant they exist to police: a gesture that fires `change` with
 * `transient: true` at pointer rate must not re-render the properties
 * inspector. That is not observable from the DOM (the values in the boxes are
 * the same either way — the live fields write them imperatively), so the only
 * honest assertion is "the component did not commit", and that needs a number
 * the page can hand out. e2e/transient-perf.spec.ts reads it through
 * `window.__kp.debug.renderCounts`.
 *
 * Counted from a `useEffect` with no dependency array, so one tick here is one
 * COMMITTED render — a render React threw away never lands.
 */

export const renderCounts: Record<string, number> = {};

export function countRender(name: string): void {
  renderCounts[name] = (renderCounts[name] ?? 0) + 1;
}
