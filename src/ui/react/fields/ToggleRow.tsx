import { useEffect, useRef, type ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { useNativeChange } from './useNativeChange';

export interface ToggleRowProps {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

/**
 * The switch row — src/ui/ui.ts's toggleRow: `.toggle-row` > label +
 * `label.switch` > checkbox + `span.track` (the track is what style.css draws;
 * the checkbox itself is visually hidden).
 *
 * A checkbox is one of the cases where React's onChange IS the native change
 * event, but it goes through useNativeChange anyway: one commit rule, one
 * place to read it, and the eslint rule stays free of per-type exceptions.
 */
export function ToggleRow({ label, value, onChange }: ToggleRowProps): ReactElement {
  const box = useRef<HTMLInputElement>(null);

  // `defaultChecked` is a mount-only prop, so mirror later model changes (undo,
  // an edit from elsewhere) the way useSyncedValue does for text fields
  useEffect(() => {
    const el = box.current;
    if (el && document.activeElement !== el) el.checked = value;
  });

  useNativeChange(box, (el) => {
    onChange(el.checked);
    store.commit();
  });

  return (
    <div className="toggle-row">
      <label>{label}</label>
      <label className="switch">
        <input type="checkbox" defaultChecked={value} ref={box} />
        <span className="track"></span>
      </label>
    </div>
  );
}
