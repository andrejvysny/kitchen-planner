import { useCallback, useEffect, useLayoutEffect, useState, type ReactElement } from 'react';
import { setOnboarded } from '../onboarded';

/**
 * The first-run tour (WS-SPEC §5.5, WP 2.5): four bubbles that name the three
 * regions of the shell plus where to find every gesture again, once, on a
 * device that has never opened the app.
 *
 * WHETHER it runs is not this component's decision — `services.firstRun`
 * (src/app/services.ts) settles that at construction, from storage, before
 * React mounts, which is also what guarantees the tour and the recovery banner
 * can never appear together. <App/> mounts this component only on a true, so
 * everything here is about the four steps themselves.
 *
 * Deliberately small: no library, no spotlight cutout punched through the
 * backdrop, no scroll-into-view. The four anchors are fixed chrome
 * (`#ws-tabs`, `#catalog`, `#props`, `#btn-settings`), so a measured rect plus
 * a ring drawn ON TOP of the dim is enough to point at each one.
 *
 * DISMISS-ANYWHERE: the backdrop takes the pointer, so any press advances —
 * which also means the tour never lets a first click land somewhere the user
 * did not mean it to. `Skip` stops propagation so it ends the tour instead of
 * advancing it one step first.
 *
 * `setOnboarded()` is written when the tour ENDS (walked or skipped), not when
 * it mounts: an interrupted first visit deserves the tour again. The e2e suites
 * seed ONBOARDED_KEY at page init precisely because a cleared profile is
 * otherwise a first run — see e2e/fixtures.ts.
 */

interface Mark {
  /** element the bubble points at; a missing one just centres the bubble */
  anchor: string;
  /** short lead-in, bold; omitted on the three region bubbles */
  title?: string;
  body: string;
  /** which side of the anchor the bubble sits on */
  place: 'below' | 'right' | 'left';
}

const MARKS: readonly Mark[] = [
  {
    anchor: '#ws-tabs',
    body: 'Work moves left to right — plan the rooms, furnish them, refine parts, export.',
    place: 'below',
  },
  {
    anchor: '#catalog',
    body: 'Everything you can place lives here.',
    place: 'right',
  },
  {
    anchor: '#props',
    body: 'Whatever you select is edited here.',
    place: 'left',
  },
  {
    anchor: '#btn-settings',
    title: 'Lost?',
    body: 'Press ? anytime for every shortcut and gesture — or find them under ⚙ → Shortcuts…',
    place: 'left',
  },
];

/** Bubble width, in one place: the CSS reads it from the inline style below. */
const BUBBLE_W = 264;
/** Enough room to keep a bubble on screen without measuring its real height. */
const BUBBLE_H = 150;
/** Gap to the anchor, and to the window edge when a bubble has to be nudged in. */
const GAP = 12;
const EDGE = 8;

interface Placement {
  left: number;
  top: number;
  /** viewport rect of the anchor, for the highlight ring; null = not found */
  ring: { left: number; top: number; width: number; height: number } | null;
}

function placeFor(mark: Mark): Placement {
  const el = document.querySelector(mark.anchor);
  if (!el) {
    return {
      left: (window.innerWidth - BUBBLE_W) / 2,
      top: (window.innerHeight - BUBBLE_H) / 2,
      ring: null,
    };
  }
  const r = el.getBoundingClientRect();
  const raw =
    mark.place === 'below'
      ? { left: r.left, top: r.bottom + GAP }
      : mark.place === 'right'
        ? { left: r.right + GAP, top: r.top + 24 }
        : { left: r.left - BUBBLE_W - GAP, top: r.top + 24 };

  return {
    left: clamp(raw.left, EDGE, window.innerWidth - BUBBLE_W - EDGE),
    top: clamp(raw.top, EDGE, window.innerHeight - BUBBLE_H - EDGE),
    ring: { left: r.left, top: r.top, width: r.width, height: r.height },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

export function CoachMarks(): ReactElement | null {
  const [step, setStep] = useState(0);
  const [pos, setPos] = useState<Placement | null>(null);

  const done = step >= MARKS.length;

  /** Ends the tour for good — this is the ONLY writer of the onboarded flag. */
  const finish = useCallback((): void => {
    setOnboarded();
    setStep(MARKS.length);
  }, []);

  // Measure before paint, and again on resize: the anchors are laid out by
  // flexbox, so their rects only exist once the shell has rendered.
  useLayoutEffect(() => {
    if (done) return;
    const measure = (): void => setPos(placeFor(MARKS[step]));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [step, done]);

  // Escape ends the tour, and must not also cancel a tool — capture phase, for
  // the reason spelled out in Cheatsheet.tsx.
  useEffect(() => {
    if (done) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [done, finish]);

  if (done) return null;

  const advance = (): void => {
    if (step + 1 >= MARKS.length) finish();
    else setStep(step + 1);
  };

  const mark = MARKS[step];

  return (
    <div id="coach-marks" className="coach-backdrop" onPointerDown={advance}>
      {pos?.ring && (
        <div
          className="coach-ring"
          style={{
            left: pos.ring.left,
            top: pos.ring.top,
            width: pos.ring.width,
            height: pos.ring.height,
          }}
        />
      )}
      <div
        className="coach-mark"
        data-step={step}
        style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: BUBBLE_W }}
      >
        {mark.title && <p className="coach-title">{mark.title}</p>}
        <p className="coach-body">{mark.body}</p>
        <div className="coach-foot">
          <span className="coach-dots" aria-label={`Step ${step + 1} of ${MARKS.length}`}>
            {MARKS.map((_, i) => (
              <span key={i} className={i === step ? 'coach-dot on' : 'coach-dot'} />
            ))}
          </span>
          <button
            className="coach-skip"
            type="button"
            onPointerDown={(e) => {
              // otherwise this press ALSO reaches the backdrop and advances
              e.stopPropagation();
              finish();
            }}
          >
            {step + 1 === MARKS.length ? 'Got it' : 'Skip'}
          </button>
        </div>
      </div>
    </div>
  );
}
