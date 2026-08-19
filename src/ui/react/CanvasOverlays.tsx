import { useLayoutEffect, useState, type ReactElement } from 'react';
import type { View3D } from '../../view3d/view3d';
import { formatAngle, formatLength } from '../../model/units';
import { unitPrefs } from '../../model/prefs';
import { drawHud, type DrawField } from '../drawHud';
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
type PaneWorkspace = 'plan' | 'furnish';

/**
 * Plan and Furnish share one set of canvas panes but remember their OWN view
 * mode: Plan starts on 2D (a floor plan doesn't need the 3D pane open by
 * default), Furnish keeps the original Split default. A manual pick during
 * the session stays sticky for that workspace — switching away and back
 * restores it — but nothing is persisted across a reload; only the starting
 * point differs from before.
 */
const viewModeByWs: Record<PaneWorkspace, ViewMode> = { plan: '2d', furnish: 'split' };

function applyViewMode(next: ViewMode, view3d: View3D): void {
  document.getElementById('pane2d')!.classList.toggle('hidden', next === '3d');
  document.getElementById('pane3d')!.classList.toggle('hidden', next === '2d');
  view3d.setActive(next !== '2d'); // a hidden 3D pane renders nothing
}

/**
 * 2D / Split / 3D, centred over #canvases. The buttons' own `.active` class is
 * React's; the panes stay imperative because the 2D/elev sub-toggle
 * (Workspace.tsx) writes `.elev-mode` on the same class list.
 */
export function ViewOverlay(): ReactElement | null {
  const { view3d } = useAppServices();
  useChannel('workspace');
  const ws = workspace();
  const paneWs: PaneWorkspace | null = ws === 'plan' || ws === 'furnish' ? ws : null;
  const [mode, setMode] = useState<ViewMode>(viewModeByWs[paneWs ?? 'plan']);

  // fires on mount and on every workspace switch, restoring that workspace's
  // own last mode (or its default) — before paint, so there is no Split flash
  useLayoutEffect(() => {
    if (!paneWs) return;
    applyViewMode(viewModeByWs[paneWs], view3d);
    setMode(viewModeByWs[paneWs]);
  }, [paneWs, view3d]);

  const pick = (next: ViewMode): void => {
    if (paneWs) viewModeByWs[paneWs] = next;
    applyViewMode(next, view3d);
    setMode(next);
  };

  const cls = (m: ViewMode): string | undefined => (mode === m ? 'active' : undefined);

  if (!paneWs) return null;

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

/**
 * The wall tool's live length/angle readout, floating beside the pending vertex.
 *
 * NOT a form. There is no `<input>` anywhere in it, deliberately: digits reach
 * the tool through the `draw.digit*` commands (src/editor/keyboard/bindings.ts),
 * and a real focused field would trip the `allowWhileTyping` gates that make
 * every other shortcut work. So this renders the buffers as text with a caret
 * and Tab moves between them via `draw.toggleField` — the keyboard path stays
 * exactly as it was, and the box is pure feedback.
 *
 * It rides its own 'draw' bridge channel because it updates at pointer rate.
 * Nothing else subscribes there, so a mouse move re-renders this component and
 * nothing else — in particular not <PropsBody/>, whose committed-render count
 * e2e/transient-perf.spec.ts asserts stays flat through a drag.
 */
export function DrawHud(): ReactElement | null {
  useChannel('draw');
  useChannel('units');
  const hud = drawHud();
  if (!hud) return null;

  const prefs = unitPrefs();
  const box = (field: DrawField, typed: string, live: string, suffix: string): ReactElement => (
    <span className={`draw-hud-field${hud.field === field ? ' active' : ''}`} data-field={field}>
      <span className="draw-hud-value">{typed === '' ? live : typed}</span>
      {typed !== '' && <span className="draw-hud-caret" />}
      <span className="draw-hud-unit">{suffix}</span>
    </span>
  );

  return (
    <div id="draw-hud" style={{ left: `${hud.at.x}px`, top: `${hud.at.y}px` }}>
      {box('length', hud.typedLength, formatLength(hud.length, prefs), prefs.unit)}
      {box('angle', hud.typedAngle, formatAngle(hud.angle), hud.relative ? '°↺' : '°')}
    </div>
  );
}
