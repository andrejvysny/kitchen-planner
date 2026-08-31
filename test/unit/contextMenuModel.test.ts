import { describe, expect, it } from 'vitest';
import { contextMenu, type ContextHit, type MenuOpts } from '../../src/ui/contextMenuModel';
import type { WorkspaceId } from '../../src/editor/commands/types';

// src/ui/contextMenuModel.ts — the right-click matrix (WS-SPEC §5.1, WP 2.1).
// Pure and DOM-free, like src/ui/outlineModel.ts: WHAT a right-click offers is
// a model decision, so it is asserted as a table here rather than through a
// rendered menu in an E2E spec (which only checks the wiring).

const ACTIVE = 'room-active';
const OTHER = 'room-other';

const opts = (over: Partial<MenuOpts> = {}): MenuOpts => ({
  multiRoom: false,
  activeRoomId: ACTIVE,
  ...over,
});

const ids = (hit: ContextHit, ws: WorkspaceId = 'plan', o: MenuOpts = opts()): string[] =>
  contextMenu(hit, ws, o).map((e) => e.id);

const ITEM: ContextHit = { kind: 'item', itemId: 'i1' };
const WALL: ContextHit = { kind: 'wall', wallId: 'w1', t: 1.2 };
const ROOM_ACTIVE: ContextHit = { kind: 'room', roomId: ACTIVE };
const ROOM_OTHER: ContextHit = { kind: 'room', roomId: OTHER };
const EMPTY: ContextHit = { kind: 'empty' };

const ALL_HITS: ContextHit[] = [ITEM, WALL, ROOM_ACTIVE, ROOM_OTHER, EMPTY];

describe('contextMenu — the entry matrix', () => {
  it('item: workshop, duplicate, rotate, delete — in that order', () => {
    expect(ids(ITEM)).toEqual(['edit-workshop', 'duplicate', 'rotate90', 'delete']);
  });

  it('wall: corner, door, window, length — colour only in Furnish, where its section lives', () => {
    expect(ids(WALL)).toEqual(['add-corner', 'add-door', 'add-window', 'wall-length']);
    expect(ids(WALL, 'furnish')).toEqual([
      'add-corner',
      'add-door',
      'add-window',
      'wall-length',
      'wall-colour',
    ]);
  });

  it('room: rename + the two shape presets, on a single-room design', () => {
    expect(ids(ROOM_ACTIVE)).toEqual(['rename-room', 'shape-rect', 'shape-l']);
  });

  it('empty floor in Plan offers the one wall tool', () => {
    expect(ids(EMPTY)).toEqual(['draw-room']);
  });
});

describe('contextMenu — the omissions', () => {
  it('omits "Make active room" for the room that is already active', () => {
    expect(ids(ROOM_ACTIVE)).not.toContain('activate-room');
    expect(ids(ROOM_OTHER)[0]).toBe('activate-room');
  });

  it('omits "Delete room" while there is only one room (the store would refuse)', () => {
    expect(ids(ROOM_ACTIVE)).not.toContain('delete-room');
    expect(ids(ROOM_ACTIVE, 'plan', opts({ multiRoom: true }))).toContain('delete-room');
  });

  it('delete-room is last and flagged danger', () => {
    const entries = contextMenu(ROOM_OTHER, 'plan', opts({ multiRoom: true }));
    expect(entries.map((e) => e.id)).toEqual([
      'activate-room',
      'rename-room',
      'shape-rect',
      'shape-l',
      'delete-room',
    ]);
    expect(entries[entries.length - 1].danger).toBe(true);
  });

  it('empty floor offers nothing in Furnish — there is no room tool there', () => {
    expect(ids(EMPTY, 'furnish')).toEqual([]);
  });
});

describe('contextMenu — workspace gating', () => {
  it('every hit yields an empty menu in Workshop and Output', () => {
    for (const ws of ['workshop', 'output'] as const) {
      for (const hit of ALL_HITS) {
        expect(ids(hit, ws, opts({ multiRoom: true })), `${hit.kind} in ${ws}`).toEqual([]);
      }
    }
  });

  it('item menus are identical in Plan and Furnish; wall differs only by colour', () => {
    expect(ids(ITEM, 'furnish')).toEqual(ids(ITEM, 'plan'));
    expect(ids(WALL, 'furnish')).toEqual([...ids(WALL, 'plan'), 'wall-colour']);
  });

  it('room menus are identical in Plan and Furnish', () => {
    const o = opts({ multiRoom: true });
    expect(ids(ROOM_OTHER, 'furnish', o)).toEqual(ids(ROOM_OTHER, 'plan', o));
  });
});

describe('contextMenu — the entries themselves', () => {
  it('every entry has a non-empty id and label, and ids are unique per menu', () => {
    for (const ws of ['plan', 'furnish'] as const) {
      for (const hit of ALL_HITS) {
        const entries = contextMenu(hit, ws, opts({ multiRoom: true }));
        for (const e of entries) {
          expect(e.id.length).toBeGreaterThan(0);
          expect(e.label.length).toBeGreaterThan(0);
        }
        expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
      }
    }
  });

  it('teaches the keyboard route for the three commands that have one', () => {
    const byId = new Map(contextMenu(ITEM, 'plan', opts()).map((e) => [e.id, e.hint]));
    expect(byId.get('duplicate')).toBe('Ctrl+D');
    expect(byId.get('rotate90')).toBe('R');
    expect(byId.get('delete')).toBe('Delete');
    // the one entry with no shortcut says so by staying silent
    expect(byId.get('edit-workshop')).toBeUndefined();
  });

  it('teaches the mouse route where the shortcut is a gesture', () => {
    const addCorner = contextMenu(WALL, 'plan', opts()).find((e) => e.id === 'add-corner');
    expect(addCorner?.hint).toBe('double-click');
  });

  it('offers "Fit to alcove" only when the hit item resolves to a fittable part, before Duplicate', () => {
    expect(ids(ITEM)).not.toContain('fit-room');
    expect(ids(ITEM, 'plan', opts({ itemFittable: true }))).toEqual([
      'edit-workshop',
      'fit-room',
      'duplicate',
      'rotate90',
      'delete',
    ]);
  });

  it('marks exactly one destructive entry per menu, never more', () => {
    for (const hit of ALL_HITS) {
      const danger = contextMenu(hit, 'plan', opts({ multiRoom: true })).filter((e) => e.danger);
      expect(danger.length).toBeLessThanOrEqual(1);
    }
  });

  it('is submenu-free and short: at most five rows anywhere', () => {
    for (const hit of ALL_HITS) {
      expect(contextMenu(hit, 'plan', opts({ multiRoom: true })).length).toBeLessThanOrEqual(5);
    }
  });
});
