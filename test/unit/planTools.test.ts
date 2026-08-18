import { describe, expect, it } from 'vitest';
import { EditorState } from '../../src/editor/editorState';
import { toCatalogDef } from '../../src/model/parts';
import { demoDesign, Store } from '../../src/model/store';
import { DEFAULT_WALL_W } from '../../src/model/rooms';
import { Plan2D } from '../../src/plan2d/plan2d';

// src/plan2d/plan2d.ts — the EditorState seam. Plan2D is constructed DETACHED
// and subscribes to the editor in its CONSTRUCTOR, so everything below runs in
// plain node without a canvas: no attach(), no DOM, no rAF (requestDraw() is a
// no-op while detached). What is pinned here is that the six tool fields are
// mirrors of EditorState and that the delegates only ever write back to it.
//
// The in-flight overlays (measure span, room ghost, draw ring) need real
// pointer gestures, so their entry-reset parity lives in e2e/tools.spec.ts.

/** The most recent hint the view raised. (`Array.prototype.at` is off-target here.) */
function last(hints: string[]): string | undefined {
  return hints[hints.length - 1];
}

function setup(): { store: Store; editor: EditorState; plan: Plan2D; hints: string[] } {
  const store = new Store(demoDesign());
  const editor = new EditorState();
  const hints: string[] = [];
  const plan = new Plan2D(store, editor, (h) => hints.push(h));
  return { store, editor, plan, hints };
}

describe('Plan2D ↔ EditorState', () => {
  it('every setX delegates to the editor instead of holding its own flag', () => {
    const { store, editor, plan } = setup();

    plan.setMeasure(true);
    expect(editor.tool).toBe('measure');
    plan.setCalibrate(true);
    expect(editor.tool).toBe('calibrate');
    plan.setDrawRoom(true);
    expect(editor.tool).toBe('drawRoom');
    plan.setArmed(toCatalogDef(store.partOf('base-cabinet')!));
    expect(editor.tool).toBe('place');
    expect(editor.armedDefId).toBe('base-cabinet');

    plan.setChecks(true);
    expect(editor.checksOn).toBe(true);

    plan.setDrawRoom(false);
    expect(editor.tool).toBe('select');
    expect(editor.armedDefId).toBe(null);
  });

  it('toolState() is a projection of the editor, tool for tool', () => {
    const { editor, plan } = setup();
    expect(plan.toolState()).toEqual({
      armedDefId: null,
      measure: false,
      calibrate: false,
      draw: false,
      checks: false,
      wallWidth: DEFAULT_WALL_W,
    });

    for (const [tool, field] of [
      ['measure', 'measure'],
      ['calibrate', 'calibrate'],
      ['drawRoom', 'draw'],
    ] as const) {
      editor.setTool(tool);
      const st = plan.toolState();
      expect(st[field], `${tool} → toolState().${field}`).toBe(true);
      // exactly one gesture tool at a time
      expect([st.measure, st.calibrate, st.draw].filter(Boolean)).toHaveLength(1);
    }

    editor.setTool('place', 'base-cabinet');
    expect(plan.toolState().armedDefId).toBe('base-cabinet');
    expect(plan.toolState().measure).toBe(false);

    // the checks LAYER is orthogonal: it survives every tool switch
    editor.setChecks(true);
    expect(plan.toolState().checks).toBe(true);
    expect(plan.checksOn).toBe(true);
    editor.setTool('select');
    expect(plan.toolState()).toEqual({
      armedDefId: null,
      measure: false,
      calibrate: false,
      draw: false,
      checks: true,
      wallWidth: DEFAULT_WALL_W,
    });
  });

  it('the wall width is a tool preference, mirrored into toolState()', () => {
    const { editor, plan } = setup();
    editor.setWallWidth(0.24);
    expect(plan.toolState().wallWidth).toBeCloseTo(0.24, 12);
    // clamped to the same range a per-wall override takes
    editor.setWallWidth(9);
    expect(plan.toolState().wallWidth).toBeCloseTo(0.4, 12);
    editor.setWallWidth(0.001);
    expect(plan.toolState().wallWidth).toBeCloseTo(0.05, 12);
  });

  it('the armed def object survives the round-trip through the editor', () => {
    const { store, editor, plan } = setup();
    const def = store.defOf('base-cabinet');

    plan.setArmed(def);
    expect(editor.armedDefId).toBe('base-cabinet');
    // identity, not just equality: the ghost and the catalog compare objects
    expect(plan.armedDef).toBe(def);

    plan.setArmed(null);
    expect(plan.armedDef).toBe(null);
    expect(editor.tool).toBe('select');
  });

  it('an armed id that resolves nowhere yields null instead of throwing', () => {
    const { store, editor, plan } = setup();

    // store.defOf() THROWS on an unknown id — a stale armedDefId (the custom
    // part it named was deleted under the tool) must not take the view with it
    expect(() => store.defOf('gone-part')).toThrow();
    expect(() => editor.setTool('place', 'gone-part')).not.toThrow();
    expect(plan.armedDef).toBe(null);
    expect(plan.toolState().armedDefId).toBe(null);

    // an id nobody handed to setArmed still resolves, from the presets
    editor.setTool('place', 'base-cabinet');
    expect(plan.armedDef?.id).toBe('base-cabinet');
  });

  it('the hint follows the tool, from the editor alone', () => {
    const { editor, plan, hints } = setup();
    hints.length = 0;

    editor.setTool('measure');
    expect(last(hints)).toMatch(/measure/i);
    editor.setTool('drawRoom');
    expect(last(hints)).toMatch(/rectangle|corner/i);
    editor.setTool('calibrate');
    expect(last(hints)).toMatch(/known|distance/i);
    editor.setTool('select');
    expect(last(hints)).toMatch(/drag/i);
    expect(plan.toolState().measure).toBe(false);
  });

  it('dispose() drops the editor subscription it took in the constructor', () => {
    const { editor, plan, hints } = setup();
    editor.setTool('measure');
    expect(plan.toolState().measure).toBe(true);

    plan.dispose();
    plan.dispose(); // idempotent
    hints.length = 0;

    editor.setTool('drawRoom');
    expect(hints).toEqual([]);
    expect(plan.toolState().measure).toBe(true); // frozen at the last sync
  });
});
