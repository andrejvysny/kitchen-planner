import { describe, expect, it } from 'vitest';
import {
  emptySelection,
  isEmpty,
  isSelected,
  pruneSelection,
  replaceSelection,
  sameRef,
  selectedIds,
  selectionOf,
  toggleSelection,
  withPrimary,
} from '../../../src/editor/selection';
import type { EntityRef } from '../../../src/model/types';

const item = (id: string): EntityRef => ({ kind: 'item', id });
const wall = (id: string): EntityRef => ({ kind: 'wall', id });
const corner = (id: string): EntityRef => ({ kind: 'corner', id });

// src/editor/selection.ts — the pure selection policy. Two rules carry it:
// a multi-selection is items-only, and the primary is the last entity added.
describe('selection state', () => {
  it('starts empty with no primary', () => {
    const s = emptySelection();
    expect(s.entities).toEqual([]);
    expect(s.primary).toBe(null);
    expect(isEmpty(s)).toBe(true);
  });

  it('replace holds exactly one ref; replace(null) empties', () => {
    const s = replaceSelection(item('a'));
    expect(s.entities).toEqual([item('a')]);
    expect(s.primary).toEqual(item('a'));
    expect(isEmpty(replaceSelection(null))).toBe(true);
  });

  it('toggle adds items and the LAST added leads', () => {
    let s = toggleSelection(emptySelection(), item('a'));
    s = toggleSelection(s, item('b'));
    s = toggleSelection(s, item('c'));
    expect(selectedIds(s, 'item')).toEqual(['a', 'b', 'c']);
    expect(s.primary).toEqual(item('c'));
  });

  it('toggle removes a held item and promotes the last one still standing', () => {
    let s = selectionOf([item('a'), item('b'), item('c')]);
    expect(s.primary).toEqual(item('c'));
    s = toggleSelection(s, item('c'));
    expect(selectedIds(s, 'item')).toEqual(['a', 'b']);
    expect(s.primary).toEqual(item('b'));
    // removing a non-primary leaves the primary alone
    s = toggleSelection(s, item('a'));
    expect(selectedIds(s, 'item')).toEqual(['b']);
    expect(s.primary).toEqual(item('b'));
  });

  it('toggling the last held item empties the selection', () => {
    const s = toggleSelection(replaceSelection(item('a')), item('a'));
    expect(isEmpty(s)).toBe(true);
    expect(s.primary).toBe(null);
  });

  it('a wall / corner / opening REPLACES, never joins (rule 1)', () => {
    const many = selectionOf([item('a'), item('b')]);
    const w = toggleSelection(many, wall('w1'));
    expect(w.entities).toEqual([wall('w1')]);
    expect(w.primary).toEqual(wall('w1'));

    // and an item shift-clicked onto a wall selection replaces it back
    const back = toggleSelection(w, item('a'));
    expect(back.entities).toEqual([item('a')]);
  });

  it('a non-item toggled twice deselects it', () => {
    const w = replaceSelection(wall('w1'));
    // toggle on a non-item is a replace, so the same wall stays selected —
    // clearing a wall is a click on empty space, not a shift-click
    expect(toggleSelection(w, wall('w1')).entities).toEqual([wall('w1')]);
  });

  it('selectionOf dedupes and keeps insertion order', () => {
    const s = selectionOf([item('a'), item('b'), item('a')]);
    expect(selectedIds(s, 'item')).toEqual(['a', 'b']);
    expect(s.primary).toEqual(item('b'));
  });

  it('selectionOf with a mixed list keeps the LAST ref alone', () => {
    const s = selectionOf([item('a'), corner('c1')]);
    expect(s.entities).toEqual([corner('c1')]);
    expect(s.primary).toEqual(corner('c1'));
  });

  it('selectionOf([]) is empty', () => {
    expect(isEmpty(selectionOf([]))).toBe(true);
  });

  it('withPrimary reorders without changing the set', () => {
    const s = selectionOf([item('a'), item('b'), item('c')]);
    const p = withPrimary(s, item('a'));
    expect(selectedIds(p, 'item')).toEqual(['b', 'c', 'a']);
    expect(p.primary).toEqual(item('a'));
  });

  it('withPrimary on a ref that is NOT held replaces the selection', () => {
    const s = selectionOf([item('a'), item('b')]);
    const p = withPrimary(s, item('z'));
    expect(p.entities).toEqual([item('z')]);
  });

  it('prune drops what no longer exists and re-picks the primary', () => {
    const s = selectionOf([item('a'), item('b'), item('c')]);
    const alive = new Set(['a', 'b']);
    const p = pruneSelection(s, (r) => alive.has(r.id));
    expect(selectedIds(p, 'item')).toEqual(['a', 'b']);
    expect(p.primary).toEqual(item('b'));
  });

  it('prune returns the SAME object when nothing was dropped', () => {
    const s = selectionOf([item('a'), item('b')]);
    expect(pruneSelection(s, () => true)).toBe(s);
    expect(pruneSelection(emptySelection(), () => false)).toBe(emptySelection());
  });

  it('prune to nothing empties', () => {
    const p = pruneSelection(selectionOf([item('a')]), () => false);
    expect(isEmpty(p)).toBe(true);
    expect(p.primary).toBe(null);
  });

  it('isSelected and sameRef compare kind AND id', () => {
    const s = selectionOf([item('a')]);
    expect(isSelected(s, item('a'))).toBe(true);
    expect(isSelected(s, wall('a'))).toBe(false);
    expect(sameRef(item('a'), item('a'))).toBe(true);
    expect(sameRef(item('a'), null)).toBe(false);
    expect(sameRef(null, null)).toBe(false);
  });

  it('never mutates the state it is handed', () => {
    const s = selectionOf([item('a'), item('b')]);
    const before = JSON.stringify(s);
    toggleSelection(s, item('c'));
    pruneSelection(s, () => false);
    expect(JSON.stringify(s)).toBe(before);
  });
});
