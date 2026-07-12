import * as THREE from 'three';
import { APPLIANCE_BLACK, type CatalogDef } from '../model/catalog';
import type { CustomPartDef, Item, RoomStyle } from '../model/types';

/**
 * Procedural, parametric meshes for every catalog kind.
 * Local space: x = width, y = up (0 at item bottom), z = depth
 * (back face at -d/2 — the side that touches walls; front at +d/2).
 *
 * Style follows the reference kitchens: matte handleless slab fronts with a
 * routed dark groove, dark recessed plinth, oak worktops.
 */

const PLINTH_H = 0.1;
const COUNTER_T = 0.04;
const FRONT_T = 0.018;
const GAP = 0.004;
const PLINTH_COLOR = '#26251f';
const GROOVE = '#1f1e1b';
const CARCASS_DARKEN = 0.92;

export function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * f);
  c.g = Math.min(1, c.g * f);
  c.b = Math.min(1, c.b * f);
  return `#${c.getHexString()}`;
}

function matte(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.03 });
}

function wood(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02 });
}

function steelMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: '#b6babd', roughness: 0.38, metalness: 0.65 });
}

function applianceGlass(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: APPLIANCE_BLACK, roughness: 0.25, metalness: 0.4 });
}

function box(
  g: THREE.Group,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function cyl(
  g: THREE.Group,
  r: number,
  h: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  rTop = r
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, h, 20), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

/** A handleless front slab with a routed groove along its top (or bottom) edge. */
function frontSlab(
  g: THREE.Group,
  w: number,
  h: number,
  color: string,
  x: number,
  y: number,
  zFront: number,
  grooveAt: 'top' | 'bottom' | 'none' = 'top'
): void {
  box(g, w, h, FRONT_T, matte(color), x, y, zFront - FRONT_T / 2);
  if (grooveAt !== 'none') {
    const gy = grooveAt === 'top' ? y + h - 0.012 : y;
    box(g, w, 0.012, FRONT_T + 0.002, matte(GROOVE), x, gy, zFront - FRONT_T / 2 - 0.002);
  }
}

/** Split a width into n fronts with small gaps; calls fn(centerX, frontW). */
function splitFronts(w: number, n: number, fn: (x: number, fw: number) => void): void {
  const fw = (w - GAP * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + GAP + fw / 2 + i * (fw + GAP);
    fn(x, fw);
  }
}

function plinth(g: THREE.Group, w: number, d: number): void {
  box(g, w - 0.06, PLINTH_H, d - 0.05, matte(PLINTH_COLOR), 0, 0, -0.02);
}

function carcass(g: THREE.Group, w: number, h: number, d: number, color: string, y0: number): void {
  box(g, w, h, d - FRONT_T, matte(shade(color, CARCASS_DARKEN)), 0, y0, -FRONT_T / 2);
}

function counterSlab(g: THREE.Group, w: number, d: number, y: number, room: RoomStyle): void {
  box(g, w, COUNTER_T, d + 0.02, wood(room.counterColor), 0, y, 0.01);
}

interface Ctx {
  item: Item;
  def: CatalogDef;
  room: RoomStyle;
  part?: CustomPartDef;
}

type Builder = (g: THREE.Group, c: Ctx) => void;

/* ---------------- base units ---------------- */

const baseCabinet: Builder = (g, { item, room }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - COUNTER_T;
  plinth(g, w, d);
  carcass(g, w, bodyH, d, item.color, PLINTH_H);
  const doors = Math.max(1, item.params?.doors ?? 1);
  splitFronts(w, doors, (x, fw) => frontSlab(g, fw, bodyH, item.color, x, PLINTH_H, d / 2));
  counterSlab(g, w, d, h - COUNTER_T, room);
};

const baseDrawers: Builder = (g, { item, room }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - COUNTER_T;
  plinth(g, w, d);
  carcass(g, w, bodyH, d, item.color, PLINTH_H);
  const n = Math.max(1, item.params?.drawers ?? 3);
  const fh = (bodyH - GAP * (n + 1)) / n;
  for (let i = 0; i < n; i++) {
    frontSlab(g, w - GAP * 2, fh, item.color, 0, PLINTH_H + GAP + i * (fh + GAP), d / 2);
  }
  counterSlab(g, w, d, h - COUNTER_T, room);
};

const sink: Builder = (g, c) => {
  const { item } = c;
  baseCabinet(g, c);
  const { w, d, h } = item;
  const bowls = Math.max(1, item.params?.bowls ?? 1);
  const basinMat = new THREE.MeshStandardMaterial({ color: '#2e3134', roughness: 0.35, metalness: 0.7 });
  const bw = Math.min(0.4, (w - 0.16) / bowls - 0.04);
  for (let i = 0; i < bowls; i++) {
    const x = bowls === 1 ? 0 : (i === 0 ? -1 : 1) * (bw / 2 + 0.03);
    box(g, bw, 0.012, d - 0.24, basinMat, x, h - 0.005, 0);
    box(g, bw - 0.05, 0.02, d - 0.3, matte('#191b1d'), x, h - 0.02, 0);
  }
  // black arc faucet
  const black = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.4, metalness: 0.5 });
  cyl(g, 0.014, 0.3, black, 0, h, -d / 2 + 0.09);
  const arm = cyl(g, 0.011, 0.22, black, 0, h + 0.29, -d / 2 + 0.09);
  arm.rotation.x = Math.PI / 2.3;
  arm.position.z += 0.09;
};

const hob: Builder = (g, c) => {
  const { item } = c;
  baseDrawers(g, { ...c, item: { ...item, params: { drawers: 2 } } });
  const { w, d, h } = item;
  box(g, w - 0.06, 0.008, d - 0.14, applianceGlass(), 0, h, 0);
  const zones = Math.max(2, item.params?.burners ?? 4);
  const ring = new THREE.MeshStandardMaterial({ color: '#3c3f43', roughness: 0.5, metalness: 0.3 });
  const pos: [number, number][] =
    zones === 2
      ? [[0, -0.12], [0, 0.12]]
      : zones === 3
        ? [[-0.14, -0.11], [-0.14, 0.11], [0.13, 0]]
        : zones === 4
          ? [[-0.13, -0.11], [-0.13, 0.11], [0.13, -0.11], [0.13, 0.11]]
          : [[-0.15, -0.12], [-0.15, 0.12], [0.15, -0.12], [0.15, 0.12], [0, 0]];
  for (const [px, pz] of pos) {
    cyl(g, 0.065, 0.004, ring, px * (w / 0.6), h + 0.008, pz * (d / 0.6));
  }
};

const oven: Builder = (g, { item, room }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - COUNTER_T;
  plinth(g, w, d);
  carcass(g, w, bodyH, d, item.color, PLINTH_H);
  const ovenH = Math.min(0.6, bodyH - 0.12);
  frontSlab(g, w - GAP * 2, bodyH - ovenH - GAP * 2, item.color, 0, PLINTH_H + GAP, d / 2, 'none');
  const oy = PLINTH_H + (bodyH - ovenH);
  box(g, w - GAP * 2, ovenH, 0.02, applianceGlass(), 0, oy, d / 2 - 0.01);
  box(g, w - 0.1, 0.02, 0.03, steelMat(), 0, oy + ovenH - 0.07, d / 2 + 0.012);
  box(g, w - 0.16, 0.16, 0.005, matte('#0c0d0f'), 0, oy + 0.12, d / 2 + 0.001);
  counterSlab(g, w, d, h - COUNTER_T, room);
};

const dishwasher: Builder = (g, { item, room }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - COUNTER_T;
  plinth(g, w, d);
  carcass(g, w, bodyH, d, '#9aa0a3', PLINTH_H);
  box(g, w - GAP * 2, bodyH, 0.016, steelMat(), 0, PLINTH_H, d / 2 - 0.008);
  box(g, w - 0.1, 0.02, 0.03, steelMat(), 0, PLINTH_H + bodyH - 0.06, d / 2 + 0.01);
  counterSlab(g, w, d, h - COUNTER_T, room);
};

const island: Builder = (g, { item, room }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - COUNTER_T;
  plinth(g, w, d);
  // body panels all around
  box(g, w, bodyH, d - FRONT_T, matte(shade(item.color, CARCASS_DARKEN)), 0, PLINTH_H, -FRONT_T / 2);
  box(g, w, bodyH, FRONT_T, matte(item.color), 0, PLINTH_H, -d / 2 + FRONT_T / 2); // back panel
  const n = item.params?.drawers ?? 3;
  if (n > 0) {
    splitFronts(w, Math.min(n, Math.max(1, Math.round(w / 0.55))), (x, fw) => {
      const rows = Math.min(3, Math.max(1, n));
      const fh = (bodyH - GAP * (rows + 1)) / rows;
      for (let i = 0; i < rows; i++) {
        frontSlab(g, fw, fh, item.color, x, PLINTH_H + GAP + i * (fh + GAP), d / 2);
      }
    });
  } else {
    box(g, w, bodyH, FRONT_T, matte(item.color), 0, PLINTH_H, d / 2 - FRONT_T / 2);
  }
  // generous worktop overhang on the seating side (front)
  box(g, w + 0.06, COUNTER_T, d + 0.18, wood(room.counterColor), 0, h - COUNTER_T, 0.06);
};

/* ---------------- tall units ---------------- */

const fridge: Builder = (g, { item }) => {
  const { w, d, h } = item;
  const body = steelMat();
  box(g, w, h - 0.02, d, body, 0, 0.02, 0);
  const doorMat = steelMat();
  const split = h * 0.62;
  box(g, w - 0.02, h - split - 0.04, 0.02, doorMat, 0, split + 0.02, d / 2 + 0.005);
  box(g, w - 0.02, split - 0.06, 0.02, doorMat, 0, 0.04, d / 2 + 0.005);
  const handle = new THREE.MeshStandardMaterial({ color: '#7e8487', roughness: 0.3, metalness: 0.8 });
  box(g, 0.02, Math.min(0.5, h * 0.25), 0.025, handle, -w / 2 + 0.07, split + 0.1, d / 2 + 0.03);
  box(g, 0.02, Math.min(0.3, h * 0.16), 0.025, handle, -w / 2 + 0.07, split - 0.4, d / 2 + 0.03);
};

const pantry: Builder = (g, { item }) => {
  const { w, d, h } = item;
  plinth(g, w, d);
  const bodyH = h - PLINTH_H;
  carcass(g, w, bodyH, d, item.color, PLINTH_H);
  const sections = Math.max(1, item.params?.split ?? 2);
  const heights = sections === 1 ? [bodyH] : sections === 2 ? [bodyH * 0.62, bodyH * 0.38] : [bodyH * 0.5, bodyH * 0.28, bodyH * 0.22];
  let y = PLINTH_H;
  for (const sh of heights) {
    splitFronts(w, w > 0.75 ? 2 : 1, (x, fw) => frontSlab(g, fw, sh - GAP, item.color, x, y, d / 2));
    y += sh;
  }
};

const ovenTower: Builder = (g, { item }) => {
  const { w, d, h } = item;
  plinth(g, w, d);
  const bodyH = h - PLINTH_H;
  carcass(g, w, bodyH, d, item.color, PLINTH_H);
  const n = Math.max(1, Math.min(3, item.params?.appliances ?? 2));
  const appH = [0.6, 0.38, 0.38]; // oven, micro/steam, coffee
  const zoneY = PLINTH_H + 0.72; // appliances start at ~standing height
  let y = zoneY;
  // lower doors
  frontSlab(g, w - GAP * 2, zoneY - PLINTH_H - GAP, item.color, 0, PLINTH_H + GAP / 2, d / 2, 'top');
  for (let i = 0; i < n; i++) {
    const ah = appH[i];
    if (y + ah > PLINTH_H + bodyH - 0.06) break;
    box(g, w - GAP * 2, ah - GAP, 0.02, applianceGlass(), 0, y, d / 2 - 0.01);
    box(g, w - 0.12, 0.015, 0.025, steelMat(), 0, y + ah - 0.06, d / 2 + 0.01);
    y += ah;
  }
  // top doors fill the rest
  const rest = PLINTH_H + bodyH - y - GAP;
  if (rest > 0.08) frontSlab(g, w - GAP * 2, rest, item.color, 0, y + GAP / 2, d / 2, 'bottom');
};

/* ---------------- wall units ---------------- */

const wallCabinet: Builder = (g, { item }) => {
  const { w, d, h } = item;
  carcass(g, w, h, d, item.color, 0);
  const doors = Math.max(1, item.params?.doors ?? 1);
  splitFronts(w, doors, (x, fw) => frontSlab(g, fw, h, item.color, x, 0, d / 2, 'bottom'));
};

const shelf: Builder = (g, { item }) => {
  const { w, d, h } = item;
  const n = Math.max(1, item.params?.shelves ?? 2);
  const mat = wood(item.color);
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : (i * (h - 0.025)) / (n - 1);
    box(g, w, 0.028, d, mat, 0, y, 0);
  }
};

const hood: Builder = (g, { item }) => {
  const { w, d, h } = item;
  const dark = applianceGlass();
  // angled screen like the reference kitchens
  const screen = box(g, w, 0.5, 0.03, dark, 0, 0.06, d / 2 - 0.18);
  screen.rotation.x = -0.75;
  screen.position.z = -d / 2 + 0.28;
  screen.position.y = 0.26;
  box(g, w, 0.05, d * 0.75, dark, 0, 0.42, -d / 2 + d * 0.375);
  box(g, 0.24, Math.max(0.1, h - 0.5), 0.24, matte('#1b1c1e'), 0, 0.47, -d / 2 + 0.14);
};

const backsplash: Builder = (g, { item }) => {
  box(g, item.w, item.h, 0.018, wood(item.color), 0, 0, 0);
};

/* ---------------- furniture ---------------- */

const table: Builder = (g, { item }) => {
  const { w, d, h } = item;
  box(g, w, 0.04, d, wood(item.color), 0, h - 0.04, 0);
  const leg = wood(shade(item.color, 0.85));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    cyl(g, 0.025, h - 0.04, leg, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08));
  }
};

const chair: Builder = (g, { item }) => {
  const { w, d, h } = item;
  const seatH = 0.46;
  const mat = matte(item.color);
  const legMat = wood('#a8895e');
  box(g, w - 0.04, 0.035, d - 0.06, mat, 0, seatH, 0.02);
  const back = box(g, w - 0.06, h - seatH - 0.05, 0.03, mat, 0, seatH + 0.04, -d / 2 + 0.035);
  back.rotation.x = 0.08;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const l = cyl(g, 0.014, seatH, legMat, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.06));
    l.rotation.z = sx * -0.06;
    l.rotation.x = sz * 0.06;
  }
};

const stool: Builder = (g, { item }) => {
  const { w, h } = item;
  cyl(g, w / 2, 0.045, wood(item.color), 0, h - 0.045, 0);
  const legMat = matte('#2a2926');
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const l = cyl(g, 0.012, h - 0.04, legMat, Math.cos(a) * (w / 2 - 0.05), 0, Math.sin(a) * (w / 2 - 0.05));
    l.rotation.z = Math.cos(a) * 0.12;
    l.rotation.x = -Math.sin(a) * 0.12;
  }
};

/* ---------------- lighting fixtures ---------------- */

const pendant: Builder = (g, { item, room }) => {
  const { w, h } = item;
  const cordLen = Math.max(0.05, room.wallHeight - item.elevation - h);
  const black = matte('#1c1b19');
  cyl(g, 0.006, cordLen, black, 0, h, 0);
  const shadeMesh = cyl(g, w / 2, h * 0.75, matte(item.color), 0, h * 0.25, 0, w / 6);
  shadeMesh.castShadow = false;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshStandardMaterial({ color: '#fff6e0', emissive: '#ffd9a0', emissiveIntensity: 1.6 })
  );
  bulb.position.y = h * 0.22;
  bulb.userData.bulb = true;
  g.add(bulb);
};

const spot: Builder = (g, { item }) => {
  cyl(g, item.w / 2, 0.02, matte(item.color), 0, 0.02, 0);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(item.w / 2 - 0.02, item.w / 2 - 0.02, 0.008, 20),
    new THREE.MeshStandardMaterial({ color: '#fff8e6', emissive: '#ffe8b8', emissiveIntensity: 1.4 })
  );
  lens.position.y = 0.012;
  lens.userData.bulb = true;
  g.add(lens);
};

const strip: Builder = (g, { item }) => {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(item.w, 0.018, 0.035),
    new THREE.MeshStandardMaterial({ color: '#fff4da', emissive: '#ffce7d', emissiveIntensity: 1.8 })
  );
  bar.position.y = 0.01;
  bar.userData.bulb = true;
  g.add(bar);
};

/* ---------------- utility markers ---------------- */

const water: Builder = (g, { item }) => {
  const plate = matte('#eef1f3');
  box(g, item.w, item.h, 0.012, plate, 0, 0, -item.d / 2 + 0.006);
  const chrome = steelMat();
  const hot = cyl(g, 0.016, 0.05, chrome, -0.045, item.h / 2 - 0.025, 0);
  hot.rotation.x = Math.PI / 2;
  const cold = cyl(g, 0.016, 0.05, chrome, 0.045, item.h / 2 - 0.025, 0);
  cold.rotation.x = Math.PI / 2;
  box(g, 0.02, 0.02, 0.02, matte('#c0392b'), -0.045, item.h / 2 - 0.02, 0.02);
  box(g, 0.02, 0.02, 0.02, matte('#2e6da4'), 0.045, item.h / 2 - 0.02, 0.02);
  cyl(g, 0.022, 0.04, matte('#8a8f94'), 0, 0.02, 0).rotation.x = Math.PI / 2;
};

const outlet: Builder = (g, { item }) => {
  box(g, item.w, item.h, 0.014, matte('#f4f3ef'), 0, 0, -item.d / 2 + 0.007);
  const holeMat = matte('#3a3934');
  for (const sx of [-1, 1]) {
    const holeCyl = cyl(g, 0.006, 0.012, holeMat, sx * 0.022, item.h / 2 - 0.006, 0.004);
    holeCyl.rotation.x = Math.PI / 2;
  }
};

/* ---------------- custom parts (Part Studio) ---------------- */

const custom: Builder = (g, c) => {
  const { item, part, room } = c;
  const template = part?.template ?? 'cabinet';
  const accent = part?.accentColor ?? '#c9a87c';
  const p = item.params ?? part?.options ?? {};
  const { w, d, h } = item;

  if (template === 'desk') {
    box(g, w, 0.035, d, wood(accent), 0, h - 0.035, 0);
    const drawers = p.drawers ?? 0;
    if (p.panelLegs) {
      box(g, 0.03, h - 0.035, d - 0.05, matte(item.color), -w / 2 + 0.05, 0, 0);
      box(g, 0.03, h - 0.035, d - 0.05, matte(item.color), w / 2 - 0.05, 0, 0);
    } else {
      const leg = matte(shade(item.color, 0.8));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        cyl(g, 0.022, h - 0.035, leg, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06));
      }
    }
    if (drawers > 0) {
      const pw = Math.min(0.42, w * 0.35);
      const px = w / 2 - pw / 2 - 0.04;
      const ph = h - 0.035 - 0.12;
      box(g, pw, ph, d - 0.06, matte(shade(item.color, CARCASS_DARKEN)), px, 0.12, -FRONT_T / 2);
      const fh = (ph - GAP * (drawers + 1)) / drawers;
      for (let i = 0; i < drawers; i++) {
        frontSlab(g, pw - GAP * 2, fh, item.color, px, 0.12 + GAP + i * (fh + GAP), d / 2 - 0.03);
      }
    }
    return;
  }

  // ---- cabinet template ----
  const wallMounted = item.elevation > 0.3;
  const hasPlinth = !wallMounted && (p.plinth ?? 1) > 0;
  const hasTop = (p.worktop ?? 0) > 0;
  const topT = hasTop ? 0.035 : 0;
  const y0 = hasPlinth ? PLINTH_H : 0;
  const bodyH = h - y0 - topT;
  if (bodyH <= 0.05) return;
  if (hasPlinth) plinth(g, w, d);
  carcass(g, w, bodyH, d, item.color, y0);

  const drawers = Math.max(0, p.drawers ?? 0);
  const doors = Math.max(0, p.doors ?? 0);
  const shelves = Math.max(0, p.shelves ?? 0);

  // vertical split: drawers at the bottom, doors in the middle, open shelves on top
  const zones: Array<{ type: 'drawers' | 'doors' | 'open'; h: number }> = [];
  const weights = [
    drawers > 0 ? Math.min(0.6, drawers * 0.2) : 0,
    doors > 0 ? 0.45 + doors * 0.05 : 0,
    shelves > 0 ? 0.35 + shelves * 0.08 : 0,
  ];
  const total = weights[0] + weights[1] + weights[2] || 1;
  if (drawers > 0) zones.push({ type: 'drawers', h: (bodyH * weights[0]) / total });
  if (doors > 0) zones.push({ type: 'doors', h: (bodyH * weights[1]) / total });
  if (shelves > 0) zones.push({ type: 'open', h: (bodyH * weights[2]) / total });
  if (!zones.length) zones.push({ type: 'doors', h: bodyH });

  let y = y0;
  for (const zone of zones) {
    if (zone.type === 'drawers') {
      const n = Math.max(1, drawers);
      const fh = (zone.h - GAP * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        frontSlab(g, w - GAP * 2, fh, item.color, 0, y + GAP + i * (fh + GAP), d / 2);
      }
    } else if (zone.type === 'doors') {
      splitFronts(w, Math.max(1, doors || 1), (x, fw) =>
        frontSlab(g, fw, zone.h - GAP, item.color, x, y + GAP / 2, d / 2, wallMounted ? 'bottom' : 'top')
      );
    } else {
      // open niche with accent interior — like the oak niches in the references
      const inner = wood(accent);
      box(g, w - 0.03, zone.h - 0.03, 0.012, inner, 0, y + 0.015, -d / 2 + 0.02);
      box(g, 0.015, zone.h - 0.03, d - 0.04, inner, -w / 2 + 0.025, y + 0.015, 0);
      box(g, 0.015, zone.h - 0.03, d - 0.04, inner, w / 2 - 0.025, y + 0.015, 0);
      const n = Math.max(1, shelves);
      for (let i = 0; i < n; i++) {
        const sy = y + ((i + 1) * zone.h) / (n + 1);
        box(g, w - 0.04, 0.02, d - 0.05, inner, 0, sy - 0.01, 0);
      }
    }
    y += zone.h;
  }
  if (hasTop) box(g, w + 0.02, topT, d + 0.02, wood(accent), 0, h - topT, 0.005);
};

/* ---------------- registry ---------------- */

const BUILDERS: Record<string, Builder> = {
  baseCabinet,
  baseDrawers,
  sink,
  hob,
  oven,
  dishwasher,
  island,
  fridge,
  pantry,
  ovenTower,
  wallCabinet,
  shelf,
  hood,
  backsplash,
  table,
  chair,
  stool,
  pendant,
  spot,
  strip,
  water,
  outlet,
  custom,
};

export function buildItemGroup(item: Item, def: CatalogDef, room: RoomStyle, part?: CustomPartDef): THREE.Group {
  const g = new THREE.Group();
  const builder = BUILDERS[def.kind];
  if (builder) builder(g, { item, def, room, part });
  else box(g, item.w, item.h, item.d, matte(item.color), 0, 0, 0);
  return g;
}

/** Where the actual light source sits, in item-local coordinates. */
export function lightLocalY(def: CatalogDef, item: Item): number {
  switch (def.kind) {
    case 'pendant':
      return item.h * 0.18;
    case 'spot':
      return -0.04;
    default:
      return -0.02;
  }
}
