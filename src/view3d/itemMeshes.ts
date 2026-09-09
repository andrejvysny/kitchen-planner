import * as THREE from 'three';
import { sofaSeats, type CatalogDef } from '../model/catalog';
import type { HostContext } from '../model/panels';
import type { CustomPartDef, Design, Item, RoomStyle } from '../model/types';
import { styleOfItem } from '../model/rooms';
import { resolveFinish } from '../model/variables';
import {
  applianceGlass,
  box,
  carcass,
  cyl,
  type Finish,
  GAP,
  GROOVE,
  matte,
  plinth,
  PLINTH_COLOR,
  PLINTH_H,
  prism,
  roundedRectPoly,
  softSlab,
  stampMaterial,
  steelMat,
  surfMat,
  wood,
} from './meshKit';
import { DECOR_FORMS } from './decorMeshes';
import { buildCustomPart } from './partMeshes';

/**
 * Procedural meshes for the remaining catalog kinds: appliances (bought
 * products — never panel lists), loose furniture, lights and wall markers.
 * Cabinets all render through the panel IR (partMeshes) via the 'custom'
 * builder. Local space: x = width, y = up (0 at item bottom), z = depth
 * (back face at -d/2 — the side that touches walls; front at +d/2).
 */

export { shade } from './meshKit';
export { lightLocalY } from '../model/catalog';

interface Ctx {
  item: Item;
  def: CatalogDef;
  design: Design;
  room: RoomStyle;
  part?: CustomPartDef;
  /** appliance cutouts other items take out of THIS item's worktop */
  host?: HostContext;
  /** the item's paintable front finish, with design-variable refs already resolved */
  finish: Finish;
}

type Builder = (g: THREE.Group, c: Ctx) => void;

/* ---------------- counter appliances ----------------
 * Sinks and hobs are bought products that mount INTO a worktop: local y = 0
 * is the counter surface, the basin hangs below into the host's cutout.
 */

const sink: Builder = (g, { item }) => {
  const { w, d } = item;
  const bowls = Math.max(1, item.params?.bowls ?? 1);
  const steel = stampMaterial(
    new THREE.MeshStandardMaterial({
      color: '#b9bdc0',
      roughness: 0.35,
      metalness: 0.7,
    }),
    { kind: 'product', product: 'steel' }
  );
  // rim plate flush on the counter
  box(g, w, 0.012, d - 0.08, steel, 0, 0, 0.02);
  // the bowl is dark, so it names as an appliance-black surface rather than
  // steel — a product name carries no colour, and folding it into the bright
  // rim material downstream would light the sink from the wrong value
  const basinMat = stampMaterial(
    new THREE.MeshStandardMaterial({
      color: '#2e3134',
      roughness: 0.35,
      metalness: 0.7,
    }),
    { kind: 'product', product: 'appliance-black' }
  );
  const bw = (w - 0.06) / bowls - 0.02;
  for (let i = 0; i < bowls; i++) {
    const x = bowls === 1 ? 0 : (i === 0 ? -1 : 1) * (bw / 2 + 0.015);
    // bowl hangs below the counter, into the cutout
    box(g, bw, 0.16, d - 0.14, basinMat, x, -0.16, 0.02);
    box(g, bw - 0.04, 0.02, d - 0.18, matte('#191b1d'), x, -0.02, 0.02);
  }
  // black arc faucet at the back edge
  const black = stampMaterial(
    new THREE.MeshStandardMaterial({
      color: '#141414',
      roughness: 0.4,
      metalness: 0.5,
    }),
    { kind: 'product', product: 'appliance-black' }
  );
  cyl(g, 0.014, 0.3, black, 0, 0.005, -d / 2 + 0.05);
  const arm = cyl(g, 0.011, 0.22, black, 0, 0.295, -d / 2 + 0.05);
  arm.rotation.x = Math.PI / 2.3;
  arm.position.z += 0.09;
};

const hob: Builder = (g, { item }) => {
  const { w, d } = item;
  box(g, w, 0.008, d, applianceGlass(), 0, 0, 0);
  const zones = Math.max(2, item.params?.burners ?? 4);
  const ring = stampMaterial(
    new THREE.MeshStandardMaterial({ color: '#3c3f43', roughness: 0.5, metalness: 0.3 }),
    { kind: 'product', product: 'appliance-ring' }
  );
  const pos: [number, number][] =
    zones === 2
      ? [
          [0, -0.12],
          [0, 0.12],
        ]
      : zones === 3
        ? [
            [-0.14, -0.11],
            [-0.14, 0.11],
            [0.13, 0],
          ]
        : zones === 4
          ? [
              [-0.13, -0.11],
              [-0.13, 0.11],
              [0.13, -0.11],
              [0.13, 0.11],
            ]
          : [
              [-0.15, -0.12],
              [-0.15, 0.12],
              [0.15, -0.12],
              [0.15, 0.12],
              [0, 0],
            ];
  for (const [px, pz] of pos) {
    cyl(g, 0.065, 0.004, ring, px * (w / 0.6), 0.008, pz * (d / 0.6));
  }
};

// A built-in oven/microwave: a boxed product that slides into a cabinet niche.
const oven: Builder = (g, { item }) => {
  const { w, d, h } = item;
  box(g, w, h, d - 0.02, matte('#26282b'), 0, 0, -0.01);
  box(g, w, h, 0.02, applianceGlass(), 0, 0, d / 2 - 0.01);
  box(g, w - 0.1, 0.02, 0.03, steelMat(), 0, h - 0.07, d / 2 + 0.012);
  box(g, w - 0.16, Math.min(0.16, h * 0.28), 0.005, matte('#0c0d0f'), 0, 0.06, d / 2 + 0.001);
};

// Freestanding dishwasher: a self-contained product with its own dark top —
// slotting it INTO a run (behind a cabinet front) is future zone territory.
const dishwasher: Builder = (g, { item }) => {
  const { w, d, h } = item;
  const bodyH = h - PLINTH_H - 0.02;
  plinth(g, w, d);
  carcass(g, w, bodyH, d, '#9aa0a3', PLINTH_H);
  box(g, w - GAP * 2, bodyH, 0.016, steelMat(), 0, PLINTH_H, d / 2 - 0.008);
  box(g, w - 0.1, 0.02, 0.03, steelMat(), 0, PLINTH_H + bodyH - 0.06, d / 2 + 0.01);
  box(g, w, 0.02, d, matte('#3a3d40'), 0, h - 0.02, 0);
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
  const handle = stampMaterial(
    new THREE.MeshStandardMaterial({
      color: '#7e8487',
      roughness: 0.3,
      metalness: 0.8,
    }),
    { kind: 'product', product: 'handle' }
  );
  box(g, 0.02, Math.min(0.5, h * 0.25), 0.025, handle, -w / 2 + 0.07, split + 0.1, d / 2 + 0.03);
  box(g, 0.02, Math.min(0.3, h * 0.16), 0.025, handle, -w / 2 + 0.07, split - 0.4, d / 2 + 0.03);
};

/* ---------------- wall units ---------------- */

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

const backsplash: Builder = (g, { item, finish }) => {
  box(g, item.w, item.h, 0.018, surfMat(finish, 'wood'), 0, 0, 0);
};

/* ---------------- bedroom ---------------- */

/** bedding tones — fabric reads as flat matte next to the painted frame */
const MATTRESS_COLOR = '#f2f1ec';
const DUVET_COLOR = '#e6dfd0';
const PILLOW_COLOR = '#f7f6f2';
/** top of the frame deck (where the mattress lands) and mattress thickness */
const BED_FRAME_H = 0.28;
const BED_MAT_T = 0.24;
/** recessed dark toe under the frame, and the headboard board thickness */
const BED_BASE_H = 0.09;
const HEADBOARD_T = 0.05;

const bed: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  const drawers = Math.max(0, Math.min(2, Math.round(item.params?.drawers ?? 0)));
  const frame = surfMat(finish, 'wood');
  // dark recessed base, like a plinth: the frame reads as floating
  box(g, w - 0.12, BED_BASE_H, d - 0.12, matte(PLINTH_COLOR), 0, 0, 0);
  // rail deck; storage fronts are applied over it, so it steps in for them
  const deckH = Math.max(0.06, BED_FRAME_H - BED_BASE_H);
  box(g, drawers ? w - 0.036 : w, deckH, d, frame, 0, BED_BASE_H, 0);
  // headboard at the BACK (-d/2) — the side that meets the wall
  box(
    g,
    w,
    Math.max(0.1, h - BED_FRAME_H),
    HEADBOARD_T,
    frame,
    0,
    BED_FRAME_H,
    -d / 2 + HEADBOARD_T / 2
  );

  const matW = Math.max(0.2, w - 0.04);
  const matD = Math.max(0.3, d - HEADBOARD_T - 0.04);
  const matCz = HEADBOARD_T / 2; // mattress clears the headboard, centred on the rest
  softSlab(g, matW, matD, BED_MAT_T, matte(MATTRESS_COLOR), BED_FRAME_H, 0, matCz, 0.04);
  // duvet folded back over the foot; pillows sit in the freed head end
  const duvD = matD * 0.62;
  softSlab(
    g,
    matW + 0.03,
    duvD,
    0.07,
    matte(DUVET_COLOR),
    BED_FRAME_H + BED_MAT_T - 0.02,
    0,
    matCz + matD / 2 - duvD / 2,
    0.05
  );
  const pillows = Math.max(1, Math.min(2, Math.round(item.params?.pillows ?? 1)));
  const pillowD = Math.min(0.36, matD * 0.22);
  const pillowW = pillows === 1 ? Math.min(0.62, matW - 0.08) : (matW - 0.1) / 2;
  const pillowZ = matCz - matD / 2 + pillowD / 2 + 0.03;
  for (let i = 0; i < pillows; i++) {
    const px = pillows === 1 ? 0 : (i === 0 ? -1 : 1) * (pillowW / 2 + 0.02);
    softSlab(
      g,
      pillowW,
      pillowD,
      0.1,
      matte(PILLOW_COLOR),
      BED_FRAME_H + BED_MAT_T - 0.02,
      px,
      pillowZ,
      0.05
    );
  }

  if (drawers > 0) {
    // handleless storage fronts on both long sides, groove-pulled like the units
    const fh = Math.max(0.08, deckH - 0.04);
    const fy = BED_BASE_H + 0.02;
    const run = d - HEADBOARD_T - 0.12;
    const pitch = run / drawers;
    const fd = pitch - 0.03;
    for (const sx of [-1, 1] as const) {
      for (let i = 0; i < drawers; i++) {
        const cz = -d / 2 + HEADBOARD_T + 0.06 + i * pitch + fd / 2;
        box(g, 0.018, fh - 0.014, fd, frame, sx * (w / 2 - 0.013), fy, cz);
        box(g, 0.012, 0.014, fd, matte(GROOVE), sx * (w / 2 - 0.016), fy + fh - 0.014, cz);
      }
    }
  }
};

/* ---------------- living room ---------------- */

/** upholstery reads a shade lighter than the frame it sits in */
const CUSHION_TINT = 1.08;
const FRAME_TINT = 0.9;
/** foot height, seat-deck height above it, and the seat cushion thickness */
const SOFA_FOOT_H = 0.07;
const SOFA_BASE_H = 0.23;
const SOFA_SEAT_T = 0.14;

/**
 * An upright rounded cushion: a soft slab stood on its edge so the rounded
 * face looks into the room. `z` is its FRONT face; a negative `tilt` leans
 * the top back. (`prism` extrudes along plan +y, so rotating a further half
 * turn maps the polygon's y onto world height and the extrusion onto depth.)
 */
function uprightCushion(
  g: THREE.Group,
  w: number,
  hgt: number,
  t: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  tilt = 0
): void {
  const m = prism(g, roundedRectPoly(w, hgt, Math.min(0.06, hgt / 3)), t, mat, 0);
  m.rotation.x = Math.PI + tilt;
  m.position.set(x, y + hgt / 2, z);
}

const sofa: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  const seats = sofaSeats(w, item.params?.seats);
  const frameMat = surfMat(finish, 'matte', FRAME_TINT);
  const cushionMat = surfMat(finish, 'matte', CUSHION_TINT);
  const armW = Math.min(0.14, w * 0.1);
  const backT = Math.min(0.12, d * 0.14);

  // short dark feet — the upholstered shell reads as floating on them
  const footMat = matte('#2a2926');
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    cyl(g, 0.022, SOFA_FOOT_H, footMat, sx * (w / 2 - 0.09), 0, sz * (d / 2 - 0.11));
  }

  const deckY = SOFA_FOOT_H + SOFA_BASE_H;
  box(g, w, SOFA_BASE_H, d, frameMat, 0, SOFA_FOOT_H, 0);
  // the back leans away from the room; nudged forward so its top corner stays
  // inside the footprint (and out of the wall behind it)
  const backH = Math.max(0.2, h - deckY);
  const back = box(g, w, backH, backT, frameMat, 0, deckY, -d / 2 + 0.03 + backT / 2);
  back.rotation.x = -0.05;
  const armH = Math.max(deckY + 0.06, h * 0.74);
  for (const sx of [-1, 1] as const) {
    box(g, armW, armH - SOFA_FOOT_H, d - 0.02, frameMat, (sx * (w - armW)) / 2, SOFA_FOOT_H, 0.01);
  }

  // seat cushions across the clear width, back cushions leaning on the frame
  const innerW = Math.max(0.2, w - armW * 2);
  const zBack = -d / 2 + 0.03 + backT;
  const seatD = Math.max(0.25, d / 2 - 0.03 - zBack);
  const seatCz = zBack + seatD / 2;
  const bcT = Math.min(0.12, seatD * 0.18);
  const bcH = Math.max(0.18, h - deckY - SOFA_SEAT_T - 0.06);
  for (let i = 0; i < seats; i++) {
    const cx = -innerW / 2 + (innerW * (i + 0.5)) / seats;
    softSlab(g, innerW / seats - 0.012, seatD, SOFA_SEAT_T, cushionMat, deckY, cx, seatCz, 0.045);
    uprightCushion(
      g,
      innerW / seats - 0.018,
      bcH,
      bcT,
      cushionMat,
      cx,
      deckY + SOFA_SEAT_T - 0.02,
      zBack + bcT,
      -0.08
    );
  }
};

/** how far the panel stands off the wall, on its bracket */
const TV_PANEL_T = 0.045;

const tv: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  // bracket first: it spans wall face → panel back, so the panel floats
  const armD = Math.max(0.01, d - TV_PANEL_T);
  const bh = Math.min(0.28, h * 0.4);
  box(g, Math.min(0.34, w * 0.28), bh, armD, matte('#2b2d30'), 0, (h - bh) / 2, -d / 2 + armD / 2);
  box(g, w, h, TV_PANEL_T, surfMat(finish), 0, 0, d / 2 - TV_PANEL_T / 2);
  // glossy screen just proud of the bezel
  box(g, w - 0.024, h - 0.03, 0.006, applianceGlass(), 0, 0.014, d / 2 - 0.002);
};

const rug: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  const r = Math.min(0.06, Math.min(w, d) * 0.06);
  // 2 mm off the floor and never casting: a rug that shadows itself reads as
  // a floating slab once the sun grazes
  const base = prism(g, roundedRectPoly(w, d, r), h, surfMat(finish, 'matte'), 0.002);
  base.castShadow = false;
  const inset = Math.min(0.1, Math.min(w, d) * 0.07);
  const bandT = Math.max(0.012, inset * 0.35);
  const innerW = w - (inset + bandT) * 2;
  const innerD = d - (inset + bandT) * 2;
  if (innerW > 0.05 && innerD > 0.05) {
    const band = prism(
      g,
      roundedRectPoly(w - inset * 2, d - inset * 2, r),
      0.0015,
      surfMat(finish, 'matte', 0.82),
      0.002 + h,
      [roundedRectPoly(innerW, innerD, r)]
    );
    band.castShadow = false;
  }
};

/* ---------------- office ---------------- */

/** seat height above floor, and the star-base arm thickness */
const CHAIR_SEAT_H = 0.47;
const CHAIR_BASE_H = 0.045;

const officeChair: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  const steel = steelMat();
  const dark = matte('#26251f');
  const armLen = Math.min(w, d) / 2 - 0.02;
  // 5-star base: flat spokes fanning out evenly, one castor at each tip
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    const arm = box(g, armLen, CHAIR_BASE_H, 0.05, dark, 0, 0, 0);
    arm.position.set((Math.cos(a) * armLen) / 2, CHAIR_BASE_H / 2, (Math.sin(a) * armLen) / 2);
    arm.rotation.y = -a;
    cyl(g, 0.02, 0.03, dark, Math.cos(a) * armLen, 0, Math.sin(a) * armLen);
  }
  // steel gas column from the base to the seat pan
  const colH = CHAIR_SEAT_H - CHAIR_BASE_H - 0.03;
  cyl(g, 0.024, colH, steel, 0, CHAIR_BASE_H, 0);
  // padded seat
  box(g, w * 0.82, 0.08, d * 0.78, surfMat(finish), 0, CHAIR_SEAT_H, 0);
  // reclined backrest
  const backH = Math.max(0.28, h - CHAIR_SEAT_H - 0.08);
  const back = box(
    g,
    w * 0.68,
    backH,
    0.06,
    surfMat(finish),
    0,
    CHAIR_SEAT_H + 0.08,
    -d / 2 + 0.05
  );
  back.rotation.x = 0.1;
};

/* ---------------- furniture ---------------- */

const table: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  box(g, w, 0.04, d, surfMat(finish, 'wood'), 0, h - 0.04, 0);
  const leg = surfMat(finish, 'wood', 0.85);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    cyl(g, 0.025, h - 0.04, leg, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08));
  }
};

const chair: Builder = (g, { item, finish }) => {
  const { w, d, h } = item;
  const seatH = 0.46;
  const mat = surfMat(finish);
  const legMat = wood('#a8895e');
  box(g, w - 0.04, 0.035, d - 0.06, mat, 0, seatH, 0.02);
  const back = box(g, w - 0.06, h - seatH - 0.05, 0.03, mat, 0, seatH + 0.04, -d / 2 + 0.035);
  back.rotation.x = 0.08;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const l = cyl(g, 0.014, seatH, legMat, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.06));
    l.rotation.z = sx * -0.06;
    l.rotation.x = sz * 0.06;
  }
};

/** A plain wooden slab — used freely as tabletop, shelf, board or riser. */
const woodPlane: Builder = (g, { item, finish }) => {
  box(g, item.w, item.h, item.d, surfMat(finish, 'wood'), 0, 0, 0);
};

const stool: Builder = (g, { item, finish }) => {
  const { w, h } = item;
  cyl(g, w / 2, 0.045, surfMat(finish, 'wood'), 0, h - 0.045, 0);
  const legMat = matte('#2a2926');
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const l = cyl(
      g,
      0.012,
      h - 0.04,
      legMat,
      Math.cos(a) * (w / 2 - 0.05),
      0,
      Math.sin(a) * (w / 2 - 0.05)
    );
    l.rotation.z = Math.cos(a) * 0.12;
    l.rotation.x = -Math.sin(a) * 0.12;
  }
};

/* ---------------- lighting fixtures ---------------- */

const pendant: Builder = (g, { item, room, finish }) => {
  const { w, h } = item;
  const cordLen = Math.max(0.05, room.wallHeight - item.elevation - h);
  const black = matte('#1c1b19');
  cyl(g, 0.006, cordLen, black, 0, h, 0);
  const shadeMesh = cyl(g, w / 2, h * 0.75, surfMat(finish), 0, h * 0.25, 0, w / 6);
  shadeMesh.castShadow = false;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    stampMaterial(
      new THREE.MeshStandardMaterial({
        color: '#fff6e0',
        emissive: '#ffd9a0',
        emissiveIntensity: 1.6,
      }),
      { kind: 'product', product: 'bulb' }
    )
  );
  bulb.position.y = h * 0.22;
  bulb.userData.bulb = true;
  g.add(bulb);
};

const spot: Builder = (g, { item, finish }) => {
  cyl(g, item.w / 2, 0.02, surfMat(finish), 0, 0.02, 0);
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(item.w / 2 - 0.02, item.w / 2 - 0.02, 0.008, 20),
    stampMaterial(
      new THREE.MeshStandardMaterial({
        color: '#fff8e6',
        emissive: '#ffe8b8',
        emissiveIntensity: 1.4,
      }),
      { kind: 'product', product: 'bulb' }
    )
  );
  lens.position.y = 0.012;
  lens.userData.bulb = true;
  g.add(lens);
};

const strip: Builder = (g, { item }) => {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(item.w, 0.018, 0.035),
    stampMaterial(
      new THREE.MeshStandardMaterial({
        color: '#fff4da',
        emissive: '#ffce7d',
        emissiveIntensity: 1.8,
      }),
      { kind: 'product', product: 'bulb' }
    )
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

// EU Type E (CEE 7/5, Slovak) socket: round recessed well with two round pin
// holes and a protruding earth pin. `gangs` sockets are laid evenly across the
// faceplate width so the mesh stays correct for any width/gang combination.
const outlet: Builder = (g, { item }) => {
  const gangs = Math.max(1, Math.min(4, Math.round(item.params?.gangs ?? 1)));
  const back = -item.d / 2;
  const cy = item.h / 2; // vertical centre in local space
  // faceplate
  box(g, item.w, item.h, 0.016, matte('#f4f3ef'), 0, 0, back + 0.008);
  const bossMat = matte('#eceae4');
  const wellMat = matte('#26251f');
  const pinMat = matte('#111111');
  const earthMat = steelMat();
  const pitch = item.w / gangs;
  const r = Math.min(pitch, item.h) * 0.4; // socket radius — always fits the box
  for (let i = 0; i < gangs; i++) {
    const cx = -item.w / 2 + pitch * (i + 0.5);
    // raised round socket boss
    const boss = cyl(g, r, 0.01, bossMat, cx, cy - 0.005, back + 0.016);
    boss.rotation.x = Math.PI / 2;
    // dark recessed well on the boss face
    const well = cyl(g, r * 0.74, 0.006, wellMat, cx, cy - 0.003, back + 0.022);
    well.rotation.x = Math.PI / 2;
    // two round plug holes
    for (const sx of [-1, 1]) {
      const hole = cyl(g, r * 0.13, 0.014, pinMat, cx + sx * r * 0.4, cy, back + 0.02);
      hole.rotation.x = Math.PI / 2;
    }
    // protruding male earth pin (the distinctive Type E feature)
    const earth = cyl(g, r * 0.1, 0.014, earthMat, cx, cy + r * 0.42, back + 0.026);
    earth.rotation.x = Math.PI / 2;
  }
};

/* ---------------- custom parts (Part Studio) ---------------- */

const custom: Builder = (g, { item, part, design, host, finish }) => {
  if (part) buildCustomPart(g, item, part, design, host);
  else box(g, item.w, item.h, item.d, surfMat(finish), 0, 0, 0);
};

/* ---------------- registry ---------------- */

/**
 * Set dressing. ONE builder for the whole family: the def names a silhouette
 * form and src/view3d/decorMeshes.ts draws it, so a new mug is a catalog entry
 * and not a new kind. A def with no `decor` cannot reach here (decor.test.ts
 * pins that), but the fallback keeps the map total rather than throwing into
 * a render loop.
 */
const decor: Builder = (g, c) => {
  DECOR_FORMS[c.def.decor?.form ?? 'vessel'](g, { item: c.item, def: c.def, finish: c.finish });
};

const BUILDERS: Record<string, Builder> = {
  sink,
  hob,
  oven,
  dishwasher,
  fridge,
  hood,
  backsplash,
  bed,
  sofa,
  tv,
  rug,
  table,
  chair,
  stool,
  woodPlane,
  officeChair,
  pendant,
  spot,
  strip,
  water,
  outlet,
  decor,
  custom,
};

/** True when this kind has a real builder (not the silent box fallback). */
export function hasItemBuilder(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILDERS, kind);
}

export function buildItemGroup(
  item: Item,
  def: CatalogDef,
  design: Design,
  part?: CustomPartDef,
  host?: HostContext
): THREE.Group {
  const g = new THREE.Group();
  const room = styleOfItem(design, item);
  const finish = resolveFinish(design, item.color, item.material, item.materialRot);
  const builder = BUILDERS[def.kind];
  if (builder) builder(g, { item, def, design, room, part, host, finish });
  else box(g, item.w, item.h, item.d, surfMat(finish), 0, 0, 0);
  return g;
}
