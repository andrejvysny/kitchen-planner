import { beforeEach, describe, expect, it } from 'vitest';
import { APP_COMMANDS } from '../../../src/editor/commands/appCommands';
import { CommandRegistry } from '../../../src/editor/commands/registry';
import type {
  CommandDefinition,
  EditorContext,
  HelpPort,
  ModalPort,
  PlanToolPort,
  WorkspaceId,
  WorkspacePort,
} from '../../../src/editor/commands/types';
import { EditorState } from '../../../src/editor/editorState';
import { demoDesign, Store } from '../../../src/model/store';

// src/editor/commands/* — the named editor behaviours the global keyboard map
// used to hold as `if` branches. These tests are the parity gate for that
// lift: same mutations, same guards, same `store.commit()` discipline.

/** Records every port call so a command's tool-cancelling path is observable. */
function fakePlan(drawing = false, buffered = drawing): PlanToolPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setArmed: () => calls.push('setArmed'),
    setCalibrate: (on) => calls.push(`setCalibrate:${on}`),
    setMeasure: (on) => calls.push(`setMeasure:${on}`),
    cancelDrawRoom: () => calls.push('cancelDrawRoom'),
    closeDrawRoom: (open) => calls.push(`closeDrawRoom:${open ?? false}`),
    drawInputActive: () => drawing,
    drawBufferActive: () => buffered,
    drawDigit: (ch) => calls.push(`drawDigit:${ch}`),
    drawBackspace: () => calls.push('drawBackspace'),
    undoDrawVertex: () => calls.push('undoDrawVertex'),
    drawToggleField: () => calls.push('drawToggleField'),
  };
}

function fakeModal(): ModalPort & { calls: string[]; open: boolean } {
  const state = {
    calls: [] as string[],
    open: false,
    isOpen: () => state.open,
    handleEscape: () => state.calls.push('handleEscape'),
  };
  return state;
}

/**
 * The guarded switch lives in src/app (it needs the studio and the shell), so
 * from here it is just a port: what the commands owe it is the right id.
 * `refuse` stands in for the dirty-confirm the user cancelled.
 */
function fakeWorkspace(): WorkspacePort & {
  calls: WorkspaceId[];
  current: WorkspaceId;
  refuse: boolean;
} {
  const state = {
    calls: [] as WorkspaceId[],
    current: 'furnish' as WorkspaceId,
    refuse: false,
    workspace: () => state.current,
    switchTo: (w: WorkspaceId) => {
      state.calls.push(w);
      if (state.refuse) return false;
      state.current = w;
      return true;
    },
  };
  return state;
}

/**
 * The cheatsheet is shell state (src/ui/shellState.ts), so from here the help
 * surface is a port like every other: what the command owes it is one toggle.
 */
function fakeHelp(): HelpPort & { toggles: number } {
  const state = {
    toggles: 0,
    toggleShortcuts: () => {
      state.toggles++;
    },
  };
  return state;
}

describe('CommandRegistry', () => {
  const ctx = (): EditorContext => ({
    store: new Store(demoDesign()),
    editor: new EditorState(),
    plan: fakePlan(),
    modal: fakeModal(),
    workspace: fakeWorkspace(),
    help: fakeHelp(),
  });

  it('an unknown id is a no-op that reports false, never a throw', () => {
    const reg = new CommandRegistry(ctx());
    expect(reg.get('nope.nope')).toBeUndefined();
    expect(reg.canExecute('nope.nope')).toBe(false);
    expect(reg.execute('nope.nope')).toBe(false);
  });

  it('a command with no canExecute is always available', () => {
    const reg = new CommandRegistry(ctx());
    let ran = 0;
    reg.register({ id: 'test.always', label: 'x', execute: () => ran++ });
    expect(reg.canExecute('test.always')).toBe(true);
    expect(reg.execute('test.always')).toBe(true);
    expect(ran).toBe(1);
  });

  it('a blocked command does not run and reports false', () => {
    const reg = new CommandRegistry(ctx());
    let ran = 0;
    reg.register({
      id: 'test.blocked',
      label: 'x',
      canExecute: () => false,
      execute: () => ran++,
    });
    expect(reg.canExecute('test.blocked')).toBe(false);
    expect(reg.execute('test.blocked')).toBe(false);
    expect(ran).toBe(0);
  });

  it('re-registering an id replaces it; list() keeps registration order', () => {
    const reg = new CommandRegistry(ctx());
    const mk = (id: string, label: string): CommandDefinition => ({
      id,
      label,
      execute: () => {},
    });
    reg.registerAll([mk('a', 'first'), mk('b', 'second')]);
    reg.register(mk('a', 'replaced'));
    expect(reg.get('a')!.label).toBe('replaced');
    expect(reg.list().map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('every seed command has a unique id and a label', () => {
    const ids = APP_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of APP_COMMANDS) expect(c.label.length).toBeGreaterThan(0);
  });
});

describe('app commands', () => {
  let store: Store;
  let editor: EditorState;
  let plan: ReturnType<typeof fakePlan>;
  let modal: ReturnType<typeof fakeModal>;
  let ws: ReturnType<typeof fakeWorkspace>;
  let help: ReturnType<typeof fakeHelp>;
  let reg: CommandRegistry;

  beforeEach(() => {
    store = new Store(demoDesign());
    editor = new EditorState();
    plan = fakePlan();
    modal = fakeModal();
    ws = fakeWorkspace();
    help = fakeHelp();
    reg = new CommandRegistry({ store, editor, plan, modal, workspace: ws, help });
    reg.registerAll(APP_COMMANDS);
  });

  /** Place a fresh item and select it — the precondition most commands want. */
  function selectNewItem(): string {
    // defOf, never catalogDef: 'base-cabinet' is a preset part, not a catalog entry
    const it = store.addItem(store.defOf('base-cabinet'), 1, 1);
    editor.select({ kind: 'item', id: it.id });
    store.commit();
    return it.id;
  }

  it('transform commands are blocked unless an ITEM is selected', () => {
    const blocked = [
      'selection.duplicate',
      'transform.rotate90',
      'transform.rotate15',
      'transform.nudgeLeft',
      'transform.nudgeRightCoarse',
    ];
    for (const id of blocked) expect(reg.canExecute(id)).toBe(false);

    selectNewItem();
    for (const id of blocked) expect(reg.canExecute(id)).toBe(true);
  });

  it('rotate steps are 90° plain and 15° fine, and each is one undo step', () => {
    const id = selectNewItem();
    const before = store.itemById(id)!.rotation;

    expect(reg.execute('transform.rotate90')).toBe(true);
    expect(store.itemById(id)!.rotation).toBeCloseTo(before + Math.PI / 2, 12);

    expect(reg.execute('transform.rotate15')).toBe(true);
    expect(store.itemById(id)!.rotation).toBeCloseTo(before + Math.PI / 2 + Math.PI / 12, 12);

    store.undo();
    expect(store.itemById(id)!.rotation).toBeCloseTo(before + Math.PI / 2, 12);
  });

  it('nudge is 10 mm fine and 100 mm coarse, in plan-space directions', () => {
    const id = selectNewItem();
    const { x, y } = store.itemById(id)!;

    reg.execute('transform.nudgeRight');
    reg.execute('transform.nudgeDown');
    expect(store.itemById(id)!.x).toBeCloseTo(x + 0.01, 12);
    expect(store.itemById(id)!.y).toBeCloseTo(y + 0.01, 12);

    reg.execute('transform.nudgeLeftCoarse');
    reg.execute('transform.nudgeUpCoarse');
    expect(store.itemById(id)!.x).toBeCloseTo(x + 0.01 - 0.1, 12);
    expect(store.itemById(id)!.y).toBeCloseTo(y + 0.01 - 0.1, 12);
  });

  it('duplicate selects the copy and leaves one undo step behind', () => {
    const id = selectNewItem();
    const n = store.design.items.length;

    expect(reg.execute('selection.duplicate')).toBe(true);
    expect(store.design.items.length).toBe(n + 1);
    expect(editor.selection.kind).toBe('item');
    expect(editor.selection.kind === 'item' && editor.selection.id).not.toBe(id);

    store.undo();
    expect(store.design.items.length).toBe(n);
  });

  it('delete removes the selected item and is blocked on an empty selection', () => {
    expect(reg.canExecute('selection.delete')).toBe(false);

    const id = selectNewItem();
    const n = store.design.items.length;
    expect(reg.execute('selection.delete')).toBe(true);
    expect(store.itemById(id)).toBeUndefined();
    expect(store.design.items.length).toBe(n - 1);
  });

  it('delete on a WALL selection is allowed but changes nothing — no undo step', () => {
    // parity with the old keyboard map: the guard was `kind !== 'none'` and the
    // body had no wall branch, so commit() saw an unchanged design
    const wallId = store.allWalls()[0].id;
    editor.select({ kind: 'wall', id: wallId });
    const depth = store.canUndo();

    expect(reg.canExecute('selection.delete')).toBe(true);
    expect(reg.execute('selection.delete')).toBe(true);
    expect(store.allWalls().some((w) => w.id === wallId)).toBe(true);
    expect(store.canUndo()).toBe(depth);
  });

  it('undo/redo are always available and round-trip a command', () => {
    const id = selectNewItem();
    const before = store.itemById(id)!.x;

    reg.execute('transform.nudgeRight');
    expect(reg.execute('history.undo')).toBe(true);
    expect(store.itemById(id)!.x).toBeCloseTo(before, 12);

    expect(reg.execute('history.redo')).toBe(true);
    expect(store.itemById(id)!.x).toBeCloseTo(before + 0.01, 12);
  });

  describe('tool.cancel priority order', () => {
    it('the modal outranks every tool', () => {
      modal.open = true;
      editor.setTool('measure');
      reg.execute('tool.cancel');
      expect(modal.calls).toEqual(['handleEscape']);
      expect(plan.calls).toEqual([]);
    });

    it('the dimension commands only run while a ring is in flight', () => {
      const idle = fakePlan(false);
      const idleReg = new CommandRegistry({
        store,
        editor,
        plan: idle,
        modal,
        workspace: ws,
        help,
      });
      idleReg.registerAll(APP_COMMANDS);
      expect(idleReg.execute('draw.digit4')).toBe(false);
      expect(idleReg.execute('draw.backspace')).toBe(false);
      expect(idleReg.execute('draw.undoVertex')).toBe(false);
      expect(idle.calls).toEqual([]);

      const live = fakePlan(true);
      const liveReg = new CommandRegistry({
        store,
        editor,
        plan: live,
        modal,
        workspace: ws,
        help,
      });
      liveReg.registerAll(APP_COMMANDS);
      expect(liveReg.execute('draw.digit4')).toBe(true);
      expect(liveReg.execute('draw.digitDot')).toBe(true);
      expect(liveReg.execute('draw.backspace')).toBe(true);
      expect(live.calls).toEqual(['drawDigit:4', 'drawDigit:.', 'drawBackspace']);
    });

    it('an EMPTY dimension box hands Backspace to the ring step-back', () => {
      // this is the whole point of splitting drawInputActive from
      // drawBufferActive: with nothing typed, draw.backspace must decline so
      // the next binding (draw.undoVertex) gets the key
      const plan = fakePlan(true, false);
      const reg = new CommandRegistry({
        store,
        editor,
        plan,
        modal,
        workspace: ws,
        help,
      });
      reg.registerAll(APP_COMMANDS);
      expect(reg.execute('draw.backspace')).toBe(false);
      expect(reg.execute('draw.undoVertex')).toBe(true);
      expect(plan.calls).toEqual(['undoDrawVertex']);
    });

    it.each([
      ['place', 'setArmed'],
      ['calibrate', 'setCalibrate:false'],
      ['measure', 'setMeasure:false'],
      ['drawRoom', 'cancelDrawRoom'],
    ] as const)('%s cancels through the plan port (%s)', (tool, call) => {
      editor.setTool(tool);
      reg.execute('tool.cancel');
      expect(plan.calls).toEqual([call]);
      expect(modal.calls).toEqual([]);
    });

    it('under select it drops the selection', () => {
      selectNewItem();
      reg.execute('tool.cancel');
      expect(editor.selection).toEqual({ kind: 'none' });
      expect(plan.calls).toEqual([]);
    });
  });

  describe('workspace.*', () => {
    it.each([
      ['workspace.plan', 'plan'],
      ['workspace.furnish', 'furnish'],
      ['workspace.workshop', 'workshop'],
      ['workspace.output', 'output'],
    ] as const)('%s switches to %s through the port', (id, want) => {
      expect(reg.execute(id)).toBe(true);
      expect(ws.calls).toEqual([want]);
      expect(ws.current).toBe(want);
    });

    it('has no guard — re-picking the live workspace still runs, and the port absorbs it', () => {
      expect(reg.canExecute('workspace.furnish')).toBe(true);
      expect(reg.execute('workspace.furnish')).toBe(true);
      expect(ws.calls).toEqual(['furnish']);
      expect(ws.current).toBe('furnish');
    });

    it('a refused switch is the port’s answer, not the command’s — it still ran', () => {
      ws.refuse = true;
      expect(reg.execute('workspace.plan')).toBe(true);
      expect(ws.calls).toEqual(['plan']);
      expect(ws.current).toBe('furnish');
    });

    it('switching workspace touches neither the design nor the undo stack', () => {
      const depth = store.canUndo();
      reg.execute('workspace.output');
      expect(store.canUndo()).toBe(depth);
      expect(plan.calls).toEqual([]);
      expect(modal.calls).toEqual([]);
    });
  });

  describe('help.shortcuts', () => {
    it('toggles the sheet through the port, with no guard', () => {
      expect(reg.canExecute('help.shortcuts')).toBe(true);
      expect(reg.execute('help.shortcuts')).toBe(true);
      expect(help.toggles).toBe(1);
      // the same key twice is close-again, which is the port's business
      reg.execute('help.shortcuts');
      expect(help.toggles).toBe(2);
    });

    it('touches neither the design, the undo stack nor any tool', () => {
      const depth = store.canUndo();
      editor.setTool('measure');
      reg.execute('help.shortcuts');
      expect(store.canUndo()).toBe(depth);
      expect(editor.isTool('measure')).toBe(true);
      expect(plan.calls).toEqual([]);
      expect(modal.calls).toEqual([]);
    });
  });

  /**
   * WS-SPEC WP 3.1 / decision D2. The blanket "a modal is open" keyboard
   * suppression is gone, so the commands that would edit something the covering
   * pane HIDES carry the precondition themselves — and undo, which is the whole
   * point of the change, deliberately does not.
   */
  describe('the covered-canvas guard', () => {
    const CANVAS_ONLY = [
      'selection.duplicate',
      'selection.delete',
      'transform.rotate90',
      'transform.rotate15',
      'transform.nudgeLeft',
      'transform.nudgeDownCoarse',
    ];

    it('blocks selection and transform commands in workshop and output', () => {
      selectNewItem();
      for (const id of CANVAS_ONLY) expect(reg.canExecute(id)).toBe(true);

      for (const w of ['workshop', 'output'] as const) {
        ws.current = w;
        for (const id of CANVAS_ONLY) expect(reg.canExecute(id), `${id} in ${w}`).toBe(false);
      }

      ws.current = 'plan';
      for (const id of CANVAS_ONLY) expect(reg.canExecute(id)).toBe(true);
    });

    it('leaves undo/redo alone — Ctrl+Z in the Workshop is the WP 3.1 feature', () => {
      const id = selectNewItem();
      const before = store.itemById(id)!.x;
      reg.execute('transform.nudgeRight');

      ws.current = 'workshop';
      expect(reg.canExecute('history.undo')).toBe(true);
      expect(reg.execute('history.undo')).toBe(true);
      expect(store.itemById(id)!.x).toBeCloseTo(before, 12);
      expect(reg.execute('history.redo')).toBe(true);
      expect(store.itemById(id)!.x).toBeCloseTo(before + 0.01, 12);
    });

    it('blocks the wall tool’s keys too — the plan is not on screen there', () => {
      const live = fakePlan(true);
      const liveReg = new CommandRegistry({
        store,
        editor,
        plan: live,
        modal,
        workspace: ws,
        help,
      });
      liveReg.registerAll(APP_COMMANDS);
      editor.setTool('drawRoom');
      expect(liveReg.canExecute('draw.digit4')).toBe(true);
      expect(liveReg.canExecute('tool.finish')).toBe(true);

      ws.current = 'workshop';
      expect(liveReg.execute('draw.digit4')).toBe(false);
      expect(liveReg.execute('draw.backspace')).toBe(false);
      expect(liveReg.execute('draw.undoVertex')).toBe(false);
      expect(liveReg.execute('draw.toggleField')).toBe(false);
      expect(liveReg.execute('tool.finish')).toBe(false);
      expect(liveReg.execute('tool.finishOpen')).toBe(false);
      expect(live.calls).toEqual([]);
    });
  });

  it('tool.finish only applies to the draw-room tool', () => {
    expect(reg.canExecute('tool.finish')).toBe(false);
    expect(reg.execute('tool.finish')).toBe(false);
    expect(plan.calls).toEqual([]);

    editor.setTool('drawRoom');
    expect(reg.execute('tool.finish')).toBe(true);
    expect(plan.calls).toEqual(['closeDrawRoom:false']);
  });

  it('tool.finishOpen forces the OPEN reading — never a room', () => {
    editor.setTool('drawRoom');
    expect(reg.execute('tool.finishOpen')).toBe(true);
    expect(plan.calls).toEqual(['closeDrawRoom:true']);
  });
});
