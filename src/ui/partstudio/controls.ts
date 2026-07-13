/** Small DOM builders shared by the studio panels (rail sections, rows). */

export function section(parent: HTMLElement, title: string): HTMLElement {
  const s = document.createElement('div');
  s.className = 'prop-section';
  s.innerHTML = `<div class="prop-section-title">${title}</div>`;
  parent.appendChild(s);
  return s;
}

/** Slider + number pair editing a length in cm (model in meters). */
export function dimRow(
  parent: HTMLElement,
  label: string,
  get: () => number,
  set: (m: number) => void,
  min: number,
  max: number
): () => void {
  const row = document.createElement('div');
  row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label>
    <input type="range" min="${min * 100}" max="${max * 100}" step="1" value="${Math.round(get() * 100)}">
    <input type="number" min="${min * 100}" max="${max * 100}" step="1" value="${Math.round(get() * 100)}">`;
  const range = row.querySelector('input[type=range]') as HTMLInputElement;
  const num = row.querySelector('input[type=number]') as HTMLInputElement;
  const apply = (v: number) => {
    set(Math.min(max, Math.max(min, v / 100)));
    range.value = num.value = String(Math.round(get() * 100));
  };
  range.addEventListener('input', () => apply(Number(range.value)));
  num.addEventListener('change', () => apply(Number(num.value)));
  parent.appendChild(row);
  return () => {
    range.value = num.value = String(Math.round(get() * 100));
  };
}

/** Plain number input editing a length in cm (model in meters). */
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
  const sync = () => (num.value = String(Math.round(get() * 100)));
  sync();
  num.addEventListener('change', () => {
    let v = Number(num.value) / 100;
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
