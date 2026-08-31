import type { Panel } from '../../src/model/panels';
import type { Board } from '../../src/model/types';

/**
 * Half-extents of a panel list about the part origin: `maxX`/`maxZ` are the
 * furthest any board reaches sideways/front-to-back, `maxY` the highest top.
 * The bbox invariant every part generator holds — nothing pokes outside the
 * instance's own w × d × h — so this is shared by the cabinet and wardrobe
 * suites rather than re-derived in each.
 */
export function bboxOf(panels: Panel[]): { maxX: number; maxY: number; maxZ: number } {
  let maxX = 0;
  let maxY = 0;
  let maxZ = 0;
  for (const p of panels) {
    if (p.shape.kind === 'prism') {
      for (const q of p.shape.outline) {
        maxX = Math.max(maxX, Math.abs(q.x));
        maxZ = Math.max(maxZ, Math.abs(q.y));
      }
      maxY = Math.max(maxY, p.y + p.shape.h);
    } else {
      const c = Math.abs(Math.cos(p.rotY));
      const s = Math.abs(Math.sin(p.rotY));
      // a cyl's `h` is its length along `axis`: upright for the default 'y'
      // (legs, posts), but ACROSS the part for 'x' (hanging rails), where the
      // vertical extent is only the tube's diameter
      const flat = p.shape.kind === 'cyl' && p.shape.axis === 'x';
      const w = p.shape.kind === 'cyl' ? (flat ? p.shape.h : p.shape.dia) : p.shape.w;
      const d = p.shape.kind === 'cyl' ? p.shape.dia : p.shape.d;
      const up = p.shape.kind === 'cyl' && flat ? p.shape.dia : p.shape.h;
      maxX = Math.max(maxX, Math.abs(p.x) + (w * c + d * s) / 2);
      maxZ = Math.max(maxZ, Math.abs(p.z) + (w * s + d * c) / 2);
      maxY = Math.max(maxY, p.y + up);
    }
  }
  return { maxX, maxY, maxZ };
}

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
