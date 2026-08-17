import type { Board } from '../../src/model/types';

/**
 * Desk-shaped freeform board list (top + 4 cylinder legs + drawer pedestal)
 * used by the builder/panel smoke tests — a stand-in for a hand-built part.
 */
export function deskBoards(drawers: number, dims: { w: number; d: number; h: number }): Board[] {
  const { w, d, h } = dims;
  const topT = 0.035;
  const b = (
    partial: Omit<Board, 'rotY' | 'shape' | 'slot' | 'style'> & Partial<Board>
  ): Board => ({
    rotY: 0,
    shape: 'box',
    slot: 'front',
    style: 'plain',
    ...partial,
  });
  const boards: Board[] = [
    b({ id: 'top', x: 0, y: h - topT, z: 0, w, h: topT, d, slot: 'accent' }),
  ];
  let n = 0;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    boards.push(
      b({
        id: `leg-${n++}`,
        x: sx * (w / 2 - 0.06),
        y: 0,
        z: sz * (d / 2 - 0.06),
        w: 0.044,
        h: h - topT,
        d: 0.044,
        shape: 'cyl',
        tint: 0.8,
      })
    );
  }
  if (drawers > 0) {
    const pw = Math.min(0.42, w * 0.35);
    const px = w / 2 - pw / 2 - 0.04;
    const ph = h - topT - 0.12;
    boards.push(b({ id: 'ped', x: px, y: 0.12, z: -0.009, w: pw, h: ph, d: d - 0.06, tint: 0.92 }));
    const fh = (ph - 0.004 * (drawers + 1)) / drawers;
    for (let i = 0; i < drawers; i++) {
      boards.push(
        b({
          id: `dr-${i}`,
          x: px,
          y: 0.12 + 0.004 + i * (fh + 0.004),
          z: d / 2 - 0.039,
          w: pw - 0.008,
          h: fh,
          d: 0.018,
          style: 'front',
        })
      );
    }
  }
  return boards;
}
