import { describe, expect, it } from 'vitest';
import {
  isMac,
  isNavInput,
  wheelEvidence,
  wheelGesture,
  WheelDevice,
  type WheelLike,
} from '../../src/view3d/wheelInput';

function wheel(p: Partial<WheelLike>): WheelLike {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, ...p };
}

/** A macOS trackpad two-finger swipe: sub-pixel deltas, slight sideways drift. */
const swipe = (p: Partial<WheelLike> = {}) => wheel({ deltaX: 0.5, deltaY: 2.5, ...p });
/** A macOS mouse notch after the OS acceleration curve — the KITCHENP-13 case. */
const acceleratedNotch = () => wheel({ deltaY: 12, wheelDeltaY: -36 });
/** A textbook unaccelerated notch. */
const notch = () => wheel({ deltaY: 100, wheelDeltaY: -120 });

describe('isMac', () => {
  it('detects macOS platforms', () => {
    expect(isMac('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(isMac('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
  });
  it('rejects non-macOS platforms', () => {
    expect(isMac('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isMac('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });
});

describe('wheelEvidence', () => {
  it('reads a horizontal component as trackpad (a wheel has one axis)', () => {
    expect(wheelEvidence(wheel({ deltaX: 3, deltaY: 0 }))).toBe('trackpad');
  });
  it('reads sub-pixel deltas as trackpad', () => {
    expect(wheelEvidence(wheel({ deltaY: 4.5 }))).toBe('trackpad');
  });
  it('reads a clean 120-multiple as a mouse notch', () => {
    expect(wheelEvidence(notch())).toBe('mouse');
    expect(wheelEvidence(wheel({ deltaY: 200, wheelDeltaY: -240 }))).toBe('mouse');
  });
  it('admits an accelerated notch is ambiguous rather than calling it a trackpad', () => {
    // The old %120 rule claimed 'trackpad' here and broke wheel-zoom on macOS.
    expect(wheelEvidence(acceleratedNotch())).toBeNull();
  });
  it('admits an axis-locked integer swipe is ambiguous', () => {
    expect(wheelEvidence(wheel({ deltaY: 2, wheelDeltaY: -6 }))).toBeNull();
  });
  it('does not treat line-mode integers as sub-pixel', () => {
    expect(wheelEvidence(wheel({ deltaY: 3, deltaMode: 1 }))).toBeNull();
  });
});

describe('WheelDevice', () => {
  it('defaults to mouse so an unrecognised wheel still zooms', () => {
    expect(new WheelDevice().classify(acceleratedNotch())).toBe('mouse');
  });
  it('resolves accelerated notches to mouse once a real notch is seen', () => {
    const d = new WheelDevice();
    expect(d.classify(notch())).toBe('mouse');
    expect(d.classify(acceleratedNotch())).toBe('mouse');
  });
  it('latches trackpad so an axis-locked swipe mid-gesture still pans', () => {
    const d = new WheelDevice();
    expect(d.classify(swipe())).toBe('trackpad');
    // Fingers straighten out: no horizontal drift, whole-pixel delta.
    expect(d.classify(wheel({ deltaY: 2, wheelDeltaY: -6 }))).toBe('trackpad');
  });
  it('self-corrects when the device changes (last evidence wins)', () => {
    const d = new WheelDevice();
    d.classify(swipe());
    expect(d.classify(notch())).toBe('mouse');
    expect(d.classify(swipe())).toBe('trackpad');
  });
  it('forgets the latch on reset', () => {
    const d = new WheelDevice();
    d.classify(swipe());
    d.reset();
    expect(d.classify(acceleratedNotch())).toBe('mouse');
  });
});

describe('wheelGesture', () => {
  it('maps pinch (ctrl+wheel) to zoom regardless of platform or device', () => {
    expect(wheelGesture(wheel({ deltaY: 5, ctrlKey: true }), true, 'trackpad')).toBe('zoom-pinch');
    expect(wheelGesture(wheel({ deltaY: 5, ctrlKey: true }), false, 'mouse')).toBe('zoom-pinch');
  });
  it('maps a two-finger swipe to pan on macOS', () => {
    expect(wheelGesture(swipe(), true, 'trackpad')).toBe('trackpad-pan');
  });
  it('maps a two-finger swipe + Shift to orbit on macOS', () => {
    expect(wheelGesture(swipe({ shiftKey: true }), true, 'trackpad')).toBe('trackpad-orbit');
  });
  it('zooms for a mouse on macOS even when the delta looks trackpad-ish', () => {
    expect(wheelGesture(acceleratedNotch(), true, 'mouse')).toBe('mouse-zoom');
    expect(wheelGesture(swipe(), true, 'mouse')).toBe('mouse-zoom');
  });
  it('never remaps on non-macOS (defers to OrbitControls zoom)', () => {
    expect(wheelGesture(swipe(), false, 'trackpad')).toBe('mouse-zoom');
    expect(wheelGesture(swipe({ shiftKey: true }), false, 'trackpad')).toBe('mouse-zoom');
  });
});

describe('isNavInput', () => {
  it('accepts the three modes and rejects junk', () => {
    expect(isNavInput('auto')).toBe(true);
    expect(isNavInput('mouse')).toBe(true);
    expect(isNavInput('trackpad')).toBe(true);
    expect(isNavInput('wheel')).toBe(false);
    expect(isNavInput(null)).toBe(false);
  });
});
