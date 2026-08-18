/**
 * Material-name grammar (`kp:…`). Pure model code — no three.js, no DOM.
 *
 * A future render pipeline exports the scene to glTF and hands it to a
 * Blender worker (render/worker/kprender/matnames.py mirrors this grammar
 * byte-for-byte). glTF carries a material's *shape* — colour, roughness,
 * transparency — but not which entry of our own library it came from, so
 * the worker has no way to rebuild the real OpenPBR material (wood grain,
 * tiling, texture set) from the baked values alone. Stamping that identity
 * into the material's `.name` survives the round trip for free: every glTF
 * exporter carries names through, and Blender's importer preserves them too
 * — except that Blender IDs are capped at 63 bytes, and a name that
 * collides with an existing one on import gets a mechanical `.001`,
 * `.002`, … suffix appended. `MATERIAL_NAME_MAX` (50) keeps every name this
 * module produces comfortably under that cap with room to spare for the
 * suffix, and `parseMaterialName` strips it back off before parsing so a
 * re-imported or duplicated material still resolves.
 *
 * `materialName` and `parseMaterialName` are exact inverses for every name
 * this module can itself produce — see test/unit/materialName.test.ts.
 */

export type ProductSlug =
  | 'steel'
  | 'appliance-glass'
  | 'appliance-black'
  | 'appliance-ring'
  | 'handle'
  | 'bulb'
  | 'window-glass'
  | 'window-frame'
  | 'door-leaf'
  | 'door-knob'
  | 'groove'
  | 'ground';

const PRODUCT_SLUGS: ReadonlySet<string> = new Set<ProductSlug>([
  'steel',
  'appliance-glass',
  'appliance-black',
  'appliance-ring',
  'handle',
  'bulb',
  'window-glass',
  'window-frame',
  'door-leaf',
  'door-knob',
  'groove',
  'ground',
]);

/** A material minted from a library entry (src/model/materials.ts), tinted or not. */
export interface LibraryMaterialDesc {
  kind: 'library';
  matId: string;
  hex6: string;
  rot: boolean;
}

/** A flat colour with no library backing — `matte()`/`wood()` in meshKit.ts. */
export interface PlainMaterialDesc {
  kind: 'plain';
  hex6: string;
  fallback: 'matte' | 'wood';
}

/** A room shell surface (wall/floor/ceiling): its own roughness curve, so it
 *  never folds into `plain`/`library` even when the underlying colour and
 *  optional library material match one. */
export interface ShellMaterialDesc {
  kind: 'shell';
  surface: 'wall' | 'floor' | 'ceiling';
  hex6: string;
  matId?: string;
  rot?: boolean;
}

/** A fixed, non-colour-driven material used by a bespoke builder (steel, glass, …). */
export interface ProductMaterialDesc {
  kind: 'product';
  product: ProductSlug;
}

export type MaterialDesc =
  LibraryMaterialDesc | PlainMaterialDesc | ShellMaterialDesc | ProductMaterialDesc;

/** Blender ID cap (63 bytes) minus headroom for its own `.001`-style suffix. */
export const MATERIAL_NAME_MAX = 50;

const HEX6_RE = /^[0-9a-f]{6}$/;
/** Blender's mechanical duplicate suffix on a colliding import. */
const DUP_SUFFIX_RE = /\.\d{3}$/;

function normalizeHex6(hex: string): string {
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  const lower = stripped.toLowerCase();
  if (!HEX6_RE.test(lower)) {
    throw new Error(`materialName: malformed hex colour "${hex}"`);
  }
  return lower;
}

function finish(name: string): string {
  if (name.length > MATERIAL_NAME_MAX) {
    throw new Error(`materialName: "${name}" exceeds ${MATERIAL_NAME_MAX} chars`);
  }
  return name;
}

/** Encode a material's identity into its `.name` string. Throws on malformed hex. */
export function materialName(d: MaterialDesc): string {
  switch (d.kind) {
    case 'library': {
      const hex = normalizeHex6(d.hex6);
      return finish(`kp:m:${d.matId}:${hex}${d.rot ? ':r' : ''}`);
    }
    case 'plain': {
      const hex = normalizeHex6(d.hex6);
      return finish(`kp:c:${hex}:${d.fallback}`);
    }
    case 'shell': {
      const hex = normalizeHex6(d.hex6);
      const parts = ['kp', 's', d.surface, hex];
      if (d.matId) parts.push(d.matId);
      if (d.rot) parts.push('r');
      return finish(parts.join(':'));
    }
    case 'product':
      return finish(`kp:p:${d.product}`);
  }
}

/**
 * Decode a `.name` string back into a `MaterialDesc`, or null for anything
 * that isn't a name this module could have produced (a foreign/default
 * three.js/Blender name, a bad hex, an unknown slug/surface/fallback). A
 * Blender duplicate suffix (`.001`, `.002`, …) is stripped first, so a
 * re-imported or copy-pasted material still resolves.
 *
 * `matId` is never the literal string `"r"` for any current library entry
 * (src/model/materials.ts) — if it ever were, that id would be
 * indistinguishable from the shell grammar's trailing rotation flag.
 */
export function parseMaterialName(name: string): MaterialDesc | null {
  const stripped = name.replace(DUP_SUFFIX_RE, '');
  const parts = stripped.split(':');
  if (parts[0] !== 'kp' || parts.length < 3) return null;
  const kind = parts[1];

  if (kind === 'm') {
    if (parts.length < 4 || parts.length > 5) return null;
    const matId = parts[2];
    const hex = parts[3];
    const rotTok = parts[4];
    if (!matId || !HEX6_RE.test(hex)) return null;
    if (parts.length === 5 && rotTok !== 'r') return null;
    return { kind: 'library', matId, hex6: hex, rot: parts.length === 5 };
  }

  if (kind === 'c') {
    if (parts.length !== 4) return null;
    const hex = parts[2];
    const fallback = parts[3];
    if (!HEX6_RE.test(hex)) return null;
    if (fallback !== 'matte' && fallback !== 'wood') return null;
    return { kind: 'plain', hex6: hex, fallback };
  }

  if (kind === 's') {
    if (parts.length < 4 || parts.length > 6) return null;
    const surface = parts[2];
    const hex = parts[3];
    if (surface !== 'wall' && surface !== 'floor' && surface !== 'ceiling') return null;
    if (!HEX6_RE.test(hex)) return null;
    const rest = parts.slice(4);
    let rot = false;
    if (rest.length > 0 && rest[rest.length - 1] === 'r') {
      rot = true;
      rest.pop();
    }
    if (rest.length > 1) return null;
    const matId = rest.length === 1 ? rest[0] : undefined;
    if (matId === '') return null;
    return { kind: 'shell', surface, hex6: hex, matId, rot };
  }

  if (kind === 'p') {
    if (parts.length !== 3) return null;
    const product = parts[2];
    if (!PRODUCT_SLUGS.has(product)) return null;
    return { kind: 'product', product: product as ProductSlug };
  }

  return null;
}
