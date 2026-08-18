import { useEffect, useRef, type ReactElement } from 'react';
import type { ToolId } from '../../editor/editorState';
import { workspace } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { useEditor } from './services';

/**
 * Floating cursor-follow hint chip, shown next to the pointer while a tool is
 * armed (WP 2.2). Deliberately redundant with the status bar's richer text
 * (plan2d.ts `updateHint` → `setHint`): short, static copy near the cursor so
 * the user does not have to look away from the canvas to read it.
 *
 * `paneId` is generic — 'pane2d' | 'pane3d' — but only the plan pane has any
 * hints today. The 2D map covers every armed tool; the 3D map covers only
 * 'place' — View3D DOES place an armed def on click (view3d.ts onPointerDown's
 * getArmed() branch: floorPoint → snapItem/addItem, plus the appliance
 * findHost path), but the other tools (drawRoom/measure/calibrate) are
 * plan-only gestures, so their chips would promise a click 3D ignores.
 *
 * Position is written straight onto the node from an effect's rAF loop, never
 * through React state — a re-render per pointermove is exactly what this
 * component must not cause (see PropsPanel.tsx's render-count contract for
 * why that discipline matters here too). The chip stays `opacity: 0` (CSS
 * default) until the first pointermove positions it, and hides again on
 * pointerleave; unmounting (tool disarmed, or the workspace leaves plan/
 * furnish) tears the listeners down for free via the effect's cleanup.
 */

const HINTS_2D: Partial<Record<ToolId, string>> = {
  place: 'Click to place · shift keeps placing',
  drawRoom: 'Drag a room, or click walls · close the loop for a room, Enter to stop',
  measure: 'Click two points',
  calibrate: 'Click both ends of a known distance',
};

/** No tool drives a 3D click interaction yet — see the doc comment above. */
const HINTS_3D: Partial<Record<ToolId, string>> = {
  place: 'Click to place \u00b7 shift keeps placing',
};

export interface HintChipProps {
  paneId: 'pane2d' | 'pane3d';
}

export function HintChip({ paneId }: HintChipProps): ReactElement | null {
  const editor = useEditor();
  useChannel('editor');
  useChannel('workspace');
  const el = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const raf = useRef<number | null>(null);

  // Pane clusters (WS-SPEC §2.3) cover the canvases in Workshop/Output, and
  // the tool resets to 'select' on every workspace switch anyway — this gate
  // is belt-and-braces so the chip never repositions itself under one of them.
  const ws = workspace();
  const inCanvasWorkspace = ws === 'plan' || ws === 'furnish';
  const map = paneId === 'pane2d' ? HINTS_2D : HINTS_3D;
  const text = inCanvasWorkspace ? map[editor.tool] : undefined;

  // Depends on `text`, not "mount once": on the FIRST render the tool is
  // 'select', this returns null, and `el.current` is still null when this
  // effect body runs — an empty dep array would never re-run it once the div
  // actually appears. Keying on `text` re-fires the effect exactly when the
  // node (re)appears (and again, harmlessly, on every subsequent armed→armed
  // tool switch, since it is the SAME node — React keeps it across a text-only
  // change — so no flicker of the tracked position).
  useEffect(() => {
    const chip = el.current;
    const pane = chip?.parentElement;
    if (!chip || !pane) return;

    const write = (): void => {
      raf.current = null;
      chip.style.transform = `translate(${pos.current.x + 14}px, ${pos.current.y + 18}px)`;
    };
    const onMove = (e: PointerEvent): void => {
      // #canvas2d hides in the elevation sub-mode but #pane2d itself does not
      // — every armed tool here only ever acts on the plan canvas, so a chip
      // hovering the elevation view would promise a click that does nothing.
      if (pane.classList.contains('elev-mode')) {
        chip.style.opacity = '0';
        return;
      }
      const rect = pane.getBoundingClientRect();
      pos.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      chip.style.opacity = '1';
      if (raf.current === null) raf.current = requestAnimationFrame(write);
    };
    const onLeave = (): void => {
      chip.style.opacity = '0';
    };

    pane.addEventListener('pointermove', onMove);
    pane.addEventListener('pointerenter', onMove);
    pane.addEventListener('pointerleave', onLeave);
    return () => {
      pane.removeEventListener('pointermove', onMove);
      pane.removeEventListener('pointerenter', onMove);
      pane.removeEventListener('pointerleave', onLeave);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [text]);

  if (!text) return null;

  return (
    <div
      id={paneId === 'pane2d' ? 'hint-chip-2d' : 'hint-chip-3d'}
      className="hint-chip"
      data-pane={paneId}
      ref={el}
    >
      {text}
    </div>
  );
}
