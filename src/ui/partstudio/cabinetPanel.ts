import { COUNTER_COLORS, FRONT_COLORS, OAK, WALNUT } from '../../model/catalog';
import { clamp } from '../../model/geometry';
import type { CabinetPartDef, Footprint } from '../../model/types';
import { choiceRow, dimRow, numRow, section, swatchRow, toggleRow, unitSuffix } from './controls';
import { renderFrontLayoutTiles } from './frontLayoutTiles';
import type { StudioTab } from './studioTab';

type FootKind = 'rect' | 'angledEnd' | 'diagonal' | 'cornerL';

/**
 * Which sub-tab a rail section belongs to (WS-SPEC WP 3.3). `'both'` is the
 * default answer, not a cop-out: the Simple tab is a FILTER over this one rail,
 * so a section only earns a tag when a novice genuinely should not see it.
 */
type SectionTab = StudioTab | 'both';

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
      return {
        kind: 'chamfer',
        corner: 'right',
        cx: Math.min(0.3, c),
        cz: Math.min(0.3, c),
        face: 'front',
      };
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
 *
 * `tab` filters it (WS-SPEC WP 3.3). Every section declares which tab it
 * belongs to AT ITS RENDER SITE, through `sec` below, and a section the
 * current tab does not show is built into a throwaway holder instead of the
 * rail. That is the whole mechanism: a list of "simple sections" kept anywhere
 * else — in the studio, in a constant at the top of this file — would drift the
 * first time somebody adds a section here and forgets it exists.
 */
export function renderCabinetPanel(
  rail: HTMLElement,
  part: CabinetPartDef,
  onChange: (transient?: boolean) => void,
  tab: StudioTab
): void {
  const on = (want: SectionTab): boolean => want === 'both' || want === tab;
  const sec = (title: string, want: SectionTab): HTMLElement =>
    section(on(want) ? rail : document.createElement('div'), title);

  const dims = sec(`Dimensions (${unitSuffix()})`, 'both');
  dimRow(
    dims,
    'Width',
    () => part.w,
    (v, transient) => {
      part.w = v;
      onChange(transient);
    },
    0.2,
    3.0
  );
  dimRow(
    dims,
    'Depth',
    () => part.d,
    (v, transient) => {
      part.d = v;
      onChange(transient);
    },
    0.2,
    1.2
  );
  dimRow(
    dims,
    'Height',
    () => part.h,
    (v, transient) => {
      part.h = v;
      onChange(transient);
    },
    0.2,
    2.5
  );
  toggleRow(
    dims,
    'Wall-mounted',
    () => part.elevation > 0.3,
    (v) => {
      part.elevation = v ? 1.45 : 0;
      onChange();
    }
  );

  // The Simple tab's front-layout slot (WS-SPEC WP 3.3/3.4): a tile row of
  // canned zone trees so a novice never has to open the Advanced tab's zone
  // canvas. It is here already so the Simple rail reads in the order it keeps
  // — dimensions, front layout, body, colours.
  const layout = sec('Front layout', 'simple');
  layout.classList.add('studio-front-slot');
  const layoutCaption = document.createElement('div');
  layoutCaption.className = 'studio-caption';
  layoutCaption.textContent = 'Pick a canned front arrangement';
  layout.appendChild(layoutCaption);
  const layoutSlot = document.createElement('div');
  layoutSlot.id = 'studio-front-layouts';
  layout.appendChild(layoutSlot);
  renderFrontLayoutTiles(layoutSlot, part, onChange);

  const foot = sec('Footprint', 'advanced');
  const buttons = document.createElement('div');
  buttons.className = 'choice foot-choice';
  const detail = document.createElement('div');
  const renderDetail = () => {
    detail.innerHTML = '';
    const fp = part.footprint;
    if (fp.kind === 'chamfer') {
      numRow(
        detail,
        'Cut width',
        () => fp.cx,
        (v) => {
          fp.cx = clamp(v, 0.05, part.w - 0.05);
          onChange();
        }
      );
      numRow(
        detail,
        'Cut depth',
        () => fp.cz,
        (v) => {
          fp.cz = clamp(v, 0.05, part.d - 0.05);
          onChange();
        }
      );
      choiceRow(
        detail,
        'Cut corner',
        [
          ['left', 'Left'],
          ['right', 'Right'],
        ],
        () => fp.corner,
        (v) => {
          fp.corner = v as 'left' | 'right';
          onChange();
        }
      );
    } else if (fp.kind === 'cornerL') {
      numRow(
        detail,
        'Notch width',
        () => fp.nw,
        (v) => {
          fp.nw = clamp(v, 0.05, part.w - 0.05);
          onChange();
        }
      );
      numRow(
        detail,
        'Notch depth',
        () => fp.nd,
        (v) => {
          fp.nd = clamp(v, 0.05, part.d - 0.05);
          onChange();
        }
      );
      choiceRow(
        detail,
        'Notch side',
        [
          ['left', 'Left'],
          ['right', 'Right'],
        ],
        () => fp.notch,
        (v) => {
          fp.notch = v as 'left' | 'right';
          onChange();
        }
      );
      choiceRow(
        detail,
        'Return front',
        [
          ['panel', 'Panel'],
          ['door', 'Door'],
        ],
        () => fp.face2,
        (v) => {
          fp.face2 = v as 'panel' | 'door';
          onChange();
        }
      );
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

  const body = sec('Body', 'both');
  toggleRow(
    body,
    'Plinth',
    () => part.plinth,
    (v) => {
      part.plinth = v;
      onChange();
    }
  );
  const overhangDetail = document.createElement('div');
  const renderOverhang = () => {
    overhangDetail.innerHTML = '';
    // the Body TOGGLES are simple; three millimetre overhangs are not, so this
    // one block follows the same per-render-site rule the sections do
    if (!part.worktop || !on('advanced')) return;
    const ov = () => (part.worktopOverhang ??= { front: 0.015, back: 0.005, sides: 0.01 });
    numRow(
      overhangDetail,
      'Overhang front',
      () => part.worktopOverhang?.front ?? 0.015,
      (v) => {
        ov().front = clamp(v, 0, 0.4);
        onChange();
      }
    );
    numRow(
      overhangDetail,
      'Overhang back',
      () => part.worktopOverhang?.back ?? 0.005,
      (v) => {
        ov().back = clamp(v, 0, 0.4);
        onChange();
      }
    );
    numRow(
      overhangDetail,
      'Overhang sides',
      () => part.worktopOverhang?.sides ?? 0.01,
      (v) => {
        ov().sides = clamp(v, 0, 0.4);
        onChange();
      }
    );
  };
  toggleRow(
    body,
    'Worktop',
    () => part.worktop,
    (v) => {
      part.worktop = v;
      renderOverhang();
      onChange();
    }
  );
  body.appendChild(overhangDetail);
  renderOverhang();
  toggleRow(
    body,
    'Finished back',
    () => part.finishedBack === true,
    (v) => {
      if (v) part.finishedBack = true;
      else delete part.finishedBack;
      onChange();
    }
  );

  const colors = sec('Front colour', 'both');
  swatchRow(
    colors,
    FRONT_COLORS,
    () => part.color,
    (c) => {
      part.color = c;
      onChange();
    }
  );
  const accent = sec('Wood accent (top / niches)', 'both');
  swatchRow(
    accent,
    [OAK, WALNUT, ...COUNTER_COLORS.slice(1, 3)],
    () => part.accentColor,
    (c) => {
      part.accentColor = c;
      onChange();
    }
  );
}
