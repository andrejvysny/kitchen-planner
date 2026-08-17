import type { ReactElement } from 'react';
import { store } from '../../app/bootstrap';
import { hint } from '../shellState';
import { statusInfoText } from '../statusText';
import { useChannel } from './hooks/useStore';

/**
 * The status bar. B2 moved the right-hand summary and the save-failure banner
 * off src/ui/ui.ts (updateInfo + its 'savefail' handler) into the components
 * below; the hint on the left now reads the shell singleton. <StatusBar/>
 * itself holds no state, so it renders once.
 */
export function StatusBar(): ReactElement {
  return (
    <footer id="statusbar">
      <StatusHint />
      <SaveFailWarning />
      <span className="statusbar-spacer"></span>
      <StatusInfo />
    </footer>
  );
}

/**
 * Transient one-liner: what the armed tool expects next, or the outcome of the
 * last command. Every writer — Plan2D's hint callback, the export handlers,
 * ui.ts — goes through shellState.setHint, so this is the only thing that
 * touches the element.
 */
function StatusHint(): ReactElement {
  useChannel('shell');
  return <span id="status-hint">{hint()}</span>;
}

/**
 * Persistent, unlike a hint: it stays lit across unrelated status messages
 * until a save succeeds again. The Store keeps the flag (`savingFailed()`) and
 * emits 'savefail' only on an ok↔fail transition.
 */
function SaveFailWarning(): ReactElement {
  useChannel('savefail');
  return (
    <span id="status-savefail" className="statusbar-warn" hidden={!store.savingFailed()}>
      ⚠ Changes are NOT being saved — storage full or blocked
    </span>
  );
}

/**
 * Item/area/room/issue counts. ui.ts refreshed these on 'history', on
 * 'activeRoom' and on EVERY 'change' including a mid-drag transient one, so the
 * live area readout follows a drag — 'transient' is the channel that carries
 * both halves of that (a settled change bumps it too, see storeBridge.ts).
 */
function StatusInfo(): ReactElement {
  useChannel('transient');
  useChannel('history');
  useChannel('activeRoom');
  return <span id="status-info">{statusInfoText(store)}</span>;
}
