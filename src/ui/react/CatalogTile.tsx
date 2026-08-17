import {
  memo,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { editor, plan, store, studio } from '../../app/bootstrap';
import type { CatalogDef } from '../../model/catalog';
import { footprintPolygon } from '../../model/parts';
import { renderThumbnail } from '../../plan2d/symbols';

/**
 * One catalog tile: a plan-symbol thumbnail, a label, and the click that arms
 * the place tool with this def. Ported from ui.ts renderCatalog's addTile —
 * same wrapper/tile/canvas/label nesting, same attributes, same handlers.
 *
 * `memo` matters here rather than being decoration: <CatalogPanel/> re-renders
 * on every 'editor' tick (arming a tile is one), and a tile that re-rendered
 * would redraw its canvas each time. The def objects are the panel's memoized
 * ones, so only the two tiles whose `armed` actually flipped do any work.
 */
export interface CatalogTileProps {
  def: CatalogDef;
  /** custom parts carry the ✎ button that opens them in the Part Studio */
  editable: boolean;
  armed: boolean;
}

export const CatalogTile = memo(function CatalogTile({
  def,
  editable,
  armed,
}: CatalogTileProps): ReactElement {
  const canvas = useRef<HTMLCanvasElement>(null);

  // The thumbnail is canvas pixels, not markup, so it is drawn imperatively.
  // Keyed on the def OBJECT: <CatalogPanel/> rebuilds its defs only when the
  // parts library changes, which is exactly when a custom part's symbol —
  // dimensions, colour or footprint — can have moved. Built-in defs are module
  // constants, so their tiles draw once.
  useEffect(() => {
    const part = store.partOf(def.id);
    renderThumbnail(
      canvas.current!,
      def.kind,
      def.w,
      def.d,
      def.color,
      part ? (footprintPolygon(part, def.w, def.d) ?? undefined) : undefined
    );
  }, [def]);

  const arm = (): void => {
    plan.setArmed(editor.armedDefId === def.id ? null : def);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      arm();
    }
  };

  // the ✎ is a SIBLING of the tile, so the click never reaches `arm` anyway —
  // stopPropagation is kept from the ported handler as a guard on the nesting
  const edit = (e: MouseEvent): void => {
    e.stopPropagation();
    plan.setArmed(null);
    studio.open(store.customPartById(def.id));
  };

  return (
    <div className="cat-item-wrap">
      <div
        className={armed ? 'cat-item armed' : 'cat-item'}
        data-def-id={def.id}
        role="button"
        tabIndex={0}
        title={`Click, then click in the plan to place — ${def.label.toLowerCase()}`}
        onClick={arm}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvas}></canvas>
        <span>{def.label}</span>
      </div>
      {editable ? (
        <button className="cat-edit" title="Edit this part" onClick={edit}>
          ✎
        </button>
      ) : null}
    </div>
  );
});
