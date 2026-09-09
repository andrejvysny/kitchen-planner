import { beforeEach, describe, expect, it } from 'vitest';
import { MeasureTool } from '../../../src/editor/tools/MeasureTool';
import { ToolManager } from '../../../src/editor/tools/ToolManager';
import type { Tool, ToolContext } from '../../../src/editor/tools/Tool';
import type { PointerInput } from '../../../src/editor/input/types';
import { EditorState } from '../../../src/editor/editorState';
import { contextMaterial } from '../../../src/model/snap';
import type { SnapContext } from '../../../src/model/snap';
import { demoDesign, Store } from '../../../src/model/store';
import type { Point } from '../../../src/model/types';

// The first tool extracted out of Plan2D (M12-A). The whole point of the
// DOM-free `PointerInput` boundary is that the gesture is drivable from plain
// objects, with no canvas, no view and no browser — so this file never touches
// one, and any regression that needs a Playwright run to see is a sign the
// boundary leaked.

/** A single wall along y = 0 from (0,0) to (4,0), plus its ends and midpoint. */
function material(): SnapContext {
  const mat = contextMaterial([{ a: { x: 0, y: 0 }, b: { x: 4, y: 0 } }]);
  return { ...mat, chain: [], anchor: null };
}

interface Harness {
  tool: MeasureTool;
  ctx: ToolContext;
  hints: string[];
  draws: number;
}

function harness(snapContext: () => SnapContext = material): Harness {
  const store = new Store(demoDesign());
  const editor = new EditorState();
  const h: Harness = {
    tool: new MeasureTool({ snapContext, hitRadius: (px) => px }),
    hints: [],
    draws: 0,
    ctx: {
      store,
      editor,
      // 100 px per metre: an 11 px reach is 0.11 m, so a click 5 cm off a
      // corner snaps and one 50 cm off does not
      zoom: 100,
      requestDraw: () => {
        h.draws++;
      },
      setHint: (t) => h.hints.push(t),
    },
  };
  return h;
}

function ptr(phase: 'down' | 'move' | 'up', world: Point, screen?: Point): PointerInput {
  return {
    phase,
    pointerId: 1,
    pointerType: 'mouse',
    // screen defaults to world × the harness zoom, so a caller that cares only
    // about geometry gets a consistent screen distance for free
    screen: screen ?? { x: world.x * 100, y: world.y * 100 },
    world,
    button: phase === 'up' ? 'none' : 'primary',
    shift: false,
    alt: false,
    ctrl: false,
    meta: false,
  };
}

describe('MeasureTool', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('starts empty and hints for the first point', () => {
    h.tool.activate(h.ctx);
    expect(h.tool.state).toEqual({
      a: null,
      b: null,
      hover: null,
      snapped: false,
      measuring: false,
    });
    expect(h.hints[h.hints.length - 1]).toContain('Click two points');
  });

  it('two clicks close a span, and the second hint asks for the second point', () => {
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    expect(h.tool.state.measuring).toBe(true);
    expect(h.hints[h.hints.length - 1]).toContain('second point');

    h.tool.pointerDown(ptr('down', { x: 3, y: 1 }), h.ctx);
    expect(h.tool.state.measuring).toBe(false);
    expect(h.tool.state.a).toEqual({ x: 1, y: 1 });
    expect(h.tool.state.b).toEqual({ x: 3, y: 1 });
  });

  it('a drag past the slop closes the span on pointerup', () => {
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    h.tool.pointerMove(ptr('move', { x: 2, y: 1 }), h.ctx);
    h.tool.pointerUp(ptr('up', { x: 2, y: 1 }), h.ctx);
    expect(h.tool.state.b).toEqual({ x: 2, y: 1 });
    expect(h.tool.state.measuring).toBe(false);
  });

  it('a press that never travelled stays open, waiting for a second click', () => {
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    // 2 px of jitter, under the 4 px slop
    h.tool.pointerMove(ptr('move', { x: 1.02, y: 1 }, { x: 102, y: 100 }), h.ctx);
    h.tool.pointerUp(ptr('up', { x: 1.02, y: 1 }, { x: 102, y: 100 }), h.ctx);
    expect(h.tool.state.b).toBe(null);
    expect(h.tool.state.measuring).toBe(true);
  });

  it('a stray pointerup passes through, so the host still runs its own teardown', () => {
    h.tool.activate(h.ctx);
    expect(h.tool.pointerUp(ptr('up', { x: 1, y: 1 }), h.ctx)).toBe('passthrough');
  });

  it('snaps to a wall end and reports it; a point in open floor stays free', () => {
    h.tool.activate(h.ctx);
    // 3 cm from the wall's (4,0) end, inside the 11 px / 100 px-per-m reach
    h.tool.pointerDown(ptr('down', { x: 3.97, y: 0 }), h.ctx);
    expect(h.tool.state.a).toEqual({ x: 4, y: 0 });
    expect(h.tool.state.snapped).toBe(true);

    h.tool.pointerMove(ptr('move', { x: 2, y: 2 }), h.ctx);
    expect(h.tool.state.hover).toEqual({ x: 2, y: 2 });
    expect(h.tool.state.snapped).toBe(false);
  });

  it('never touches the design — it reads the drawing', () => {
    const before = JSON.stringify(h.ctx.store.design);
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    h.tool.pointerDown(ptr('down', { x: 3, y: 1 }), h.ctx);
    expect(JSON.stringify(h.ctx.store.design)).toBe(before);
  });

  describe('cancel is two-stage', () => {
    it('drops a span in progress and keeps the tool', () => {
      h.tool.activate(h.ctx);
      h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
      expect(h.tool.cancel(h.ctx)).toBe('handled');
      expect(h.tool.state.a).toBe(null);
      expect(h.tool.state.measuring).toBe(false);
    });

    it('passes a COMPLETED span through — Escape over a result leaves the tool', () => {
      h.tool.activate(h.ctx);
      h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
      h.tool.pointerDown(ptr('down', { x: 3, y: 1 }), h.ctx);
      expect(h.tool.cancel(h.ctx)).toBe('passthrough');
      expect(h.tool.state.b).not.toBe(null);
    });

    it('passes through with nothing to cancel, so the host may leave the tool', () => {
      h.tool.activate(h.ctx);
      expect(h.tool.cancel(h.ctx)).toBe('passthrough');
    });
  });

  it('deactivate drops a half-measurement rather than leaving it painted', () => {
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    h.tool.deactivate(h.ctx);
    expect(h.tool.state.a).toBe(null);
    expect(h.tool.snap).toBe(null);
  });

  it('clear() drops the span without leaving the tool (the host entry reset)', () => {
    h.tool.activate(h.ctx);
    h.tool.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    h.tool.clear();
    expect(h.tool.state.measuring).toBe(false);
  });
});

describe('ToolManager', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('routes nothing and answers passthrough until a tool is entered', () => {
    const m = new ToolManager();
    m.register(h.tool);
    expect(m.active).toBe(null);
    expect(m.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx)).toBe('passthrough');
    expect(m.cancel(h.ctx)).toBe('passthrough');
  });

  it('an UNREGISTERED id is not an error — it just means no tool of ours is live', () => {
    const m = new ToolManager();
    m.register(h.tool);
    m.setTool('measure', h.ctx);
    expect(m.active).toBe(h.tool);
    // drawRoom still lives inside Plan2D
    m.setTool('drawRoom', h.ctx);
    expect(m.active).toBe(null);
    expect(m.pointerMove(ptr('move', { x: 1, y: 1 }), h.ctx)).toBe('passthrough');
  });

  it('leaving a tool deactivates it, so its overlay cannot outlive the switch', () => {
    const m = new ToolManager();
    m.register(h.tool);
    m.setTool('measure', h.ctx);
    m.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    expect(h.tool.state.a).not.toBe(null);
    m.setTool('select', h.ctx);
    expect(h.tool.state.a).toBe(null);
  });

  it('re-entering the live tool is a no-op, so a reconcile pass cannot restart it', () => {
    const m = new ToolManager();
    m.register(h.tool);
    m.setTool('measure', h.ctx);
    m.pointerDown(ptr('down', { x: 1, y: 1 }), h.ctx);
    m.setTool('measure', h.ctx);
    expect(h.tool.state.measuring).toBe(true);
  });

  it('get() finds a registered tool and answers null for anything else', () => {
    const m = new ToolManager();
    m.register(h.tool);
    expect(m.get<MeasureTool>('measure')).toBe(h.tool);
    expect(m.get<Tool>('nope')).toBe(null);
  });
});
