import { useEffect, type RefObject } from 'react';

/**
 * Click-away close, shared by every popup in the shell: the two topbar
 * dropdowns (src/ui/react/Topbar.tsx) and the canvas context menu
 * (src/ui/react/ContextMenu.tsx).
 *
 * Pointerdown, not click: it must fire before a menu item's own click — and
 * must NOT close when the press lands inside the menu (the item still needs its
 * click) or on the `anchor` that toggles it (that would fight the toggle).
 * Cleanup keeps a StrictMode double mount from stacking listeners.
 *
 * `close` goes in the deps, so pass a stable callback (a `useState` setter, or
 * a `useCallback`) unless re-subscribing per render is genuinely fine.
 */
export function useMenuDismiss(
  open: boolean,
  close: () => void,
  menu: RefObject<HTMLElement | null>,
  anchor?: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (menu.current?.contains(t)) return;
      if (anchor?.current?.contains(t)) return;
      close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close, menu, anchor]);
}
