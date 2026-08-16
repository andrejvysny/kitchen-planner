import { useEffect, useRef, type ReactElement } from 'react';
import { elev, plan, view } from '../../app/bootstrap';
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
          <div id="mode2d-toggle" className="pane-modes">
            <button data-2dmode="plan" className="active" title="Top-down floor plan">
              Plan
            </button>
            <button data-2dmode="elev" title="Front view of one wall">
              Elevation
            </button>
          </div>
          <div id="zoom-controls">
            <button id="btn-zoom-in" title="Zoom in">
              +
            </button>
            <button id="btn-zoom-fit" title="Zoom to fit">
              ⛶
            </button>
            <button id="btn-zoom-out" title="Zoom out">
              −
            </button>
          </div>
          <div id="measure-controls">
            <button
              id="btn-room"
              title="Add a room — click in the plan, or hover a wall to attach it"
            >
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
          <div id="wall-nav">
            <button id="btn-wall-prev" title="Previous wall">
              ‹
            </button>
            <span id="wall-label">Wall</span>
            <button id="btn-wall-next" title="Next wall">
              ›
            </button>
          </div>
        </div>
        <div id="pane3d" className="pane">
          <canvas id="canvas3d" ref={viewCanvas}></canvas>
          <div className="pane-badge">3D view</div>
          <div id="cam-controls">
            <button data-cam="corner" className="active" title="Perspective view">
              Corner
            </button>
            <button data-cam="top" title="View from above">
              Top
            </button>
            <button data-cam="front" title="Front elevation">
              Front
            </button>
            <button data-cam="inside" title="Eye-level view inside the room">
              Inside
            </button>
          </div>
        </div>
      </section>

      <PropsPanel />
    </main>
  );
}
