import { useCallback, useSyncExternalStore } from 'react';
import { bridge } from '../../../app/bootstrap';
import type { Channel } from '../storeBridge';

/**
 * Subscribe a component to one StoreBridge channel.
 *
 * The return value is the channel's version NUMBER — see THE RULE in
 * storeBridge.ts. It is a re-render ticket, not data: hold it, then read
 * `store`/`view` directly in the render body. A component that depends on two
 * channels calls the hook twice.
 *
 * The bridge comes straight from the bootstrap module, like the views in
 * src/ui/react/Workspace.tsx — there is exactly one app, so a provider would
 * only add ceremony.
 */
export function useChannel(ch: Channel): number {
  const subscribe = useCallback((fn: () => void) => bridge.subscribe(ch, fn), [ch]);
  return useSyncExternalStore(subscribe, () => bridge.getVersion(ch));
}
