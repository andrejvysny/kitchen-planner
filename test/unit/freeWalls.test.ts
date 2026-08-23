import { describe, expect, it } from 'vitest';
import { EditorState } from '../../src/editor/editorState';
import { syncSelection } from '../../src/editor/selectionSync';
import { DEFAULT_WALL_W, NO_ROOM, designWalls, freeWallGeoms } from '../../src/model/rooms';
import { catalogDef } from '../../src/model/catalog';
import { emptyDesign, Store } from '../../src/model/store';
import type { FreeWall } from '../../src/model/types';

/**
 * Free-standing wall chains (`design.walls`) — dividers, peninsulas, stubs.
 *
 * The contract worth pinning is that a chain is NOT a special case downstream:
 * it arrives through `store.allWalls()` in the same `RoomWall` shape a room
 * ring produces, which is what lets the plan, View3D and `wallJoints` draw one
 * without a line of code of their own.
 */

function store(): Store {
  const s = new Store(emptyDesign());
  s.addRoom({ at: { x: 0, y: 0 }, w: 4, d: 3 });
  s.commit();
  return s;
}

describe('freeWallGeoms', () => {
  const chain: FreeWall = {
    id: 'w1',
    corners: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 2, y: 0 },
      { id: 'c', x: 2, y: 2 },
    ],
    thickness: 0.2,
  };

  it('an OPEN chain of n corners yields n-1 walls, not n', () => {
    const walls = freeWallGeoms([chain]);
    expect(walls).toHaveLength(2);
    expect(walls.map((w) => w.id)).toEqual(['a', 'b']);
  });

  it('the slab STRADDLES the polyline — a chain has no interior side', () => {
    for (const w of freeWallGeoms([chain])) {
      expect(w.faceOffset).toBeCloseTo(w.thickness / 2, 12);
      expect(w.thickness).toBeCloseTo(0.2, 12);
    }
  });

  it('carries NO_ROOM plus the chain id, so consumers can tell it apart', () => {
    for (const w of freeWallGeoms([chain])) {
      expect(w.roomId).toBe(NO_ROOM);
      expect(w.freeWallId).toBe('w1');
      expect(w.shared).toBeNull();
    }
  });

  it('a per-segment override beats the chain thickness', () => {
    const [first, second] = freeWallGeoms([{ ...chain, wallWidths: { a: 0.35 } }]);
    expect(first.thickness).toBeCloseTo(0.35, 12);
    expect(second.thickness).toBeCloseTo(0.2, 12);
  });

  it('zero-length segments and empty input are skipped, never emitted', () => {
    expect(freeWallGeoms(undefined)).toEqual([]);
    expect(freeWallGeoms([])).toEqual([]);
    const dupe: FreeWall = {
      id: 'w2',
      corners: [
        { id: 'a', x: 1, y: 1 },
        { id: 'b', x: 1, y: 1 },
      ],
      thickness: 0.1,
    };
    expect(freeWallGeoms([dupe])).toEqual([]);
  });
});

describe('designWalls', () => {
  it('room rings first, then the chains', () => {
    const s = store();
    s.addFreeWall(
      [
        { x: 8, y: 0 },
        { x: 10, y: 0 },
      ],
      0.115
    );
    const all = designWalls(s.design.rooms, s.design.walls);
    expect(all.filter((w) => !w.freeWallId)).toHaveLength(4);
    expect(all.filter((w) => w.freeWallId)).toHaveLength(1);
    expect(all[all.length - 1].freeWallId).toBeTruthy();
  });
});

describe('store: free wall chains', () => {
  it('addFreeWall stores the polyline AS DRAWN — no face inset', () => {
    const s = store();
    const chain = s.addFreeWall(
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
      0.2
    )!;
    expect(chain).toBeTruthy();
    expect(chain.corners.map((c) => [c.x, c.y])).toEqual([
      [1, 1],
      [3, 1],
    ]);
    expect(chain.thickness).toBeCloseTo(0.2, 12);
  });

  it('points closer than a wall segment collapse; under two survivors is refused', () => {
    const s = store();
    expect(
      s.addFreeWall(
        [
          { x: 1, y: 1 },
          { x: 1.01, y: 1 },
        ],
        0.115
      )
    ).toBeNull();
    expect(s.addFreeWall([{ x: 1, y: 1 }], 0.115)).toBeNull();
    expect(s.design.walls ?? []).toHaveLength(0);
  });

  it('the width clamps to the same range a per-wall override takes', () => {
    const s = store();
    expect(
      s.addFreeWall(
        [
          { x: 0, y: 8 },
          { x: 2, y: 8 },
        ],
        9
      )!.thickness
    ).toBeCloseTo(0.4, 12);
    expect(
      s.addFreeWall(
        [
          { x: 0, y: 9 },
          { x: 2, y: 9 },
        ],
        0.001
      )!.thickness
    ).toBeCloseTo(0.05, 12);
  });

  it('wallById and cornerById reach into chains — one id space with the rooms', () => {
    const s = store();
    const chain = s.addFreeWall(
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
      0.115
    )!;
    const id = chain.corners[0].id;
    expect(s.wallById(id)?.freeWallId).toBe(chain.id);
    expect(s.cornerById(id)).toMatchObject({ x: 1, y: 1 });
    expect(s.freeWallOf(id)?.id).toBe(chain.id);
  });

  it('per-segment width lands on the CHAIN, not on a room', () => {
    const s = store();
    const chain = s.addFreeWall(
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
      0.115
    )!;
    const id = chain.corners[0].id;
    expect(s.hasWallWidthOverride(id)).toBe(false);
    s.setWallWidth(id, 0.3);
    expect(s.hasWallWidthOverride(id)).toBe(true);
    expect(s.wallById(id)!.thickness).toBeCloseTo(0.3, 12);
    // and no room was touched
    for (const r of s.design.rooms) expect(r.wallWidths ?? {}).toEqual({});
    s.setWallWidth(id, null);
    expect(s.wallById(id)!.thickness).toBeCloseTo(0.115, 12);
  });

  it('deleteFreeWall drops the chain, its openings and the selection', () => {
    const s = store();
    const chain = s.addFreeWall(
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
      0.115
    )!;
    const id = chain.corners[0].id;
    s.addOpening(catalogDef('door'), id, 1);
    expect(s.design.openings.filter((o) => o.wallId === id)).toHaveLength(1);
    const editor = new EditorState();
    syncSelection(s, editor);
    editor.select({ kind: 'wall', id });

    expect(s.deleteFreeWall(chain.id)).toBe(true);
    expect(s.design.walls).toHaveLength(0);
    expect(s.design.openings.filter((o) => o.wallId === id)).toHaveLength(0);
    expect(editor.selection.kind).toBe('none');
    expect(s.deleteFreeWall(chain.id)).toBe(false);
  });

  it('a chain never becomes half of a partition, however it lies', () => {
    const s = store();
    // laid exactly along the room's right wall centreline
    s.addFreeWall(
      [
        { x: 4, y: 0 },
        { x: 4, y: 3 },
      ],
      DEFAULT_WALL_W
    );
    s.commit();
    expect(s.allWalls().filter((w) => w.shared)).toHaveLength(0);
  });
});
