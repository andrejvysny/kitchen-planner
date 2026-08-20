import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useAppServices, useEditor } from './services';
import type { ToolId } from '../../editor/editorState';
import type { CamPreset } from '../../view3d/view3d';
import { wallLabel } from '../shellState';
import { workspace } from '../workspaceState';
import { DrawHud, SceneOverlay, ViewOverlay } from './CanvasOverlays';
import { ContextMenu } from './ContextMenu';
import { FurnishNudge, PlanStarterCard } from './EmptyState';
import { HintChip } from './HintChip';
import { useChannel } from './hooks/useStore';
import { OutputPane } from './OutputPane';
import { PropsPanel } from './PropsPanel';
import { Sidebar } from './Sidebar';
import { WorkshopPane } from './WorkshopPane';
import { unitPrefs } from '../../model/prefs';
import { formatLength, parseLength } from '../../model/units';
import { useNativeChange } from './fields/useNativeChange';

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
 * conditional here: this component renders once and never reconciles it. The
 * two canvas overlays WS-SPEC §2.3 moved off the top bar (<ViewOverlay/> over
 * #canvases, <SceneOverlay/> in #pane3d) arrive the same way, from
 * src/ui/react/CanvasOverlays.tsx. <OutputPane/> (WP 1.8) is the same shape,
 * one workspace over. <ContextMenu/> (WP 2.1) is the same shape again: it holds
 * the open popup's state and finds the two canvases from its own effect, which
 * runs after this component's children are in the document.
 *
 * <HintChip/> (WP 2.2) is the same shape once more: a cursor-follow label
 * shown while a tool is armed, mounted only in #pane2d — see its own doc
 * comment for why the 3D pane gets no instance today.
 *
 * <PlanStarterCard/> and <FurnishNudge/> (WP 2.4, src/ui/react/EmptyState.tsx)
 * are the last two: both also live in #pane2d, subscribing to 'workspace' so
 * only one of them ever shows for a given task.
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
          <HintChip paneId="pane2d" />
          <PlanStarterCard />
          <FurnishNudge />
          <DrawHud />
        </div>
        <div id="pane3d" className="pane">
          <canvas id="canvas3d" ref={viewCanvas}></canvas>
          <div className="pane-badge">3D view</div>
          <CamControls />
          <SceneOverlay />
          <HintChip paneId="pane3d" />
        </div>
        <ViewOverlay />
        <WorkshopPane />
        <OutputPane />
        <ContextMenu />
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
        Floor plan
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
 * The plan tools. The two of them that are gestures share one tool slot, so
 * clicking one arms it and clicking it again drops back to 'select'; ⚠ is a
 * display layer and stays orthogonal. Everything is read off EditorState — the
 * `.active` classes are a projection of it, never a second copy.
 *
 * There is ONE wall tool: a drag makes a rectangle, clicks make a polygon.
 * While it is armed the cluster grows a width box, because the width applies to
 * the room about to be drawn and nothing else — it is a tool preference on
 * EditorState, not design data, so no undo step is taken for changing it (a
 * PLACED wall's width lives on the Room and is edited in the wall inspector).
 *
 * Which buttons exist follows the workspace (WS-SPEC §4.4): the wall tool is
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
            id="btn-draw-room"
            className={cls('drawRoom')}
            title="Draw walls — drag a room, or click wall by wall; close the loop for a room, cross one to split it"
            onClick={toggle('drawRoom')}
          >
            ✎
          </button>
          {editor.isTool('drawRoom') && (
            <>
              <button
                id="btn-angle-snap"
                className={editor.angleSnap ? 'active' : undefined}
                title="Snap walls to 15° steps — Shift inverts this while you draw"
                onClick={() => editor.setAngleSnap(!editor.angleSnap)}
              >
                ⟂
              </button>
              <WallWidthField />
              <GridStepField />
            </>
          )}
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
 * Wall width for the tool that is about to draw. Uncontrolled and committed on
 * the DOM's native `change` like every other field (src/ui/react/fields/), but
 * it writes to EditorState rather than the Store: there is no design mutation
 * here and therefore no `store.commit()` and no undo step.
 */
function WallWidthField(): ReactElement {
  const editor = useEditor();
  useChannel('units');
  const input = useRef<HTMLInputElement>(null);
  const prefs = unitPrefs();

  useNativeChange(input, (el) => {
    const m = parseLength(el.value, prefs);
    if (m !== null) editor.setWallWidth(m);
    el.value = formatLength(editor.wallWidth, prefs);
  });

  return (
    <label id="wall-width" title="Thickness of the walls being drawn">
      <input
        type="text"
        inputMode="decimal"
        data-unit={prefs.unit}
        data-cls="draw-wall-width"
        defaultValue={formatLength(editor.wallWidth, prefs)}
        ref={input}
      />
      <span>{prefs.unit}</span>
    </label>
  );
}

/**
 * Snap grid step for the wall tool. A fixed metric list rather than a text box:
 * src/model/units.ts is metric-only (mm | cm | m), and a grid is a choice from
 * a handful of sensible steps, not an arbitrary length to type.
 *
 * Writes to EditorState like <WallWidthField/> above — no design mutation, so
 * no `store.commit()` and no undo step.
 */
const GRID_STEPS: readonly { label: string; m: number | null }[] = [
  { label: 'Off', m: null },
  { label: '10 mm', m: 0.01 },
  { label: '50 mm', m: 0.05 },
  { label: '100 mm', m: 0.1 },
];

function GridStepField(): ReactElement {
  const editor = useEditor();
  const current = GRID_STEPS.find((g) => g.m === editor.snapGrid) ?? GRID_STEPS[2];

  return (
    <select
      id="btn-grid-step"
      title="Snap grid — the fallback used when nothing else is in reach"
      value={current.label}
      onChange={(e) => {
        const pick = GRID_STEPS.find((g) => g.label === e.target.value);
        if (pick) editor.setSnapGrid(pick.m);
      }}
    >
      {GRID_STEPS.map((g) => (
        <option key={g.label} value={g.label}>
          {g.label === 'Off' ? 'Grid off' : `Grid ${g.label}`}
        </option>
      ))}
    </select>
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
