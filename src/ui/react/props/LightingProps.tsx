import type { ReactElement } from 'react';
import { useStore } from '../services';
import { SUN_ELEV_MAX, SUN_ELEV_MIN } from '../../../model/sky';
import { SliderRow } from '../fields/SliderRow';

const deg = (v: number): string => `${Math.round(v)}°`;
/** brightness is a 0..2 SCALE shown as a percentage — not a length, so no units.ts */
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Global lighting — src/ui/ui.ts's renderLightingProps, shown at the bottom of
 * the no-selection (room) panel.
 *
 * `design.scene` angles are DEGREES, the model's one non-radian exception
 * (CLAUDE.md), so these sliders hand the store its own numbers untouched.
 * Every one is a live, NON-structural mutation — View3D.relight() runs on the
 * spot — with the single undo step taken by SliderRow's native change at the
 * end of the drag.
 */
export function LightingProps(): ReactElement {
  const store = useStore();
  const scene = store.design.scene;

  return (
    <div className="prop-section">
      <div className="prop-section-title">Lighting</div>
      <SliderRow
        label="Sun direction"
        value={scene.sunAzimuth}
        onInput={(v) => store.setScene({ sunAzimuth: v })}
        min={0}
        max={360}
        step={5}
        fmt={deg}
      />
      <SliderRow
        label="Sun height"
        value={scene.sunElevation}
        onInput={(v) => store.setScene({ sunElevation: v })}
        min={SUN_ELEV_MIN}
        max={SUN_ELEV_MAX}
        step={1}
        fmt={deg}
      />
      <SliderRow
        label="Brightness"
        value={scene.brightness}
        onInput={(v) => store.setScene({ brightness: v })}
        min={0}
        max={2}
        step={0.05}
        fmt={pct}
      />
    </div>
  );
}
