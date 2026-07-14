import { describe, expect, it } from 'vitest';
import { sanitizeDesign, Store } from '../../src/model/store';
import {
  detach,
  isVarRef,
  refId,
  resolveColor,
  resolveFinish,
  toVarRef,
  VAR_FALLBACK,
} from '../../src/model/variables';
import type { Corner, Design } from '../../src/model/types';

const c = (id: string, x: number, y: number): Corner => ({ id, x, y });
const CORNERS = [c('a', 0, 0), c('b', 4, 0), c('d', 4, 3)];

/** A resolver design carrying one oak-textured variable "sage". */
function designWith(): Design {
  return {
    variables: [{ id: 'sage', name: 'Sage', color: '#8a9683', material: 'oak', materialRot: true }],
  } as unknown as Design;
}

describe('variables — ref helpers', () => {
  it('detects and round-trips var refs', () => {
    expect(isVarRef('var:sage')).toBe(true);
    expect(isVarRef('#8a9683')).toBe(false);
    expect(isVarRef(undefined)).toBe(false);
    expect(refId(toVarRef('sage'))).toBe('sage');
  });
});

describe('variables — resolveFinish / resolveColor', () => {
  const design = designWith();

  it('passes literal colours straight through', () => {
    expect(resolveFinish(design, '#123456', 'walnut', true)).toEqual({
      color: '#123456',
      material: 'walnut',
      rot: true,
    });
    expect(resolveColor(design, '#123456')).toBe('#123456');
  });

  it('resolves a ref to the variable full finish (colour + texture)', () => {
    // a bound slot takes the whole finish from the variable, ignoring its own material
    expect(resolveFinish(design, toVarRef('sage'), 'walnut', false)).toEqual({
      color: '#8a9683',
      material: 'oak',
      rot: true,
    });
    expect(resolveColor(design, toVarRef('sage'))).toBe('#8a9683');
  });

  it('falls back for a dangling ref', () => {
    expect(resolveFinish(design, toVarRef('gone'))).toEqual({ color: VAR_FALLBACK });
    expect(resolveColor(design, toVarRef('gone'))).toBe(VAR_FALLBACK);
    expect(detach(design, toVarRef('gone'))).toEqual({ color: VAR_FALLBACK });
  });
});

describe('variables — sanitizeDesign migration & repair', () => {
  it('adds an empty variables registry to a v3 design (v3 → v4)', () => {
    const d = sanitizeDesign({ version: 3, corners: CORNERS })!;
    expect(d).not.toBeNull();
    expect(d.version).toBe(4);
    expect(d.variables).toEqual([]);
  });

  it('drops malformed variables and unknown material ids', () => {
    const d = sanitizeDesign({
      version: 4,
      corners: CORNERS,
      variables: [
        { id: 'ok', name: 'Ok', color: '#fff', material: 'oak', materialRot: true },
        { id: 'badMat', name: 'BadMat', color: '#000', material: 'nope', materialRot: 'yes' },
        { id: 'noColor', name: 'NoColor' }, // missing color → dropped
        { name: 'NoId', color: '#111' }, // missing id → dropped
        { id: 'ok', name: 'Dup', color: '#222' }, // duplicate id → dropped
      ],
    })!;
    expect(d.variables.map((v) => v.id)).toEqual(['ok', 'badMat']);
    expect(d.variables[0]).toEqual({ id: 'ok', name: 'Ok', color: '#fff', material: 'oak', materialRot: true });
    // unknown material dropped; non-literal-true rot dropped
    expect(d.variables[1].material).toBeUndefined();
    expect(d.variables[1].materialRot).toBeUndefined();
  });

  it('detaches dangling var refs on items and room to the fallback', () => {
    const d = sanitizeDesign({
      version: 4,
      corners: CORNERS,
      variables: [{ id: 'live', name: 'Live', color: '#abcdef' }],
      items: [
        { id: 'i1', defId: 'base-cabinet', x: 1, y: 1, rotation: 0, w: 0.6, d: 0.6, h: 0.9, elevation: 0, color: 'var:live' },
        { id: 'i2', defId: 'base-cabinet', x: 2, y: 1, rotation: 0, w: 0.6, d: 0.6, h: 0.9, elevation: 0, color: 'var:gone', accentColor: 'var:gone' },
      ],
      room: { wallColor: 'var:gone', floorColor: '#cfccc6', counterColor: 'var:live', wallHeight: 2.6, wallThickness: 0.1 },
      defaultFrontVar: 'gone',
    })!;
    const i1 = d.items.find((i) => i.id === 'i1')!;
    const i2 = d.items.find((i) => i.id === 'i2')!;
    expect(i1.color).toBe('var:live'); // live ref preserved
    expect(i2.color).toBe(VAR_FALLBACK); // dangling detached
    expect(i2.accentColor).toBe(VAR_FALLBACK);
    expect(d.room.wallColor).toBe(VAR_FALLBACK);
    expect(d.room.counterColor).toBe('var:live');
    expect(d.defaultFrontVar).toBeUndefined(); // default pointing nowhere cleared
  });
});

describe('variables — store mutations', () => {
  function store(): Store {
    return new Store(sanitizeDesign({ version: 4, corners: CORNERS })!);
  }

  it('addVariable then bind an item and resolve live', () => {
    const s = store();
    const v = s.addVariable({ name: 'Sage', color: '#8a9683' });
    const def = s.defOf('base-cabinet');
    const it = s.addItem(def, 1, 1);
    s.updateItem(it.id, { color: toVarRef(v.id) });
    expect(resolveColor(s.design, s.itemById(it.id)!.color)).toBe('#8a9683');
    s.updateVariable(v.id, { color: '#31455a' });
    expect(resolveColor(s.design, s.itemById(it.id)!.color)).toBe('#31455a');
  });

  it('deleteVariable inlines the resolved finish into every reference (no data loss)', () => {
    const s = store();
    const v = s.addVariable({ name: 'Oak', color: '#c9a87c', material: 'oak' });
    const def = s.defOf('base-cabinet');
    const it = s.addItem(def, 1, 1);
    s.updateItem(it.id, { color: toVarRef(v.id) });
    s.setRoomStyle({ wallColor: toVarRef(v.id) });
    s.setDefaultVar('front', v.id);

    s.deleteVariable(v.id);
    expect(s.design.variables).toHaveLength(0);
    // the bound slots keep the colour the variable was showing, plus its material
    const inlined = s.itemById(it.id)!;
    expect(inlined.color).toBe('#c9a87c');
    expect(inlined.material).toBe('oak');
    expect(s.design.room.wallColor).toBe('#c9a87c');
    expect(s.design.defaultFrontVar).toBeUndefined();
  });

  it('applyVarToItems binds every front-painted item', () => {
    const s = store();
    const v = s.addVariable();
    const cab = s.addItem(s.defOf('base-cabinet'), 1, 1);
    const outlet = s.addItem(s.defOf('outlet'), 2, 0); // marker — never bound
    const n = s.applyVarToItems(v.id, 'front');
    expect(n).toBe(1);
    expect(s.itemById(cab.id)!.color).toBe(toVarRef(v.id));
    expect(isVarRef(s.itemById(outlet.id)!.color)).toBe(false);
  });

  it('new items adopt the default front variable', () => {
    const s = store();
    const v = s.addVariable();
    s.setDefaultVar('front', v.id);
    const it = s.addItem(s.defOf('base-cabinet'), 1, 1);
    expect(it.color).toBe(toVarRef(v.id));
    // markers never adopt it
    const outlet = s.addItem(s.defOf('outlet'), 2, 0);
    expect(isVarRef(outlet.color)).toBe(false);
  });
});
