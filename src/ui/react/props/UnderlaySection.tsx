import type { ReactElement } from 'react';
import { useAppServices } from '../services';
import { pixelSize } from '../../underlayImport';
import { SliderRow } from '../fields/SliderRow';
import { useChannel } from '../hooks/useStore';

/**
 * Tracing-photo controls — src/ui/ui.ts's underlaySection/underlayToggles.
 *
 * The photo itself lives OUTSIDE the design (CLAUDE.md: the bytes are their
 * own storage key, only the transform is undoable), so this section keys off
 * `underlayRef()` — both halves present — not off the transform alone.
 *
 * The picker is the topbar's `#underlay-input` (src/ui/react/Topbar.tsx), which
 * also owns the import and calibration callbacks; here a button only clicks it.
 * ui.ts used to mirror the calibrate button's `.active` class by hand from an
 * editor subscription — the last hand-mirrored bit of tool state in the app.
 * `useChannel('editor')` replaces it.
 */
export function UnderlaySection(): ReactElement {
  const { store, editor, plan } = useAppServices();
  useChannel('editor');
  useChannel('units'); // the pixel-size readout is a length like any other
  const ref = store.underlayRef();
  const pick = (): void => document.querySelector<HTMLInputElement>('#underlay-input')!.click();

  if (!ref) {
    return (
      <div className="prop-section">
        <div className="prop-section-title">Reference photo</div>
        <div className="btn-row">
          <button className="btn" onClick={pick}>
            Import photo…
          </button>
        </div>
        <p className="props-sub" style={{ marginTop: 8 }}>
          Trace an existing floor plan: import it, drag it under the room, then calibrate its scale.
        </p>
      </div>
    );
  }

  const u = ref.u;
  const flip = (patch: Parameters<typeof store.updateUnderlay>[0]): void => {
    store.updateUnderlay(patch);
    store.commit();
  };

  return (
    <div className="prop-section">
      <div className="prop-section-title">Reference photo</div>
      {/* opacity is a 0..1 RATIO shown as a percentage — not a length, so it
          does not go through units.ts */}
      <SliderRow
        label="Opacity"
        value={Math.round(u.opacity * 100)}
        onInput={(v) => store.updateUnderlay({ opacity: v / 100 })}
        min={0}
        max={100}
        step={1}
        fmt={(v) => `${Math.round(v)}%`}
      />
      <div className="btn-row">
        <button
          className={
            editor.isTool('calibrate') ? 'btn underlay-calibrate active' : 'btn underlay-calibrate'
          }
          onClick={() => plan.setCalibrate(!editor.isTool('calibrate'))}
        >
          Calibrate scale
        </button>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={() => flip({ visible: !u.visible })}>
          {u.visible ? 'Hide' : 'Show'}
        </button>
        <button
          className={u.locked ? 'btn active' : 'btn'}
          onClick={() => flip({ locked: !u.locked })}
        >
          {u.locked ? '🔒 Locked' : '🔓 Unlocked'}
        </button>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={pick}>
          Replace…
        </button>
        <button
          className="btn danger"
          onClick={() => {
            store.setUnderlay(null);
            store.commit();
          }}
        >
          Remove
        </button>
      </div>
      <p className="props-sub" style={{ marginTop: 8 }}>
        {`1 photo pixel = ${pixelSize(u.scale)} · drag the photo in the plan to move it`}
      </p>
    </div>
  );
}
