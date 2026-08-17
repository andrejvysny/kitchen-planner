import { demoDesign, Store } from '../model/store';
import { Plan2D } from '../plan2d/plan2d';
import { ElevationView } from '../plan2d/elevation';
import { PartStudio } from '../ui/partstudio';
import { View3D } from '../view3d/view3d';
import { EditorState } from '../editor/editorState';
import { APP_COMMANDS } from '../editor/commands/appCommands';
import { CommandRegistry } from '../editor/commands/registry';
import { KeyboardController } from '../editor/keyboard/KeyboardController';
import { StoreBridge } from '../ui/react/storeBridge';
import { setCatalogOpen, setHint, setWallLabel } from '../ui/shellState';
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
   * The ONE guarded workspace switch — the Topbar tabs, the panes and the
   * `workspace.*` commands all route through it. Returns false when the switch
   * was refused (unsaved Part Studio edits the user chose to keep).
   */
  switchWorkspace: (w: WorkspaceId) => boolean;

  /**
   * Whether the autosave was unreadable and a backup was stashed. Decided HERE,
   * at construction, before anything else can touch storage; <RecoveryBanner/>
   * only renders the answer.
   */
  needsRecoveryBanner: boolean;
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
  const store = new Store(loadedDesign ?? demoDesign());
  const needsRecoveryBanner = !loadedDesign && Store.recoveryPayload() !== null;

  const editor = new EditorState();

  // hints and the elevation's wall caption both go to the shell singleton,
  // which the status bar and <WallNav/> render — no DOM lookup, so a hint
  // raised by a DETACHED view (or before the first render) still lands
  const plan = new Plan2D(store, editor, (hint) => setHint(hint));
  const elevation = new ElevationView(store, () => setWallLabel(elevation.wallLabel()));

  const view3d = new View3D(store, {
    getArmed: () => plan.armedDef,
    clearArmed: () => plan.setArmed(null),
  });

  /**
   * One Part Studio for the whole app, reached by the catalog's ＋/✎ tiles, the
   * props panel's "Edit part template…" and Escape. Its constructor is DOM-free
   * (only `open()` touches the document), so it belongs with the singletons.
   *
   * Its close callback is a no-op: the only paths that change the parts library
   * (save / delete part) both `store.commit()`, so the 'history' channel already
   * wakes <CatalogPanel/>. Cancelling changes nothing, so there is nothing to
   * refresh.
   */
  const studio = new PartStudio(store, () => {});

  /**
   * The one guarded workspace switch. Everything that changes workspace — the
   * topbar tabs, the panes, the `workspace.*` commands behind keys 1-4 — comes
   * through here, so the guard and the resets are written once.
   *
   * The guard is the Part Studio's own dirty-confirm: today the Workshop IS
   * that modal, so leaving it with unsaved edits has to ask, and a refused
   * close must abort the switch rather than leave the shell showing a
   * workspace the modal is still covering. When WP 1.6 hosts the studio inside
   * the Workshop pane instead, the guard moves but this helper does not.
   *
   * The two resets exist because a workspace is a different TASK, not a
   * different view of the same one: an armed catalog def or a live measure
   * would otherwise fire on the next click in a pane that never armed it, and
   * the narrow-screen catalog drawer would stay open over the new pane.
   */
  const switchWorkspace = (w: WorkspaceId): boolean => {
    if (w === workspace()) return true;
    if (workspace() === 'workshop' && studio.isOpen() && !studio.close()) return false;
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
  });
  commands.registerAll(APP_COMMANDS);

  const keyboard = new KeyboardController(commands, { modalOpen: () => studio.isOpen() });

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
  };
}
