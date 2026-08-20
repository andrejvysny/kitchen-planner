import { unitPrefs } from '../../model/prefs';
import { formatLength, parseLength } from '../../model/units';

/** Small DOM builders shared by the studio panels (rail sections, rows). */

/**
 * The studio's length rows are plain spinners, not the inspector's expression
 * boxes, but they read and write the SAME unit — src/model/units.ts is the one
 * conversion authority (CLAUDE.md), so nothing here multiplies by 100. Both
 * helpers re-read the preference on every call: it is a module singleton and a
 * studio panel is rebuilt whenever it is opened.
 */

/** metres → the number a studio box shows, in the preferred unit. */
function disp(m: number): number {
  return Number(formatLength(m, unitPrefs()));
}

/** a bare number typed into a studio box → metres, or null if it is not one. */
function model(v: number): number | null {
  return Number.isFinite(v) ? parseLength(String(v), unitPrefs()) : null;
}

/** The unit suffix a studio section title carries, e.g. "Dimensions (mm)". */
export function unitSuffix(): string {
  return unitPrefs().unit;
}

export function section(parent: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('div');
  s.className = 'prop-section';
  s.innerHTML = `<div class="prop-section-title">${title}</div>`;
  parent.appendChild(s);
  return s;
}

/**
 * Slider + number pair editing a length in the display unit (model in meters).
 *
 * `set` is told whether this is a mid-drag tick: the RANGE fires per pointer
 * move, so under live-apply (WS-SPEC WP 3.1) those ticks must notify without
 * committing, or one slider drag would bury the undo stack. The number box
 * fires on `change` and is always the end of a gesture.
 */
export function dimRow(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (m: number, transient?: boolean) => void,
  min: number,
  max: number
): () => void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label>
    <input type="range" min="${disp(min)}" max="${disp(max)}" step="1" value="${disp(get())}">
    <input type="number" min="${disp(min)}" max="${disp(max)}" step="1" value="${disp(get())}">`;
  const range = row.querySelector('input[type=range]') as HTMLInputElement;
  const num = row.querySelector('input[type=number]') as HTMLInputElement;
  const sync = () => {
    range.value = num.value = String(disp(get()));
  };
  const apply = (v: number, transient?: boolean) => {
    const m = model(v);
    if (m !== null) set(Math.min(max, Math.max(min, m)), transient);
    sync();
  };
  range.addEventListener('input', () => apply(Number(range.value), true));
  // …and the drag's own end: `change` fires once, after the pointer is up
  range.addEventListener('change', () => apply(Number(range.value)));
  num.addEventListener('change', () => apply(Number(num.value)));
  parent.appendChild(row);
  return sync;
}

/** Plain number input editing a length in the display unit (model in meters). */
export function numRow(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (m: number) => void,
  opts: { min?: number; max?: number; step?: number } = {}
): () => void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label><input type="number" step="${opts.step ?? 1}">`;
  const num = row.querySelector('input') as HTMLInputElement;
  const sync = () => (num.value = String(disp(get())));
  sync();
  num.addEventListener('change', () => {
    let v = model(Number(num.value));
    // nonsense in, nothing out — put the model's own value back
    if (v === null) return sync();
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    set(v);
    sync();
  });
  parent.appendChild(row);
  return sync;
}

export function toggleRow(
  parent: HTMLElement,
  label: string,
  get: () => boolean,
  set: (v: boolean) => void
): void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label><label class="switch"><input type="checkbox" ${get() ? 'checked' : ''}><span class="track"></span></label>`;
  const cb = row.querySelector('input') as HTMLInputElement;
  cb.addEventListener('change', () => set(cb.checked));
  parent.appendChild(row);
}

export function stepperRow(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (v: number) => void,
  min: number,
  max: number
): void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label>
    <div class="stepper"><button>−</button><span>${get()}</span><button>+</button></div>`;
  const [minus, plus] = Array.from(row.querySelectorAll('button'));
  const span = row.querySelector('span') as HTMLElement;
  const apply = (v: number) => {
    set(Math.min(max, Math.max(min, v)));
    span.textContent = String(get());
  };
  minus.addEventListener('click', () => apply(get() - 1));
  plus.addEventListener('click', () => apply(get() + 1));
  parent.appendChild(row);
}

export function swatchRow(
  parent: HTMLElement,
  colors: string[],
  get: () => string,
  set: (c: string) => void
): void {
  const sw = document.createElement('div');
  sw.className = 'swatches';
  for (const c of colors) {
    const b = document.createElement('button');
    b.className = `swatch${get() === c ? ' active' : ''}`;
    b.style.background = c;
    b.addEventListener('click', () => {
      set(c);
      sw.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    sw.appendChild(b);
  }
  parent.appendChild(sw);
}

/** Segmented buttons picking one of a few values. */
export function choiceRow(
  parent: HTMLElement,
  label: string,
  options: [string, string][],
  get: () => string,
  set: (v: string) => void
): void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label><div class="choice"></div>`;
  const holder = row.querySelector('.choice') as HTMLElement;
  for (const [value, text] of options) {
    const b = document.createElement('button');
    b.className = `btn choice-btn${get() === value ? ' active' : ''}`;
    b.textContent = text;
    b.addEventListener('click', () => {
      set(value);
      holder.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    holder.appendChild(b);
  }
  parent.appendChild(row);
}
