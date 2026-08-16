import type { ReactElement } from 'react';

/**
 * The right-hand properties panel — an empty shell, exactly as index.html had
 * it. src/ui/ui.ts renders the whole selection-driven form into #props-inner.
 */
export function PropsPanel(): ReactElement {
  return (
    <aside id="props">
      <div id="props-inner"></div>
    </aside>
  );
}
