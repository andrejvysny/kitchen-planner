import { useCallback, useSyncExternalStore } from 'react';
import { useAppServices } from '../services';
import type { Channel } from '../storeBridge';

/**
 * Subscribe a component to one StoreBridge channel.
 *
 * The return value is the channel's version NUMBER — see THE RULE in
 * storeBridge.ts. It is a re-render ticket, not data: hold it, then read
 * `store`/`view` directly in the render body. A component that depends on two
 * channels calls the hook twice.
 *
 * The bridge comes off the AppServices context, like everything else in this
 * directory — see src/ui/react/services.tsx.
 */
export function useChannel(ch: Channel): number {
  const { bridge } = useAppServices();
  const subscribe = useCallback((fn: () => void) => bridge.subscribe(ch, fn), [bridge, ch]);
  return useSyncExternalStore(subscribe, () => bridge.getVersion(ch));
}
