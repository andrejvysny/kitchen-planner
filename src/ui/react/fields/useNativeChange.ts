import { useEffect, useRef, type RefObject } from 'react';

/**
 * THE COMMIT RULE, and the only sanctioned way a field commits.
 *
 * React's `onChange` is NOT the DOM's change event: for text, number and range
 * inputs React wires it to `input`, which fires on every keystroke. Committing
 * there would push one undo step per character. The DOM's own `change` fires
 * once, when the edit is finished (blur, Enter, a picker's confirm) — exactly
 * the gesture end that `store.commit()` is defined for (see CLAUDE.md: undo is
 * a JSON snapshot taken at commit).
 *
 * So every field attaches its commit here, natively, and eslint.config.js bans
 * `onChange` on <input>/<select> under src/ui/react/fields/** and props/**.
 * SliderRow is the one sanctioned exception — a slider genuinely wants the
 * live input event, and it still commits through this hook.
 *
 * `fn` is read through a ref, so passing an inline arrow (the normal case)
 * does not tear down and re-attach the listener on every render.
 */
export function useNativeChange<T extends HTMLElement>(
  ref: RefObject<T | null>,
  fn: (el: T) => void
): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = (): void => latest.current(el);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [ref]);
}
