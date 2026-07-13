// Pure classification of wheel/trackpad input for navigation.
// Kept free of three.js so it can be unit-tested headlessly. View3D wires the
// resulting gesture to camera pan/orbit/zoom; Plan2D reuses isMac/isTrackpadWheel
// for two-finger pan vs pinch-zoom (macOS trackpad support, KITCHENP-4).

/** Subset of WheelEvent we read. `wheelDeltaY` is a legacy field (absent from
 *  lib.dom types) but still exposed by Chrome/Safari — our best trackpad tell. */
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

/** True for Apple laptops/desktops, where the trackpad gestures apply. */
export function isMac(platform: string, userAgent: string): boolean {
  return /mac/i.test(platform) || /Mac OS X/i.test(userAgent);
}

/**
 * Distinguish a MacBook trackpad two-finger swipe from a mouse wheel notch.
 * Heuristic (there is no definitive DOM flag):
 *  - any horizontal component ⇒ trackpad (mouse wheels are vertical-only);
 *  - else mouse notches report `wheelDeltaY` as a multiple of 120 — trackpad
 *    deltas are not;
 *  - else (browsers without `wheelDeltaY`, e.g. Firefox) sub-pixel/pixel-mode
 *    deltas indicate a trackpad.
 */
export function isTrackpadWheel(e: WheelLike): boolean {
  if (e.deltaX !== 0) return true;
  const wd = e.wheelDeltaY;
  if (typeof wd === 'number' && wd !== 0) return Math.abs(wd) % 120 !== 0;
  return e.deltaMode === 0 && !Number.isInteger(e.deltaY);
}

/**
 * Map a wheel event to a camera gesture. `mac` gates the trackpad remap so that
 * on other platforms the caller keeps OrbitControls' default wheel-zoom.
 * A pinch (ctrl+wheel) always zooms — it is macOS's pinch signal and is
 * harmless as a plain ctrl+scroll elsewhere.
 */
export function wheelGesture(e: WheelLike, mac: boolean): WheelGesture {
  if (e.ctrlKey) return 'zoom-pinch';
  if (mac && isTrackpadWheel(e)) {
    return e.shiftKey ? 'trackpad-orbit' : 'trackpad-pan';
  }
  return 'mouse-zoom';
}
