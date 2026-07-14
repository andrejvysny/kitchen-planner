/**
 * Design variables (named finish tokens). Pure model code — no three.js.
 *
 * A colour slot binds to a variable by storing the sentinel `var:<id>` in its
 * existing `color` string (no type widening). The resolver here turns a ref
 * into the variable's concrete finish; a literal hex passes straight through.
 * This is the single choke point every render path resolves colours through.
 */

import type { Design, DesignVar } from './types';

export const VAR_PREFIX = 'var:';

/** Fallback colour for a dangling ref (variable deleted out from under a slot). */
export const VAR_FALLBACK = '#e6dfd0'; // FRONT_COLORS[1] — a neutral cabinet tone

export interface ResolvedFinish {
  color: string;
  material?: string;
  rot?: boolean;
}

export function isVarRef(v: string | undefined): v is string {
  return typeof v === 'string' && v.startsWith(VAR_PREFIX);
}

/** `var:<id>` → `<id>`; assumes isVarRef(ref). */
export function refId(ref: string): string {
  return ref.slice(VAR_PREFIX.length);
}

/** `<id>` → `var:<id>`. */
export function toVarRef(id: string): string {
  return VAR_PREFIX + id;
}

export function variableById(design: Design, id: string): DesignVar | undefined {
  return design.variables.find((v) => v.id === id);
}

/**
 * Resolve a possibly-bound colour slot to a concrete finish. When `color` is a
 * `var:<id>` ref the variable supplies the whole finish (colour + texture);
 * otherwise the literal colour + the passed material/rot pass through.
 */
export function resolveFinish(
  design: Design,
  color: string,
  material?: string,
  rot?: boolean
): ResolvedFinish {
  if (isVarRef(color)) {
    const v = variableById(design, refId(color));
    return v ? { color: v.color, material: v.material, rot: v.materialRot } : { color: VAR_FALLBACK };
  }
  return { color, material, rot };
}

/** Resolve a possibly-bound colour slot to a plain hex (2D / cut list). */
export function resolveColor(design: Design, color: string): string {
  if (isVarRef(color)) return variableById(design, refId(color))?.color ?? VAR_FALLBACK;
  return color;
}

/** The concrete finish a ref currently resolves to — used to inline on delete/unbind. */
export function detach(design: Design, ref: string): ResolvedFinish {
  return resolveFinish(design, ref);
}
