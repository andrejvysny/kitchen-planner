import type { Zone } from './types';

/**
 * Canned front-layout presets for the Part Studio's Simple tab (WS-SPEC WP
 * 3.4): eight common cabinet-front arrangements a novice can pick without
 * ever opening the Advanced tab's zone canvas. Same literal-tree idiom
 * presets.ts uses for `face`, just isolated to the face alone.
 *
 * `face()` MUST hand back a FRESH tree every call — the result is written
 * straight into `part.face` (cabinetPanel.ts) and the zone canvas edits that
 * object in place, so returning a shared reference would let a later drag on
 * one placed cabinet corrupt every OTHER cabinet's copy of "3 drawers".
 *
 * Every tree here is written already-normalized: split weights are exact
 * binary fractions (halves/quarters/eighths) so `normalizeZones` divides them
 * by a `total` that is exactly 1.0 and hands back the identical value — that
 * is what test/unit/faceLayouts.test.ts's normalize-stability check demands,
 * and why the weights below are not the "nicer" decimal splits presets.ts
 * sometimes uses (those are hand-tuned, not designed to survive a bit-exact
 * round trip).
 */
export interface FaceLayout {
  id: string;
  label: string;
  /** builds a FRESH zone tree each call — never a shared object */
  face: () => Zone;
}

export const FACE_LAYOUTS: readonly FaceLayout[] = [
  {
    id: 'single-door',
    label: 'Single door',
    face: () => ({ kind: 'leaf', fill: 'door' }),
  },
  {
    id: 'door-pair',
    label: 'Door pair',
    face: () => ({ kind: 'leaf', fill: 'doorPair' }),
  },
  {
    id: 'drawers-3',
    label: '3 drawers',
    face: () => ({ kind: 'leaf', fill: 'drawers', drawers: 3 }),
  },
  {
    id: 'drawers-4',
    label: '4 drawers',
    face: () => ({ kind: 'leaf', fill: 'drawers', drawers: 4 }),
  },
  {
    id: 'drawer-over-door',
    label: 'Drawer over door',
    face: () => ({
      kind: 'split',
      dir: 'h',
      weights: [0.75, 0.25],
      children: [
        { kind: 'leaf', fill: 'door' },
        { kind: 'leaf', fill: 'drawers', drawers: 1 },
      ],
    }),
  },
  {
    id: 'door-pair-drawer-top',
    label: 'Door pair + top drawer',
    face: () => ({
      kind: 'split',
      dir: 'h',
      weights: [0.75, 0.25],
      children: [
        { kind: 'leaf', fill: 'doorPair' },
        { kind: 'leaf', fill: 'drawers', drawers: 1 },
      ],
    }),
  },
  {
    id: 'shelf-over-door',
    label: 'Open shelf over door',
    face: () => ({
      kind: 'split',
      dir: 'h',
      weights: [0.625, 0.375],
      children: [
        { kind: 'leaf', fill: 'door' },
        {
          kind: 'leaf',
          fill: 'open',
          interior: { mode: 'auto', shelves: 1, innerDrawers: 0 },
        },
      ],
    }),
  },
  {
    id: 'glass-over-drawers',
    label: 'Glass over drawers',
    face: () => ({
      kind: 'split',
      dir: 'h',
      weights: [0.625, 0.375],
      children: [
        { kind: 'leaf', fill: 'drawers', drawers: 2 },
        { kind: 'leaf', fill: 'glass' },
      ],
    }),
  },
] as const;
