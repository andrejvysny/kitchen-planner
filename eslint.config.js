import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/**', 'node_modules/**']),

  {
    // App code: browser globals, no Node.
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Repo idiom: guarded `!` on values already narrowed a few lines up
      // (e.g. after an explicit `if (!x) return`, or on a Map.get() right
      // after a `.has()` check). Not part of the recommended set anyway,
      // but pinned off explicitly so it stays off if that ever changes.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Repo idiom: `const { drop: _drop, ...rest } = obj` to omit one key —
      // the rest-sibling variable is unused by design, not a mistake.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Unit tests: same TS rules, but they run under vitest in plain Node
    // (no jsdom — see test/unit/storageKeys.test.ts), so Node globals.
    files: ['test/unit/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // Plain-JS Node scripts (Playwright E2E driver, screenshot tool). Also
    // browser globals: most of the interesting code here is a callback
    // passed to page.evaluate(), which runs inside the browser tab, not Node.
    files: ['test/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // test/interact.mjs deliberately matches a UTF-8 BOM (U+FEFF) via
      // /^﻿/ to assert the CSV export strips it — not a stray character.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
]);
