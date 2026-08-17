import type { ReactElement } from 'react';

/**
 * The Output workspace's sidebar: a caption. The real document picker (cut
 * list / shopping list / print sheet cards) lands in the main pane in WP 1.8
 * — this is the minimal Phase-1 stand-in so the sidebar swaps cleanly per
 * workspace ahead of that.
 */
export function OutputDocsPanel(): ReactElement {
  return (
    <div id="output-docs">
      <p className="cat-empty">Choose a document</p>
    </div>
  );
}
