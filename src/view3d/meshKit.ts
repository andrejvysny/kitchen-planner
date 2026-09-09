import * as THREE from 'three';
import { APPLIANCE_BLACK, PLINTH_COLOR } from '../model/catalog';
import { signedArea } from '../model/geometry';
import type { Design, Item, Point, RoomStyle } from '../model/types';
import { counterFin, type ResolvedFinish } from '../model/variables';
import { stampMaterial, texturedMaterial } from './textures';

export { PLINTH_COLOR } from '../model/catalog';
export { counterFin } from '../model/variables';
// the semantic-name stamp lives with texturedMaterial (which needs it too),
// but every mesh builder reaches for it through the mesh vocabulary
export { stampMaterial, type MaterialStamp } from './textures';

/**
 * Shared procedural-mesh vocabulary. Local space: x = width, y = up (0 at
 * item bottom), z = depth (back at -d/2 — the wall side; front at +d/2).
 *
 * Style follows the reference interiors: matte handleless slab fronts with a
 * routed dark groove, dark recessed plinth, oak worktops.
 */

// geometry tokens live with the panel model so cut lists and meshes agree
export { FRONT_T, GAP, PLINTH_H } from '../model/panels';
import { FRONT_T, GAP, PLINTH_H } from '../model/panels';

export const COUNTER_T = 0.04;
export const GROOVE = '#1f1e1b';
export const CARCASS_DARKEN = 0.92;

export function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * f);
  c.g = Math.min(1, c.g * f);
  c.b = Math.min(1, c.b * f);
  return `#${c.getHexString()}`;
}

export function matte(color: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.03 });
  return stampMaterial(m, { kind: 'plain', fallback: 'matte' });
}

export function wood(color: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02 });
  return stampMaterial(m, { kind: 'plain', fallback: 'wood' });
}

/** A paintable surface: user colour + optional built-in PBR material id. */
export type Finish = ResolvedFinish;

/**
 * Material for a colour-carrying surface. With a library material id it
 * resolves to the textured PBR material (src/view3d/textures.ts); otherwise
 * the classic flat matte/wood finish. `tint` darkens (carcass, legs).
 */
export function surfMat(
  f: string | Finish,
  fallback: 'matte' | 'wood' = 'matte',
  tint = 1
): THREE.MeshStandardMaterial {
  const fin = typeof f === 'string' ? { color: f } : f;
  const color = tint === 1 ? fin.color : shade(fin.color, tint);
  if (fin.material) {
    const m = texturedMaterial(fin.material, color, fin.rot === true);
    if (m) {
      // the tint lands AFTER construction, so the stamped name has to follow it
      if (tint !== 1) {
        m.color.multiplyScalar(tint);
        stampMaterial(m, { kind: 'library', matId: fin.material, rot: fin.rot === true });
      }
      return m;
    }
  }
  // `color` is already shaded here, so matte/wood stamp the final colour
  return fallback === 'wood' ? wood(color) : matte(color);
}

/**
 * Rescale BoxGeometry UVs from 0..1 per face to METERS, so shared textures
 * (repeat = 1/tile-size) keep constant real-world grain on every panel.
 * Face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
 */
export function scaleBoxUV(geo: THREE.BoxGeometry, w: number, h: number, d: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const scales: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i++) {
    const [su, sv] = scales[Math.floor(i / 4)];
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
}

/** Same idea for cylinders: torso UVs → circumference × height, caps → diameter. */
function scaleCylUV(geo: THREE.CylinderGeometry, r: number, h: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const torso = (geo.parameters.radialSegments + 1) * 2; // heightSegments = 1
  for (let i = 0; i < uv.count; i++) {
    const [su, sv] = i < torso ? [2 * Math.PI * r, h] : [2 * r, 2 * r];
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
}

export function steelMat(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: '#b6babd', roughness: 0.38, metalness: 0.65 });
  return stampMaterial(m, { kind: 'product', product: 'steel' });
}

export function applianceGlass(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: APPLIANCE_BLACK,
    roughness: 0.25,
    metalness: 0.4,
  });
  return stampMaterial(m, { kind: 'product', product: 'appliance-glass' });
}

export function box(
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  scaleBoxUV(geo, w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/**
 * Curved primitives for set dressing (src/view3d/decorMeshes.ts).
 *
 * Same contract as `box`/`cyl`/`prism`: they take a material and MINT NONE, so
 * they stay outside test/unit/materialStamping.test.ts's sweep by construction
 * — the stamping rule lives in the builders that call them.
 *
 * `y` is the BOTTOM of the shape, matching every other primitive here. They
 * ship three's stock 0..1 UVs rather than the metre-space rescaling `box` and
 * `cyl` do: decor is plain-coloured, and a body of revolution has no natural
 * metre parameterisation to rescale to.
 */

/** A ball resting on `y`. `squash` < 1 flattens it (a pebble, a bun, a leaf mass). */
export function sphere(
  g: THREE.Group,
  r: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  squash = 1
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), mat);
  m.scale.y = squash;
  m.position.set(x, y + r * squash, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** A ring lying flat (axis +y): a bowl rim, a basket hoop, a pot lip. */
export function torus(
  g: THREE.Group,
  ringR: number,
  tubeR: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.TorusGeometry(ringR, tubeR, 8, 24), mat);
  m.rotation.x = Math.PI / 2; // three builds it in the xy plane
  m.position.set(x, y + tubeR, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/**
 * A body of revolution about +y from a `(radius, height)` profile — the one
 * primitive behind every kettle, jar, vase, bottle and bowl, which is why the
 * `vessel` form covers so many products from a per-def profile constant.
 *
 * `profile` reuses the `Point` shape `prism` already takes: `x` is the radius
 * at that station, `y` the height above the piece's own base. It must be
 * ordered bottom-to-top.
 */
export function lathe(
  g: THREE.Group,
  profile: Point[],
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  seg = 20
): THREE.Mesh {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(1e-4, p.x), p.y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

export function cyl(
  g: THREE.Group,
  r: number,
  h: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rTop = r
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rTop, r, h, 20);
  scaleCylUV(geo, r, h);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** A handleless front slab with a routed groove along its top (or bottom) edge. */
export function frontSlab(
  g: THREE.Group,
  w: number,
  h: number,
  color: string | Finish,
  x: number,
  y: number,
  zFront: number,
  grooveAt: 'top' | 'bottom' | 'none' = 'top'
): void {
  box(g, w, h, FRONT_T, surfMat(color), x, y, zFront - FRONT_T / 2);
  if (grooveAt !== 'none') {
    const gy = grooveAt === 'top' ? y + h - 0.012 : y;
    box(g, w, 0.012, FRONT_T + 0.002, matte(GROOVE), x, gy, zFront - FRONT_T / 2 - 0.002);
  }
}

/** Split a width into n fronts with small gaps; calls fn(centerX, frontW). */
export function splitFronts(w: number, n: number, fn: (x: number, fw: number) => void): void {
  const fw = (w - GAP * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + GAP + fw / 2 + i * (fw + GAP);
    fn(x, fw);
  }
}

export function plinth(g: THREE.Group, w: number, d: number): void {
  box(g, w - 0.06, PLINTH_H, d - 0.05, matte(PLINTH_COLOR), 0, 0, -0.02);
}

export function carcass(
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  color: string | Finish,
  y0: number
): void {
  box(g, w, h, d - FRONT_T, surfMat(color, 'matte', CARCASS_DARKEN), 0, y0, -FRONT_T / 2);
}

export function counterSlab(
  g: THREE.Group,
  w: number,
  d: number,
  y: number,
  design: Design,
  room: RoomStyle,
  item?: Item
): void {
  box(g, w, COUNTER_T, d + 0.02, surfMat(counterFin(design, room, item), 'wood'), 0, y, 0.01);
}

/**
 * Plan-space rounded rectangle (w × d, corner radius r) centred on (cx, cz),
 * as a polygon for `prism()`. The soft-cushion primitive of the flat-matte
 * language: mattresses, seat cushions, rugs.
 */
export function roundedRectPoly(w: number, d: number, r: number, cx = 0, cz = 0): Point[] {
  const rr = Math.max(0, Math.min(r, w / 2, d / 2));
  if (rr < 1e-4) {
    return [
      { x: cx - w / 2, y: cz - d / 2 },
      { x: cx + w / 2, y: cz - d / 2 },
      { x: cx + w / 2, y: cz + d / 2 },
      { x: cx - w / 2, y: cz + d / 2 },
    ];
  }
  const hw = w / 2 - rr;
  const hd = d / 2 - rr;
  const SEG = 8;
  const out: Point[] = [];
  // arc centres walked in order, each sweeping a quarter turn
  const arcs: [number, number, number][] = [
    [hw, hd, 0],
    [-hw, hd, Math.PI / 2],
    [-hw, -hd, Math.PI],
    [hw, -hd, -Math.PI / 2],
  ];
  for (const [ox, oy, a0] of arcs) {
    for (let i = 0; i <= SEG; i++) {
      const a = a0 + (Math.PI / 2) * (i / SEG);
      out.push({ x: cx + ox + Math.cos(a) * rr, y: cz + oy + Math.sin(a) * rr });
    }
  }
  return out;
}

/** A rounded-corner slab spanning y..y+h — `prism` takes its plan position
 * from the polygon, so cx/cz live there, not on the mesh. */
export function softSlab(
  g: THREE.Group,
  w: number,
  d: number,
  h: number,
  mat: THREE.Material,
  y: number,
  cx = 0,
  cz = 0,
  r = 0.035
): THREE.Mesh {
  return prism(g, roundedRectPoly(w, d, r, cx, cz), h, mat, y);
}

/** One contour edge with its start offset along the contour's arc length. */
interface UVSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  s0: number;
  len: number;
}

function segDist(px: number, py: number, s: UVSeg): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / (s.len * s.len)));
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
}

/**
 * Rewrite ExtrudeGeometry SIDE-wall UVs to (arc length along the contour,
 * extrusion depth) in METERS — the scaleBoxUV convention. Three's default
 * WorldUVGenerator projects u onto whichever axis moves most, which compresses
 * diagonal edges by cos(angle) and jitters across the segments of an arc. Cap
 * UVs are already shape-space metres and stay untouched. Each contour restarts
 * at u = 0, so the one texture seam per ring lands on a corner vertex.
 */
function prismSideUV(geo: THREE.ExtrudeGeometry, contours: Point[][]): void {
  if (geo.index) return; // ExtrudeGeometry is non-indexed; bail if that drifts
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;

  const segs: UVSeg[] = [];
  for (const c of contours) {
    let s = 0;
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, s0: s, len });
      s += len;
    }
  }
  if (!segs.length) return;

  for (let t = 0; t < pos.count; t += 3) {
    const zs = [pos.getZ(t), pos.getZ(t + 1), pos.getZ(t + 2)];
    if (Math.max(...zs) - Math.min(...zs) < 1e-6) continue; // cap: constant z
    // a wall quad lies on exactly one contour edge — the centroid finds it
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    let best = segs[0];
    let bestD = Infinity;
    for (const sg of segs) {
      const d = segDist(cx, cy, sg);
      if (d < bestD) {
        bestD = d;
        best = sg;
      }
    }
    const dx = best.bx - best.ax;
    const dy = best.by - best.ay;
    for (let k = t; k < t + 3; k++) {
      const frac =
        ((pos.getX(k) - best.ax) * dx + (pos.getY(k) - best.ay) * dy) / (best.len * best.len);
      const u = best.s0 + Math.max(0, Math.min(1, frac)) * best.len;
      uv.setXY(k, u, pos.getZ(k));
    }
  }
  uv.needsUpdate = true;
}

/**
 * Vertical prism extruded from a plan-local polygon (+y = front). The mesh
 * spans y0..y0+h and plan (x, y) lands on world (x, z) — front toward +z.
 * `holes` are cut through the slab (winding is normalized here).
 */
export function prism(
  g: THREE.Group,
  poly: Point[],
  h: number,
  mat: THREE.Material,
  y0: number,
  holes?: Point[][]
): THREE.Mesh {
  const outline = signedArea(poly) < 0 ? [...poly].reverse() : poly;
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const contours: Point[][] = [outline];
  for (const hpts of holes ?? []) {
    const hole = signedArea(hpts) > 0 ? [...hpts].reverse() : hpts;
    shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
    contours.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  prismSideUV(geo, contours);
  const m = new THREE.Mesh(geo, mat);
  // shape (x, y) → world (x, z); extrusion +z → world -y, so lift by h
  m.rotation.x = Math.PI / 2;
  m.position.y = y0 + h;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}
