import { useState, type ReactElement } from 'react';
import { workspace } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { useAppServices, useStore } from './services';

/**
 * The two control clusters WS-SPEC §2.3 took off the top bar and put on the
 * canvases themselves: which panes are showing, and how the 3D scene is lit and
 * posed. Both steer the drawing rather than the document, so they belong over
 * the drawing — and the bar keeps only the file/workspace level.
 *
 * Both live HERE rather than inline in <Workspace/> for the reason its doc
 * comment gives: that component must stay stateless and never reconcile, so
 * anything holding a subscription arrives as a child that holds its own. Both
 * return null outside the Plan/Furnish workspaces, where a workspace pane
 * covers the canvases (`.workspace-pane`, z-index 30, above `.canvas-overlay`'s
 * 20) and these controls would steer something nobody can see.
 */

type ViewMode = '2d' | 'split' | '3d';

/**
 * `.hidden` on the panes is the TRUTH, not this component's state: the overlay
 * unmounts on a workspace switch, so the mode has to be read back off the DOM
 * on mount instead of assuming 'split' and lying about a hidden pane.
 */
function readViewMode(): ViewMode {
  if (document.getElementById('pane2d')?.classList.contains('hidden')) return '3d';
  if (document.getElementById('pane3d')?.classList.contains('hidden')) return '2d';
  return 'split';
}

/**
 * 2D / Split / 3D, centred over #canvases. The buttons' own `.active` class is
 * React's; the panes stay imperative because the 2D/elev sub-toggle
 * (Workspace.tsx) writes `.elev-mode` on the same class list — so `pick` is the
 * old setView, unchanged, minus the part React now renders.
 */
export function ViewOverlay(): ReactElement | null {
  const { view3d } = useAppServices();
  useChannel('workspace');
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const ws = workspace();

  const pick = (next: ViewMode): void => {
    document.getElementById('pane2d')!.classList.toggle('hidden', next === '3d');
    document.getElementById('pane3d')!.classList.toggle('hidden', next === '2d');
    view3d.setActive(next !== '2d'); // a hidden 3D pane renders nothing
    setMode(next);
  };

  const cls = (m: ViewMode): string | undefined => (mode === m ? 'active' : undefined);

  if (ws !== 'plan' && ws !== 'furnish') return null;

  return (
    <div className="canvas-overlay canvas-overlay-top">
      <div className="canvas-overlay-group" id="view-toggle">
        <button
          data-view="2d"
          className={cls('2d')}
          title="2D floor plan only"
          onClick={() => pick('2d')}
        >
          2D
        </button>
        <button
          data-view="split"
          className={cls('split')}
          title="2D + 3D side by side"
          onClick={() => pick('split')}
        >
          Split
        </button>
        <button
          data-view="3d"
          className={cls('3d')}
          title="3D view only"
          onClick={() => pick('3d')}
        >
          3D
        </button>
      </div>
    </div>
  );
}

/**
 * Day/night and the open-front pose, in the corner of #pane3d — both only
 * change what that pane draws. Two toggles, two sources: night is design data
 * (committed, so it lands on 'history'), the pose is ephemeral view state on
 * the 'pose' channel, never in the Design and never in an undo step.
 */
export function SceneOverlay(): ReactElement | null {
  const store = useStore();
  useChannel('history');
  useChannel('pose');
  useChannel('workspace');
  const ws = workspace();

  const night = store.design.scene.night;

  const toggleNight = (): void => {
    store.setNight(!store.design.scene.night);
    store.commit();
  };

  if (ws !== 'plan' && ws !== 'furnish') return null;

  return (
    <div className="canvas-overlay canvas-overlay-scene">
      <div className="canvas-overlay-group">
        <button id="btn-daynight" title="Toggle day / night" onClick={toggleNight}>
          {night ? '☾ Night' : '☀ Day'}
        </button>
        <button
          id="btn-openfronts"
          className={store.openFronts.allOpen ? 'active' : undefined}
          title="Preview all doors and drawers open (3D only, never saved)"
          onClick={() => store.openFronts.setAll(!store.openFronts.allOpen)}
        >
          Open fronts
        </button>
      </div>
    </div>
  );
}
