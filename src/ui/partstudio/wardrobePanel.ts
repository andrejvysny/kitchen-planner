import { COUNTER_COLORS, FRONT_COLORS, OAK, WALNUT } from '../../model/catalog';
import { clamp } from '../../model/geometry';
import type { WardrobePartDef } from '../../model/types';
import { choiceRow, dimRow, numRow, section, swatchRow, toggleRow, unitSuffix } from './controls';
import type { StudioTab } from './studioTab';

/** Mirrors cabinetPanel's rule: `'both'` is the default, a tag is a decision. */
type SectionTab = StudioTab | 'both';

type FrontChoice = 'none' | 'hinged' | 'sliding2' | 'sliding3';

function frontChoice(part: WardrobePartDef): FrontChoice {
  const f = part.front;
  if (f.kind === 'none') return 'none';
  if (f.kind === 'hinged') return 'hinged';
  return f.panels === 3 ? 'sliding3' : 'sliding2';
}

/**
 * Wardrobe rail: everything about the run that is NOT its columns — the
 * columns are the canvas' job, and it sits next to this rail on both tabs.
 *
 * `tab` filters it exactly the way `renderCabinetPanel`'s does, with every
 * section declaring its tab at its own render site (`sec` below). The Simple
 * half is what a fitted wardrobe is: how big, what closes it, what the body
 * looks like. The Advanced half is how it meets the room — end panels versus
 * bare wall, scribe fillers, a cornice, the lighting.
 */
export function renderWardrobePanel(
  rail: HTMLElement,
  part: WardrobePartDef,
  onChange: (transient?: boolean) => void,
  tab: StudioTab
): void {
  const on = (want: SectionTab): boolean => want === 'both' || want === tab;
  const sec = (title: string, want: SectionTab): HTMLElement =>
    section(on(want) ? rail : document.createElement('div'), title);

  /* ---------------- dimensions ---------------- */

  const dims = sec(`Dimensions (${unitSuffix()})`, 'both');
  dimRow(
    dims,
    'Width',
    () => part.w,
    (v, transient) => {
      part.w = v;
      onChange(transient);
    },
    0.3,
    6.0
  );
  dimRow(
    dims,
    'Depth',
    () => part.d,
    (v, transient) => {
      part.d = v;
      onChange(transient);
    },
    0.3,
    1.0
  );
  dimRow(
    dims,
    'Height',
    () => part.h,
    (v, transient) => {
      part.h = v;
      onChange(transient);
    },
    0.4,
    4.0
  );

  /* ---------------- front ---------------- */

  const front = sec('Front', 'both');
  const mirrorHolder = document.createElement('div');
  const renderMirror = (): void => {
    mirrorHolder.innerHTML = '';
    // an open run has no leaf to mirror
    if (part.front.kind === 'none') return;
    toggleRow(
      mirrorHolder,
      'Mirror',
      () => (part.front.kind === 'sliding' ? part.front.mirror === true : part.mirror === true),
      (v) => {
        // the flag lives on the sliding panel set, or on the part for a hinged
        // leaf — the sanitizer drops whichever one the current front cannot use
        if (part.front.kind === 'sliding') {
          if (v) part.front.mirror = true;
          else delete part.front.mirror;
        } else if (v) {
          part.mirror = true;
        } else {
          delete part.mirror;
        }
        onChange();
      }
    );
  };
  choiceRow(
    front,
    'Doors',
    [
      ['none', 'Open'],
      ['hinged', 'Hinged'],
      ['sliding2', 'Sliding 2'],
      ['sliding3', 'Sliding 3'],
    ],
    () => frontChoice(part),
    (v) => {
      const choice = v as FrontChoice;
      part.front =
        choice === 'none'
          ? { kind: 'none' }
          : choice === 'hinged'
            ? { kind: 'hinged' }
            : { kind: 'sliding', panels: choice === 'sliding3' ? 3 : 2 };
      renderMirror();
      onChange();
    }
  );
  // the row `choiceRow` just appended — the e2e handle for the front switch
  front.lastElementChild?.classList.add('studio-wardrobe-front');
  front.appendChild(mirrorHolder);
  renderMirror();

  /* ---------------- body ---------------- */

  const body = sec('Body', 'both');
  numRow(
    body,
    'Plinth height',
    () => part.plinthH,
    (v) => {
      part.plinthH = clamp(v, 0, 0.2);
      onChange();
    },
    { min: 0, max: 0.2 }
  );
  const topRowHolder = document.createElement('div');
  const renderTopRow = (): void => {
    topRowHolder.innerHTML = '';
    if (!part.topRow) return;
    numRow(
      topRowHolder,
      'Top row height',
      () => part.topRow?.h ?? 0.4,
      (v) => {
        if (part.topRow) part.topRow.h = clamp(v, 0.25, 0.8);
        onChange();
      },
      { min: 0.25, max: 0.8 }
    );
    toggleRow(
      topRowHolder,
      'Top row doors',
      () => part.topRow?.doors === true,
      (v) => {
        if (part.topRow) part.topRow.doors = v;
        onChange();
      }
    );
  };
  toggleRow(
    body,
    'Top box row',
    () => !!part.topRow,
    (v) => {
      if (v) part.topRow = { h: 0.4, doors: true };
      else delete part.topRow;
      renderTopRow();
      onChange();
    }
  );
  body.appendChild(topRowHolder);
  renderTopRow();
  toggleRow(
    body,
    'Cove light',
    () => part.light?.cove === true,
    (v) => setLight(part, 'cove', v, onChange)
  );

  /* ---------------- colours ---------------- */

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
  const accent = sec('Wood accent (interior / shelves)', 'both');
  swatchRow(
    accent,
    [OAK, WALNUT, ...COUNTER_COLORS.slice(1, 3)],
    () => part.accentColor,
    (c) => {
      part.accentColor = c;
      onChange();
    }
  );

  /* ---------------- fit to the room ---------------- */

  const fit = sec('Fit to the room', 'advanced');
  for (const side of ['left', 'right'] as const) {
    choiceRow(
      fit,
      side === 'left' ? 'Left side' : 'Right side',
      [
        ['panel', 'Panel'],
        ['wall', 'Wall'],
      ],
      () => part.sides[side],
      (v) => {
        part.sides[side] = v === 'wall' ? 'wall' : 'panel';
        onChange();
      }
    );
  }
  for (const side of ['left', 'right'] as const) {
    numRow(
      fit,
      side === 'left' ? 'Filler left' : 'Filler right',
      () => part.filler[side],
      (v) => {
        part.filler[side] = clamp(v, 0, 0.1);
        onChange();
      },
      { min: 0, max: 0.1 }
    );
  }
  choiceRow(
    fit,
    'Top',
    [
      ['panel', 'Panel'],
      ['ceiling', 'To ceiling'],
    ],
    () => part.top,
    (v) => {
      part.top = v === 'ceiling' ? 'ceiling' : 'panel';
      onChange();
    }
  );
  toggleRow(
    fit,
    'Back panel',
    () => part.back,
    (v) => {
      part.back = v;
      onChange();
    }
  );
  numRow(
    fit,
    'Cornice',
    () => part.cornice ?? 0,
    (v) => {
      const c = clamp(v, 0, 0.3);
      if (c > 0) part.cornice = c;
      else delete part.cornice;
      onChange();
    },
    { min: 0, max: 0.3 }
  );

  /* ---------------- lighting ---------------- */

  const lighting = sec('Lighting', 'advanced');
  toggleRow(
    lighting,
    'Shelf lights',
    () => part.light?.shelves === true,
    (v) => setLight(part, 'shelves', v, onChange)
  );
}

/**
 * `light` is absent when nothing is lit — the sanitizer deletes it, and an
 * undo snapshot is a JSON round-trip, so writing `{cove:false, shelves:false}`
 * would be a diff that says nothing.
 */
function setLight(
  part: WardrobePartDef,
  key: 'cove' | 'shelves',
  on: boolean,
  onChange: (transient?: boolean) => void
): void {
  const next = { cove: part.light?.cove === true, shelves: part.light?.shelves === true };
  next[key] = on;
  if (next.cove || next.shelves) part.light = next;
  else delete part.light;
  onChange();
}
