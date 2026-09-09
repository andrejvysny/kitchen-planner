import { useEffect, useRef, type ReactElement } from 'react';
import { presetPart } from '../../model/presets';
import { openInWorkshop, workshopTarget, workspace, type WorkshopTarget } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { useAppServices } from './services';

/**
 * The Workshop workspace's canvas pane: an absolutely positioned layer over
 * #canvases that hosts the Part Studio while `workspace() === 'workshop'`
 * (WS-SPEC WP 1.6). Before this the studio was a document.body modal with its
 * own backdrop and ✕; now it is a place you navigate to, and "leaving" is the
 * Back button or a topbar tab — both of which run the ONE switch in
 * src/app/services.ts. There is nothing to confirm on the way out any more
 * (WS-SPEC WP 3.1: the studio writes through to the store as you edit), so the
 * cleanup below simply closes.
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

    // Opened FROM a placed item: the def the editor is about to draw has to be
    // the size that item actually IS. A fitted wardrobe took its width from the
    // wall segment it landed in, so the def is still at its catalog width and
    // every column would be laid out against the wrong total. `adoptItemDims`
    // is scope-gated and idempotent, and it FORKS a def shared by more than one
    // instance — so the answer can be a different id than the target carried.
    // Retarget onto it and let the effect re-enter: the second pass adopts
    // nothing and opens the studio.
    if (target?.itemId) {
      const adopted = store.adoptItemDims(target.itemId);
      if (adopted?.changed) {
        store.commit();
        openInWorkshop(adopted.defId, target.itemId);
        return;
      }
    }

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
      // nothing to confirm — live-apply put every edit in the design already —
      // but this IS where a pristine preset shadow gets discarded (WP 3.1)
      if (studio.isOpen()) studio.close();
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
