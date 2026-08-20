import { useState, type ReactElement } from 'react';
import { NUDGE_KEY } from '../../model/storageKeys';
import { workspace } from '../workspaceState';
import { useChannel } from './hooks/useStore';
import { useAppServices, useEditor, useStore } from './services';

/**
 * The three empty-state aids (WS-SPEC §5.4, WP 2.4): help for a brand-new
 * design before there is anything on the canvas to click on.
 *
 * `emptyDesign()` (store.ts) ships zero rooms, so "Plan, no rooms" is the
 * literal state <PlanStarterCard/> gates on — there is nothing hidden behind
 * it for "Draw a room" to collide with.
 *
 * Both components mount as children of #pane2d in Workspace.tsx, after
 * <HintChip/> — see that component's shape and Workspace.tsx's doc comment
 * for why a subscribing overlay arrives as a child rather than a conditional
 * on the stateless parent. Plan and Furnish never show both at once: the
 * card is Plan-only, the nudge is Furnish-only.
 */

/**
 * Plan's "nothing here yet" card: three ways to get a room on the canvas.
 * Gated on the resting tool as well as the empty design, so arming any
 * tool — the card's own buttons included — hides it immediately rather than
 * blocking the click that follows (e.g. placing the room itself).
 *
 * "Load sample design" is the demo kitchen's only route in since a first run
 * stopped booting it (src/app/services.ts). It sits LAST because it answers a
 * different question from the other two — "show me one" rather than "let me
 * draw mine" — and it pairs `store.loadDemo()` with a `zoomFit` exactly as the
 * topbar's New and Load do: a swapped design that lands off-screen reads as a
 * button that did nothing.
 */
export function PlanStarterCard(): ReactElement | null {
  const { plan } = useAppServices();
  const store = useStore();
  const editor = useEditor();
  useChannel('workspace');
  useChannel('design');
  useChannel('editor');
  useChannel('history'); // the underlay lands on a commit, not on 'design'

  // A placed reference means the user already answered this card's question —
  // leaving it up covers the very photo they just imported, and its two
  // buttons re-ask something they are past. The card is for a BLANK plan.
  const show =
    workspace() === 'plan' &&
    editor.isTool('select') &&
    store.design.rooms.length === 0 &&
    !store.underlayRef();
  if (!show) return null;

  return (
    <div id="plan-starter" className="pane-empty-card">
      <div className="pane-empty-title">Start with a room</div>
      <p className="pane-empty-sub">
        Drag out a rectangle, click corner by corner, or trace a photo of your floor plan.
      </p>
      <div className="pane-empty-actions">
        <button className="btn" onClick={() => editor.setTool('drawRoom')}>
          Draw a room
        </button>
        <button className="btn" onClick={() => document.getElementById('underlay-input')!.click()}>
          Import a floor plan photo…
        </button>
        <button
          className="btn"
          onClick={() => {
            store.loadDemo();
            plan.zoomFit();
          }}
        >
          Load sample design
        </button>
      </div>
    </div>
  );
}

/**
 * Furnish's "nothing placed yet" nudge, dismissible for the rest of the
 * session — and the session is the TAB's, not the page load's. The flag was a
 * plain module `let`, so a reload re-raised a nudge the user had already
 * answered; sessionStorage (NUDGE_KEY) is the smallest thing that spells the
 * lifetime the copy already promised. Shape is src/ui/onboarded.ts's:
 * load-at-import, no listener set, best-effort write — nothing subscribes to a
 * decision that is read once per mount.
 *
 * A storage that throws reads as NOT dismissed (the opposite of `onboarded`,
 * which would rather stay quiet than replay): the module `let` still carries
 * the dismissal for the rest of the page's life, so the worst case is exactly
 * the old behaviour.
 *
 * The container stays pointer-events:none (it sits over the bottom of the
 * pane, where test/interact.mjs clicks the canvas by world coordinate) and
 * only the ✕ turns pointer events back on.
 */
let nudgeDismissed = loadNudgeDismissed();

function loadNudgeDismissed(): boolean {
  try {
    return sessionStorage.getItem(NUDGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function FurnishNudge(): ReactElement | null {
  const store = useStore();
  useChannel('workspace');
  useChannel('design');
  const [dismissed, setDismissed] = useState(nudgeDismissed);

  const show = workspace() === 'furnish' && store.design.items.length === 0 && !dismissed;
  if (!show) return null;

  const dismiss = (): void => {
    nudgeDismissed = true;
    setDismissed(true);
    try {
      sessionStorage.setItem(NUDGE_KEY, '1');
    } catch {
      /* preference is best-effort */
    }
  };

  return (
    <div id="furnish-nudge" className="pane-nudge">
      Pick something from the library, then click in the room to place it
      <button aria-label="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
