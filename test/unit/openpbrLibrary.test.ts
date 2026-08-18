/**
 * Data parity: `render/materials/openpbr.materials.json` (the worker's
 * OpenPBR library, source of truth for render/worker/kprender/openpbr_map.py)
 * against `src/model/materials.ts` (the app's own MATERIALS registry) and
 * `render/materials/textures.lock.json` (the pinned CC0 texture sets).
 *
 * Both JSON files are read as plain module imports — `resolveJsonModule` in
 * tsconfig.json types them, same as the golden-manifest import in
 * renderManifest.test.ts; no `node:fs` needed since this suite never writes
 * anything back (see that file's comment on why `fs` there goes through a
 * computed specifier — the repo carries no `@types/node`).
 */

import { describe, expect, it } from 'vitest';
import library from '../../render/materials/openpbr.materials.json';
import textureLock from '../../render/materials/textures.lock.json';
import { MATERIALS, type TexturePattern } from '../../src/model/materials';

/** Mirrors src/view3d/textures.ts's TILE_M (not exported — physical size in
 *  metres covered by one texture tile, per pattern). */
const TILE_M: Record<Exclude<TexturePattern, 'none'>, number> = {
  wood: 1.0,
  planks: 2.0,
  marble: 1.6,
  concrete: 1.6,
  tiles: 1.2,
};

function libraryEntry(id: string) {
  const entry = library.materials.find((m) => m.id === id);
  if (!entry) throw new Error(`openpbr.materials.json: no entry for '${id}'`);
  return entry;
}

describe('openpbr material library (render/materials/openpbr.materials.json)', () => {
  it('id set exactly equals MATERIALS.map(m => m.id)', () => {
    const appIds = MATERIALS.map((m) => m.id).sort();
    const libIds = library.materials.map((m) => m.id).sort();
    expect(libIds).toEqual(appIds);
  });

  it('tileMeters mirrors textures.ts TILE_M per material pattern, null for none', () => {
    for (const def of MATERIALS) {
      const expected = def.pattern === 'none' ? null : TILE_M[def.pattern];
      expect(libraryEntry(def.id).tileMeters, def.id).toBe(expected);
    }
  });

  it('every textureSet.ref exists in textures.lock.json sets', () => {
    const refs = new Set(textureLock.sets.map((s) => s.ref));
    for (const entry of library.materials) {
      if (entry.textureSet) {
        expect(refs.has(entry.textureSet.ref), `${entry.id}: ${entry.textureSet.ref}`).toBe(true);
      }
    }
  });

  it('tintable matches materials.ts', () => {
    for (const def of MATERIALS) {
      expect(libraryEntry(def.id).tintable, def.id).toBe(def.tintable ?? false);
    }
  });

  it('has exactly the wood/marble/concrete/planks/tiles pattern spread MATERIALS declares', () => {
    // Cross-check against the literal per-material expectations from the
    // task spec, so a future edit to MATERIALS' patterns can't silently
    // change the tileMeters contract without this test also changing.
    expect(libraryEntry('oak').tileMeters).toBe(1.0); // wood
    expect(libraryEntry('floor-oak').tileMeters).toBe(2.0); // planks
    expect(libraryEntry('marble-light').tileMeters).toBe(1.6); // marble
    expect(libraryEntry('concrete').tileMeters).toBe(1.6); // concrete
    expect(libraryEntry('tiles-grey').tileMeters).toBe(1.2); // tiles
    expect(libraryEntry('glass').tileMeters).toBeNull(); // none
  });
});
