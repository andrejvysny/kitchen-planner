/**
 * The selection STATE and every rule that governs it — pure, DOM-free and
 * framework-free, so the whole policy is unit-testable without a canvas, a
 * store or a React tree. `EditorState` owns one of these and is the only
 * mutable holder; everything here returns a NEW state and never mutates its
 * argument.
 *
 * Two rules carry the whole design, and both live here rather than at the call
 * sites that would otherwise each re-derive them:
 *
 * - **A multi-selection is items-only.** A wall, a corner or an opening always
 *   REPLACES whatever was held. Mixed kinds share no operation (there is no
 *   "move a wall and a chair by the same delta" gesture) and no properties
 *   body, so allowing the combination would buy nothing and cost every panel a
 *   mixed-kind branch.
 * - **The primary is the LAST entity added**, and dropping it promotes the last
 *   one still standing. The primary is what snapping resolves against and what
 *   the inspector titles itself after, so it can never be undefined while the
 *   selection is non-empty.
 */

import type { EntityRef } from '../model/types';

export interface SelectionState {
  /** every held entity, in the order they were added; all `item` when > 1 */
  readonly entities: readonly EntityRef[];
  /** the one that leads: snapped against, titled after; null iff `entities` is empty */
  readonly primary: EntityRef | null;
}

const EMPTY: SelectionState = Object.freeze({ entities: Object.freeze([]), primary: null });

/** The resting state. Shared frozen singleton — never mutate a SelectionState. */
export function emptySelection(): SelectionState {
  return EMPTY;
}

export function sameRef(a: EntityRef | null, b: EntityRef | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

export function isSelected(state: SelectionState, ref: EntityRef): boolean {
  return state.entities.some((e) => sameRef(e, ref));
}

export function isEmpty(state: SelectionState): boolean {
  return state.entities.length === 0;
}

/** Ids of every held entity of one kind, in selection order. */
export function selectedIds(state: SelectionState, kind: EntityRef['kind']): string[] {
  return state.entities.filter((e) => e.kind === kind).map((e) => e.id);
}

/** Build a state from a list, applying the two rules; `primary` = the last entry. */
function build(refs: readonly EntityRef[]): SelectionState {
  const out: EntityRef[] = [];
  for (const r of refs) {
    if (!out.some((e) => sameRef(e, r))) out.push({ kind: r.kind, id: r.id });
  }
  if (out.length === 0) return EMPTY;
  // items-only above one: a non-item in the list means the LAST ref wins alone
  if (out.length > 1 && out.some((e) => e.kind !== 'item')) {
    const last = out[out.length - 1];
    return { entities: [last], primary: last };
  }
  return { entities: out, primary: out[out.length - 1] };
}

/** Click semantics: this ref alone, or nothing at all. */
export function replaceSelection(ref: EntityRef | null): SelectionState {
  return ref ? build([ref]) : EMPTY;
}

/**
 * Shift-click semantics: add if absent, remove if present. A non-item ref
 * replaces instead (rule 1), which is what collapses a multi-selection the
 * moment the user shift-clicks a wall.
 */
export function toggleSelection(state: SelectionState, ref: EntityRef): SelectionState {
  if (ref.kind !== 'item') return replaceSelection(ref);
  if (isSelected(state, ref)) return build(state.entities.filter((e) => !sameRef(e, ref)));
  // adding an item to a selection holding a wall/corner/opening replaces it
  if (state.entities.some((e) => e.kind !== 'item')) return replaceSelection(ref);
  return build([...state.entities, ref]);
}

/** Marquee / select-all semantics: exactly this set, primary = the last ref. */
export function selectionOf(refs: readonly EntityRef[]): SelectionState {
  return build(refs);
}

/**
 * Drop whatever the design no longer holds. The one bridge between the editor's
 * selection and the store's lifetime: `exists` is supplied by the caller
 * (src/app/services.ts wires it to `store.entityExists`) so this module keeps
 * knowing nothing about the Design.
 */
export function pruneSelection(
  state: SelectionState,
  exists: (ref: EntityRef) => boolean
): SelectionState {
  if (state.entities.length === 0) return state;
  const kept = state.entities.filter(exists);
  if (kept.length === state.entities.length) return state; // identity: no bump upstream
  return build(kept);
}
