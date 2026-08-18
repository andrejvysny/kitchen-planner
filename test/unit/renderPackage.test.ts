/**
 * Render package (src/model/renderPackage.ts) — round-trips a built zip
 * through fflate's `unzipSync` and asserts every entry survives byte- (or
 * value-) identical, plus the cross-check against renderManifest.ts's own
 * `files.glb` / `files.design` literals (see PACKAGE_FILES's doc comment).
 */

import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DESIGN_VERSION } from '../../src/model/migrate';
import { OAK } from '../../src/model/catalog';
import { buildRenderManifest, type ManifestInput } from '../../src/model/renderManifest';
import { buildRenderPackage, PACKAGE_FILENAME, PACKAGE_FILES } from '../../src/model/renderPackage';
import { defaultRoomStyle } from '../../src/model/rooms';
import type { Design, Item, Room, RoomStyle } from '../../src/model/types';

/* ---------------- fixtures (same shape as renderManifest.test.ts) ---------------- */

function room(id: string, pts: [number, number][], style: Partial<RoomStyle> = {}): Room {
  return {
    id,
    name: id,
    corners: pts.map(([x, y], i) => ({ id: `${id}-c${i}`, x, y })),
    style: { ...defaultRoomStyle(), ...style },
  };
}

const rect4x3 = (id = 'A'): Room =>
  room(id, [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]);

function item(over: Partial<Item> & Pick<Item, 'id' | 'defId'>): Item {
  return {
    x: 2,
    y: 1.5,
    rotation: 0,
    w: 0.6,
    d: 0.6,
    h: 0.9,
    elevation: 0,
    color: OAK,
    ...over,
  };
}

function mkDesign(): Design {
  return {
    version: DESIGN_VERSION,
    rooms: [rect4x3()],
    openings: [],
    items: [item({ id: 'it-cabinet', defId: 'base-cabinet', roomId: 'A' })],
    customParts: [],
    variables: [],
    scene: { sunAzimuth: 135, sunElevation: 35, brightness: 1, night: false },
  };
}

function mkInput(): ManifestInput {
  return {
    camera: {
      position: { x: 5, y: 1.6, z: 5 },
      target: { x: 2, y: 1, z: 1.5 },
      up: { x: 0, y: 1, z: 0 },
      fovYDeg: 50,
      viewportAspect: 1.7778,
      nearM: 0.05,
      farM: 120,
    },
    materials: [
      {
        name: 'kp:m:oak:c9a87c',
        kind: 'library',
        matId: 'oak',
        baseColorHex: OAK,
        rot: false,
        meshCount: 4,
      },
    ],
    render: { widthPx: 1920, heightPx: 1080, tier: 'preview', sensorFit: 'vertical' },
    appVersion: '0.0.0-test',
    now: new Date('2026-01-02T03:04:05.000Z'),
  };
}

/** Not a real GLB — just distinctive, non-trivial bytes to prove a byte-identical round trip. */
const FAKE_GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 1, 2, 3, 254, 255, 0, 128, 42]);

describe('buildRenderPackage', () => {
  it('zips exactly the four PACKAGE_FILES entries', () => {
    const design = mkDesign();
    const manifest = buildRenderManifest(design, mkInput());
    const zip = buildRenderPackage({ manifest, glb: FAKE_GLB, design });
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped).sort()).toEqual(Object.values(PACKAGE_FILES).sort());
  });

  it('writes a manifest.json that parses and agrees with renderManifest.ts on file names', () => {
    const design = mkDesign();
    const manifest = buildRenderManifest(design, mkInput());
    const zip = buildRenderPackage({ manifest, glb: FAKE_GLB, design });
    const unzipped = unzipSync(zip);
    const parsed = JSON.parse(
      new TextDecoder().decode(unzipped[PACKAGE_FILES.manifest])
    ) as typeof manifest;
    expect(parsed).toEqual(manifest);
    // drift guard: renderManifest.ts stamps `files.glb`/`files.design` with its
    // own internal literals — this pins them equal to PACKAGE_FILES's.
    expect(parsed.files.glb).toBe(PACKAGE_FILES.glb);
    expect(parsed.files.design).toBe(PACKAGE_FILES.design);
  });

  it('writes a design.json that parses, deep-equals the design, and carries no underlaySrc', () => {
    const design = mkDesign();
    const manifest = buildRenderManifest(design, mkInput());
    const zip = buildRenderPackage({ manifest, glb: FAKE_GLB, design });
    const unzipped = unzipSync(zip);
    const parsed = JSON.parse(new TextDecoder().decode(unzipped[PACKAGE_FILES.design])) as Design;
    expect(parsed).toEqual(design);
    expect('underlaySrc' in (parsed as unknown as Record<string, unknown>)).toBe(false);
  });

  it('carries scene.glb bytes byte-identical', () => {
    const design = mkDesign();
    const manifest = buildRenderManifest(design, mkInput());
    const zip = buildRenderPackage({ manifest, glb: FAKE_GLB, design });
    const unzipped = unzipSync(zip);
    expect(unzipped[PACKAGE_FILES.glb]).toEqual(FAKE_GLB);
  });

  it('writes a non-empty README.txt', () => {
    const design = mkDesign();
    const manifest = buildRenderManifest(design, mkInput());
    const zip = buildRenderPackage({ manifest, glb: FAKE_GLB, design });
    const unzipped = unzipSync(zip);
    const readme = new TextDecoder().decode(unzipped[PACKAGE_FILES.readme]);
    expect(readme.length).toBeGreaterThan(0);
    expect(readme).toContain('render.sh');
  });

  it('exposes a stable download filename', () => {
    expect(PACKAGE_FILENAME).toBe('interior-render.zip');
  });
});
