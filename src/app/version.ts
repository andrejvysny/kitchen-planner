/**
 * App version stamped into the render manifest (`RenderManifest.appVersion`).
 * `__APP_VERSION__` is a build-time `define` (vite.config.ts, from
 * package.json's `version`); model code never imports package.json directly,
 * so this is the one place that reads it and hands it in as plain input.
 */
export const APP_VERSION: string = __APP_VERSION__;
