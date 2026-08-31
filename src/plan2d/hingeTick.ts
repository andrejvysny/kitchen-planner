/**
 * A short diagonal near one corner — the plan/elevation notation for a door's
 * swing, drawn from the hinged edge.
 *
 * It lives in plan2d rather than in the Part Studio because TWO canvases draw
 * it: the studio's front-layout tiles and the wall elevation. Dependencies
 * point INTO the view layers (see the migration boundary in eslint.config.js),
 * so the shared primitive sits here and src/ui/partstudio/frontLayoutTiles.ts
 * re-exports it — one hinge convention, one implementation.
 */
export function drawHingeTick(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  side: 'left' | 'right' | 'top' | 'bottom'
): void {
  const len = Math.min(w, h) * 0.4;
  ctx.beginPath();
  if (side === 'left') {
    ctx.moveTo(x + 3, y + 3);
    ctx.lineTo(x + 3 + len, y + 3 + len);
  } else if (side === 'right') {
    ctx.moveTo(x + w - 3, y + 3);
    ctx.lineTo(x + w - 3 - len, y + 3 + len);
  } else if (side === 'top') {
    ctx.moveTo(x + 3, y + 3);
    ctx.lineTo(x + 3 + len, y + 3 + len);
  } else {
    ctx.moveTo(x + 3, y + h - 3);
    ctx.lineTo(x + 3 + len, y + h - 3 - len);
  }
  ctx.stroke();
}
