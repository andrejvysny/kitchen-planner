import { useEffect, useRef, type ReactElement } from 'react';
import { presetPart } from '../../model/presets';
import { workshopTarget, workspace, type WorkshopTarget } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { useAppServices } from './services';

/**
 * The Workshop workspace's canvas pane: an absolutely positioned layer over
 * #canvases that hosts the Part Studio while `workspace() === 'workshop'`
 * (WS-SPEC WP 1.6). Before this the studio was a document.body modal with its
 * own backdrop and ✕; now it is a place you navigate to, and "leaving" is the
 * Back button or a topbar tab — both of which run the ONE guarded switch in
 * src/app/services.ts, so the unsaved-edits confirm lives there, once.
 *
 * <Workspace/> must stay STATELESS (see its doc comment), so every
 * subscription and every ref this pane needs lives HERE and the parent just
 * renders <WorkshopPane/> as the last child of #canvases. The two canvases
 * underneath are never unmounted — the pane covers them, it does not replace
 * them, which is what keeps the WebGL context and both view attachments alive
 * across a workspace round trip (e2e/lifecycle.spec.ts).
 *
 * Two effects on purpose:
 *  - the TARGET effect re-runs on every 'workspace' emit and opens the studio
 *    only when the target actually changed, because re-opening rebuilds the
 *    studio's DOM and would eat the user's in-progress edits;
 *  - the MOUNT effect has the cleanup, so leaving (or a StrictMode double
 *    mount) closes exactly once and the target effect can re-open on top.
 */
export function WorkshopPane(): ReactElement | null {
  const wsVersion = useChannel('workspace');
  const { store, studio, view3d, switchWorkspace } = useAppServices();
  const hostRef = useRef<HTMLDivElement>(null);
  /** the target this pane last opened the studio on; `undefined` = nothing opened yet */
  const opened = useRef<WorkshopTarget | null | undefined>(undefined);
  const active = workspace() === 'workshop';

  useEffect(() => {
    if (!active) return;
    const host = hostRef.current;
    if (!host) return;

    const target = workshopTarget();
    if (studio.isOpen() && (target === opened.current || target === null)) {
      // Same target (an unrelated 'workspace' emit), or one the studio cleared
      // itself after deleting the part it was editing. Either way there is
      // nothing new to open, and a rebuild would drop live edits.
      opened.current = target;
      return;
    }
    opened.current = target;

    // A stale id — a custom part deleted since the target was set — resolves
    // to nothing and lands on the picker rather than throwing.
    const defId = target?.defId ?? null;
    const def = defId ? (store.customPartById(defId) ?? presetPart(defId)) : undefined;
    studio.open(def, host);
    // wsVersion is the re-run ticket, not data: every openInWorkshop() bumps it
  }, [active, store, studio, wsVersion]);

  useEffect(() => {
    if (!active) return;
    // the 3D pane is covered while the Workshop is up; the studio has its own
    // preview renderer, so paying for both would be paying twice
    view3d.setActive(false);
    return () => {
      if (studio.isOpen()) studio.close(true); // the guard already ran in switchWorkspace
      opened.current = undefined;
      // the topbar's 2D/3D toggle owns `.hidden` on #pane3d — read it, never
      // duplicate it, or a Workshop visit would resurrect a hidden 3D pane
      if (!document.getElementById('pane3d')?.classList.contains('hidden')) view3d.setActive(true);
    };
  }, [active, studio, view3d]);

  if (!active) return null;

  return (
    <div id="pane-workshop" className="workspace-pane">
      <div className="workspace-pane-head">
        <button
          id="wsp-back"
          className="btn"
          onClick={() => switchWorkspace(workshopTarget()?.returnTo ?? 'furnish')}
        >
          ‹ Back
        </button>
        <span className="workspace-pane-caption">Workshop</span>
      </div>
      <div className="workshop-host" ref={hostRef}></div>
    </div>
  );
}
