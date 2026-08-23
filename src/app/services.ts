import { emptyDesign, Store } from '../model/store';
import { Plan2D } from '../plan2d/plan2d';
import { ElevationView } from '../plan2d/elevation';
import { PartStudio } from '../ui/partstudio';
import { View3D } from '../view3d/view3d';
import { EditorState } from '../editor/editorState';
import { syncSelection } from '../editor/selectionSync';
import { APP_COMMANDS } from '../editor/commands/appCommands';
import { CommandRegistry } from '../editor/commands/registry';
import { KeyboardController } from '../editor/keyboard/KeyboardController';
import { StoreBridge } from '../ui/react/storeBridge';
import { setDrawHud } from '../ui/drawHud';
import { onboarded } from '../ui/onboarded';
import {
  cheatsheetOpen,
  setCatalogOpen,
  setCheatsheetOpen,
  setHint,
  setWallLabel,
} from '../ui/shellState';
import { setWorkspace, workspace, type WorkspaceId } from '../ui/workspaceState';

/**
 * The application's object graph, assembled in one place.
 *
 * Before this, every one of the ~28 React modules imported the singletons it
 * needed straight out of bootstrap.ts — which meant the whole component tree
 * knew WHERE the app is constructed, and any new editor service would have had
 * to become one more bootstrap export. Components now take the bundle from a
 * React context (src/ui/react/services.tsx) and this module is the only place
 * that says `new`.
 *
 * There is still exactly one instance in the running app; the seam buys
 * testability and a future host (Tauri/Electron, a second window) that wants a
 * differently-wired graph, not multi-tenancy.
 *
 * Framework-free on purpose — no React in this file, so the boundary lint that
 * keeps model/editor/view free of the shell has one fewer exception to make.
 */
export interface AppServices {
  store: Store;
  editor: EditorState;

  plan: Plan2D;
  elevation: ElevationView;
  view3d: View3D;

  studio: PartStudio;

  commands: CommandRegistry;
  keyboard: KeyboardController;

  /** Store/EditorState/shell → React adapter; inert until a component subscribes */
  bridge: StoreBridge;

  /**
   * The ONE workspace switch — the Topbar tabs, the panes and the `workspace.*`
   * commands all route through it, so the resets are written once. It returns a
   * boolean because `WorkspacePort` does; nothing can refuse a switch since the
   * Part Studio stopped holding drafts (WS-SPEC WP 3.1), so the answer is now
   * always true.
   */
  switchWorkspace: (w: WorkspaceId) => boolean;

  /**
   * Whether the autosave was unreadable and a backup was stashed. Decided HERE,
   * at construction, before anything else can touch storage; <RecoveryBanner/>
   * only renders the answer.
   */
  needsRecoveryBanner: boolean;

  /**
   * Whether this is a genuinely FIRST run — no design to load, no backup to
   * offer, and the tour never shown on this device. Decided here for the same
   * reason as needsRecoveryBanner: it is a statement about storage BEFORE the
   * app touched it, and <CoachMarks/> only renders the answer. WS-SPEC §5.5
   * also makes it force the Plan workspace, which happens below rather than in
   * a component — the workspace has to be right on the FIRST paint.
   */
  firstRun: boolean;
}

/**
 * Construct the graph. Order matters and is the order the pre-React main.ts
 * used: the store first (it reads storage), then the three views DETACHED —
 * they never touch the DOM until the shell hands each one its canvas through
 * `attach()` — then the modal, then the editor services that wire them
 * together.
 */
export function createServices(): AppServices {
  const loadedDesign = Store.loadAutosaved();
  /**
   * Nothing to load means an EMPTY design, not the demo kitchen. A furnished
   * plan on arrival teaches nothing about how it got there — and the first
   * thing a new user has to do is delete it. <PlanStarterCard/> and the tour
   * take that slot instead, and `store.loadDemo()` behind the card's "Load
   * sample design" is the way back to the demo.
   *
   * The unreadable-autosave path lands here too: <RecoveryBanner/> already
   * says a backup was kept, so replacing the user's design with a sample one
   * would only be one more thing to clear away.
   */
  const store = new Store(loadedDesign ?? emptyDesign());
  const needsRecoveryBanner = !loadedDesign && Store.recoveryPayload() !== null;

  /**
   * Nothing loaded, nothing to recover, tour never seen: a new user. The three
   * reads are the ones already done above plus one flag — no second parse of
   * the autosave, and no way for a corrupt-save recovery to be mistaken for a
   * first run (the banner and the coach marks must never appear together).
   *
   * WS-SPEC §5.5 starts a first run in Plan, which is a different workspace
   * from the persisted default ('furnish'). Doing it here, before React mounts,
   * is what keeps it off the first paint: a component effect would flash the
   * wrong workspace first. It persists like any other switch, which is correct
   * — the second run genuinely was last in Plan.
   */
  const firstRun = !loadedDesign && !needsRecoveryBanner && !onboarded();
  if (firstRun) setWorkspace('plan');

  const editor = new EditorState();

  // selection ⇄ design lifetime, in one line (src/editor/selectionSync.ts)
  syncSelection(store, editor);

  // hints and the elevation's wall caption both go to the shell singleton,
  // which the status bar and <WallNav/> render — no DOM lookup, so a hint
  // raised by a DETACHED view (or before the first render) still lands
  const plan = new Plan2D(
    store,
    editor,
    (hint) => setHint(hint),
    (s) => setDrawHud(s)
  );
  const elevation = new ElevationView(store, editor, () => setWallLabel(elevation.wallLabel()));

  const view3d = new View3D(store, {
    getArmed: () => plan.armedDef,
    clearArmed: () => plan.setArmed(null),
    editor,
  });

  /**
   * One Part Studio for the whole app. Every route in — the catalog's ＋/✎
   * tiles, the Workshop sidebar's rows, the props panel's "Edit in Workshop…"
   * / "Customize in Workshop…" — goes through `openInWorkshop`, and <WorkshopPane/> is
   * what actually hands it a host to build into. Its constructor is DOM-free
   * (only `open()` touches the document), so it belongs with the singletons.
   *
   * Its close callback is a no-op: every path that changes the parts library
   * commits (live-apply writes through on each field change, and so do create /
   * duplicate / delete), so the 'history' channel already wakes <CatalogPanel/>.
   */
  const studio = new PartStudio(store, () => {});

  /**
   * The one workspace switch. Everything that changes workspace — the topbar
   * tabs, the panes, the `workspace.*` commands behind keys 1-4 — comes through
   * here, so the resets are written once.
   *
   * There is nothing left to GUARD. Until WS-SPEC WP 3.1 this asked the Part
   * Studio whether it held unsaved edits and aborted the switch on a refusal;
   * live-apply means the studio holds no edits at all — every change is already
   * in the design and undoable — so the abort path, and with it the app's last
   * native `confirm()`, is gone. Tearing the studio down is <WorkshopPane/>'s
   * cleanup effect, which fires off the workspace change this makes.
   *
   * The two resets exist because a workspace is a different TASK, not a
   * different view of the same one: an armed catalog def or a live measure
   * would otherwise fire on the next click in a pane that never armed it, and
   * the narrow-screen catalog drawer would stay open over the new pane.
   */
  const switchWorkspace = (w: WorkspaceId): boolean => {
    if (w === workspace()) return true;
    editor.setTool('select');
    setCatalogOpen(false);
    setWorkspace(w);
    return true;
  };

  /**
   * `plan` and `studio` go in as the STRUCTURAL `PlanToolPort` / `ModalPort`
   * the command layer declares. That indirection is the point: src/editor may
   * not import src/ui or src/app (eslint boundary), and plan2d already imports
   * editorState, so a concrete import either way would be a cycle. It also
   * makes every command unit-testable against fakes.
   */
  const commands = new CommandRegistry({
    store,
    editor,
    plan,
    modal: studio,
    workspace: { workspace, switchTo: switchWorkspace },
    help: { toggleShortcuts: () => setCheatsheetOpen(!cheatsheetOpen()) },
  });
  commands.registerAll(APP_COMMANDS);

  // No modal gate any more (WS-SPEC WP 3.1 / D2): the hosted studio holds no
  // draft, so Ctrl+Z in the Workshop is the feature. The commands that would
  // edit an invisible selection carry their own `onCanvas` precondition.
  const keyboard = new KeyboardController(commands);

  const bridge = new StoreBridge(store, editor);

  return {
    store,
    editor,
    plan,
    elevation,
    view3d,
    studio,
    commands,
    keyboard,
    bridge,
    switchWorkspace,
    needsRecoveryBanner,
    firstRun,
  };
}
