import { partPanels, type PanelParams, type PartDims } from '../panels';
import type { CabinetPartDef, Design } from '../types';
import { walkZones } from '../zones';
import { collectDesign } from './collect';
import { DEFAULT_MANUFACTURE, panelParamsFrom, type ManufactureSettings } from './settings';
import { hingeCountForHeight, itemDrilling } from './drilling';
import type { HardwareItem } from './types';

/**
 * Hardware schedule generator. Walks the collected design and derives every
 * fitting a cabinet needs — concealed hinges (by door height), drawer runner
 * sets, adjustable legs, shelf pins, carcass connectors (confirmat screws or
 * cam-lock sets, counted from the ACTUAL drilled ops so the schedule and the
 * drilling stay coherent), wall hangers and screwed-back screws — deduplicated
 * by spec with quantities summed and a stable category order.
 *
 * Pure model code — no Three.js, no Store.
 */

const RUNNER_NLS = [250, 300, 350, 400, 450, 500, 550];

/** Largest nominal runner length not exceeding the available tray depth (mm). */
function runnerNL(trayDepthMm: number): number {
  let best = RUNNER_NLS[0];
  for (const l of RUNNER_NLS) if (l <= trayDepthMm) best = l;
  return best;
}

interface Acc {
  category: HardwareItem['category'];
  name: string;
  unit: HardwareItem['unit'];
  spec: string;
  qty: number;
}

const RANK: Record<HardwareItem['category'], number> = {
  hinge: 0, runner: 1, leg: 2, shelfPin: 3, connector: 4, handle: 6, misc: 6,
};

/** Body height of a placed cabinet (mirrors cabinetPanels' carcass framing). */
function bodyHeightOf(part: CabinetPartDef, dims: PartDims, pp: PanelParams): number {
  const wallMounted = dims.elevation > 0.3;
  const topT = part.worktop ? pp.worktopT : 0;
  const y0 = !wallMounted && part.plinth ? pp.plinthH : 0;
  return dims.h - y0 - topT;
}

export function buildHardware(design: Design): HardwareItem[] {
  const mfg: ManufactureSettings = design.manufacture ?? DEFAULT_MANUFACTURE;
  const pp = panelParamsFrom(mfg);
  const acc = new Map<string, Acc>();
  const add = (category: Acc['category'], name: string, unit: Acc['unit'], spec: string, qty: number): void => {
    if (qty <= 0) return;
    const key = `${category}|${spec}`;
    const cur = acc.get(key);
    if (cur) cur.qty += qty;
    else acc.set(key, { category, name, unit, spec, qty });
  };

  for (const c of collectDesign(design).items) {
    const part = c.part;
    if (!part || part.type !== 'cabinet') continue;
    const dims = c.dims;
    const wallMounted = dims.elevation > 0.3;
    const bodyH = bodyHeightOf(part, dims, pp);
    if (bodyH <= 0.05) continue;

    // door hinges + drawer runners + shelf pins, from the zone tree
    let drawerCount = 0;
    for (const r of walkZones(part.face, dims.w, bodyH)) {
      const H = (r.h - pp.reveal) * 1000;
      if (r.leaf.fill === 'door') {
        add('hinge', 'Concealed hinge', 'pc', '35 mm cup concealed hinge 110°, incl. mounting plate', hingeCountForHeight(H));
      } else if (r.leaf.fill === 'doorPair') {
        add('hinge', 'Concealed hinge', 'pc', '35 mm cup concealed hinge 110°, incl. mounting plate', 2 * hingeCountForHeight(H));
      } else if (r.leaf.fill === 'drawers') {
        drawerCount += Math.max(1, r.leaf.drawers ?? 1);
      } else if (r.leaf.fill === 'open') {
        const shelves = Math.max(0, r.leaf.shelves ?? 1);
        add('shelfPin', 'Shelf pin', 'pc', '5 mm sleeve pin', 4 * shelves);
      }
    }
    if (drawerCount > 0) {
      const tray = Math.round((dims.d - pp.frontT - pp.drawer.depthDeduction) * 1000);
      const nl = runnerNL(tray);
      add('runner', 'Drawer runner set', 'set', `${mfg.drawer.system}, NL ${nl} mm, soft-close`, drawerCount);
    }

    // adjustable legs on plinthed floor cabinets
    if (!wallMounted && part.plinth) {
      add('leg', 'Adjustable leg', 'pc', '100 mm adjustable + plinth clip', 4 + (dims.w > 0.9 ? 2 : 0));
    }

    // carcass connectors, counted from the real drilled ops
    const ops = itemDrilling(part, dims, partPanels(part, dims, pp), mfg);
    let confirmat = 0;
    let camBore = 0;
    for (const o of ops.values()) for (const d of o.drills) {
      if (d.kind === 'confirmat') confirmat++;
      else if (d.kind === 'camBore') camBore++;
    }
    add('connector', 'Confirmat screw', 'pc', '7×50 mm confirmat', confirmat);
    add('connector', 'Cam lock set', 'set', '15 mm cam + bolt + 8×35 dowel', camBore);

    // wall hangers on wall-mounted cabinets
    if (wallMounted) add('misc', 'Wall hanger', 'pc', 'cabinet hanger + wall rail', 2);

    // screwed backs: perimeter screws at ~150 mm pitch
    if (mfg.backMode === 'screwed') {
      const perim = 2 * (dims.w + bodyH);
      add('misc', 'Back screw', 'pc', '3.5×16 screws for screwed back', Math.ceil(perim / 0.15));
    }
  }

  return [...acc.values()]
    .sort((a, b) => {
      const ra = a.category === 'misc' && /hanger/i.test(a.spec) ? 5 : RANK[a.category];
      const rb = b.category === 'misc' && /hanger/i.test(b.spec) ? 5 : RANK[b.category];
      return ra - rb || a.spec.localeCompare(b.spec);
    })
    .map((a): HardwareItem => ({ key: `${a.category}|${a.spec}`, name: a.name, category: a.category, qty: a.qty, unit: a.unit, spec: a.spec }));
}
