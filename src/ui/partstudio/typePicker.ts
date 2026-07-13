import type { CustomPartDef } from '../../model/types';

interface Card {
  type: CustomPartDef['type'];
  title: string;
  blurb: string;
  icon: string;
}

const CARDS: Card[] = [
  {
    type: 'cabinet',
    title: 'Cabinet',
    blurb: 'Carcass with doors, drawers and niches — split the front into zones.',
    icon: `<svg viewBox="0 0 64 64"><rect x="8" y="10" width="48" height="44" rx="2"/><line x1="8" y1="26" x2="56" y2="26"/><line x1="32" y1="26" x2="32" y2="54"/><line x1="14" y1="18" x2="50" y2="18"/></svg>`,
  },
  {
    type: 'board',
    title: 'Worktop / board',
    blurb: 'Draw any outline and extrude a slab — L-shaped worktops, shelves.',
    icon: `<svg viewBox="0 0 64 64"><path d="M8 14 h48 v20 h-26 v16 h-22 z"/><rect x="16" y="20" width="12" height="8" rx="1"/></svg>`,
  },
  {
    type: 'freeform',
    title: 'Free boards',
    blurb: 'Place individual boards to build tables, benches and wardrobes.',
    icon: `<svg viewBox="0 0 64 64"><rect x="8" y="12" width="48" height="8" rx="1"/><line x1="14" y1="20" x2="14" y2="52"/><line x1="50" y1="20" x2="50" y2="52"/><rect x="34" y="24" width="14" height="20" rx="1"/></svg>`,
  },
];

/** The "new part" chooser: one card per part type. */
export function renderTypePicker(
  body: HTMLElement,
  types: CustomPartDef['type'][],
  onChoose: (type: CustomPartDef['type']) => void
): void {
  const holder = document.createElement('div');
  holder.className = 'studio-cards';
  for (const card of CARDS.filter((c) => types.includes(c.type))) {
    const el = document.createElement('button');
    el.className = 'studio-card';
    el.dataset.type = card.type;
    el.innerHTML = `<div class="studio-card-icon">${card.icon}</div>
      <div class="studio-card-title">${card.title}</div>
      <div class="studio-card-blurb">${card.blurb}</div>`;
    el.addEventListener('click', () => onChoose(card.type));
    holder.appendChild(el);
  }
  body.appendChild(holder);
}
