import type { ReactElement } from 'react';
import { hasPattern } from '../../../model/materials';
import { ToggleRow } from './ToggleRow';

export interface RotToggleProps {
  /** The slot's active material; a plain colour has no pattern to rotate. */
  matId?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

/**
 * "Rotate texture 90°" — src/ui/ui.ts's rotToggle: a ToggleRow that renders
 * only when the active material actually carries a pattern, so a plain-colour
 * surface shows no dead control.
 */
export function RotToggle({ matId, value, onChange }: RotToggleProps): ReactElement | null {
  if (!hasPattern(matId)) return null;
  return <ToggleRow label="Rotate texture 90°" value={value} onChange={onChange} />;
}
