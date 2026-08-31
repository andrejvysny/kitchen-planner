import { FACE_LAYOUTS, type FaceLayout } from '../../model/faceLayouts';
import { drawHingeTick } from '../../plan2d/hingeTick';
import { presetPart } from '../../model/presets';
import type { CabinetPartDef, LeafZone, Zone } from '../../model/types';
import { walkZones } from '../../model/zones';
import { confirmDialog } from '../dialogService';

/**
 * The Simple tab's front-layout tile row (WS-SPEC WP 3.4): one button per
 * canned zone tree from src/model/faceLayouts.ts, each with a tiny schematic
 * canvas, so a novice can pick a common front arrangement without ever
 * opening the Advanced tab's zone canvas. Split out of cabinetPanel.ts as its
 * own module for the same reason boardPanel.ts/freeformPanel.ts/zoneCanvas.ts
 * are — one file per rail concern.
 */

const TILE_W = 84;
const TILE_H = 56;
const TILE_INK = '#3a3934';
const TILE_SOFT = '#6f6d67';

/**
 * Whether `part.face` is something a Replace would actually lose. Picking
 * between canned layouts is lossless (nothing to confirm), and so is picking
 * one for a part that still has its ORIGINAL preset face — only a tree that
 * diverges from both is user work the confirm dialog needs to protect.
 *
 * Same JSON-stringify comparison `store.discardPristineShadow` uses for its
 * own "is this still what it started as" check — not a second deep-equal.
 */
function isCustomizedFace(part: CabinetPartDef): boolean {
  const current = JSON.stringify(part.face);
  if (FACE_LAYOUTS.some((l) => JSON.stringify(l.face()) === current)) return false;
  const preset = presetPart(part.id);
  return !(preset?.type === 'cabinet' && JSON.stringify(preset.face) === current);
}

/** Kept exported here for the studio's own callers — the implementation moved
 * to src/plan2d/hingeTick.ts so the wall elevation draws the SAME notation. */
export { drawHingeTick };

/** Diagonal hatch inside a clipped rect — the "open"/void schematic. */
function drawHatch(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 2, y + 2, w - 4, h - 4);
  ctx.clip();
  ctx.beginPath();
  const step = 6;
  for (let d = -h; d < w; d += step) {
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * One zone's schematic fill, in the tile's own pixel rect — drawers as
 * horizontal bands, doors as an outlined panel with a hinge tick, open as a
 * hatch, glass as a crossed X. Loosely mirrors the zone canvas' visual
 * language (zoneCanvas.ts `draw()`), traded down for a tile the size of a
 * postage stamp: cheap strokes, no captions, no resolved interiors.
 */
function drawZoneFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  leaf: LeafZone
): void {
  ctx.strokeStyle = TILE_SOFT;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  switch (leaf.fill) {
    case 'door':
      drawHingeTick(ctx, x, y, w, h, leaf.hinge ?? 'left');
      break;
    case 'doorPair': {
      const midX = x + w / 2;
      ctx.beginPath();
      ctx.moveTo(midX, y + 2);
      ctx.lineTo(midX, y + h - 2);
      ctx.stroke();
      drawHingeTick(ctx, x, y, w / 2, h, 'left');
      drawHingeTick(ctx, midX, y, w / 2, h, 'right');
      break;
    }
    case 'drawers': {
      const n = Math.max(1, leaf.drawers ?? 1);
      for (let i = 1; i < n; i++) {
        const ly = y + (h * i) / n;
        ctx.beginPath();
        ctx.moveTo(x + 3, ly);
        ctx.lineTo(x + w - 3, ly);
        ctx.stroke();
      }
      break;
    }
    case 'open':
      drawHatch(ctx, x, y, w, h);
      break;
    case 'glass':
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 3);
      ctx.lineTo(x + w - 3, y + h - 3);
      ctx.moveTo(x + w - 3, y + 3);
      ctx.lineTo(x + 3, y + h - 3);
      ctx.stroke();
      break;
    default:
      break;
  }
}

/**
 * Render one layout's whole face into a fixed-size canvas. Width/height are
 * hardcoded rather than read off `clientWidth` — a tile draws the instant it
 * is built, off a tree that may still be sitting in a throwaway (Advanced-tab)
 * holder never laid out by the browser, so there is no live layout to read.
 */
function drawFrontLayoutSchematic(canvas: HTMLCanvasElement, tree: Zone): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = TILE_W * dpr;
  canvas.height = TILE_H * dpr;
  canvas.style.width = `${TILE_W}px`;
  canvas.style.height = `${TILE_H}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, TILE_W, TILE_H);
  ctx.strokeStyle = TILE_INK;
  ctx.lineWidth = 1.4;
  const pad = 4;
  const fw = TILE_W - pad * 2;
  const fh = TILE_H - pad * 2;
  ctx.strokeRect(pad, pad, fw, fh);
  for (const r of walkZones(tree, fw, fh)) {
    // walkZones' y is up-from-bottom; canvas y is down-from-top
    drawZoneFill(ctx, pad + r.x, pad + (fh - r.y - r.h), r.w, r.h, r.leaf);
  }
}

/**
 * The tile row itself: one button per canned layout, a tiny schematic canvas
 * plus its label, `.active` on whichever one `part.face` currently
 * deep-equals. Applying a layout goes through `onChange` exactly like every
 * other field on the cabinet rail (dimRow, toggleRow, swatchRow) — the SAME
 * live-apply write path, so Ctrl+Z undoes a pick like any other edit.
 *
 * A customized tree gets a confirm first (`confirmDialog`, the same promise
 * every destructive studio action already awaits). The dialog is async, so a
 * user can navigate elsewhere while it is open; `layoutSlot.isConnected` is
 * the guard against writing into a `part` this rail no longer owns, the same
 * shape `PartStudio.deletePart` uses (`this.part !== part`).
 */
export function renderFrontLayoutTiles(
  layoutSlot: HTMLElement,
  part: CabinetPartDef,
  onChange: (transient?: boolean) => void
): void {
  layoutSlot.innerHTML = '';
  layoutSlot.className = 'front-layout-grid';
  const tiles: [FaceLayout, HTMLButtonElement][] = [];

  const refreshActive = (): void => {
    const current = JSON.stringify(part.face);
    for (const [layout, tile] of tiles) {
      tile.classList.toggle('active', JSON.stringify(layout.face()) === current);
    }
  };

  const pick = (layout: FaceLayout): void => {
    void (async () => {
      if (isCustomizedFace(part)) {
        const ok = await confirmDialog({
          title: 'Replace the front layout?',
          body: 'The current zone arrangement is replaced. Ctrl+Z brings it back.',
          confirmLabel: 'Replace',
        });
        if (!ok) return;
      }
      if (!layoutSlot.isConnected) return; // studio moved on while the dialog was open
      part.face = layout.face();
      refreshActive();
      onChange();
    })();
  };

  for (const layout of FACE_LAYOUTS) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'front-layout-tile';
    tile.dataset.layout = layout.id;
    tile.title = layout.label;
    const canvas = document.createElement('canvas');
    canvas.className = 'front-layout-schematic';
    drawFrontLayoutSchematic(canvas, layout.face());
    tile.appendChild(canvas);
    const caption = document.createElement('span');
    caption.className = 'front-layout-label';
    caption.textContent = layout.label;
    tile.appendChild(caption);
    tile.addEventListener('click', () => pick(layout));
    layoutSlot.appendChild(tile);
    tiles.push([layout, tile]);
  }
  refreshActive();
}
