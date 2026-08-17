import { describe, expect, it } from 'vitest';
import {
  applianceHosting,
  attachedPose,
  findHost,
  partOfDesign,
  syncAttachments,
} from '../../src/model/attach';
import type { CatalogDef } from '../../src/model/catalog';
import { cabinetFaceSize, partPanels } from '../../src/model/panels';
import { presetPart } from '../../src/model/presets';
import { emptyDesign, sanitizeDesign } from '../../src/model/store';
import type { CabinetPartDef, Design, Item } from '../../src/model/types';
import { walkZones } from '../../src/model/zones';

/** a minimal counter-mount appliance def (the real ones land with the catalog cut) */
const SINK_DEF: CatalogDef = {
  id: 'appl-sink-test',
  kind: 'sink',
  label: 'Sink',
  w: 0.56,
  d: 0.5,
  h: 0.2,
  elevation: 0.9,
  color: '#ccc',
  appliance: { mount: 'counter', cutout: { w: 0.5, d: 0.4 } },
};

const OVEN_DEF: CatalogDef = {
  id: 'appl-oven-test',
  kind: 'oven',
  label: 'Oven',
  w: 0.56,
  d: 0.55,
  h: 0.58,
  elevation: 0,
  color: '#222',
  appliance: { mount: 'zone', niche: { minW: 0.5, minH: 0.55 } },
};

function baseItem(defId: string, x: number, y: number, rotation = 0): Item {
  const part = presetPart(defId);
  return {
    id: `i_${defId}_${x}_${y}`,
    defId,
    x,
    y,
    rotation,
    w: part?.w ?? 0.6,
    d: part?.d ?? 0.6,
    h: part?.h ?? 0.9,
    elevation: part?.elevation ?? 0,
    color: '#8a9683',
  };
}

/** tall cabinet part with one appliance niche above a door */
function towerPart(): CabinetPartDef {
  return {
    id: 'tower-test',
    name: 'Tower',
    type: 'cabinet',
    w: 0.6,
    d: 0.6,
    h: 2.2,
    elevation: 0,
    color: '#8a9683',
    accentColor: '#c9a87c',
    footprint: { kind: 'rect' },
    plinth: true,
    worktop: false,
    face: {
      kind: 'split',
      dir: 'h',
      weights: [0.4, 0.3, 0.3],
      children: [
        { kind: 'leaf', fill: 'door' },
        { kind: 'leaf', fill: 'appliance' },
        { kind: 'leaf', fill: 'door' },
      ],
    },
  };
}

function designWith(items: Item[], parts: CabinetPartDef[] = []): Design {
  const d = emptyDesign();
  d.items = items;
  d.customParts = [...d.customParts, ...parts];
  return d;
}

describe('counter attachments', () => {
  it('derives the world pose from a host-local anchor, following rotation', () => {
    const host = baseItem('base-cabinet', 2, 1, Math.PI / 2);
    const sink: Item = { ...baseItem('base-cabinet', 0, 0), id: 'sink1', defId: SINK_DEF.id };
    sink.attach = { kind: 'counter', hostId: host.id, u: 0.1, v: 0.05 };
    const d = designWith([host, sink]);
    const pose = attachedPose(d, sink)!;
    // u along the rotated width axis (cos, sin) = (0, 1); v along (−sin, cos) = (−1, 0)
    expect(pose.x).toBeCloseTo(2 - 0.05);
    expect(pose.y).toBeCloseTo(1 + 0.1);
    expect(pose.rotation).toBeCloseTo(Math.PI / 2);
    expect(pose.elevation).toBeCloseTo(host.elevation + host.h);
  });

  it('syncAttachments moves the appliance with its host and detaches orphans', () => {
    const host = baseItem('base-cabinet', 1, 1);
    const sink: Item = { ...baseItem('base-cabinet', 0, 0), id: 'sink1' };
    sink.attach = { kind: 'counter', hostId: host.id, u: 0, v: 0 };
    const d = designWith([host, sink]);
    syncAttachments(d);
    expect(sink.x).toBeCloseTo(1);
    expect(sink.elevation).toBeCloseTo(0.9);
    host.x = 3;
    syncAttachments(d);
    expect(sink.x).toBeCloseTo(3);
    // host gone → detach in place, keep the cached pose
    d.items = d.items.filter((i) => i.id !== host.id);
    syncAttachments(d);
    expect(sink.attach).toBeUndefined();
    expect(sink.x).toBeCloseTo(3);
  });

  it('findHost snaps onto worktop-bearing cabinets only, within reach', () => {
    const host = baseItem('base-cabinet', 1, 1); // preset: worktop true
    const wall = baseItem('wall-cabinet', 3, 1); // preset: worktop false
    const d = designWith([host, wall]);
    const hit = findHost(d, SINK_DEF, { x: 1.1, y: 1.05 }, null)!;
    expect(hit.hostId).toBe(host.id);
    if (hit.attach.kind === 'counter') {
      expect(hit.attach.u).toBeCloseTo(0.1);
      expect(hit.attach.v).toBeCloseTo(0.05);
    } else {
      throw new Error('expected counter attach');
    }
    expect(findHost(d, SINK_DEF, { x: 3, y: 1 }, null)).toBeNull(); // no worktop
    expect(findHost(d, SINK_DEF, { x: 1, y: 2.5 }, null)).toBeNull(); // out of reach
  });
});

describe('zone attachments', () => {
  it('pose + size come from the appliance niche rect (walkZones truth)', () => {
    const part = towerPart();
    const host = { ...baseItem('base-cabinet', 1, 1), defId: part.id, h: 2.2 };
    const oven: Item = { ...baseItem('base-cabinet', 0, 0), id: 'oven1', defId: OVEN_DEF.id };
    oven.attach = { kind: 'zone', hostId: host.id, path: [1] };
    const d = designWith([host, oven], [part]);
    const scaled = { ...part, w: host.w, d: host.d, h: host.h, elevation: host.elevation };
    const { faceW, faceH } = cabinetFaceSize(scaled);
    const rect = walkZones(part.face, faceW, faceH).find((r) => r.path.join() === '1')!;
    const pose = attachedPose(d, oven)!;
    expect(pose.elevation).toBeCloseTo(0.1 + rect.y + 0.002); // plinth + rect.y + GAP/2
    expect(pose.w).toBeCloseTo(rect.w - 0.008);
    expect(pose.h).toBeCloseTo(rect.h - 0.004);
    syncAttachments(d);
    expect(oven.w).toBeCloseTo(rect.w - 0.008);
  });

  it('hosting map records occupancy; findHost skips claimed niches', () => {
    const part = towerPart();
    const host = { ...baseItem('base-cabinet', 1, 1), defId: part.id, h: 2.2 };
    const oven: Item = { ...baseItem('base-cabinet', 0, 0), id: 'oven1', defId: OVEN_DEF.id };
    oven.attach = { kind: 'zone', hostId: host.id, path: [1] };
    const d = designWith([host, oven], [part]);
    const hosting = applianceHosting(d);
    expect(hosting.get(host.id)?.occupiedZones.has('1')).toBe(true);
    // the only niche is taken → nothing to offer a second oven
    expect(findHost(d, OVEN_DEF, { x: 1, y: 1 }, null)).toBeNull();
  });
});

describe('hosting cutouts in the panel list', () => {
  it('a cutout turns the host worktop into a prism with a hole', () => {
    const part = partOfDesign(emptyDesign(), 'base-cabinet')!;
    const dims = { w: 0.8, d: 0.6, h: 0.9, elevation: 0 };
    const plain = partPanels(part, dims).find((p) => p.role === 'worktop')!;
    expect(plain.shape.kind).toBe('box'); // no cutouts → unchanged
    const cut = partPanels(part, dims, { cutouts: [{ x: 0.05, y: 0, w: 0.5, d: 0.4 }] }).find(
      (p) => p.role === 'worktop'
    )!;
    if (cut.shape.kind !== 'prism') throw new Error('expected prism');
    expect(cut.shape.holes).toHaveLength(1);
    expect(cut.shape.holes![0][0].x).toBeCloseTo(0.05 - 0.25);
    // outline spans the overhang-extended slab
    const xs = cut.shape.outline.map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(0.8 / 2 + 0.01);
  });
});

describe('sanitizeDesign attachment gate', () => {
  it('drops malformed attaches and second zone claimants; syncs poses', () => {
    const part = towerPart();
    const host = { ...baseItem('base-cabinet', 1, 1), defId: part.id, h: 2.2 };
    const a: Item = { ...baseItem('base-cabinet', 0, 0), id: 'a1' };
    const b: Item = { ...baseItem('base-cabinet', 0, 0), id: 'b1' };
    const junk: Item = { ...baseItem('base-cabinet', 0, 0), id: 'c1' };
    a.attach = { kind: 'zone', hostId: host.id, path: [1] };
    b.attach = { kind: 'zone', hostId: host.id, path: [1] }; // duplicate claim
    junk.attach = { kind: 'counter', hostId: 'nope', u: 0, v: 0 };
    const raw = designWith([host, a, b, junk], [part]);
    const d = sanitizeDesign(JSON.parse(JSON.stringify(raw)))!;
    const [, sa, sb, sj] = d.items;
    expect(sa.attach).toBeTruthy();
    expect(sb.attach).toBeUndefined();
    expect(sj.attach).toBeUndefined();
    // synced: the surviving oven sits at the host's front
    expect(sa.x).toBeCloseTo(1);
  });
});

describe('Store lifecycle with attachments', () => {
  async function storeWith(): Promise<{
    store: import('../../src/model/store').Store;
    hostId: string;
    applId: string;
  }> {
    const { Store } = await import('../../src/model/store');
    const store = new Store(emptyDesign());
    const host = store.addItem(store.defOf('base-cabinet'), 1, 1);
    store.updateItem(host.id, { w: 0.8 }); // room for the cutout + rim around u=0.05
    const appl = store.addItem(store.defOf('appl-sink'), 1, 1);
    store.setAttachment(appl.id, { kind: 'counter', hostId: host.id, u: 0.05, v: 0 });
    store.commit();
    return { store, hostId: host.id, applId: appl.id };
  }

  it('dragging the host carries the appliance; nudging the appliance re-anchors', async () => {
    const { store, hostId, applId } = await storeWith();
    store.updateItem(hostId, { x: 2.5 });
    expect(store.itemById(applId)!.x).toBeCloseTo(2.55);
    // nudge the appliance itself: the anchor follows the new world position
    store.updateItem(applId, { x: 2.4 });
    const a = store.itemById(applId)!.attach;
    if (a?.kind !== 'counter') throw new Error('expected counter attach');
    expect(a.u).toBeCloseTo(-0.1);
    expect(store.itemById(applId)!.elevation).toBeCloseTo(0.9);
  });

  it('deleting the host cascades; one undo restores both', async () => {
    const { store, hostId, applId } = await storeWith();
    store.deleteItem(hostId);
    store.commit();
    expect(store.itemById(hostId)).toBeUndefined();
    expect(store.itemById(applId)).toBeUndefined();
    store.undo();
    expect(store.itemById(hostId)).toBeTruthy();
    expect(store.itemById(applId)?.attach).toBeTruthy();
  });

  it('deleting a custom part cascades to appliances on its instances', async () => {
    const { store, hostId, applId } = await storeWith();
    const fork = store.forkPartForItem(hostId)!; // host becomes a design-local custom part
    store.commit();
    store.deleteCustomPart(fork.id);
    store.commit();
    expect(store.itemById(hostId)).toBeUndefined();
    expect(store.itemById(applId)).toBeUndefined(); // mounted sink went with it
  });

  it('duplicating the host rehomes copies of its appliances', async () => {
    const { store, hostId } = await storeWith();
    const copy = store.duplicateItem(hostId)!;
    const kids = store.design.items.filter((i) => i.attach && i.attach.hostId === copy.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].x).toBeCloseTo(copy.x + 0.05);
  });

  it('editing the host part to drop its worktop detaches the appliance', async () => {
    const { store, hostId, applId } = await storeWith();
    const fork = store.forkPartForItem(hostId)!;
    expect(store.itemById(applId)!.attach).toBeTruthy(); // fork keeps the worktop
    const noTop = JSON.parse(JSON.stringify(fork));
    noTop.worktop = false;
    store.upsertCustomPart(noTop);
    expect(store.itemById(applId)!.attach).toBeUndefined();
  });
});
