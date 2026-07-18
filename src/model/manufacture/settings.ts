/**
 * Manufacturing settings: the physical constants (panel thickness, back
 * construction, joinery, System32 drilling, drawer-box sizing) that will
 * drive the cut-list / drilling / drawing generators added in later phases.
 * `DEFAULT_MANUFACTURE` reproduces today's hard-coded panel geometry
 * exactly — see the panelParamsFrom(DEFAULT_MANUFACTURE) ≡ DEFAULT_PANEL_PARAMS
 * parity test — so introducing this module changes no visuals; only the
 * settings dialog and later phases give these numbers any effect.
 */

import { DEFAULT_PANEL_PARAMS, FRONT_T, type PanelParams } from '../panels';

export type Joinery = 'confirmat' | 'camlock';
export type BackMode = 'groove' | 'screwed';

export interface System32Settings {
  pitch: number;
  frontSetback: number;
  holeDia: number;
  holeDepth: number;
  hingeCupDia: number;
  hingeCupInset: number;
}

export interface DrawerSystemSettings {
  bottomT: number;
  backT: number;
  widthDeduction: number;
  depthDeduction: number;
  boxHeight: number;
  system: string;
}

export interface ManufactureSettings {
  /** carcass board thickness, m */
  carcassT: number;
  backMode: BackMode;
  /** back panel thickness, m */
  backT: number;
  /** groove depth cut into carcass sides/bottom/top for the back panel, m */
  grooveDepth: number;
  /** groove face setback from the rear edge, m */
  backInset: number;
  joinery: Joinery;
  /** front-to-front / front-to-carcass reveal gap == today's GAP, m */
  frontReveal: number;
  /** front edge banding thickness, m */
  edgeFrontT: number;
  /** visible carcass edge banding thickness, m */
  edgeCarcassT: number;
  /** plinth/kickboard height == today's PLINTH_H, m */
  plinthH: number;
  /** kickboard recess from the front plane, m */
  plinthInset: number;
  legs: boolean;
  /** worktop slab thickness == today's WORKTOP_T, m */
  worktopT: number;
  system32: System32Settings;
  drawer: DrawerSystemSettings;
}

/** Freezes an object and everything nested inside it. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) deepFreeze(val);
    Object.freeze(v);
  }
  return v;
}

export const DEFAULT_MANUFACTURE: ManufactureSettings = deepFreeze({
  carcassT: 0.018,
  backMode: 'groove',
  backT: 0.003,
  grooveDepth: 0.008,
  backInset: 0.012,
  joinery: 'confirmat',
  frontReveal: 0.004,
  edgeFrontT: 0.002,
  edgeCarcassT: 0.0008,
  plinthH: 0.1,
  plinthInset: 0.045,
  legs: true,
  worktopT: 0.035,
  system32: {
    pitch: 0.032,
    frontSetback: 0.037,
    holeDia: 0.005,
    holeDepth: 0.012,
    hingeCupDia: 0.035,
    hingeCupInset: 0.0215,
  },
  drawer: {
    bottomT: 0.016,
    backT: 0.016,
    widthDeduction: 0.084,
    depthDeduction: 0.01,
    boxHeight: 0.09,
    system: 'Tandembox-style',
  },
});

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fb: number, lo: number, hi: number): number =>
  clamp(typeof v === 'number' && Number.isFinite(v) ? v : fb, lo, hi);
const str = (v: unknown, fb: string): string => (typeof v === 'string' && v.length > 0 ? v : fb);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function sanitizeSystem32(raw: unknown): System32Settings {
  const d = DEFAULT_MANUFACTURE.system32;
  const r = obj(raw);
  return {
    pitch: num(r.pitch, d.pitch, 0.02, 0.05),
    frontSetback: num(r.frontSetback, d.frontSetback, 0.02, 0.06),
    holeDia: num(r.holeDia, d.holeDia, 0.003, 0.01),
    holeDepth: num(r.holeDepth, d.holeDepth, 0.008, 0.02),
    hingeCupDia: num(r.hingeCupDia, d.hingeCupDia, 0.02, 0.05),
    hingeCupInset: num(r.hingeCupInset, d.hingeCupInset, 0.01, 0.04),
  };
}

function sanitizeDrawerSystem(raw: unknown): DrawerSystemSettings {
  const d = DEFAULT_MANUFACTURE.drawer;
  const r = obj(raw);
  return {
    bottomT: num(r.bottomT, d.bottomT, 0.003, 0.019),
    backT: num(r.backT, d.backT, 0.003, 0.019),
    widthDeduction: num(r.widthDeduction, d.widthDeduction, 0, 0.2),
    depthDeduction: num(r.depthDeduction, d.depthDeduction, 0, 0.1),
    boxHeight: num(r.boxHeight, d.boxHeight, 0.05, 0.3),
    system: str(r.system, d.system),
  };
}

/**
 * Validate + repair manufacturing settings parsed from storage or a file.
 * Mirrors the sanitizeScene idiom (store.ts): always builds a fresh object
 * (never aliases `raw` or the frozen defaults), numbers are finite-checked
 * and clamped to sane ranges, enums fall back to the default on any other
 * value.
 */
export function sanitizeManufacture(raw: unknown): ManufactureSettings {
  const d = DEFAULT_MANUFACTURE;
  const r = obj(raw);
  return {
    carcassT: num(r.carcassT, d.carcassT, 0.012, 0.03),
    backMode: r.backMode === 'groove' || r.backMode === 'screwed' ? r.backMode : d.backMode,
    backT: num(r.backT, d.backT, 0.003, 0.019),
    grooveDepth: num(r.grooveDepth, d.grooveDepth, 0.004, 0.012),
    backInset: num(r.backInset, d.backInset, 0.008, 0.03),
    joinery: r.joinery === 'confirmat' || r.joinery === 'camlock' ? r.joinery : d.joinery,
    frontReveal: num(r.frontReveal, d.frontReveal, 0.001, 0.008),
    edgeFrontT: num(r.edgeFrontT, d.edgeFrontT, 0, 0.003),
    edgeCarcassT: num(r.edgeCarcassT, d.edgeCarcassT, 0, 0.003),
    plinthH: num(r.plinthH, d.plinthH, 0.04, 0.2),
    plinthInset: num(r.plinthInset, d.plinthInset, 0, 0.08),
    legs: typeof r.legs === 'boolean' ? r.legs : d.legs,
    worktopT: num(r.worktopT, d.worktopT, 0.012, 0.08),
    system32: sanitizeSystem32(r.system32),
    drawer: sanitizeDrawerSystem(r.drawer),
  };
}

/**
 * Map manufacturing settings onto the PanelParams the panel generators will
 * consume (Phase 1). `frontT` stays the FRONT_T constant — front thickness
 * isn't an exposed setting yet — and `shelfSetback` isn't user-tunable
 * either, so both come straight from DEFAULT_PANEL_PARAMS.
 */
export function panelParamsFrom(m: ManufactureSettings): PanelParams {
  return {
    carcassT: m.carcassT,
    frontT: FRONT_T,
    reveal: m.frontReveal,
    plinthH: m.plinthH,
    plinthInset: m.plinthInset,
    worktopT: m.worktopT,
    backMode: m.backMode,
    backT: m.backT,
    grooveDepth: m.grooveDepth,
    backInset: m.backInset,
    shelfSetback: DEFAULT_PANEL_PARAMS.shelfSetback,
    drawer: {
      bottomT: m.drawer.bottomT,
      backT: m.drawer.backT,
      widthDeduction: m.drawer.widthDeduction,
      depthDeduction: m.drawer.depthDeduction,
      boxHeight: m.drawer.boxHeight,
    },
  };
}
