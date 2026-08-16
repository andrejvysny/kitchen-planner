import { memo, useEffect, useRef, useState, type ReactElement } from 'react';
import { elev, plan, view } from '../../app/bootstrap';
import type { CamPreset } from '../../view3d/view3d';
import { PropsPanel } from './PropsPanel';
import { Sidebar } from './Sidebar';

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
 * These effects run BEFORE the App-level one that constructs the legacy UI, so
 * ui.ts always finds three attached views.
 *
 * <Workspace/> must stay STATELESS. #pane2d and #pane3d carry classes written
 * by hand — `.hidden` from the topbar's view toggle, `.elev-mode` from ui.ts's
 * 2D/elev sub-toggle — and a re-render here would reconcile `className` back to
 * the literal below. State belongs in the leaf controls; the ones ui.ts still
 * owns are memo fragments that never re-render at all.
 */
export function Workspace(): ReactElement {
  const planCanvas = useRef<HTMLCanvasElement>(null);
  const elevCanvas = useRef<HTMLCanvasElement>(null);
  const viewCanvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    plan.attach(planCanvas.current!);
    return () => plan.detach();
  }, []);

  useEffect(() => {
    elev.attach(elevCanvas.current!);
    return () => elev.detach();
  }, []);

  useEffect(() => {
    view.attach(viewCanvas.current!);
    return () => view.detach();
  }, []);

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
          <LegacyMode2dToggle />
          <ZoomControls />
          <LegacyToolButtons />
          <LegacyWallNav />
        </div>
        <div id="pane3d" className="pane">
          <canvas id="canvas3d" ref={viewCanvas}></canvas>
          <div className="pane-badge">3D view</div>
          <CamControls />
        </div>
      </section>

      <PropsPanel />
    </main>
  );
}

/**
 * B5 EXPIRY: ui.ts's setMode2d owns this pair — it flips `.elev-mode` on
 * #pane2d, drives ElevationView.setActive and writes the `.active` classes
 * below. No props, so React never re-renders it.
 */
const LegacyMode2dToggle = memo(function LegacyMode2dToggle(): ReactElement {
  return (
    <div id="mode2d-toggle" className="pane-modes">
      <button data-2dmode="plan" className="active" title="Top-down floor plan">
        Plan
      </button>
      <button data-2dmode="elev" title="Front view of one wall">
        Elevation
      </button>
    </div>
  );
});

/**
 * B5 EXPIRY: the four plan tools stay legacy-wired — their `.active` classes
 * mirror Plan2D tool state through ui.ts's onMeasureChange/onChecksChange/
 * onRoomToolChange/onDrawRoomChange callbacks, and Escape clears them. No
 * props, so React never re-renders them and can never drop an `.active`.
 */
const LegacyToolButtons = memo(function LegacyToolButtons(): ReactElement {
  return (
    <div id="measure-controls">
      <button id="btn-room" title="Add a room — click in the plan, or hover a wall to attach it">
        ▧
      </button>
      <button
        id="btn-draw-room"
        title="Draw a room — click each corner, click the first again (or Enter) to close"
      >
        ✎
      </button>
      <button
        id="btn-measure"
        title="Measure distances — click two points (snaps to corners, edges & walls)"
      >
        📏
      </button>
      <button id="btn-checks" title="Show clearance warnings">
        ⚠
      </button>
    </div>
  );
});

/**
 * B5 EXPIRY: wall stepping belongs to the elevation sub-mode ui.ts still owns,
 * and #wall-label's text comes from ElevationView's callback (bootstrap.ts).
 */
const LegacyWallNav = memo(function LegacyWallNav(): ReactElement {
  return (
    <div id="wall-nav">
      <button id="btn-wall-prev" title="Previous wall">
        ‹
      </button>
      <span id="wall-label">Wall</span>
      <button id="btn-wall-next" title="Next wall">
        ›
      </button>
    </div>
  );
});

/** Plan zoom. Pure commands on Plan2D — no state, so this renders once. */
function ZoomControls(): ReactElement {
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
  const [preset, setPreset] = useState<CamPreset>('corner');

  const pick = (p: CamPreset): void => {
    view.setPreset(p);
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
