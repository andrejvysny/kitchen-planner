import { useState, type ReactElement } from 'react';
import { SliderRow } from '../fields/SliderRow';
import { useStore } from '../services';

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Room staging — fill the active room with set dressing in one step.
 *
 * Density and the seed are LOCAL component state, not store fields: they are
 * knobs on this one action, not properties of the design, and putting them in
 * the Design would mean serializing and undoing them. "Restage" re-rolls the
 * seed, which is the only control over it anyone actually wants.
 *
 * Calls the store directly, like every other room section — `CommandRegistry`
 * exists for behaviours the KEYBOARD also reaches, and `execute(id)` carries no
 * payload, so routing a density through it would mean widening that contract
 * for a button that has no shortcut.
 */
export function StagingSection(): ReactElement {
  const store = useStore();
  const [density, setDensity] = useState(0.5);
  const [seed, setSeed] = useState(1);
  const staged = store.hasStaging();

  const stage = (): void => {
    // stageRoom clears first, so pressing this twice restages rather than
    // piling a second set of clutter on top of the first
    store.stageRoom(undefined, density, seed);
    store.commit();
    setSeed((s) => (s + 1) >>> 0);
  };

  const clear = (): void => {
    store.unstageRoom();
    store.commit();
  };

  return (
    <div className="prop-section" id="section-staging">
      <div className="prop-section-title">Staging</div>
      <SliderRow
        label="Amount"
        value={density}
        onInput={setDensity}
        min={0}
        max={1}
        step={0.05}
        fmt={pct}
      />
      <div className="prop-row prop-actions">
        <button id="btn-stage" onClick={stage}>
          {staged ? 'Restage room' : 'Stage room'}
        </button>
        <button id="btn-unstage" disabled={!staged} onClick={clear}>
          Clear
        </button>
      </div>
      <div className="prop-hint">
        Books, plants and kitchen clutter, arranged on the surfaces this room already has. Never
        printed, never on a shopping list.
      </div>
    </div>
  );
}
