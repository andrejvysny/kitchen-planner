import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useAppServices, useEditor } from './services';
import type { ToolId } from '../../editor/editorState';
import type { CamPreset } from '../../view3d/view3d';
import { wallLabel } from '../shellState';
import { workspace } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { PropsPanel } from './PropsPanel';
import { Sidebar } from './Sidebar';
import { WorkshopPane } from './WorkshopPane';

/**
 * The workspace row: sidebar, the two canvas panes, properties panel — ported
 * node-for-node from index.html, because ~60 checks in test/interact.mjs drive
 * the app by mouse position and every pixel of this layout is load-bearing
 * (e2e/layout.spec.ts is the gate).
 *
 * The canvases are React's elements now, but the views that draw on them are
 * not: each one gets an effect that hands its element to the view's attach()
 * and detaches on cleanup. That is the whole React↔view seam — a StrictMode
 * double mount runs attach → detach → attach on the SAME element, which every
 * view treats as a no-op (see e2e/lifecycle.spec.ts).
 *
 * These effects run BEFORE the App-level one that attaches the global keyboard
 * map, so a command can never reach a detached view.
 *
 * <Workspace/> must stay STATELESS. #pane2d and #pane3d carry classes written
 * by hand — `.hidden` from the topbar's view toggle, `.elev-mode` from the
 * 2D/elev sub-toggle below — and a re-render here would reconcile `className`
 * back to the literal below. State belongs in the leaf controls.
 *
 * That is also why <WorkshopPane/> — the overlay pane that hosts the Part
 * Studio — is a CHILD holding its own 'workspace' subscription rather than a
 * conditional here: this component renders once and never reconciles it.
 */
export function Workspace(): ReactElement {
  const { plan, elevation, view3d } = useAppServices();
  const planCanvas = useRef<HTMLCanvasElement>(null);
  const elevCanvas = useRef<HTMLCanvasElement>(null);
  const viewCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    plan.attach(planCanvas.current!);
    return () => plan.detach();
  }, [plan]);

  useEffect(() => {
    elevation.attach(elevCanvas.current!);
    return () => elevation.detach();
  }, [elevation]);

  useEffect(() => {
    view3d.attach(viewCanvas.current!);
    return () => view3d.detach();
  }, [view3d]);

  return (
    <main id="workspace">
      <Sidebar />

      <section id="canvases">
        <div id="pane2d" className="pane">
          <canvas id="canvas2d" ref={planCanvas}></canvas>
          <canvas id="canvas-elev" ref={elevCanvas}></canvas>
          <div className="pane-badge" id="badge-plan">
            Floor plan
          </div>
          <div className="pane-badge" id="badge-elev">
            Wall elevation
          </div>
          <Mode2dToggle />
          <ZoomControls />
          <ToolButtons />
          <WallNav />
        </div>
        <div id="pane3d" className="pane">
          <canvas id="canvas3d" ref={viewCanvas}></canvas>
          <div className="pane-badge">3D view</div>
          <CamControls />
        </div>
        <WorkshopPane />
      </section>

      <PropsPanel />
    </main>
  );
}

type Mode2d = 'plan' | 'elev';

/**
 * 2D pane sub-mode: top-down plan vs. front-view wall elevation. React owns the
 * buttons' `.active` class; `.elev-mode` on #pane2d stays imperative because
 * that class list is shared with the topbar's view toggle (`.hidden`), exactly
 * as ui.ts's setMode2d wrote it — the rest of that function is unchanged.
 */
function Mode2dToggle(): ReactElement {
  const { plan, elevation } = useAppServices();
  const [mode, setMode] = useState<Mode2d>('plan');

  const pick = (next: Mode2d): void => {
    document.getElementById('pane2d')!.classList.toggle('elev-mode', next === 'elev');
    elevation.setActive(next === 'elev');
    if (next === 'plan') plan.requestDraw();
    setMode(next);
  };

  const cls = (m: Mode2d): string | undefined => (mode === m ? 'active' : undefined);

  return (
    <div id="mode2d-toggle" className="pane-modes">
      <button
        data-2dmode="plan"
        className={cls('plan')}
        title="Top-down floor plan"
        onClick={() => pick('plan')}
      >
        Plan
      </button>
      <button
        data-2dmode="elev"
        className={cls('elev')}
        title="Front view of one wall"
        onClick={() => pick('elev')}
      >
        Elevation
      </button>
    </div>
  );
}

/**
 * The four plan tools. Three of them are the same single-gesture tool slot, so
 * clicking one arms it and clicking it again drops back to 'select'; ⚠ is a
 * display layer and stays orthogonal. Everything is read off EditorState — the
 * `.active` classes are a projection of it, never a second copy.
 *
 * Which buttons exist follows the workspace (WS-SPEC §4.4): the room tools are
 * Plan's job, measuring and checks belong to arranging too, and in the
 * Workshop/Output workspaces the cluster is covered by an overlay pane — the
 * component returns null there so the DOM stays honest. No cleanup is needed
 * on the buttons that disappear: switchWorkspace already reset the tool.
 */
function ToolButtons(): ReactElement | null {
  const editor = useEditor();
  useChannel('editor');
  useChannel('workspace');
  const ws = workspace();

  const toggle = (t: ToolId) => (): void => editor.setTool(editor.isTool(t) ? 'select' : t);
  const cls = (t: ToolId): string | undefined => (editor.isTool(t) ? 'active' : undefined);

  if (ws === 'workshop' || ws === 'output') return null;

  return (
    <div id="measure-controls">
      {ws === 'plan' && (
        <>
          <button
            id="btn-room"
            className={cls('room')}
            title="Add a room — click in the plan, or hover a wall to attach it"
            onClick={toggle('room')}
          >
            ▧
          </button>
          <button
            id="btn-draw-room"
            className={cls('drawRoom')}
            title="Draw a room — click each corner, click the first again (or Enter) to close"
            onClick={toggle('drawRoom')}
          >
            ✎
          </button>
        </>
      )}
      <button
        id="btn-measure"
        className={cls('measure')}
        title="Measure distances — click two points (snaps to corners, edges & walls)"
        onClick={toggle('measure')}
      >
        📏
      </button>
      <button
        id="btn-checks"
        className={editor.checksOn ? 'active' : undefined}
        title="Show clearance warnings"
        onClick={() => editor.setChecks(!editor.checksOn)}
      >
        ⚠
      </button>
    </div>
  );
}

/**
 * Wall stepping for the elevation sub-mode. The caption comes off shellState —
 * ElevationView's onWallChange callback writes it there (bootstrap.ts) exactly
 * as the status hint works, which is what got the last `document.getElementById`
 * out of the bootstrap.
 */
function WallNav(): ReactElement {
  const { elevation } = useAppServices();
  useChannel('shell');

  return (
    <div id="wall-nav">
      <button id="btn-wall-prev" title="Previous wall" onClick={() => elevation.stepWall(-1)}>
        ‹
      </button>
      <span id="wall-label">{wallLabel()}</span>
      <button id="btn-wall-next" title="Next wall" onClick={() => elevation.stepWall(1)}>
        ›
      </button>
    </div>
  );
}

/** Plan zoom. Pure commands on Plan2D — no state, so this renders once. */
function ZoomControls(): ReactElement {
  const { plan } = useAppServices();
  return (
    <div id="zoom-controls">
      <button id="btn-zoom-in" title="Zoom in" onClick={() => plan.zoomBy(1.25)}>
        +
      </button>
      <button id="btn-zoom-fit" title="Zoom to fit" onClick={() => plan.zoomFit()}>
        ⛶
      </button>
      <button id="btn-zoom-out" title="Zoom out" onClick={() => plan.zoomBy(0.8)}>
        −
      </button>
    </div>
  );
}

/**
 * Camera presets. Which one is lit is view-local state — View3D has no event
 * for it and the camera drifts freely once the user orbits, exactly as the
 * imperative version behaved.
 */
function CamControls(): ReactElement {
  const { view3d } = useAppServices();
  const [preset, setPreset] = useState<CamPreset>('corner');

  const pick = (p: CamPreset): void => {
    view3d.setPreset(p);
    setPreset(p);
  };

  const cls = (p: CamPreset): string | undefined => (preset === p ? 'active' : undefined);

  return (
    <div id="cam-controls">
      <button
        data-cam="corner"
        className={cls('corner')}
        title="Perspective view"
        onClick={() => pick('corner')}
      >
        Corner
      </button>
      <button
        data-cam="top"
        className={cls('top')}
        title="View from above"
        onClick={() => pick('top')}
      >
        Top
      </button>
      <button
        data-cam="front"
        className={cls('front')}
        title="Front elevation"
        onClick={() => pick('front')}
      >
        Front
      </button>
      <button
        data-cam="inside"
        className={cls('inside')}
        title="Eye-level view inside the room"
        onClick={() => pick('inside')}
      >
        Inside
      </button>
    </div>
  );
}
