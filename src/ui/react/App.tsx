/**
 * App — the React root, deliberately EMPTY.
 *
 * Step B0 of the strangler migration only mounts React; every pixel is still
 * drawn by index.html's static markup plus src/ui/ui.ts. Rendering null keeps
 * the DOM byte-identical to the pre-React app, so the whole E2E safety net
 * (test/interact.mjs + e2e/dom-contract.spec.ts) is a real regression gate for
 * the tooling change itself.
 *
 * B1 ports the app frame (topbar / panes / status bar) into components here.
 */
export function App(): null {
  return null;
}
