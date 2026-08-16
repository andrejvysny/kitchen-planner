import { memo, type ReactElement } from 'react';
import { store } from '../../app/bootstrap';
import { statusInfoText } from '../statusText';
import { useChannel } from './hooks/useStore';

/**
 * The status bar. B2 moved the right-hand summary and the save-failure banner
 * off src/ui/ui.ts (updateInfo + its 'savefail' handler) into the components
 * below; the hint on the left is still written imperatively and stays legacy
 * until B5. <StatusBar/> itself holds no state, so it renders once.
 */
export function StatusBar(): ReactElement {
  return (
    <footer id="statusbar">
      <LegacyStatusHint />
      <SaveFailWarning />
      <span className="statusbar-spacer"></span>
      <StatusInfo />
    </footer>
  );
}

/**
 * B5 EXPIRY: #status-hint is written by Plan2D's hint callback (see
 * src/app/bootstrap.ts) and by ui.ts. No props, so React never re-renders it
 * and can never wipe the text back to empty.
 */
const LegacyStatusHint = memo(function LegacyStatusHint(): ReactElement {
  return <span id="status-hint"></span>;
});

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
