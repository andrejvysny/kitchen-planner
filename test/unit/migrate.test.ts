import { describe, expect, it } from 'vitest';
import { DESIGN_VERSION, MIN_MIGRATABLE_VERSION, migrate5to6, migrateDesign } from '../../src/model/migrate';

type Raw = Record<string, unknown>;

/** Minimal v5 payload: a 4×3 rectangle of wall CENTRELINES (pre-v6). */
function v5Design(): Raw {
  return {
    version: 5,
    corners: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4, y: 0 },
      { id: 'c', x: 4, y: 3 },
      { id: 'd', x: 0, y: 3 },
    ],
    room: { wallThickness: 0.2, wallColor: '#ffffff' },
    openings: [{ id: 'o1', wallId: 'a', type: 'door', offset: 1, width: 0.9, height: 2, sill: 0 }],
    items: [{ id: 'i1', defId: 'base-cabinet' }],
    wallVisibility: { a: 'hide' },
    ceilingVisibility: 'show',
  };
}

describe('DESIGN_VERSION / MIN_MIGRATABLE_VERSION', () => {
  it('pins the current constants', () => {
    expect(DESIGN_VERSION).toBe(6);
    expect(MIN_MIGRATABLE_VERSION).toBe(5);
  });
});

describe('migrate5to6', () => {
  it('insets corners by half the wall thickness, keeping their ids', () => {
    const d = migrate5to6(v5Design());
    const room = (d.rooms as Raw[])[0];
    const corners = room.corners as { id: string; x: number; y: number }[];
    expect(corners.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
    // wallThickness 0.2 => inset 0.1 on every side of the 4x3 rectangle
    const expected = [
      [0.1, 0.1],
      [3.9, 0.1],
      [3.9, 2.9],
      [0.1, 2.9],
    ];
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(expected[i][0]);
      expect(c.y).toBeCloseTo(expected[i][1]);
    });
  });

  it('re-projects openings onto the inset wall, keeping their world position', () => {
    const d = migrate5to6(v5Design());
    const opening = (d.openings as Raw[])[0];
    // old wall a->b was 4m at y=0; the door sat at world x=1. The new wall
    // (a->b inset to y=0.1) keeps the same along-wall id, offset re-measured.
    expect(opening.wallId).toBe('a');
    expect(opening.offset).toBeCloseTo(0.9);
  });

  it('folds the global room style + wall/ceiling visibility into rooms[0]', () => {
    const d = migrate5to6(v5Design());
    const room = (d.rooms as Raw[])[0];
    const style = room.style as Raw;
    expect(style.wallThickness).toBe(0.2);
    expect(style.wallColor).toBe('#ffffff');
    expect(room.wallVisibility).toEqual({ a: 'hide' });
    expect(room.ceilingVisibility).toBe('show');
  });

  it('stamps every item with the new room id and drops the v5-only fields', () => {
    const d = migrate5to6(v5Design());
    const room = (d.rooms as Raw[])[0];
    expect((d.items as Raw[])[0].roomId).toBe(room.id);
    expect(d.corners).toBeUndefined();
    expect(d.room).toBeUndefined();
    expect(d.wallVisibility).toBeUndefined();
    expect(d.ceilingVisibility).toBeUndefined();
    expect(d.version).toBe(6);
  });

  it('leaves rooms empty for an unusable (<3 corner) polygon instead of crashing', () => {
    const raw: Raw = {
      version: 5,
      corners: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1, y: 0 },
      ],
    };
    const d = migrate5to6(raw);
    expect(d.rooms).toEqual([]);
  });
});

describe('migrateDesign', () => {
  it('steps a v5 payload up to version 6', () => {
    const d = migrateDesign(v5Design())!;
    expect(d).not.toBeNull();
    expect(d.version).toBe(6);
    expect(Array.isArray(d.rooms)).toBe(true);
    expect((d.rooms as Raw[]).length).toBe(1);
  });

  it('passes a v6 payload through unchanged', () => {
    const v6: Raw = { version: 6, rooms: [], openings: [], items: [], customParts: [] };
    const out = migrateDesign({ ...v6 });
    expect(out).toEqual(v6);
  });

  it('returns null for a version below MIN_MIGRATABLE_VERSION (no migration path)', () => {
    expect(migrateDesign({ version: 4 })).toBeNull();
    expect(migrateDesign({ version: 1 })).toBeNull();
    expect(migrateDesign({ version: 0 })).toBeNull();
  });

  it('returns null for an absurd/unknown version with no registered step', () => {
    expect(migrateDesign({ version: 999 })).toBeNull();
    expect(migrateDesign({ version: 7 })).toBeNull();
  });

  it('returns null when the version field is missing, non-numeric or non-integer', () => {
    expect(migrateDesign({})).toBeNull();
    expect(migrateDesign({ version: '6' })).toBeNull();
    expect(migrateDesign({ version: null })).toBeNull();
    expect(migrateDesign({ version: 5.5 })).toBeNull();
    expect(migrateDesign({ version: NaN })).toBeNull();
  });
});
