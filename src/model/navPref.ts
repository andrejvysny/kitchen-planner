// Navigation input preference: how to read the wheel (KITCHENP-13).
//
// This is a per-device UI preference, NOT design data — it lives in its own
// localStorage key so it never enters the design JSON, DESIGN_VERSION or export.
// The detector is a module singleton because the user has one physical device:
// evidence seen in the 3D view resolves ambiguous events in the 2D plan too.

import { isNavInput, WheelDevice, type NavDevice, type NavInput, type WheelLike } from '../view3d/wheelInput';

const NAV_KEY = 'kitchen-planner-nav-v1';

const detector = new WheelDevice();
let current: NavInput = load();

function load(): NavInput {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    return isNavInput(raw) ? raw : 'auto';
  } catch {
    return 'auto'; // private mode / storage disabled
  }
}

export function navInput(): NavInput {
  return current;
}

export function setNavInput(v: NavInput): void {
  current = v;
  detector.reset(); // re-learn from scratch rather than trust a stale latch
  try {
    localStorage.setItem(NAV_KEY, v);
  } catch {
    /* preference is best-effort */
  }
}

/** Which device this event should be treated as, honouring the preference. */
export function resolveDevice(e: WheelLike): NavDevice {
  return current === 'auto' ? detector.classify(e) : current;
}
