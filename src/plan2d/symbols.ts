import { sofaSeats, type DecorForm, type ItemKind } from '../model/catalog';
import type { Point } from '../model/types';
import type { WardrobePlanSymbol } from '../model/wardrobe';

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
  /** outlets only: number of sockets in the box */
  gangs?: number;
  /** sofas only: the `seats` param, when the def carries one */
  seats?: number;
  /** wardrobe parts only: column ticks + door/slide symbols, from
   * `wardrobePlanSymbol`. Absent → the plain rect + centre split line. */
  plan?: WardrobePlanSymbol;
  /** decor only: which silhouette to glyph. `drawPlanSymbol` takes a KIND, not
   * a def, so per-kind extra data is threaded through named fields like this
   * one (see `gangs`, `seats`) and filled in at renderPlan's call site. */
  decorForm?: DecorForm;
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

/** true when the kind is drawn dashed (mounted above the counter plane);
 * preset/custom cabinets use the elevation heuristic in the plan instead */
export function isOverhead(kind: ItemKind): boolean {
  return ['hood', 'pendant', 'spot', 'strip', 'tv'].includes(kind);
}

/**
 * One glyph per `DecorForm`. Deliberately schematic — at plan scale a mug is
 * six pixels across, so the job is "something round sits here", not likeness.
 */
const DECOR_GLYPH: Record<
  DecorForm,
  (ctx: CanvasRenderingContext2D, w: number, d: number, hair: number) => void
> = {
  vessel: (ctx, w, d) => {
    circle(ctx, 0, 0, Math.min(w, d) / 2, true);
    circle(ctx, 0, 0, Math.min(w, d) / 2);
  },
  bowl: (ctx, w, d) => {
    const r = Math.min(w, d) / 2;
    circle(ctx, 0, 0, r, true);
    circle(ctx, 0, 0, r);
    circle(ctx, 0, 0, r * 0.62);
  },
  plant: (ctx, w, d) => {
    const r = Math.min(w, d) / 2;
    circle(ctx, 0, 0, r, true);
    circle(ctx, 0, 0, r);
    // three lobes, so it is not just another circle at a glance
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      circle(ctx, Math.cos(a) * r * 0.42, Math.sin(a) * r * 0.42, r * 0.34);
    }
  },
  stack: (ctx, w, d, hair) => {
    roundRect(ctx, -w / 2, -d / 2, w, d, Math.min(w, d) * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = hair;
    line(ctx, -w / 2 + w * 0.24, -d / 2, -w / 2 + w * 0.24, d / 2);
  },
  frame: (ctx, w, d, hair) => {
    roundRect(ctx, -w / 2, -d / 2, w, d, Math.min(w, d) * 0.1);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = hair;
    line(ctx, -w / 2, -d / 2, w / 2, d / 2);
  },
  cloth: (ctx, w, d, hair) => {
    roundRect(ctx, -w / 2, -d / 2, w, d, Math.min(w, d) * 0.3);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = hair;
    for (const t of [-0.2, 0.2]) line(ctx, -w / 2, d * t, w / 2, d * t);
  },
  rack: (ctx, w, d, hair) => {
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.lineWidth = hair;
    for (let i = 1; i < 4; i++)
      line(ctx, -w / 2 + (w * i) / 4, -d / 2, -w / 2 + (w * i) / 4, d / 2);
  },
  basket: (ctx, w, d, hair) => {
    roundRect(ctx, -w / 2, -d / 2, w, d, Math.min(w, d) * 0.16);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = hair;
    roundRect(ctx, -w * 0.36, -d * 0.36, w * 0.72, d * 0.72, Math.min(w, d) * 0.12);
    ctx.stroke();
  },
};

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
  if (
    !['pendant', 'spot', 'water', 'outlet', 'stool', 'door', 'window', 'rug', 'decor'].includes(
      kind
    )
  ) {
    ctx.globalAlpha = bodyAlpha;
    ctx.fillRect(-hw, -hd, w, d);
    ctx.globalAlpha = 1;
    ctx.strokeRect(-hw, -hd, w, d);
  }
  ctx.setLineDash([]);

  ctx.lineWidth = hair;
  switch (kind) {
    case 'custom': {
      const plan = style.plan;
      if (!plan) {
        // front stripe + door split
        line(ctx, -hw, hd - 0.05, hw, hd - 0.05);
        line(ctx, 0, -hd, 0, hd);
        break;
      }
      // `plan`'s ticks/doors/slides are item-local metres for the SAME w/d this
      // case already works in (wardrobePlanSymbol is called with the placed
      // item's own w/d, exactly like drawPlanSymbol's caller) — no rescale.
      for (const t of plan.ticks) line(ctx, t, -hd, t, hd);
      if (plan.open) {
        // no front system: ticks are the whole story, plus the plain stripe
        // every other custom part uses to mark the front edge
        line(ctx, -hw, hd - 0.05, hw, hd - 0.05);
        break;
      }
      // sliding tracks: layer 1 (outer, nearer the front face) draws closer to
      // hd than layer 0 (inner, set back a slab thickness + gap) — mirrors
      // WardrobeSlidingPanel.layer's own "0 = inner, 1 = outer" doc
      for (const s of plan.slides) {
        const y = hd - (s.layer === 1 ? 0.03 : 0.06);
        line(ctx, s.x0, y, s.x1, y);
      }
      // hinged leaves: dashed 90° sweep + solid open leaf, same construction as
      // the wall-door symbol below — pivot at the leaf's hinged edge, on the
      // FRONT face (y = hd)
      for (const dr of plan.doors) {
        const lw = dr.x1 - dr.x0;
        const fxc = (dr.x0 + dr.x1) / 2;
        ctx.save();
        ctx.translate(fxc, 0);
        ctx.scale(dr.hinge === 'right' ? -1 : 1, 1);
        ctx.setLineDash([hair * 4, hair * 3]);
        ctx.beginPath();
        ctx.arc(-lw / 2, hd, lw, 0, Math.PI / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = hair * 2;
        line(ctx, -lw / 2, hd, -lw / 2, hd + lw);
        ctx.restore();
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
    case 'hood': {
      line(ctx, -hw, -hd, hw, hd);
      line(ctx, hw, -hd, -hw, hd);
      break;
    }
    case 'backsplash':
      break;
    case 'bed': {
      // head is the BACK edge (-y, the wall side): pillows there, then the
      // turned-down duvet line across the mattress
      const pw = Math.min(0.62, (w - 0.14) / 2);
      const ph = Math.min(0.2, d * 0.12);
      for (const sx of [-1, 1] as const) {
        roundRect(ctx, sx < 0 ? -hw + 0.05 : hw - 0.05 - pw, -hd + 0.05, pw, ph, 0.035);
        ctx.stroke();
      }
      line(ctx, -hw, -hd + d / 3, hw, -hd + d / 3);
      break;
    }
    case 'sofa': {
      // back stripe on the wall edge (-y), arms down both sides, one division
      // line per seat join — an armchair derives its single seat from the width
      const armW = Math.min(0.14, w * 0.1);
      const backT = Math.min(0.12, d * 0.14);
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-hw, -hd, w, backT);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(-hw, -hd, armW, d);
      ctx.fillRect(hw - armW, -hd, armW, d);
      ctx.globalAlpha = 1;
      const seats = sofaSeats(w, style.seats);
      const inner = w - armW * 2;
      for (let i = 1; i < seats; i++) {
        const x = -inner / 2 + (inner * i) / seats;
        line(ctx, x, -hd + backT, x, hd);
      }
      break;
    }
    case 'tv': {
      // dashed body reads as wall-mounted; the arrow marks the viewing side
      line(ctx, 0, hd, 0, hd + 0.13);
      line(ctx, -0.05, hd + 0.08, 0, hd + 0.13);
      line(ctx, 0.05, hd + 0.08, 0, hd + 0.13);
      break;
    }
    case 'rug': {
      // floor covering, not furniture: ghosted body with a dashed inset border
      ctx.setLineDash([hair * 6, hair * 4]);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(-hw, -hd, w, d);
      ctx.globalAlpha = 1;
      ctx.strokeRect(-hw, -hd, w, d);
      const m = Math.min(0.1, Math.min(w, d) * 0.07);
      if (w > m * 2 && d > m * 2) ctx.strokeRect(-hw + m, -hd + m, w - m * 2, d - m * 2);
      ctx.setLineDash([]);
      break;
    }
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
    case 'officeChair': {
      // backrest stripe at the rear edge, swivel pivot dot at centre
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-hw, -hd, w, Math.min(0.08, d * 0.18));
      ctx.globalAlpha = 1;
      circle(ctx, 0, 0, Math.min(0.03, hw * 0.25), true);
      break;
    }
    case 'pendant': {
      circle(ctx, 0, 0, hw);
      circle(ctx, 0, 0, hw * 0.35);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        line(
          ctx,
          Math.cos(a) * hw,
          Math.sin(a) * hw,
          Math.cos(a) * hw * 1.45,
          Math.sin(a) * hw * 1.45
        );
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
      // EU Type E (Slovak): round socket, two pin holes + earth pin per gang.
      const gangs = Math.max(1, Math.min(4, Math.round(style.gangs ?? 1)));
      const pitch = w / gangs;
      const r = pitch * 0.42;
      for (let i = 0; i < gangs; i++) {
        const cx = -hw + pitch * (i + 0.5);
        ctx.fillStyle = '#fff';
        circle(ctx, cx, 0, r, true);
        circle(ctx, cx, 0, r);
        ctx.fillStyle = ink;
        circle(ctx, cx - r * 0.4, 0, r * 0.13, true);
        circle(ctx, cx + r * 0.4, 0, r * 0.13, true);
        // earth pin toward the front (+y)
        circle(ctx, cx, r * 0.42, r * 0.11, true);
      }
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
    case 'decor': {
      // Set dressing reads as TEXTURE, not as furniture: a hairline glyph at
      // half alpha, so a staged worktop does not bury the cabinets under it.
      ctx.globalAlpha = style.bodyAlpha ?? 0.5;
      DECOR_GLYPH[style.decorForm ?? 'vessel'](ctx, w, d, hair);
      ctx.globalAlpha = 1;
      break;
    }
    default:
      break;
  }

  // front tick (helps users see which way an item faces)
  if (
    !overhead &&
    ![
      'door',
      'window',
      'water',
      'outlet',
      'stool',
      'table',
      'chair',
      'backsplash',
      'woodPlane',
      'rug',
      'decor',
    ].includes(kind)
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
  footprint?: Point[],
  plan?: WardrobePlanSymbol,
  decorForm?: DecorForm
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
  // decor is deliberately exempt from the 0.3 m floor: it is the only family
  // small enough that the floor would render every tile as the same dot
  const extent = Math.max(w, d, kind === 'door' ? w * 1.6 : kind === 'decor' ? 0 : 0.3) * 1.35;
  const scale = px / extent;
  ctx.translate(px / 2, px / 2);
  ctx.scale(scale, scale);
  if (kind === 'door') ctx.translate(0, -w * 0.35);
  drawPlanSymbol(ctx, kind, w, d, {
    color,
    selected: false,
    pxPerM: scale,
    footprint,
    plan,
    decorForm,
  });
}
