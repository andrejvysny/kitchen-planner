import type { ReactElement } from 'react';

/**
 * The status bar. #status-hint is written by Plan2D's hint callback (see
 * src/app/bootstrap.ts), #status-info and #status-savefail by src/ui/ui.ts.
 */
export function StatusBar(): ReactElement {
  return (
    <footer id="statusbar">
      <span id="status-hint"></span>
      <span id="status-savefail" className="statusbar-warn" hidden>
        ⚠ Changes are NOT being saved — storage full or blocked
      </span>
      <span className="statusbar-spacer"></span>
      <span id="status-info"></span>
    </footer>
  );
}
