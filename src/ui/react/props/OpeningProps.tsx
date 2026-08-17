import type { ReactElement } from 'react';
import { store } from '../../../app/bootstrap';
import { ChoiceRow } from '../fields/ChoiceRow';
import { LengthField } from '../fields/LengthField';

const HINGE: readonly (readonly [string, string])[] = [
  ['left', 'Hinge left'],
  ['right', 'Hinge right'],
];

const SWING: readonly (readonly [string, string])[] = [
  ['in', 'Opens in'],
  ['out', 'Opens out'],
];

/**
 * A selected door or window — src/ui/ui.ts's renderOpeningProps.
 *
 * An opening is anchored to `wallId` + an offset from that wall's start
 * corner, so "From corner" is the field a plan drag moves: it is `live`, and
 * follows the drag through the 'transient' channel without re-rendering the
 * panel. Its cap is the wall's current length, which is why the row only
 * renders once that wall resolves.
 */
export function OpeningProps({ id }: { id: string }): ReactElement | null {
  const o = store.openingById(id);
  if (!o) return null;
  const wall = store.wallById(o.wallId);
  const one = [o];

  return (
    <>
      <h2 className="props-title">{o.type === 'door' ? 'Door' : 'Window'}</h2>
      <p className="props-sub">Slides along its wall — drag it in the plan</p>

      <div className="prop-section">
        <div className="prop-section-title">Size</div>
        <LengthField
          label="Width"
          items={one}
          read={(x) => x.width}
          onCommit={(m) => store.updateOpening(id, { width: m })}
          min={30}
          max={400}
        />
        <LengthField
          label="Height"
          items={one}
          read={(x) => x.height}
          onCommit={(m) => store.updateOpening(id, { height: m })}
          min={30}
          max={300}
        />
        {o.type === 'window' ? (
          <LengthField
            label="Sill height"
            items={one}
            read={(x) => x.sill}
            onCommit={(m) => store.updateOpening(id, { sill: m })}
            min={0}
            max={250}
          />
        ) : null}
        {wall ? (
          <LengthField
            label="From corner"
            items={one}
            read={(x) => x.offset}
            onCommit={(m) => store.updateOpening(id, { offset: m })}
            min={0}
            max={Math.round(wall.len * 100)}
            cls="opening-off"
            live
          />
        ) : null}
      </div>

      {o.type === 'door' ? (
        <div className="prop-section">
          <div className="prop-section-title">Swing</div>
          <ChoiceRow
            options={HINGE}
            current={o.hinge ?? 'left'}
            onPick={(v) => store.updateOpening(id, { hinge: v as 'left' | 'right' })}
          />
          <ChoiceRow
            options={SWING}
            current={o.swing ?? 'in'}
            onPick={(v) => store.updateOpening(id, { swing: v as 'in' | 'out' })}
          />
        </div>
      ) : null}

      <div className="prop-section">
        <div className="prop-section-title">Actions</div>
        <div className="btn-row">
          <button
            className="btn danger"
            onClick={() => {
              store.deleteOpening(id);
              store.commit();
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </>
  );
}
