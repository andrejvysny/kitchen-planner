import type { Board, CabinetPartDef, CustomPartDef, FreeformPartDef, Zone } from './types';
import { uid } from './types';
import { normalizeZones } from './zones';

/**
 * Everything v1 → v2. Old parts had { template: 'cabinet' | 'desk', options }.
 * The generators here reproduce the v1 mesh layout exactly, so migrated
 * designs render identically; the old Part Studio steppers reuse them too.
 */

interface CabinetCounts {
  drawers: number;
  doors: number;
  shelves: number;
}

const FRONT_T = 0.018;
const GAP = 0.004;

/** The v1 vertical layout (drawers bottom / doors middle / open top) as a zone tree. */
export function cabinetTreeFromCounts(o: CabinetCounts): Zone {
  const children: Zone[] = [];
  const weights: number[] = [];
  if (o.drawers > 0) {
    children.push({ kind: 'leaf', fill: 'drawers', drawers: o.drawers });
    weights.push(Math.min(0.6, o.drawers * 0.2));
  }
  if (o.doors > 0) {
    children.push({ kind: 'leaf', fill: o.doors >= 2 ? 'doorPair' : 'door' });
    weights.push(0.45 + o.doors * 0.05);
  }
  if (o.shelves > 0) {
    children.push({ kind: 'leaf', fill: 'open', shelves: o.shelves });
    weights.push(0.35 + o.shelves * 0.08);
  }
  if (!children.length) return { kind: 'leaf', fill: 'door' };
  if (children.length === 1) return children[0];
  return { kind: 'split', dir: 'h', weights, children };
}

/** Best-effort inverse of cabinetTreeFromCounts (old studio steppers + tests). */
export function countsFromTree(face: Zone): CabinetCounts {
  const out: CabinetCounts = { drawers: 0, doors: 0, shelves: 0 };
  const visit = (z: Zone): void => {
    if (z.kind === 'split') {
      z.children.forEach(visit);
      return;
    }
    if (z.fill === 'drawers') out.drawers += z.drawers ?? 1;
    else if (z.fill === 'doorPair') out.doors += 2;
    else if (z.fill === 'door') out.doors += 1;
    else if (z.fill === 'open') out.shelves += Math.max(1, z.shelves ?? 1);
  };
  visit(face);
  return out;
}

interface DeskOptions {
  drawers: number;
  panelLegs: number;
}

/** The v1 desk template (top + legs or panels + drawer pedestal) as a board list. */
export function deskBoards(o: DeskOptions, dims: { w: number; d: number; h: number }): Board[] {
  const { w, d, h } = dims;
  const topT = 0.035;
  const b = (partial: Omit<Board, 'rotY' | 'shape' | 'slot' | 'style'> & Partial<Board>): Board => ({
    rotY: 0,
    shape: 'box',
    slot: 'front',
    style: 'plain',
    ...partial,
  });
  const boards: Board[] = [
    b({ id: 'top', x: 0, y: h - topT, z: 0, w, h: topT, d, slot: 'accent' }),
  ];
  if (o.panelLegs) {
    boards.push(
      b({ id: 'panel-l', x: -w / 2 + 0.05, y: 0, z: 0, w: 0.03, h: h - topT, d: d - 0.05 }),
      b({ id: 'panel-r', x: w / 2 - 0.05, y: 0, z: 0, w: 0.03, h: h - topT, d: d - 0.05 })
    );
  } else {
    let n = 0;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
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
  }
  if (o.drawers > 0) {
    const pw = Math.min(0.42, w * 0.35);
    const px = w / 2 - pw / 2 - 0.04;
    const ph = h - topT - 0.12;
    boards.push(
      b({ id: 'ped', x: px, y: 0.12, z: -FRONT_T / 2, w: pw, h: ph, d: d - 0.06, tint: 0.92 })
    );
    const fh = (ph - GAP * (o.drawers + 1)) / o.drawers;
    for (let i = 0; i < o.drawers; i++) {
      boards.push(
        b({
          id: `dr-${i}`,
          x: px,
          y: 0.12 + GAP + i * (fh + GAP),
          z: d / 2 - 0.03 - FRONT_T / 2,
          w: pw - GAP * 2,
          h: fh,
          d: FRONT_T,
          style: 'front',
        })
      );
    }
  }
  return boards;
}

/** Convert one v1 part (template + options) to the v2 model. Null when unusable. */
export function migratePartV1(raw: unknown): CustomPartDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.w !== 'number') return null;
  const o = (p.options && typeof p.options === 'object' ? p.options : {}) as Record<string, number>;
  const base = {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : 'Part',
    w: p.w as number,
    d: typeof p.d === 'number' ? p.d : 0.5,
    h: typeof p.h === 'number' ? p.h : 0.8,
    elevation: typeof p.elevation === 'number' ? p.elevation : 0,
    color: typeof p.color === 'string' ? p.color : '#8a9683',
    accentColor: typeof p.accentColor === 'string' ? p.accentColor : '#c9a87c',
  };
  if (p.template === 'desk') {
    const part: FreeformPartDef = {
      ...base,
      type: 'freeform',
      boards: deskBoards({ drawers: o.drawers ?? 0, panelLegs: o.panelLegs ?? 0 }, base),
    };
    return part;
  }
  const part: CabinetPartDef = {
    ...base,
    type: 'cabinet',
    footprint: { kind: 'rect' },
    plinth: (o.plinth ?? 1) > 0,
    worktop: (o.worktop ?? 0) > 0,
    face: normalizeZones(
      cabinetTreeFromCounts({
        drawers: Math.max(0, o.drawers ?? 0),
        doors: Math.max(0, o.doors ?? 0),
        shelves: Math.max(0, o.shelves ?? 0),
      })
    ),
  };
  return part;
}

/**
 * Migrate a whole v1 design in place: convert parts, split variants for items
 * whose per-instance params diverged from their part (v2 has no per-instance
 * zone config), and drop the now-meaningless custom item params.
 */
export function migrateDesignV1(d: Record<string, unknown>): void {
  const rawParts = (Array.isArray(d.customParts) ? d.customParts : []) as Record<string, unknown>[];
  const items = (Array.isArray(d.items) ? d.items : []) as Record<string, unknown>[];
  const v1ById = new Map<string, Record<string, unknown>>();
  for (const p of rawParts) {
    if (typeof p?.id === 'string' && typeof p.template === 'string') v1ById.set(p.id, p);
  }

  const sig = (o: Record<string, number> | undefined): string =>
    JSON.stringify(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));

  const variants = new Map<string, Record<string, unknown>>();
  for (const it of items) {
    const src = typeof it.defId === 'string' ? v1ById.get(it.defId) : undefined;
    if (!src) continue;
    const params = (it.params && typeof it.params === 'object' ? it.params : undefined) as
      | Record<string, number>
      | undefined;
    if (params && sig(params) !== sig(src.options as Record<string, number>)) {
      const key = `${it.defId}|${sig(params)}`;
      let variant = variants.get(key);
      if (!variant) {
        variant = { ...src, id: uid('part'), name: `${src.name} (variant)`, options: { ...params } };
        variants.set(key, variant);
        rawParts.push(variant);
      }
      it.defId = variant.id as string;
    }
    delete it.params;
  }

  d.customParts = rawParts
    .map((p) => (typeof p?.template === 'string' ? migratePartV1(p) : (p as unknown as CustomPartDef)))
    .filter(Boolean);
}
