import * as THREE from 'three';
import { partPanels, type Panel } from '../model/panels';
import type { CustomPartDef, Item, RoomStyle } from '../model/types';
import { box, cyl, type Finish, GROOVE, matte, PLINTH_COLOR, prism, surfMat } from './meshKit';

/**
 * Custom parts render from their panel list (src/model/panels.ts) — this file
 * only turns panels into meshes and applies the visual language (materials,
 * routed grooves). Anything geometric belongs in the panel generator.
 */

function panelMaterial(p: Panel, front: Finish, accentColor: string): THREE.Material {
  if (p.slot === 'glass') {
    return new THREE.MeshStandardMaterial({
      color: '#bcd2d8',
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.35,
    });
  }
  // the instance's PBR material paints the 'front' slot; accent/plinth stay flat colours
  const fin: Finish =
    p.slot === 'accent' ? { color: accentColor } : p.slot === 'plinth' ? { color: PLINTH_COLOR } : front;
  return surfMat(fin, p.finish === 'wood' ? 'wood' : 'matte', p.tint ?? 1);
}

function tag(o: THREE.Object3D, p: Panel): void {
  o.name = p.id;
  o.userData.role = p.role;
  if (p.boardId) o.userData.boardId = p.boardId;
}

function panelMesh(g: THREE.Group, p: Panel, front: Finish, accentColor: string): void {
  const mat = panelMaterial(p, front, accentColor);
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

export function buildCustomPart(g: THREE.Group, item: Item, part: CustomPartDef, _room: RoomStyle): void {
  const dims = { w: item.w, d: item.d, h: item.h, elevation: item.elevation };
  const front: Finish = { color: item.color, material: item.material };
  for (const p of partPanels(part, dims)) {
    panelMesh(g, p, front, part.accentColor);
  }
}
