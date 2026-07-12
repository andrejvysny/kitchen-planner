import { FRONT_COLORS, OAK, type CatalogDef, type ParamDef } from './catalog';
import type { CustomPartDef } from './types';
import { uid } from './types';

/**
 * Custom parts are user-created parametric components (Part Studio).
 * Two templates cover most furniture:
 *  - 'cabinet': plinth + carcass + drawers / doors / open shelves + optional worktop.
 *    Covers cupboards, drawer units, wall cabinets, pantries, sideboards, bookshelves.
 *  - 'desk': top + legs or side panels + optional drawer pedestal.
 *    Covers desks, tables, benches.
 */

export const TEMPLATE_LABELS: Record<CustomPartDef['template'], string> = {
  cabinet: 'Cabinet / shelving',
  desk: 'Desk / table',
};

export function templateParams(template: CustomPartDef['template']): ParamDef[] {
  if (template === 'cabinet') {
    return [
      { key: 'drawers', label: 'Drawers', min: 0, max: 5, def: 2 },
      { key: 'doors', label: 'Doors', min: 0, max: 2, def: 0 },
      { key: 'shelves', label: 'Open shelves', min: 0, max: 4, def: 0 },
      { key: 'plinth', label: 'Plinth', min: 0, max: 1, def: 1 },
      { key: 'worktop', label: 'Worktop', min: 0, max: 1, def: 1 },
    ];
  }
  return [
    { key: 'drawers', label: 'Pedestal drawers', min: 0, max: 4, def: 0 },
    { key: 'panelLegs', label: 'Panel legs', min: 0, max: 1, def: 0 },
  ];
}

export function defaultOptions(template: CustomPartDef['template']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of templateParams(template)) out[p.key] = p.def;
  return out;
}

export function newCustomPart(template: CustomPartDef['template'] = 'cabinet'): CustomPartDef {
  return {
    id: uid('part'),
    name: template === 'cabinet' ? 'My cabinet' : 'My desk',
    template,
    w: template === 'cabinet' ? 0.8 : 1.4,
    d: template === 'cabinet' ? 0.45 : 0.7,
    h: template === 'cabinet' ? 0.9 : 0.75,
    elevation: 0,
    color: FRONT_COLORS[2],
    accentColor: OAK,
    options: defaultOptions(template),
  };
}

/** Present a custom part as a CatalogDef so the rest of the app treats it uniformly. */
export function toCatalogDef(part: CustomPartDef): CatalogDef {
  return {
    id: part.id,
    kind: 'custom',
    label: part.name,
    w: part.w,
    d: part.d,
    h: part.h,
    elevation: part.elevation,
    color: part.color,
    resize: { w: [0.2, 3.5], d: [0.2, 1.4], h: [0.2, 2.6] },
    elevAdjust: [0, 2.2],
    params: templateParams(part.template),
  };
}

/** A sample part so the "My parts" section shows what's possible. */
export function samplePart(): CustomPartDef {
  return {
    id: uid('part'),
    name: 'Oak sideboard',
    template: 'cabinet',
    w: 1.2,
    d: 0.42,
    h: 0.75,
    elevation: 0,
    color: FRONT_COLORS[1],
    accentColor: OAK,
    options: { drawers: 1, doors: 2, shelves: 1, plinth: 0, worktop: 1 },
  };
}
