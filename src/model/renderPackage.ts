/**
 * Render package — the single zip handed to the Blender worker. One artifact
 * beats three loose downloads: the worker takes one path on the command line
 * (`render/render.sh interior-render.zip out.png`), and a zip is trivial to
 * move between the browser, disk and a future job queue. Built with fflate
 * (~8 kB, synchronous `zipSync`) rather than a bigger streaming zip library —
 * everything here already lives in memory (a Design, a GLB Blob's bytes, a
 * manifest object), so sync suits it and keeps this module dependency-light.
 *
 * Pure: no DOM, no three.js. `buildRenderPackage` takes plain bytes/objects
 * and returns bytes: the same shape as buildBom / cutListCsv.
 */

import { strToU8, zipSync, type Zippable } from 'fflate';
import type { RenderManifest } from './renderManifest';
import type { Design } from './types';

/** Entry names inside the zip — shared with tests as the drift guard against
 *  renderManifest.ts's own `files.glb` / `files.design` literals. */
export const PACKAGE_FILES = {
  manifest: 'manifest.json',
  glb: 'scene.glb',
  design: 'design.json',
  readme: 'README.txt',
} as const;

/** Suggested download filename for the zip. */
export const PACKAGE_FILENAME = 'interior-render.zip';

const README = `Interior Planner — render package
==================================

This zip is the input to the Blender render worker. It contains:

  manifest.json  camera, sky, lights, window portals and material identities
  scene.glb      the modelled interior (geometry + canonical materials)
  design.json    the raw design, for reference / re-export

Render it with:

  render/render.sh interior-render.zip out.png --tier preview

See render/README.md for setup and the full CLI.
`;

/**
 * Zip the three artifacts + a README into one `Uint8Array`.
 *
 * `manifest.json` and `design.json` are pretty-printed UTF-8 at the zip
 * default compression (level 6) — small, worth shrinking. `scene.glb` is
 * stored at level 0: it is already a binary/float payload GLTFExporter wrote,
 * so deflating it burns time for negligible size back. `design` is the plain
 * `Design` object — never `store.exportJson()`, which inlines the (possibly
 * multi-MB) underlay photo as an extra `underlaySrc` field the Design itself
 * never carries — so a raw stringify is already photo-free.
 */
export function buildRenderPackage(input: {
  manifest: RenderManifest;
  glb: Uint8Array;
  design: Design;
}): Uint8Array {
  const files: Zippable = {
    [PACKAGE_FILES.manifest]: [
      strToU8(`${JSON.stringify(input.manifest, null, 2)}\n`),
      { level: 6 },
    ],
    [PACKAGE_FILES.glb]: [input.glb, { level: 0 }],
    [PACKAGE_FILES.design]: [strToU8(`${JSON.stringify(input.design, null, 2)}\n`), { level: 6 }],
    [PACKAGE_FILES.readme]: [strToU8(README), { level: 6 }],
  };
  return zipSync(files);
}
