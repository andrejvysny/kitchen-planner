import { COUNTER_COLORS, FRONT_COLORS, OAK, WALNUT } from '../../model/catalog';
import { clamp } from '../../model/geometry';
import type { CabinetPartDef, Footprint } from '../../model/types';
import { choiceRow, dimRow, numRow, section, swatchRow, toggleRow } from './controls';

type FootKind = 'rect' | 'angledEnd' | 'diagonal' | 'cornerL';

function footKind(fp: Footprint): FootKind {
  if (fp.kind === 'rect') return 'rect';
  if (fp.kind === 'cornerL') return 'cornerL';
  return fp.face === 'angled' ? 'diagonal' : 'angledEnd';
}

function defaultFootprint(kind: FootKind, part: CabinetPartDef): Footprint {
  const c = clamp(Math.min(part.w, part.d) * 0.6, 0.1, Math.min(part.w, part.d) - 0.05);
  switch (kind) {
    case 'rect':
      return { kind: 'rect' };
    case 'diagonal':
      return { kind: 'chamfer', corner: 'right', cx: c, cz: c, face: 'angled' };
    case 'angledEnd':
      return { kind: 'chamfer', corner: 'right', cx: Math.min(0.3, c), cz: Math.min(0.3, c), face: 'front' };
    case 'cornerL':
      return {
        kind: 'cornerL',
        notch: 'right',
        nw: clamp(part.w * 0.45, 0.1, part.w - 0.1),
        nd: clamp(part.d * 0.45, 0.1, part.d - 0.1),
        face2: 'door',
      };
  }
}

const FOOT_LABELS: [FootKind, string, string][] = [
  ['rect', 'Rectangular', 'Plain rectangular footprint'],
  ['angledEnd', 'Angled end', 'End-of-run unit with a chamfered corner'],
  ['diagonal', 'Diagonal corner', 'Corner cabinet with the front on the diagonal'],
  ['cornerL', 'L corner', 'Blind-corner unit with an L footprint'],
];

/**
 * Cabinet mode rail: body dimensions, footprint and finishes. The front
 * layout itself is edited in the zone canvas next to this rail.
 */
export function renderCabinetPanel(
  rail: HTMLElement,
  part: CabinetPartDef,
  onChange: () => void
): void {
  const dims = section(rail, 'Dimensions (cm)');
  dimRow(dims, 'Width', () => part.w, (v) => { part.w = v; onChange(); }, 0.2, 3.0);
  dimRow(dims, 'Depth', () => part.d, (v) => { part.d = v; onChange(); }, 0.2, 1.2);
  dimRow(dims, 'Height', () => part.h, (v) => { part.h = v; onChange(); }, 0.2, 2.5);
  toggleRow(dims, 'Wall-mounted', () => part.elevation > 0.3, (v) => {
    part.elevation = v ? 1.45 : 0;
    onChange();
  });

  const foot = section(rail, 'Footprint');
  const buttons = document.createElement('div');
  buttons.className = 'choice foot-choice';
  const detail = document.createElement('div');
  const renderDetail = () => {
    detail.innerHTML = '';
    const fp = part.footprint;
    if (fp.kind === 'chamfer') {
      numRow(detail, 'Cut width', () => fp.cx, (v) => {
        fp.cx = clamp(v, 0.05, part.w - 0.05);
        onChange();
      });
      numRow(detail, 'Cut depth', () => fp.cz, (v) => {
        fp.cz = clamp(v, 0.05, part.d - 0.05);
        onChange();
      });
      choiceRow(detail, 'Cut corner', [['left', 'Left'], ['right', 'Right']], () => fp.corner, (v) => {
        fp.corner = v as 'left' | 'right';
        onChange();
      });
    } else if (fp.kind === 'cornerL') {
      numRow(detail, 'Notch width', () => fp.nw, (v) => {
        fp.nw = clamp(v, 0.05, part.w - 0.05);
        onChange();
      });
      numRow(detail, 'Notch depth', () => fp.nd, (v) => {
        fp.nd = clamp(v, 0.05, part.d - 0.05);
        onChange();
      });
      choiceRow(detail, 'Notch side', [['left', 'Left'], ['right', 'Right']], () => fp.notch, (v) => {
        fp.notch = v as 'left' | 'right';
        onChange();
      });
      choiceRow(detail, 'Return front', [['panel', 'Panel'], ['door', 'Door']], () => fp.face2, (v) => {
        fp.face2 = v as 'panel' | 'door';
        onChange();
      });
    }
  };
  for (const [kind, label, title] of FOOT_LABELS) {
    const b = document.createElement('button');
    b.className = `btn choice-btn${footKind(part.footprint) === kind ? ' active' : ''}`;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      part.footprint = defaultFootprint(kind, part);
      buttons.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      renderDetail();
      onChange();
    });
    buttons.appendChild(b);
  }
  foot.appendChild(buttons);
  foot.appendChild(detail);
  renderDetail();

  const body = section(rail, 'Body');
  toggleRow(body, 'Plinth', () => part.plinth, (v) => { part.plinth = v; onChange(); });
  toggleRow(body, 'Worktop', () => part.worktop, (v) => { part.worktop = v; onChange(); });

  const colors = section(rail, 'Front colour');
  swatchRow(colors, FRONT_COLORS, () => part.color, (c) => { part.color = c; onChange(); });
  const accent = section(rail, 'Wood accent (top / niches)');
  swatchRow(accent, [OAK, WALNUT, ...COUNTER_COLORS.slice(1, 3)], () => part.accentColor, (c) => {
    part.accentColor = c;
    onChange();
  });
}
