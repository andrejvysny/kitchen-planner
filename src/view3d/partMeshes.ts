import * as THREE from 'three';
import { partPanels, type HostContext, type Panel, type PanelMotion } from '../model/panels';
import type { CustomPartDef, Design, Item } from '../model/types';
import { resolveColor, resolveFinish } from '../model/variables';
import { box, counterFin, cyl, type Finish, GROOVE, matte, PLINTH_COLOR, prism, surfMat } from './meshKit';

/**
 * Custom parts render from their panel list (src/model/panels.ts) — this file
 * only turns panels into meshes and applies the visual language (materials,
 * routed grooves). Anything geometric belongs in the panel generator; the
 * open/closed POSE of a motion unit is cosmetic and applied here from the
 * ephemeral OpenFronts view state.
 */

/** how far a hinged door swings open (rad) */
export const OPEN_ANGLE = Math.PI * 0.55;
/** flaps (top/bottom hinges) open a little less so they read as flaps */
export const FLAP_ANGLE = Math.PI * 0.42;
/** per-frame lerp factor for the open/close animation */
const POSE_LERP = 0.18;

interface UnitData {
  motionUnit: string;
  kind: PanelMotion['kind'];
  side?: PanelMotion['side'];
  travel: number;
  /** closed-pose transform of the pivot group */
  baseX: number;
  baseZ: number;
  baseRotY: number;
  openT: number;
  targetT: number;
}

function panelMaterial(p: Panel, front: Finish, accentColor: string, counter: Finish): THREE.Material {
  if (p.slot === 'glass') {
    return new THREE.MeshStandardMaterial({
      color: '#bcd2d8',
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.35,
    });
  }
  // 'counter' panels follow the room worktop style (per-item override wins),
  // the item's PBR material paints the 'front' slot; accent/plinth stay flat
  const fin: Finish =
    p.slot === 'counter' || p.role === 'worktop'
      ? counter
      : p.slot === 'accent'
        ? { color: accentColor }
        : p.slot === 'plinth'
          ? { color: PLINTH_COLOR }
          : front;
  return surfMat(fin, p.finish === 'wood' ? 'wood' : 'matte', p.tint ?? 1);
}

function tag(o: THREE.Object3D, p: Panel): void {
  o.name = p.id;
  o.userData.role = p.role;
  if (p.boardId) o.userData.boardId = p.boardId;
}

function panelMesh(g: THREE.Group, p: Panel, front: Finish, accentColor: string, counter: Finish): void {
  const mat = panelMaterial(p, front, accentColor, counter);
  if (p.shape.kind === 'prism') {
    tag(prism(g, p.shape.outline, p.shape.h, mat, p.y, p.shape.holes), p);
    return;
  }
  if (p.shape.kind === 'cyl') {
    tag(cyl(g, p.shape.dia / 2, p.shape.h, mat, p.x, p.y, p.z), p);
    return;
  }
  const { w, h, d } = p.shape;
  const grooveAt = (host: THREE.Group, x: number, y: number, z: number): void => {
    if (!p.groove) return;
    const gy = p.groove === 'top' ? y + h - 0.012 : y;
    box(host, w, 0.012, d + 0.002, matte(GROOVE), x, gy, z - 0.002);
  };
  if (p.rotY) {
    const fg = new THREE.Group();
    fg.position.set(p.x, 0, p.z);
    fg.rotation.y = p.rotY;
    tag(fg, p);
    g.add(fg);
    box(fg, w, h, d, mat, 0, p.y, 0);
    grooveAt(fg, 0, p.y, 0);
    return;
  }
  tag(box(g, w, h, d, mat, p.x, p.y, p.z), p);
  grooveAt(g, p.x, p.y, p.z);
}

export function buildCustomPart(
  g: THREE.Group,
  item: Item,
  part: CustomPartDef,
  design: Design,
  ctx?: HostContext
): void {
  const dims = { w: item.w, d: item.d, h: item.h, elevation: item.elevation };
  // front + accent colour slots may hold design-variable refs — resolve them.
  // The per-instance accent override (item.accentColor) wins over the part's.
  const front: Finish = resolveFinish(design, item.color, item.material, item.materialRot);
  const accentColor = resolveColor(design, item.accentColor ?? part.accentColor);
  // worktops follow the room worktop style; the item's counterMaterial wins
  const counter = counterFin(design, design.room, item);
  const units = new Map<string, Panel[]>();
  for (const p of partPanels(part, dims, ctx)) {
    if (p.motion) {
      const list = units.get(p.motion.unit) ?? [];
      list.push(p);
      units.set(p.motion.unit, list);
    } else {
      panelMesh(g, p, front, accentColor, counter);
    }
  }
  for (const panels of units.values()) {
    motionUnit(g, panels, front, accentColor, counter);
  }
}

/**
 * Build one pivot group for a set of panels that move together (a door, or a
 * drawer front + its box). The group sits at the hinge line (or the unit's
 * reference point for slides) in its CLOSED pose; setFrontPoses/
 * stepFrontPoses rotate/translate it, so opening never rebuilds geometry.
 */
function motionUnit(g: THREE.Group, panels: Panel[], front: Finish, accentColor: string, counter: Finish): void {
  const ref = panels.find((p) => p.role === 'front') ?? panels[0];
  const m = ref.motion!;
  if (ref.shape.kind !== 'box') return; // motion panels are always boards
  const ry = ref.rotY;
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  // pivot: the hinge edge of the reference front (its ±w/2 along face-local x),
  // or the front's centre line for slides / horizontal hinges
  const lxPivot = m.kind === 'hinge' && m.side === 'left' ? -ref.shape.w / 2 : m.kind === 'hinge' && m.side === 'right' ? ref.shape.w / 2 : 0;
  const yPivot = m.kind === 'hinge' && m.side === 'top' ? ref.y + ref.shape.h : m.kind === 'hinge' && m.side === 'bottom' ? ref.y : 0;
  const px = ref.x + lxPivot * c;
  const pz = ref.z - lxPivot * s;
  const unit = new THREE.Group();
  unit.position.set(px, yPivot, pz);
  unit.rotation.y = ry;
  const data: UnitData = {
    motionUnit: m.unit,
    kind: m.kind,
    side: m.side,
    travel: m.travel ?? 0.3,
    baseX: px,
    baseZ: pz,
    baseRotY: ry,
    openT: 0,
    targetT: 0,
  };
  unit.userData = { ...unit.userData, ...data };
  g.add(unit);
  for (const p of panels) {
    if (p.shape.kind !== 'box') continue;
    // face-local offset of this panel relative to the pivot
    const dx = p.x - px;
    const dz = p.z - pz;
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const mat = panelMaterial(p, front, accentColor, counter);
    const { w, h, d } = p.shape;
    const mesh = box(unit, w, h, d, mat, lx, p.y - yPivot, lz);
    tag(mesh, p);
    if (p.groove) {
      const gy = p.groove === 'top' ? p.y - yPivot + h - 0.012 : p.y - yPivot;
      box(unit, w, 0.012, d + 0.002, matte(GROOVE), lx, gy, lz - 0.002);
    }
  }
}

/** All motion-unit pivot groups under an item group (for the pose pass). */
export function collectMotionUnits(root: THREE.Object3D): THREE.Group[] {
  const out: THREE.Group[] = [];
  root.traverse((o) => {
    if (o.userData.motionUnit) out.push(o as THREE.Group);
  });
  return out;
}

/** Set each unit's animation target from the view state. */
export function setFrontPoses(units: THREE.Group[], isOpen: (unit: string) => boolean, snap = false): void {
  for (const u of units) {
    const d = u.userData as UnitData;
    d.targetT = isOpen(d.motionUnit) ? 1 : 0;
    if (snap) d.openT = d.targetT;
  }
  if (snap) applyPoses(units);
}

/** Advance the open/close animation one frame. Returns true while moving. */
export function stepFrontPoses(units: THREE.Group[]): boolean {
  let moving = false;
  for (const u of units) {
    const d = u.userData as UnitData;
    if (Math.abs(d.targetT - d.openT) < 0.005) {
      if (d.openT !== d.targetT) {
        d.openT = d.targetT;
        applyPose(u, d);
      }
      continue;
    }
    d.openT += (d.targetT - d.openT) * POSE_LERP;
    applyPose(u, d);
    moving = true;
  }
  return moving;
}

function applyPoses(units: THREE.Group[]): void {
  for (const u of units) applyPose(u, u.userData as UnitData);
}

function applyPose(u: THREE.Group, d: UnitData): void {
  if (d.kind === 'slide') {
    // slide out along the face normal (+z in face-local space)
    const dist = d.travel * d.openT;
    u.position.x = d.baseX + Math.sin(d.baseRotY) * dist;
    u.position.z = d.baseZ + Math.cos(d.baseRotY) * dist;
    return;
  }
  if (d.side === 'top') {
    u.rotation.x = -FLAP_ANGLE * d.openT;
  } else if (d.side === 'bottom') {
    u.rotation.x = FLAP_ANGLE * d.openT;
  } else {
    const sign = d.side === 'right' ? 1 : -1;
    u.rotation.y = d.baseRotY + sign * OPEN_ANGLE * d.openT;
  }
}

/** Reset every unit to the closed pose (GLB export); returns a restore fn. */
export function withClosedPoses<T>(units: THREE.Group[], fn: () => T): T {
  const saved = units.map((u) => (u.userData as UnitData).openT);
  for (const u of units) {
    const d = u.userData as UnitData;
    d.openT = 0;
    applyPose(u, d);
  }
  try {
    return fn();
  } finally {
    units.forEach((u, i) => {
      const d = u.userData as UnitData;
      d.openT = saved[i];
      applyPose(u, d);
    });
  }
}
