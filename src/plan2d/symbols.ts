import type { ItemKind } from '../model/catalog';
import type { Point } from '../model/types';

/**
 * Architectural plan symbols, drawn in meter-space centered on the item.
 * +y is the item's front (facing away from the wall it backs onto).
 * The caller has already applied pan/zoom/rotation transforms.
 */

export interface SymbolStyle {
  color: string;
  selected: boolean;
  /** px-per-meter scale, to keep hairlines readable at any zoom */
  pxPerM: number;
  /** override the dashed "mounted above counter" style (used for custom wall parts) */
  overhead?: boolean;
  /** body fill opacity override (worktop boards stay see-through) */
  bodyAlpha?: number;
  /** custom parts with a non-rectangular footprint: local polygon, +y = front */
  footprint?: Point[];
  /** doors only */
  doorHinge?: 'left' | 'right';
  doorSwing?: 'in' | 'out';
}

const INK = '#3a3934';
const SEL = '#2f6f5e';

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill = false) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) ctx.fill();
  else ctx.stroke();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** true when the kind is drawn dashed (mounted above the counter plane) */
export function isOverhead(kind: ItemKind): boolean {
  return ['wallCabinet', 'shelf', 'hood', 'pendant', 'spot', 'strip'].includes(kind);
}

export function drawPlanSymbol(
  ctx: CanvasRenderingContext2D,
  kind: ItemKind,
  w: number,
  d: number,
  style: SymbolStyle
): void {
  const hw = w / 2;
  const hd = d / 2;
  const hair = 1 / style.pxPerM; // ~1px
  const ink = style.selected ? SEL : INK;

  ctx.lineWidth = hair * (style.selected ? 1.8 : 1.1);
  ctx.strokeStyle = ink;
  ctx.fillStyle = style.color;

  const overhead = style.overhead ?? isOverhead(kind);
  ctx.setLineDash(overhead ? [hair * 5, hair * 3] : []);

  // body
  const bodyAlpha = style.bodyAlpha ?? (overhead ? 0.25 : 0.85);
  if (style.footprint && style.footprint.length >= 3) {
    // true outline for polygon-footprint parts (worktops, corner cabinets)
    ctx.beginPath();
    ctx.moveTo(style.footprint[0].x, style.footprint[0].y);
    for (let i = 1; i < style.footprint.length; i++) {
      ctx.lineTo(style.footprint[i].x, style.footprint[i].y);
    }
    ctx.closePath();
    ctx.globalAlpha = bodyAlpha;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  if (!['pendant', 'spot', 'water', 'outlet', 'stool', 'door', 'window'].includes(kind)) {
    ctx.globalAlpha = bodyAlpha;
    ctx.fillRect(-hw, -hd, w, d);
    ctx.globalAlpha = 1;
    ctx.strokeRect(-hw, -hd, w, d);
  }
  ctx.setLineDash([]);

  ctx.lineWidth = hair;
  switch (kind) {
    case 'custom':
    case 'baseCabinet':
    case 'wallCabinet':
    case 'pantry': {
      // front stripe + door split
      line(ctx, -hw, hd - 0.05, hw, hd - 0.05);
      line(ctx, 0, -hd, 0, hd);
      if (kind === 'pantry') line(ctx, -hw, -hd, hw, hd);
      break;
    }
    case 'baseDrawers':
    case 'island': {
      line(ctx, -hw, hd - 0.05, hw, hd - 0.05);
      for (let i = 1; i <= 2; i++) {
        line(ctx, -hw + 0.05, -hd + (d - 0.1) * (i / 3) + 0.05, hw - 0.05, -hd + (d - 0.1) * (i / 3) + 0.05);
      }
      break;
    }
    case 'sink': {
      const bw = Math.min(0.42, w - 0.16);
      roundRect(ctx, -bw / 2, -hd + 0.08, bw, d - 0.22, 0.04);
      ctx.stroke();
      ctx.fillStyle = ink;
      circle(ctx, 0, -hd + 0.045, 0.022, true);
      break;
    }
    case 'hob': {
      const r = Math.min(0.075, w / 8);
      circle(ctx, -w / 4, -d / 20 - r, r);
      circle(ctx, w / 4, -d / 20 - r, r);
      circle(ctx, -w / 4, d / 20 + r, r);
      circle(ctx, w / 4, d / 20 + r, r);
      break;
    }
    case 'oven': {
      ctx.strokeRect(-hw + 0.07, -hd + 0.07, w - 0.14, d - 0.14);
      circle(ctx, 0, 0, 0.05);
      break;
    }
    case 'dishwasher': {
      ctx.strokeRect(-hw + 0.06, -hd + 0.06, w - 0.12, d - 0.12);
      circle(ctx, 0, 0, Math.min(0.16, w / 4));
      break;
    }
    case 'fridge': {
      line(ctx, -hw, -hd, hw, hd);
      line(ctx, hw, -hd, -hw, hd);
      break;
    }
    case 'ovenTower': {
      line(ctx, -hw, -hd, hw, hd);
      ctx.strokeRect(-hw + 0.1, -hd + 0.1, w - 0.2, d - 0.2);
      break;
    }
    case 'shelf': {
      line(ctx, -hw, 0, hw, 0);
      break;
    }
    case 'hood': {
      line(ctx, -hw, -hd, hw, hd);
      line(ctx, hw, -hd, -hw, hd);
      break;
    }
    case 'backsplash':
      break;
    case 'table': {
      break;
    }
    case 'chair': {
      // seat drawn as body; backrest stripe at the rear edge
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(-hw, -hd, w, 0.06);
      ctx.globalAlpha = 1;
      break;
    }
    case 'stool': {
      ctx.globalAlpha = 0.85;
      circle(ctx, 0, 0, hw, true);
      ctx.globalAlpha = 1;
      circle(ctx, 0, 0, hw);
      break;
    }
    case 'pendant': {
      circle(ctx, 0, 0, hw);
      circle(ctx, 0, 0, hw * 0.35);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        line(ctx, Math.cos(a) * hw, Math.sin(a) * hw, Math.cos(a) * hw * 1.45, Math.sin(a) * hw * 1.45);
      }
      break;
    }
    case 'spot': {
      circle(ctx, 0, 0, hw);
      line(ctx, -hw * 0.6, 0, hw * 0.6, 0);
      line(ctx, 0, -hw * 0.6, 0, hw * 0.6);
      break;
    }
    case 'strip': {
      for (let x = -hw + 0.05; x < hw - 0.03; x += 0.1) {
        ctx.fillStyle = '#e8b658';
        circle(ctx, x, 0, 0.012, true);
      }
      break;
    }
    case 'water': {
      // valve symbol: circle + inner drop triangle
      ctx.fillStyle = '#dbeafe';
      circle(ctx, 0, 0, 0.09, true);
      ctx.strokeStyle = '#2c5f8a';
      circle(ctx, 0, 0, 0.09);
      ctx.fillStyle = '#2c5f8a';
      ctx.beginPath();
      ctx.moveTo(0, -0.045);
      ctx.lineTo(0.04, 0.035);
      ctx.lineTo(-0.04, 0.035);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'outlet': {
      ctx.fillStyle = '#fff';
      circle(ctx, 0, 0, 0.07, true);
      circle(ctx, 0, 0, 0.07);
      ctx.fillStyle = ink;
      circle(ctx, -0.025, 0, 0.012, true);
      circle(ctx, 0.025, 0, 0.012, true);
      break;
    }
    case 'door': {
      // swing arc: hinge at (-hw, 0), leaf opening inward (+y);
      // mirrored for right hinges / outward swings
      ctx.save();
      ctx.scale(style.doorHinge === 'right' ? -1 : 1, style.doorSwing === 'out' ? -1 : 1);
      ctx.setLineDash([hair * 4, hair * 3]);
      ctx.beginPath();
      ctx.arc(-hw, 0, w, 0, Math.PI / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = hair * 2;
      line(ctx, -hw, 0, -hw, w);
      ctx.restore();
      break;
    }
    case 'window': {
      ctx.lineWidth = hair;
      line(ctx, -hw, -hd / 2, hw, -hd / 2);
      line(ctx, -hw, 0, hw, 0);
      line(ctx, -hw, hd / 2, hw, hd / 2);
      line(ctx, -hw, -hd / 2, -hw, hd / 2);
      line(ctx, hw, -hd / 2, hw, hd / 2);
      break;
    }
    default:
      break;
  }

  // front tick (helps users see which way an item faces)
  if (
    !overhead &&
    !['door', 'window', 'water', 'outlet', 'stool', 'table', 'chair', 'backsplash'].includes(kind)
  ) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = hair * 1.5;
    line(ctx, -0.04, hd, 0, hd + 0.05);
    line(ctx, 0, hd + 0.05, 0.04, hd);
  }
}

/** Render a catalog thumbnail for a def onto a small canvas. */
export function renderThumbnail(
  canvas: HTMLCanvasElement,
  kind: ItemKind,
  w: number,
  d: number,
  color: string,
  footprint?: Point[]
): void {
  const px = 54;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = px * dpr;
  canvas.height = px * dpr;
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, px, px);
  const extent = Math.max(w, d, kind === 'door' ? w * 1.6 : 0.3) * 1.35;
  const scale = px / extent;
  ctx.translate(px / 2, px / 2);
  ctx.scale(scale, scale);
  if (kind === 'door') ctx.translate(0, -w * 0.35);
  drawPlanSymbol(ctx, kind, w, d, { color, selected: false, pxPerM: scale, footprint });
}
