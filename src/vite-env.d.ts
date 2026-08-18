/// <reference types="vite/client" />

/**
 * `define`d in vite.config.ts from package.json's `version` field, so it is a
 * real string literal at build/dev time (see src/app/version.ts, the one
 * place that reads it).
 */
declare const __APP_VERSION__: string;
