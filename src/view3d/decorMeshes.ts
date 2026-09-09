import * as THREE from 'three';
import type { CatalogDef, DecorForm } from '../model/catalog';
import type { Item, Point } from '../model/types';
import {
  box,
  cyl,
  lathe,
  matte,
  shade,
  softSlab,
  sphere,
  steelMat,
  surfMat,
  torus,
  type Finish,
} from './meshKit';

/**
 * Set dressing — the procedural meshes behind the `decor` item kind.
 *
 * Split out of itemMeshes.ts the way partMeshes.ts was: these are eight
 * silhouette FAMILIES, not eight kinds, and the def picks one plus a handful
 * of numbers. That is what keeps a catalog of two dozen mugs, jars, books and
 * plants from becoming two dozen builders.
 *
 * Local space is itemMeshes.ts's: x = width, y = up with 0 at the item's
 * bottom, z = depth with the back at −d/2.
 *
 * TWO RULES keep test/unit/materialStamping.test.ts green, and both are easy
 * to break by accident:
 *  1. mint materials ONLY through meshKit (`matte`/`wood`/`surfMat`/
 *     `steelMat`/`applianceGlass`). A bare `new THREE.MeshStandardMaterial`
 *     is exactly the unstamped case that sweep exists to catch.
 *  2. never mutate a material's colour after minting — pass `shade(hex, f)`
 *     in, or use `surfMat(fin, fallback, tint)`, which re-stamps. A post-hoc
 *     `m.color.multiplyScalar` drifts the stamped name from the colour.
 */

export interface DecorCtx {
  item: Item;
  def: CatalogDef;
  finish: Finish;
}

export type DecorBuilder = (g: THREE.Group, c: DecorCtx) => void;

/* ---------------- shared helpers ---------------- */

/**
 * A param, clamped to its own def's range.
 *
 * `Item.params` is NOT sanitised by `sanitizeDesign` and NOT clamped by
 * `setItemParam`, so a hand-edited or stale file can hand a builder any
 * number at all. Every count that drives a loop goes through here — a
 * "books: 40000" would otherwise be a mesh bomb, and builders.test.ts
 * instantiates every def at its min and max besides.
 */
function param(c: DecorCtx, key: string, fallback: number): number {
  const spec = c.def.params?.find((p) => p.key === key);
  // no spec = the def does not offer this knob at all, so there is no range to
  // clamp INTO. Clamping to an invented one is how a 0-default param (a
  // chopping board's absent picture mount) silently came back as 1.
  if (!spec) return fallback;
  const raw = c.item.params?.[key];
  const v = Number.isFinite(raw) ? (raw as number) : spec.def;
  return Math.max(spec.min, Math.min(spec.max, Math.round(v)));
}

/**
 * Deterministic jitter. A stack of books must look casual and be the SAME
 * casual on every rebuild — the mesh layer is rebuilt on every structural
 * notify, so `Math.random` here would make the scene twitch on every edit and
 * make renders unreproducible. Seeded off the item id instead.
 */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Profile of a body of revolution, as `(radius, height)` stations. */
const profile = (pts: [number, number][]): Point[] => pts.map(([x, y]) => ({ x, y }));

/* ---------------- forms ---------------- */

/**
 * A lathed body: kettle, jar, canister, vase, bottle. `params.neck` pinches
 * the top, which is the whole difference between a canister and a bottle.
 */
const vessel: DecorBuilder = (g, c) => {
  const { w, h } = c.item;
  const r = w / 2;
  const neck = param(c, 'neck', 10) / 10; // 1.0 = straight sided, 0.2 = bottle
  const mat = surfMat(c.finish);
  const body = profile([
    [0, 0],
    [r * 0.94, 0],
    [r, h * 0.08],
    [r, h * 0.62],
    [r * (0.55 + 0.45 * neck), h * 0.8],
    [r * (0.3 + 0.7 * neck), h * 0.94],
    [r * (0.3 + 0.7 * neck) * 0.86, h],
  ]);
  lathe(g, body, mat, 0, 0, 0);
  // a lid disc reads as a lid at any size, and closes the open lathe top
  cyl(g, r * (0.32 + 0.68 * neck), h * 0.03, surfMat(c.finish, 'matte', 0.8), 0, h, 0);
  if (neck > 0.85) {
    // wide-mouthed: a handle loop off the side, which is what makes it a kettle
    const hoop = torus(g, r * 0.42, r * 0.09, steelMat(), r * 0.98, h * 0.55, 0);
    hoop.rotation.set(0, 0, Math.PI / 2);
  }
};

/** A shallow dish, optionally heaped with contents (the fruit bowl). */
const bowl: DecorBuilder = (g, c) => {
  const { w, h } = c.item;
  const r = w / 2;
  const fill = param(c, 'fill', 5);
  lathe(
    g,
    profile([
      [r * 0.42, 0],
      [r * 0.5, h * 0.06],
      [r * 0.86, h * 0.5],
      [r, h],
      [r * 0.94, h],
      [r * 0.8, h * 0.5],
      [r * 0.4, h * 0.1],
    ]),
    surfMat(c.finish),
    0,
    0,
    0
  );
  if (fill <= 0) return;
  const accent = c.item.accentColor ?? '#c96f4a';
  const rand = rng(c.item.id);
  const fr = Math.min(r * 0.3, h * 0.55);
  for (let i = 0; i < fill; i++) {
    const a = (i / fill) * Math.PI * 2 + rand();
    const rr = r * 0.42 * Math.sqrt(rand());
    sphere(
      g,
      fr * (0.78 + rand() * 0.34),
      matte(shade(accent, 0.82 + rand() * 0.36)),
      Math.cos(a) * rr,
      h * 0.55 + rand() * h * 0.12,
      Math.sin(a) * rr
    );
  }
};

/** A jittered pile of slabs — books lying flat, magazines, folded boards. */
const stack: DecorBuilder = (g, c) => {
  const { w, d, h } = c.item;
  const n = param(c, 'count', 4);
  const rand = rng(c.item.id);
  const t = h / n;
  const accent = c.item.accentColor;
  for (let i = 0; i < n; i++) {
    // each slab a little smaller and a little askew: a stack, not a block
    const sw = w * (0.86 + rand() * 0.14);
    const sd = d * (0.86 + rand() * 0.14);
    const mat = surfMat(
      accent && i % 2 === 1 ? { ...c.finish, color: accent } : c.finish,
      'matte',
      0.86 + rand() * 0.28
    );
    const m = box(
      g,
      sw,
      t * 0.86,
      sd,
      mat,
      (rand() - 0.5) * w * 0.1,
      i * t,
      (rand() - 0.5) * d * 0.1
    );
    m.rotation.y = (rand() - 0.5) * 0.16;
  }
};

/** A tapered pot under a foliage mass. */
const plant: DecorBuilder = (g, c) => {
  const { w, h } = c.item;
  const potH = h * param(c, 'pot', 4) * 0.1;
  const r = w / 2;
  const potR = Math.min(r * 0.9, potH * 0.95);
  // a frustum: cyl's trailing rTop is what a `cone` primitive would duplicate
  cyl(g, potR * 0.72, potH, surfMat(c.finish), 0, 0, 0, potR);
  torus(g, potR * 0.97, potR * 0.06, surfMat(c.finish, 'matte', 0.88), 0, potH - potR * 0.12, 0);
  // soil, so the pot never reads as empty from above
  cyl(g, potR * 0.9, 0.006, matte('#3a2f27'), 0, potH - 0.008, 0);

  const leaf = matte('#4e7a4a');
  const stem = matte('#5c7f43');
  const bushes = param(c, 'leaves', 5);
  const rand = rng(c.item.id);
  const canopy = h - potH;
  for (let i = 0; i < bushes; i++) {
    const a = (i / bushes) * Math.PI * 2 + rand() * 0.6;
    const lean = r * (0.42 + rand() * 0.62);
    // foliage starts LOW, overlapping the rim: a houseplant bushes out of its
    // pot, where a canopy floated up a bare stem reads as a lollipop tree
    const top = potH + canopy * (0.2 + rand() * 0.5);
    const rod = cyl(g, 0.008, top - potH, stem, 0, potH * 0.9, 0);
    rod.rotation.set(Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42);
    sphere(
      g,
      canopy * (0.26 + rand() * 0.16),
      matte(shade('#4e7a4a', 0.8 + rand() * 0.4)),
      Math.cos(a) * lean,
      top - canopy * 0.16,
      Math.sin(a) * lean,
      0.72
    );
  }
  sphere(g, canopy * 0.3, leaf, 0, potH + canopy * 0.34, 0, 0.76);
};

/** An open rod lattice: dish rack, wire basket, utensil crock. */
const rack: DecorBuilder = (g, c) => {
  const { w, d, h } = c.item;
  const mat = steelMat();
  const t = 0.005;
  const bars = param(c, 'bars', 7);
  // frame: four uprights and a rim
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    cyl(g, t, h, mat, (sx * (w / 2 - t)) as number, 0, (sz * (d / 2 - t)) as number);
  }
  for (const y of [h * 0.08, h - t]) {
    box(g, w - t * 2, t * 1.6, t * 1.6, mat, 0, y, -d / 2 + t);
    box(g, w - t * 2, t * 1.6, t * 1.6, mat, 0, y, d / 2 - t);
    box(g, t * 1.6, t * 1.6, d - t * 2, mat, -w / 2 + t, y, 0);
    box(g, t * 1.6, t * 1.6, d - t * 2, mat, w / 2 - t, y, 0);
  }
  // the tines that make it a rack rather than a box
  for (let i = 0; i < bars; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / bars;
    const rod = cyl(g, t * 0.8, d - t * 3, mat, x, h * 0.1, -d / 2 + t * 1.5);
    rod.rotation.x = Math.PI / 2;
  }
};

/** Soft folded textile: tea towel, throw, cushion. Never casts a hard shadow. */
const cloth: DecorBuilder = (g, c) => {
  const { w, d, h } = c.item;
  const folds = param(c, 'folds', 3);
  const rand = rng(c.item.id);
  const layer = h / folds;
  for (let i = 0; i < folds; i++) {
    const m = softSlab(
      g,
      w * (0.9 + rand() * 0.12),
      d * (0.9 + rand() * 0.12),
      layer * 0.92,
      surfMat(c.finish, 'matte', 0.9 + rand() * 0.2),
      i * layer,
      (rand() - 0.5) * w * 0.06,
      (rand() - 0.5) * d * 0.06,
      Math.min(w, d) * 0.18
    );
    m.rotation.y = (rand() - 0.5) * 0.12;
    // a folded towel has no crisp edge to cast: soften the contact shadow
    m.castShadow = false;
  }
};

/**
 * A thin slab standing on its long edge, leaning back: frame, tray, board.
 *
 * The `mount` param is what separates the three. A picture frame has a mount
 * inset all round; a chopping board and a tray are solid, and drawing them
 * with one made every board on every worktop read as a framed photograph.
 */
const frame: DecorBuilder = (g, c) => {
  const { w, d, h } = c.item;
  const t = Math.min(d * 0.5, 0.018);
  const lean = param(c, 'lean', 8) / 100; // radians of backward tilt
  const holder = new THREE.Group();
  holder.rotation.x = -lean;
  g.add(holder);
  box(holder, w, h, t, surfMat(c.finish, 'wood'), 0, 0, -d / 2 + t);
  if (param(c, 'mount', 0) <= 0) return;
  const inset = Math.min(w, h) * 0.12;
  box(
    holder,
    w - inset * 2,
    h - inset * 2,
    t * 0.4,
    surfMat(c.item.accentColor ?? '#e8e3d8', 'matte'),
    0,
    inset,
    -d / 2 + t * 1.6
  );
};

/** A tapered open box with a rim: crate, storage box, laundry basket. */
const basket: DecorBuilder = (g, c) => {
  const { w, d, h } = c.item;
  const t = 0.012;
  const taper = param(c, 'taper', 1) / 10; // how much narrower the base is
  const mat = surfMat(c.finish, 'wood');
  const base = 1 - taper;
  box(g, w * base, t, d * base, mat, 0, 0, 0);
  // four leaning walls, which is what separates a basket from a box
  const wall = (sx: number, sz: number): void => {
    const long = sz !== 0;
    const m = box(g, long ? w : t, h, long ? t : d, mat, (sx * w) / 2, 0, (sz * d) / 2);
    m.position.y = h / 2;
    if (long) m.rotation.x = -sz * taper * 0.8;
    else m.rotation.z = sx * taper * 0.8;
  };
  wall(0, -1);
  wall(0, 1);
  wall(-1, 0);
  wall(1, 0);
  // rim
  box(g, w + t, t * 1.4, t * 1.6, surfMat(c.finish, 'wood', 0.88), 0, h - t, -d / 2);
  box(g, w + t, t * 1.4, t * 1.6, surfMat(c.finish, 'wood', 0.88), 0, h - t, d / 2);
};

/**
 * Every form, by name. `decor.test.ts` asserts this covers `DecorForm`
 * exhaustively, so a new form fails the suite rather than silently falling
 * back to a box.
 */
export const DECOR_FORMS: Record<DecorForm, DecorBuilder> = {
  vessel,
  bowl,
  stack,
  plant,
  rack,
  cloth,
  frame,
  basket,
};
