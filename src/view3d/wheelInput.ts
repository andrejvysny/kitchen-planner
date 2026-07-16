// Pure classification of wheel/trackpad input for navigation.
// Kept free of three.js AND of storage/DOM so it can be unit-tested headlessly.
// View3D wires the resulting gesture to camera pan/orbit/zoom; Plan2D reuses the
// device resolution for two-finger pan vs pinch-zoom (macOS trackpad, KITCHENP-4).
// Persistence + the shared detector instance live in src/model/navPref.ts.

/** Subset of WheelEvent we read. `wheelDeltaY` is a legacy field (absent from
 *  lib.dom types) but still exposed by Chrome/Safari — one of our device tells. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  wheelDeltaY?: number;
}

export type WheelGesture =
  | 'zoom-pinch' // macOS pinch (ctrl+wheel) → dolly
  | 'trackpad-pan' // two-finger swipe → pan
  | 'trackpad-orbit' // two-finger swipe + Shift → orbit
  | 'mouse-zoom'; // classic mouse wheel notch → dolly

/** The physical device a wheel event came from. */
export type NavDevice = 'mouse' | 'trackpad';
/** User preference: 'auto' runs the detector below, the others force a device. */
export type NavInput = 'auto' | NavDevice;

export const NAV_INPUTS: readonly NavInput[] = ['auto', 'mouse', 'trackpad'];

export function isNavInput(v: unknown): v is NavInput {
  return typeof v === 'string' && (NAV_INPUTS as readonly string[]).includes(v);
}

/** True for Apple laptops/desktops, where the trackpad gestures apply. */
export function isMac(platform: string, userAgent: string): boolean {
  return /mac/i.test(platform) || /Mac OS X/i.test(userAgent);
}

/**
 * Positive evidence that an event came from one device, or null when it could
 * have come from either.
 *
 * Deliberately conservative: we only claim a device on a signal the other one
 * physically cannot produce. There is no DOM flag for this (Chromium tracks
 * `has_precise_scrolling_deltas` internally but never exposes it), so guessing
 * from magnitude alone is what made this misfire before — on macOS the OS
 * applies its own acceleration curve, and `wheelDeltaY` is derived from the
 * accelerated amount for trackpads AND smooth/high-resolution wheels alike.
 * That means a plain notch can arrive as deltaY 12 / wheelDeltaY -36 and look
 * nothing like the textbook multiple of 120.
 */
export function wheelEvidence(e: WheelLike): NavDevice | null {
  // A wheel spins on one axis; only a surface can push sideways.
  if (e.deltaX !== 0) return 'trackpad';
  // Sub-pixel deltas only come off a continuous-scroll surface.
  if (e.deltaMode === 0 && !Number.isInteger(e.deltaY)) return 'trackpad';
  // A textbook notch: unaccelerated, and still reported in units of 120.
  const wd = e.wheelDeltaY;
  if (typeof wd === 'number' && wd !== 0 && Math.abs(wd) % 120 === 0) return 'mouse';
  return null; // accelerated notch vs axis-locked swipe — genuinely ambiguous
}

/**
 * Remembers the last device we had real evidence for, so the ambiguous events
 * in between resolve to whatever is actually plugged in. One physical device
 * per user, so a single instance is shared by both views (see navPref.ts).
 *
 * Unknown resolves to 'mouse' — wheel-zoom is the documented expectation
 * (KITCHENP-13), and a trackpad reveals itself on the first fractional or
 * horizontal delta, which is essentially always the first event of a gesture.
 * Evidence is last-wins, so a stray misread self-corrects on the next event
 * instead of wedging the session.
 */
export class WheelDevice {
  private seen: NavDevice | null = null;

  classify(e: WheelLike): NavDevice {
    const ev = wheelEvidence(e);
    if (ev) this.seen = ev;
    return this.seen ?? 'mouse';
  }

  /** Forget the latch (used when the user changes the nav preference). */
  reset(): void {
    this.seen = null;
  }
}

/**
 * Map a wheel event to a camera gesture. `mac` gates the trackpad remap so that
 * on other platforms the caller keeps OrbitControls' default wheel-zoom.
 * A pinch (ctrl+wheel) always zooms — it is macOS's pinch signal and is
 * harmless as a plain ctrl+scroll elsewhere.
 */
export function wheelGesture(e: WheelLike, mac: boolean, device: NavDevice): WheelGesture {
  if (e.ctrlKey) return 'zoom-pinch';
  if (mac && device === 'trackpad') {
    return e.shiftKey ? 'trackpad-orbit' : 'trackpad-pan';
  }
  return 'mouse-zoom';
}
