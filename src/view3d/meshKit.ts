import * as THREE from 'three';
import { APPLIANCE_BLACK } from '../model/catalog';
import { signedArea } from '../model/geometry';
import type { Design, Item, Point, RoomStyle } from '../model/types';
import { resolveFinish } from '../model/variables';
import { texturedMaterial } from './textures';

/**
 * Shared procedural-mesh vocabulary. Local space: x = width, y = up (0 at
 * item bottom), z = depth (back at -d/2 — the wall side; front at +d/2).
 *
 * Style follows the reference kitchens: matte handleless slab fronts with a
 * routed dark groove, dark recessed plinth, oak worktops.
 */

// geometry tokens live with the panel model so cut lists and meshes agree
export { FRONT_T, GAP, PLINTH_H } from '../model/panels';
import { FRONT_T, GAP, PLINTH_H } from '../model/panels';

export const COUNTER_T = 0.04;
export const PLINTH_COLOR = '#26251f';
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
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.03 });
}

export function wood(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02 });
}

/** A paintable surface: user colour + optional built-in PBR material id. */
export interface Finish {
  color: string;
  material?: string;
  /** rotate the material's texture 90° (grain vertical → horizontal) */
  rot?: boolean;
}

/**
 * Material for a colour-carrying surface. With a library material id it
 * resolves to the textured PBR material (src/view3d/textures.ts); otherwise
 * the classic flat matte/wood finish. `tint` darkens (carcass, legs).
 */
export function surfMat(f: string | Finish, fallback: 'matte' | 'wood' = 'matte', tint = 1): THREE.MeshStandardMaterial {
  const fin = typeof f === 'string' ? { color: f } : f;
  const color = tint === 1 ? fin.color : shade(fin.color, tint);
  if (fin.material) {
    const m = texturedMaterial(fin.material, color, fin.rot === true);
    if (m) {
      if (tint !== 1) m.color.multiplyScalar(tint);
      return m;
    }
  }
  return fallback === 'wood' ? wood(color) : matte(color);
}

/**
 * Rescale BoxGeometry UVs from 0..1 per face to METERS, so shared textures
 * (repeat = 1/tile-size) keep constant real-world grain on every panel.
 * Face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
 */
export function scaleBoxUV(geo: THREE.BoxGeometry, w: number, h: number, d: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const scales: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
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
  return new THREE.MeshStandardMaterial({ color: '#b6babd', roughness: 0.38, metalness: 0.65 });
}

export function applianceGlass(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: APPLIANCE_BLACK, roughness: 0.25, metalness: 0.4 });
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

export function carcass(g: THREE.Group, w: number, h: number, d: number, color: string | Finish, y0: number): void {
  box(g, w, h, d - FRONT_T, surfMat(color, 'matte', CARCASS_DARKEN), 0, y0, -FRONT_T / 2);
}

/**
 * Worktop finish as a Finish: the item's own counter material when set, else
 * the room-wide worktop style. The room worktop colour may be a design-variable
 * ref, so resolve it; a per-item material override keeps that resolved colour.
 */
export function counterFin(design: Design, room: RoomStyle, item?: Item): Finish {
  const base = resolveFinish(design, room.counterColor, room.counterMaterial, room.counterMaterialRot);
  if (item?.counterMaterial) {
    return { color: base.color, material: item.counterMaterial, rot: item.counterMaterialRot };
  }
  return base;
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
  for (const hpts of holes ?? []) {
    const hole = signedArea(hpts) > 0 ? [...hpts].reverse() : hpts;
    shape.holes.push(new THREE.Path(hole.map((p) => new THREE.Vector2(p.x, p.y))));
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  const m = new THREE.Mesh(geo, mat);
  // shape (x, y) → world (x, z); extrusion +z → world -y, so lift by h
  m.rotation.x = Math.PI / 2;
  m.position.y = y0 + h;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}
