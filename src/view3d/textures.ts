import * as THREE from 'three';
import { materialDef, type TexturePattern } from '../model/materials';

/**
 * Procedural PBR texture maps for the built-in material library — no asset
 * files. Each pattern renders ONCE into a seamless near-white luminance
 * canvas (+ a bump canvas from the same field) and is shared by every
 * material that uses it; `material.color` does the tinting. Mesh UVs are in
 * METERS (see meshKit scaleBoxUV / ShapeGeometry / ExtrudeGeometry), so one
 * `repeat = 1 / tile-size` on the shared texture gives constant real-world
 * grain scale on every surface.
 *
 * Everything is guarded for headless runs (unit tests build meshes in node):
 * without `document` materials come back with colour + PBR params but no maps.
 */

const SIZE = 512;

/** physical size (m) covered by one texture tile */
const TILE_M: Record<Exclude<TexturePattern, 'none'>, number> = {
  wood: 1.0,
  planks: 2.0,
  marble: 1.6,
  concrete: 1.6,
  tiles: 1.2,
};

const BUMP_SCALE: Record<Exclude<TexturePattern, 'none'>, number> = {
  wood: 0.15,
  planks: 0.35,
  marble: 0.05,
  concrete: 0.3,
  tiles: 0.4,
};

/* ---------------- deterministic seamless noise ---------------- */

function hash2(ix: number, iy: number, seed: number): number {
  let n = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Value noise with independent integer frequencies per axis; the lattice
 * wraps at (fx, fy), so the result tiles seamlessly at u/v integers.
 * Anisotropic frequencies (fx ≫ fy) give elongated features — wood grain.
 */
function vnoise(u: number, v: number, fx: number, fy: number, seed: number): number {
  const x = u * fx;
  const y = v * fy;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const dx = x - xi;
  const dy = y - yi;
  const sx = dx * dx * (3 - 2 * dx);
  const sy = dy * dy * (3 - 2 * dy);
  const at = (ax: number, ay: number) => hash2(((ax % fx) + fx) % fx, ((ay % fy) + fy) % fy, seed);
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, f: number, seed: number): number {
  return (
    0.5 * vnoise(u, v, f, f, seed) +
    0.3 * vnoise(u, v, f * 2, f * 2, seed + 1) +
    0.2 * vnoise(u, v, f * 4, f * 4, seed + 2)
  );
}

const clamp01 = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ---------------- pattern fields ---------------- */

/** Luminance + bump height, both 0..1, for u/v in [0,1). Must be seamless. */
type Field = (u: number, v: number) => { l: number; b: number };

function woodField(seed: number): Field {
  return (u, v) => {
    const wob = 0.1 * vnoise(u, v, 3, 3, seed + 9);
    const streak = vnoise(u + wob, v, 40, 4, seed); // grain runs along v
    const bands = vnoise(u + wob, v, 12, 2, seed + 1);
    const pore = vnoise(u, v, 90, 14, seed + 2);
    let l = 0.84 + 0.14 * bands - 0.16 * streak * streak;
    if (pore > 0.8) l -= (pore - 0.8) * 0.9;
    return { l: clamp01(l, 0.55, 1), b: 0.5 + 0.4 * (streak - 0.5) };
  };
}

function planksField(seed: number): Field {
  const grain = woodField(seed + 20);
  const ROWS = 10; // 2 m tile → 0.2 m wide planks
  return (u, v) => {
    const row = Math.min(ROWS - 1, Math.floor(v * ROWS));
    const fy = v * ROWS - row;
    const uu = u + Math.floor(hash2(row, 1, seed) * 4) / 4;
    const col = Math.floor((((uu % 1) + 1) % 1) * 2); // 2 plank ends per tile → 1 m planks
    const fx = (((uu % 1) + 1) % 1) * 2 - col;
    // planks run along u: swap axes so the grain follows the plank length
    const g = grain(v * 5, u);
    const tone = 0.84 + 0.16 * hash2(col, row, seed + 1);
    let l = g.l * tone;
    let b = g.b * 0.5 + 0.45;
    if (fy < 0.04 || fy > 0.96 || fx < 0.015 || fx > 0.985) {
      l *= 0.55;
      b = 0.05;
    }
    return { l: clamp01(l, 0.3, 1), b };
  };
}

function marbleField(seed: number): Field {
  return (u, v) => {
    const w = fbm(u, v, 3, seed);
    const s = Math.abs(Math.sin((u + 2 * v + w * 2.4) * 2 * Math.PI));
    const vein = Math.pow(1 - s, 14);
    // faint secondary veining at another angle so it reads as stone, not stripes
    const s2 = Math.abs(Math.sin((3 * u - v + fbm(u, v, 5, seed + 7) * 1.8) * 2 * Math.PI));
    const vein2 = Math.pow(1 - s2, 18);
    const cloud = 0.05 * fbm(u, v, 8, seed + 3);
    const l = 0.97 - 0.5 * vein - 0.25 * vein2 - cloud;
    return { l: clamp01(l, 0.4, 1), b: 0.5 - 0.3 * vein };
  };
}

function concreteField(seed: number): Field {
  return (u, v) => {
    const n = fbm(u, v, 5, seed);
    let l = 0.78 + 0.18 * n;
    let b = 0.5 + 0.3 * (n - 0.5);
    const pore = vnoise(u, v, 70, 70, seed + 3);
    if (pore < 0.15) {
      l -= (0.15 - pore) * 1.6;
      b -= (0.15 - pore) * 2.5;
    }
    return { l: clamp01(l, 0.5, 1), b: clamp01(b, 0, 1) };
  };
}

function tilesField(seed: number): Field {
  const N = 2; // 1.2 m tile → 0.6 m tiles
  return (u, v) => {
    const cx = Math.min(N - 1, Math.floor(u * N));
    const cy = Math.min(N - 1, Math.floor(v * N));
    const fx = u * N - cx;
    const fy = v * N - cy;
    let l = 0.88 + 0.1 * hash2(cx, cy, seed) + 0.05 * fbm(u, v, 10, seed + 1) - 0.025;
    let b = 0.85;
    if (fx < 0.015 || fx > 0.985 || fy < 0.015 || fy > 0.985) {
      l = 0.45;
      b = 0.05;
    }
    return { l: clamp01(l, 0.35, 1), b };
  };
}

const FIELDS: Record<Exclude<TexturePattern, 'none'>, Field> = {
  wood: woodField(11),
  planks: planksField(23),
  marble: marbleField(37),
  concrete: concreteField(41),
  tiles: tilesField(53),
};

/* ---------------- canvases & textures ---------------- */

interface PatternMaps {
  map: THREE.Texture;
  bumpMap: THREE.Texture;
  bumpScale: number;
  /** raw near-white pattern image, for UI swatches */
  canvas: HTMLCanvasElement;
}

/** keyed by pattern + rotation variant (`wood`, `wood|rot`, …) */
const patternCache = new Map<string, PatternMaps | null>();
const canvasCache = new Map<TexturePattern, { color: HTMLCanvasElement; bump: HTMLCanvasElement }>();

function renderPattern(pattern: Exclude<TexturePattern, 'none'>): { color: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const field = FIELDS[pattern];
  const color = document.createElement('canvas');
  const bump = document.createElement('canvas');
  color.width = color.height = bump.width = bump.height = SIZE;
  const cctx = color.getContext('2d')!;
  const bctx = bump.getContext('2d')!;
  const cimg = cctx.createImageData(SIZE, SIZE);
  const bimg = bctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const { l, b } = field(x / SIZE, y / SIZE);
      const i = (y * SIZE + x) * 4;
      const cl = Math.round(l * 255);
      const bl = Math.round(b * 255);
      cimg.data[i] = cimg.data[i + 1] = cimg.data[i + 2] = cl;
      cimg.data[i + 3] = 255;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bl;
      bimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  return { color, bump };
}

/**
 * Shared, cached maps for a pattern; null headless or for pattern 'none'.
 * `rot` returns a 90°-rotated texture variant (grain vertical → horizontal) —
 * a separate texture instance over the SAME rendered canvases, since UV
 * rotation is a per-texture transform.
 */
function patternMaps(pattern: TexturePattern, rot = false): PatternMaps | null {
  if (pattern === 'none' || typeof document === 'undefined') return null;
  const key = rot ? `${pattern}|rot` : pattern;
  const hit = patternCache.get(key);
  if (hit !== undefined) return hit;
  let canvases = canvasCache.get(pattern);
  if (!canvases) {
    canvases = renderPattern(pattern);
    canvasCache.set(pattern, canvases);
  }
  const mk = (cnv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cnv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    const r = 1 / TILE_M[pattern];
    t.repeat.set(r, r);
    if (rot) {
      t.center.set(0.5, 0.5);
      t.rotation = Math.PI / 2;
    }
    return t;
  };
  const maps: PatternMaps = {
    map: mk(canvases.color, true),
    bumpMap: mk(canvases.bump, false),
    bumpScale: BUMP_SCALE[pattern],
    canvas: canvases.color,
  };
  patternCache.set(key, maps);
  return maps;
}

/**
 * Build the three.js material for a library material id, tinted by the
 * user's colour where the definition allows. Returns null for unknown ids so
 * callers can fall back to the plain-colour finish. Maps are shared and
 * cached — disposing the returned material never disposes them.
 */
export function texturedMaterial(matId: string, userColor: string, rot = false): THREE.MeshStandardMaterial | null {
  const def = materialDef(matId);
  if (!def) return null;
  const mat = new THREE.MeshStandardMaterial({
    color: def.tintable ? userColor : def.color,
    roughness: def.roughness,
    metalness: def.metalness,
  });
  if (def.opacity !== undefined) {
    mat.transparent = true;
    mat.opacity = def.opacity;
  }
  const maps = patternMaps(def.pattern, rot);
  if (maps) {
    mat.map = maps.map;
    mat.bumpMap = maps.bumpMap;
    mat.bumpScale = maps.bumpScale;
  }
  return mat;
}

/** Small tinted preview of a material for UI swatches; null headless. */
export function materialSwatch(matId: string, size = 44): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const def = materialDef(matId);
  if (!def) return null;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = def.color;
  ctx.fillRect(0, 0, size, size);
  const maps = patternMaps(def.pattern);
  if (maps) {
    ctx.globalCompositeOperation = 'multiply';
    // crop a quarter of the tile so the preview shows recognizable detail
    ctx.drawImage(maps.canvas, 0, 0, SIZE / 2, SIZE / 2, 0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (def.opacity !== undefined) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(0, 0, size, size);
  }
  return out;
}
