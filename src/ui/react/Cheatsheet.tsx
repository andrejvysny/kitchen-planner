import { useEffect, type ReactElement } from 'react';
import { cheatsheetOpen, setCheatsheetOpen } from '../shellState';
import { SHORTCUT_GROUPS, SHORTCUTS, type ShortcutGroup } from '../shortcuts';
import { useChannel } from './hooks/useStore';

/**
 * The keyboard & mouse cheatsheet (WS-SPEC §5.5, WP 2.5) — the sheet `?` and
 * the settings menu's `Shortcuts…` both raise.
 *
 * It SELF-GATES on the shell singleton rather than being a conditional in
 * <App/>: the shell holds no state and never re-renders (see App.tsx), so
 * anything that appears and disappears has to hold its own subscription. Same
 * shape as <WorkshopPane/> and <ContextMenu/> one level down.
 *
 * The content is src/ui/shortcuts.ts and nothing else — a help sheet that
 * paraphrased the key map in its own markup would be a second copy waiting to
 * drift.
 *
 * ESCAPE ORDER is the one subtle thing here. The global key map lives on
 * `window` (src/editor/keyboard/) and Escape there runs `tool.cancel` — even
 * while typing, deliberately. A user who opens the sheet mid-measure and hits
 * Escape means "close the sheet", not "throw away my tool", so this listener
 * goes on `window` in the CAPTURE phase: it runs before the controller's
 * bubble-phase one and stops the event dead. It exists only while the sheet is
 * open, so the tool keeps its Escape the rest of the time. (<ContextMenu/>
 * solves the same problem the other way — it can stopPropagation on its own
 * focused node; a backdrop that must not steal focus from the canvas cannot.)
 */
export function Cheatsheet(): ReactElement | null {
  useChannel('shell');
  const open = cheatsheetOpen();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setCheatsheetOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;

  return (
    <div
      id="cheatsheet"
      className="cheatsheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard and mouse shortcuts"
      // the backdrop closes, the panel does not — so only a press that landed
      // on the backdrop ITSELF counts, never one that bubbled out of the card
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setCheatsheetOpen(false);
      }}
    >
      <div className="cheatsheet">
        <div className="cheatsheet-head">
          <span className="cheatsheet-title">Keyboard &amp; mouse</span>
          <button
            id="btn-cheatsheet-close"
            type="button"
            aria-label="Close"
            onClick={() => setCheatsheetOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="cheatsheet-cols">
          {SHORTCUT_GROUPS.map((group) => (
            <Group key={group} group={group} />
          ))}
        </div>
        <div className="cheatsheet-foot">On macOS, Ctrl means Cmd.</div>
      </div>
    </div>
  );
}

/** One titled block; the CSS column layout decides where it lands. */
function Group({ group }: { group: ShortcutGroup }): ReactElement | null {
  const rows = SHORTCUTS.filter((s) => s.group === group);
  if (!rows.length) return null;

  return (
    <section className="cheatsheet-group">
      <h3 className="cheatsheet-group-title">{group}</h3>
      {rows.map((row) => (
        <div className="cheatsheet-row" key={`${row.keys}|${row.does}`}>
          <span className="cheatsheet-keys">{row.keys}</span>
          <span className="cheatsheet-does">{row.does}</span>
        </div>
      ))}
    </section>
  );
}
