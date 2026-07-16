import { catalogDef, hasCatalogDef, type CatalogDef } from './catalog';
import { clamp } from './geometry';
import { cabinetFaceSize, GAP } from './panels';
import { toCatalogDef } from './parts';
import { presetPart } from './presets';
import type { Attachment, CabinetPartDef, CustomPartDef, Design, Item, Point } from './types';
import { walkZones, type ZoneRect } from './zones';

/**
 * Appliance hosting — all pure model code. An appliance item stores a
 * HOST-LOCAL anchor (`item.attach`); its x/y/rotation/elevation stay the
 * authoritative world cache so every existing reader (plan, 3D, elevation,
 * snapping) keeps working untouched. syncAttachments recomputes the cache
 * whenever a host changes; applianceHosting collects the cutouts/occupied
 * niches a host's panel list needs. The manufacturing export runs the same
 * two calls the renderer does.
 */

/** minimum worktop material left around a cutout */
export const CUTOUT_RIM = 0.03;
/** how far a dragged appliance searches for a host */
export const HOST_REACH = 0.35;

/** A cutout in a host's worktop, host-local plan coords (+y = front). */
export interface WorktopCutout {
  x: number;
  y: number;
  w: number;
  d: number;
  itemId: string;
}

export interface HostContext {
  cutouts: WorktopCutout[];
  /** zone paths (joined with '-') already claimed by an appliance */
  occupiedZones: Set<string>;
}

/** Pure part resolution mirroring Store.partOf (design part shadows preset). */
export function partOfDesign(design: Design, defId: string): CustomPartDef | undefined {
  return design.customParts.find((p) => p.id === defId) ?? presetPart(defId);
}

/** Pure def resolution mirroring Store.defOf; null instead of throwing. */
export function defOfDesign(design: Design, defId: string): CatalogDef | null {
  const part = partOfDesign(design, defId);
  if (part) return toCatalogDef(part);
  return hasCatalogDef(defId) ? catalogDef(defId) : null;
}

const itemById = (design: Design, id: string): Item | undefined =>
  design.items.find((i) => i.id === id);

/** width axis = (cos r, sin r); front axis (+v) = (−sin r, cos r) in plan space */
function hostToWorld(host: Item, u: number, v: number): Point {
  const c = Math.cos(host.rotation);
  const s = Math.sin(host.rotation);
  return { x: host.x + u * c - v * s, y: host.y + u * s + v * c };
}

function worldToHost(host: Item, p: Point): { u: number; v: number } {
  const c = Math.cos(host.rotation);
  const s = Math.sin(host.rotation);
  const dx = p.x - host.x;
  const dy = p.y - host.y;
  return { u: dx * c + dy * s, v: -dx * s + dy * c };
}

/** the host part scaled to the instance's dimensions, for face math */
function hostFacePart(part: CabinetPartDef, host: Item): CabinetPartDef {
  return { ...part, w: host.w, d: host.d, h: host.h, elevation: host.elevation };
}

function plinthOffset(part: CabinetPartDef, host: Item): number {
  const wallMounted = host.elevation > 0.3;
  return !wallMounted && part.plinth ? 0.1 : 0;
}

/** the appliance zone rect (face-local) an attachment points at, or null */
function zoneRectOf(design: Design, attach: Extract<Attachment, { kind: 'zone' }>): {
  host: Item;
  part: CabinetPartDef;
  rect: ZoneRect;
  faceW: number;
  faceH: number;
} | null {
  const host = itemById(design, attach.hostId);
  const part = host && partOfDesign(design, host.defId);
  if (!host || !part || part.type !== 'cabinet') return null;
  const scaled = hostFacePart(part, host);
  const { faceW, faceH } = cabinetFaceSize(scaled);
  const key = attach.path.join(',');
  for (const r of walkZones(part.face, faceW, faceH)) {
    if (r.path.join(',') === key) {
      return r.leaf.fill === 'appliance' ? { host, part: scaled, rect: r, faceW, faceH } : null;
    }
  }
  return null;
}

export interface AttachedPose {
  x: number;
  y: number;
  rotation: number;
  elevation: number;
  /** zone mounts also size the appliance to its niche */
  w?: number;
  h?: number;
  d?: number;
}

/** World pose derived from a host-local anchor; null when it can't resolve. */
export function attachedPose(design: Design, it: Item): AttachedPose | null {
  const a = it.attach;
  if (!a) return null;
  if (a.kind === 'counter') {
    const host = itemById(design, a.hostId);
    if (!host || host.attach) return null; // hosts can't themselves be attached
    const part = partOfDesign(design, host.defId);
    if (!part || part.type !== 'cabinet' || !part.worktop) return null;
    const p = hostToWorld(host, a.u, a.v);
    return { x: p.x, y: p.y, rotation: host.rotation, elevation: host.elevation + host.h };
  }
  const z = zoneRectOf(design, a);
  if (!z) return null;
  const { host, part, rect } = z;
  const u = rect.x + rect.w / 2 - z.faceW / 2;
  // the appliance face sits flush with the host front
  const v = host.d / 2 - it.d / 2;
  const p = hostToWorld(host, u, v);
  return {
    x: p.x,
    y: p.y,
    rotation: host.rotation,
    elevation: host.elevation + plinthOffset(part, host) + rect.y + GAP / 2,
    w: Math.max(0.1, rect.w - GAP * 2),
    h: Math.max(0.1, rect.h - GAP),
  };
}

/**
 * Recompute every attached item's world-pose cache (and clamp counter anchors
 * inside the host worktop). Unresolvable attachments detach in place: the
 * item keeps its last world pose and becomes freestanding.
 */
export function syncAttachments(design: Design): void {
  for (const it of design.items) {
    if (!it.attach) continue;
    if (it.attach.kind === 'counter') {
      const host = itemById(design, it.attach.hostId);
      const def = defOfDesign(design, it.defId);
      if (host && def?.appliance?.cutout) {
        const cut = def.appliance.cutout;
        const maxU = host.w / 2 - cut.w / 2 - CUTOUT_RIM;
        const maxV = host.d / 2 - cut.d / 2 - CUTOUT_RIM;
        if (maxU >= 0) it.attach.u = clamp(it.attach.u, -maxU, maxU);
        if (maxV >= 0) it.attach.v = clamp(it.attach.v, -maxV, maxV);
      }
    }
    const pose = attachedPose(design, it);
    if (!pose) {
      delete it.attach; // detach-to-world at the cached pose
      continue;
    }
    it.x = pose.x;
    it.y = pose.y;
    it.rotation = pose.rotation;
    it.elevation = pose.elevation;
    if (pose.w !== undefined) it.w = pose.w;
    if (pose.h !== undefined) it.h = pose.h;
  }
}

/** Cutouts + occupied niches per host item id — feeds partPanels' HostContext. */
export function applianceHosting(design: Design): Map<string, HostContext> {
  const out = new Map<string, HostContext>();
  const ctx = (hostId: string): HostContext => {
    let c = out.get(hostId);
    if (!c) {
      c = { cutouts: [], occupiedZones: new Set() };
      out.set(hostId, c);
    }
    return c;
  };
  for (const it of design.items) {
    const a = it.attach;
    if (!a) continue;
    if (a.kind === 'zone') {
      ctx(a.hostId).occupiedZones.add(a.path.join('-'));
      continue;
    }
    const def = defOfDesign(design, it.defId);
    const cut = def?.appliance?.cutout;
    if (cut) {
      ctx(a.hostId).cutouts.push({ x: a.u, y: a.v, w: cut.w, d: cut.d, itemId: it.id });
    }
  }
  return out;
}

export interface HostHit {
  hostId: string;
  attach: Attachment;
}

/** Find a host for an armed/dragged appliance near plan point `p`. */
export function findHost(design: Design, def: CatalogDef, p: Point, excludeId: string | null): HostHit | null {
  const spec = def.appliance;
  if (!spec || (spec.mount !== 'counter' && spec.mount !== 'zone')) return null;
  const hosting = applianceHosting(design);
  let best: { hit: HostHit; dist: number } | null = null;
  for (const host of design.items) {
    if (host.id === excludeId || host.attach) continue;
    const part = partOfDesign(design, host.defId);
    if (!part || part.type !== 'cabinet') continue;
    const { u, v } = worldToHost(host, p);
    if (spec.mount === 'counter') {
      if (!part.worktop) continue;
      const du = Math.max(0, Math.abs(u) - host.w / 2);
      const dv = Math.max(0, Math.abs(v) - host.d / 2);
      const dist = Math.hypot(du, dv);
      if (dist > HOST_REACH) continue;
      if (!best || dist < best.dist) {
        best = { hit: { hostId: host.id, attach: { kind: 'counter', hostId: host.id, u, v } }, dist };
      }
      continue;
    }
    // zone mount: nearest FREE appliance niche that fits the product
    const scaled = hostFacePart(part, host);
    const { faceW, faceH } = cabinetFaceSize(scaled);
    const occupied = hosting.get(host.id)?.occupiedZones ?? new Set<string>();
    for (const r of walkZones(part.face, faceW, faceH)) {
      if (r.leaf.fill !== 'appliance' || occupied.has(r.path.join('-'))) continue;
      if (spec.niche && (r.w < spec.niche.minW || r.h < spec.niche.minH)) continue;
      const zc = hostToWorld(host, r.x + r.w / 2 - faceW / 2, host.d / 2);
      const dist = Math.hypot(zc.x - p.x, zc.y - p.y);
      if (dist > HOST_REACH + host.d) continue;
      if (!best || dist < best.dist) {
        best = { hit: { hostId: host.id, attach: { kind: 'zone', hostId: host.id, path: r.path } }, dist };
      }
    }
  }
  return best?.hit ?? null;
}

/** True when the attachment still physically works (cutout inside the rim, niche fits). */
export function attachValid(design: Design, it: Item): boolean {
  const a = it.attach;
  if (!a) return true;
  if (a.kind === 'counter') {
    const host = itemById(design, a.hostId);
    const part = host && partOfDesign(design, host.defId);
    if (!host || !part || part.type !== 'cabinet' || !part.worktop) return false;
    const def = defOfDesign(design, it.defId);
    const cut = def?.appliance?.cutout;
    if (!cut) return true;
    return (
      Math.abs(a.u) + cut.w / 2 + CUTOUT_RIM <= host.w / 2 + 1e-6 &&
      Math.abs(a.v) + cut.d / 2 + CUTOUT_RIM <= host.d / 2 + 1e-6
    );
  }
  const z = zoneRectOf(design, a);
  if (!z) return false;
  const def = defOfDesign(design, it.defId);
  const niche = def?.appliance?.niche;
  return !niche || (z.rect.w >= niche.minW && z.rect.h >= niche.minH);
}
