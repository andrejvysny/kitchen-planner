import { describe, expect, it } from 'vitest';
import { isMac, isTrackpadWheel, wheelGesture, type WheelLike } from '../../src/view3d/wheelInput';

function wheel(p: Partial<WheelLike>): WheelLike {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, ...p };
}

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

describe('isTrackpadWheel', () => {
  it('flags any horizontal component as trackpad', () => {
    expect(isTrackpadWheel(wheel({ deltaX: 3, deltaY: 0 }))).toBe(true);
  });
  it('treats 120-multiple wheelDeltaY as a mouse notch', () => {
    expect(isTrackpadWheel(wheel({ deltaY: 100, wheelDeltaY: 120 }))).toBe(false);
    expect(isTrackpadWheel(wheel({ deltaY: 200, wheelDeltaY: -240 }))).toBe(false);
  });
  it('treats non-120 wheelDeltaY as a trackpad swipe', () => {
    expect(isTrackpadWheel(wheel({ deltaY: 12, wheelDeltaY: -36 }))).toBe(true);
  });
  it('falls back to fractional pixel deltas when wheelDeltaY is absent', () => {
    expect(isTrackpadWheel(wheel({ deltaY: 4.5, deltaMode: 0 }))).toBe(true);
    expect(isTrackpadWheel(wheel({ deltaY: 3, deltaMode: 1 }))).toBe(false); // line-mode mouse
  });
});

describe('wheelGesture', () => {
  it('maps pinch (ctrl+wheel) to zoom regardless of platform', () => {
    expect(wheelGesture(wheel({ deltaY: 5, ctrlKey: true }), true)).toBe('zoom-pinch');
    expect(wheelGesture(wheel({ deltaY: 5, ctrlKey: true }), false)).toBe('zoom-pinch');
  });
  it('maps a two-finger swipe to pan on macOS', () => {
    expect(wheelGesture(wheel({ deltaX: 8, deltaY: 2 }), true)).toBe('trackpad-pan');
  });
  it('maps a two-finger swipe + Shift to orbit on macOS', () => {
    expect(wheelGesture(wheel({ deltaX: 8, deltaY: 2, shiftKey: true }), true)).toBe(
      'trackpad-orbit'
    );
  });
  it('keeps mouse-wheel notches as zoom on macOS', () => {
    expect(wheelGesture(wheel({ deltaY: 100, wheelDeltaY: 120 }), true)).toBe('mouse-zoom');
  });
  it('never remaps on non-macOS (defers to OrbitControls zoom)', () => {
    expect(wheelGesture(wheel({ deltaX: 8, deltaY: 2 }), false)).toBe('mouse-zoom');
    expect(wheelGesture(wheel({ deltaX: 8, deltaY: 2, shiftKey: true }), false)).toBe('mouse-zoom');
  });
});
