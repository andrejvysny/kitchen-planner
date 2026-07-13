import { clamp } from './geometry';
import type { LeafZone, Zone, ZoneFill } from './types';

/**
 * Zone-tree math for cabinet faces. A face is recursively split into zones;
 * each leaf holds a fill (door, drawers, open niche...). Pure logic — the mesh
 * builder and the studio's zone canvas both lay out via walkZones, so what the
 * editor shows is exactly what gets built.
 */

export const MAX_LEAVES = 12;
export const MAX_DEPTH = 4;
export const MIN_FRAC = 0.08;

const FILLS: ZoneFill[] = ['door', 'doorPair', 'drawers', 'open', 'panel', 'glass'];

/** A leaf's rectangle in face-local coords: x from left, y up from face bottom. */
export interface ZoneRect {
  x: number;
  y: number;
  w: number;
  h: number;
  leaf: LeafZone;
  /** child indices from the root to this leaf */
  path: number[];
}

export function walkZones(root: Zone, w: number, h: number): ZoneRect[] {
  const out: ZoneRect[] = [];
  const visit = (z: Zone, x: number, y: number, zw: number, zh: number, path: number[]): void => {
    if (z.kind === 'leaf') {
      out.push({ x, y, w: zw, h: zh, leaf: z, path });
      return;
    }
    const total = z.weights.reduce((s, v) => s + v, 0) || 1;
    let off = 0;
    for (let i = 0; i < z.children.length; i++) {
      const frac = (z.weights[i] ?? 0) / total;
      if (z.dir === 'v') visit(z.children[i], x + off * zw, y, frac * zw, zh, [...path, i]);
      else visit(z.children[i], x, y + off * zh, zw, frac * zh, [...path, i]);
      off += frac;
    }
  };
  visit(root, 0, 0, w, h, []);
  return out;
}

export function zoneAtPath(root: Zone, path: number[]): Zone | null {
  let z: Zone = root;
  for (const i of path) {
    if (z.kind !== 'split' || !z.children[i]) return null;
    z = z.children[i];
  }
  return z;
}

export function zoneAtPoint(root: Zone, w: number, h: number, x: number, y: number): ZoneRect | null {
  for (const r of walkZones(root, w, h)) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

export function countLeaves(root: Zone): number {
  return root.kind === 'leaf' ? 1 : root.children.reduce((s, c) => s + countLeaves(c), 0);
}

function cloneZone(z: Zone): Zone {
  return JSON.parse(JSON.stringify(z)) as Zone;
}

/**
 * Split the leaf at `path` into `count` equal zones along `dir`. When the
 * parent already splits in the same direction the new zones become siblings,
 * keeping the tree shallow. Returns a new root (input untouched).
 */
export function splitZone(root: Zone, path: number[], dir: 'h' | 'v', count = 2): Zone {
  const next = cloneZone(root);
  const target = zoneAtPath(next, path);
  if (!target || target.kind !== 'leaf') return next;
  if (countLeaves(next) + count - 1 > MAX_LEAVES) return next;

  const parent = path.length ? (zoneAtPath(next, path.slice(0, -1)) as Zone) : null;
  const idx = path[path.length - 1];
  const pieces: Zone[] = Array.from({ length: count }, () => cloneZone(target));

  if (parent && parent.kind === 'split' && parent.dir === dir) {
    const w = parent.weights[idx] / count;
    parent.children.splice(idx, 1, ...pieces);
    parent.weights.splice(idx, 1, ...Array.from({ length: count }, () => w));
    return normalizeZones(next);
  }
  if (path.length + 1 > MAX_DEPTH) return next;
  const split: Zone = { kind: 'split', dir, weights: pieces.map(() => 1 / count), children: pieces };
  if (!parent) return normalizeZones(split);
  (parent as Extract<Zone, { kind: 'split' }>).children[idx] = split;
  return normalizeZones(next);
}

/** Collapse the split containing the leaf at `path` into that leaf. Returns a new root. */
export function mergeZone(root: Zone, path: number[]): Zone {
  if (!path.length) return cloneZone(root);
  const next = cloneZone(root);
  const leaf = zoneAtPath(next, path);
  const parent = zoneAtPath(next, path.slice(0, -1));
  if (!leaf || leaf.kind !== 'leaf' || !parent || parent.kind !== 'split') return next;
  if (path.length === 1) return normalizeZones(leaf);
  const gp = zoneAtPath(next, path.slice(0, -2)) as Extract<Zone, { kind: 'split' }>;
  gp.children[path[path.length - 2]] = leaf;
  return normalizeZones(next);
}

/**
 * Move the divider after child `divider` of the split at `path` so the cut
 * sits at fraction `frac` of the split's extent. Mutates in place (drag path).
 */
export function setDivider(root: Zone, path: number[], divider: number, frac: number): void {
  const split = zoneAtPath(root, path);
  if (!split || split.kind !== 'split' || divider < 0 || divider >= split.children.length - 1) return;
  const total = split.weights.reduce((s, v) => s + v, 0) || 1;
  const before = split.weights.slice(0, divider).reduce((s, v) => s + v, 0) / total;
  const pair = (split.weights[divider] + split.weights[divider + 1]) / total;
  if (pair < MIN_FRAC * 2) return;
  const cut = clamp(frac - before, MIN_FRAC, pair - MIN_FRAC);
  split.weights[divider] = cut * total;
  split.weights[divider + 1] = (pair - cut) * total;
}

/** Flatten same-direction nesting, renormalize weights, clamp counts, enforce caps. */
export function normalizeZones(root: Zone): Zone {
  const norm = (z: Zone, depth: number): Zone => {
    if (z.kind === 'leaf') {
      const leaf: LeafZone = { kind: 'leaf', fill: FILLS.includes(z.fill) ? z.fill : 'door' };
      if (leaf.fill === 'drawers') leaf.drawers = clamp(Math.round(z.drawers ?? 2), 1, 5);
      if (leaf.fill === 'open') leaf.shelves = clamp(Math.round(z.shelves ?? 1), 0, 4);
      return leaf;
    }
    if (depth >= MAX_DEPTH) return norm({ kind: 'leaf', fill: 'door' }, depth);
    const children: Zone[] = [];
    const weights: number[] = [];
    for (let i = 0; i < z.children.length; i++) {
      const c = norm(z.children[i], depth + 1);
      const w = Math.max(MIN_FRAC, Number.isFinite(z.weights[i]) ? z.weights[i] : 1);
      if (c.kind === 'split' && c.dir === z.dir) {
        const inner = c.weights.reduce((s, v) => s + v, 0) || 1;
        for (let j = 0; j < c.children.length; j++) {
          children.push(c.children[j]);
          weights.push((w * c.weights[j]) / inner);
        }
      } else {
        children.push(c);
        weights.push(w);
      }
    }
    if (children.length === 0) return { kind: 'leaf', fill: 'door' };
    if (children.length === 1) return children[0];
    const total = weights.reduce((s, v) => s + v, 0);
    return { kind: 'split', dir: z.dir === 'v' ? 'v' : 'h', weights: weights.map((w) => w / total), children };
  };
  let out = norm(root, 0);
  while (countLeaves(out) > MAX_LEAVES && out.kind === 'split') {
    out.children.pop();
    out.weights.pop();
    out = norm(out, 0);
  }
  return out;
}

/** Repair a zone tree parsed from storage; anything unusable becomes a single door. */
export function sanitizeZone(raw: unknown): Zone {
  const valid = (z: unknown, depth: number): boolean => {
    if (!z || typeof z !== 'object') return false;
    const o = z as Record<string, unknown>;
    if (o.kind === 'leaf') return true;
    if (o.kind !== 'split' || depth >= MAX_DEPTH) return false;
    if (!Array.isArray(o.children) || !Array.isArray(o.weights)) return false;
    if (o.children.length === 0 || o.children.length !== o.weights.length) return false;
    return o.children.every((c) => valid(c, depth + 1));
  };
  if (!valid(raw, 0)) return { kind: 'leaf', fill: 'door' };
  return normalizeZones(raw as Zone);
}
