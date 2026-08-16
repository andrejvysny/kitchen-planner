import type { ReactElement } from 'react';

/**
 * The top bar, ported node-for-node from index.html.
 *
 * Every button is still WIRED by src/ui/ui.ts, which finds it by id or by
 * `data-*` attribute — this component only renders the shell, so ids, classes,
 * attribute values and order are the contract (e2e/dom-contract.spec.ts pins
 * them). No handlers, no state: React never re-renders this subtree, which is
 * what lets ui.ts mutate labels and `.active` classes in place.
 */
export function Topbar(): ReactElement {
  return (
    <header id="topbar">
      <div className="brand">
        <span className="brand-mark">▦</span>
        <span className="brand-name">Interior Planner</span>
      </div>
      <button id="btn-catalog" title="Show / hide the catalog">
        ☰
      </button>
      <div className="topbar-group" id="view-toggle">
        <button data-view="2d" title="2D floor plan only">
          2D
        </button>
        <button data-view="split" className="active" title="2D + 3D side by side">
          Split
        </button>
        <button data-view="3d" title="3D view only">
          3D
        </button>
      </div>
      <div className="topbar-group">
        <button id="btn-undo" title="Undo (Ctrl+Z)">
          ↩
        </button>
        <button id="btn-redo" title="Redo (Ctrl+Y)">
          ↪
        </button>
      </div>
      <div className="topbar-group">
        <button id="btn-daynight" title="Toggle day / night">
          ☀ Day
        </button>
        <button
          id="btn-openfronts"
          title="Preview all doors and drawers open (3D only, never saved)"
        >
          Open fronts
        </button>
      </div>
      <div className="topbar-group" id="navinput-group" hidden>
        <button id="btn-navinput" title="How to read the scroll wheel">
          Nav: Auto
        </button>
      </div>
      <div className="topbar-spacer"></div>
      <div className="topbar-group">
        <button id="btn-new" title="Start a new empty design">
          New
        </button>
        <button id="btn-save" title="Download design as JSON">
          Save
        </button>
        <button id="btn-load" title="Load design from JSON">
          Load
        </button>
        <button id="btn-png" title="Export 3D snapshot as PNG">
          Snapshot
        </button>
        <button id="btn-glb" title="Export the modelled interior as .glb for Blender">
          Blender
        </button>
        <div className="topbar-menu-wrap">
          <button id="btn-export" title="Cut list, shopping list and printable sheets">
            Export ▾
          </button>
          <div id="export-menu" className="topbar-menu">
            <button data-export="cut">Cut list (CSV)</button>
            <button data-export="buy">Shopping list (CSV)</button>
            <button data-export="sheet">Printable sheet…</button>
            <button data-export="plan">Plan sheet…</button>
          </div>
        </div>
        <input type="file" id="file-input" accept=".json,application/json" hidden />
        <input type="file" id="underlay-input" accept="image/*" hidden />
      </div>
    </header>
  );
}
